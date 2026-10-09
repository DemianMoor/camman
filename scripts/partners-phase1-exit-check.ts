import "./_env-preload";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { getPartnerReport } from "@/lib/reporting/partner-report";

// Phase 1 exit check (Q10, owner fixes F1–F3). READ-ONLY.
//
//   --capture  run from a checkout of origin/main (the OLD code, whose 4th
//              argument is a partner KEY id and which does not know `partners`),
//              BEFORE 0200 is applied to prod. Writes the baseline file.
//   --compare  run from the Phase 1 worktree AFTER the deploy. Re-reads the same
//              range with the NEW code (4th argument = pml's PARTNER id) and
//              must print identical rows; also proves the link moved (F3) and
//              that scoping by partner equals filtering the whole report (F2).
//
// The range ends YESTERDAY in ET: campaign 1606 sends live, so today's rows
// move between the two runs. Capture and compare the same morning, minutes
// apart; both print the lookup rate, and a rate difference is reported on its
// own line, never hidden inside the row diff.
//
//   npx tsx --conditions=react-server scripts/partners-phase1-exit-check.ts --capture
//   npx tsx --conditions=react-server scripts/partners-phase1-exit-check.ts --compare

const PML_KEY_ID = 77;
const FROM = "2026-10-01";
const FILE = `${process.env.LOCALAPPDATA}/Temp/claude/partners-phase1-baseline.json`;

function etDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

type Baseline = { rows: unknown[]; rate: number; rateSource: string; keyHash: string | null; from: string; to: string };
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}
// Columns that only the NEW row shape carries; dropped on both sides so the
// comparison is about numbers.
const strip = (r: Record<string, unknown>) => {
  const { partner_id: _p, ...rest } = r;
  return rest;
};

async function main() {
  const capture = process.argv.includes("--capture");
  const org = (await db.execute(sql`SELECT org_id, report_token_hash FROM partner_keys WHERE id = ${PML_KEY_ID}`)) as unknown as
    { org_id: string; report_token_hash: string | null }[];
  const orgId = org[0].org_id;

  if (capture) {
    const to = etDay(1);
    // OLD code: the 4th argument is the KEY id.
    const report = await getPartnerReport(orgId, FROM, to, PML_KEY_ID);
    const rows = report.rows.map((r) => strip(r as unknown as Record<string, unknown>));
    const baseline: Baseline = { rows, rate: report.rate.rate, rateSource: report.rate.source, keyHash: org[0].report_token_hash, from: FROM, to };
    writeFileSync(FILE, JSON.stringify(baseline, null, 2));
    console.log(`baseline written: ${rows.length} row(s), ${FROM}..${to}, rate ${report.rate.rate} (${report.rate.source}), key 77 link live=${org[0].report_token_hash !== null}`);
    await pgConn.end();
    return;
  }

  const base = JSON.parse(readFileSync(FILE, "utf-8")) as Baseline;
  console.log(`baseline: ${base.rows.length} row(s), ${base.from}..${base.to}, rate ${base.rate} (${base.rateSource})`);
  check("the compare runs on the baseline's day (range ends yesterday ET)", base.to === etDay(1), `baseline to=${base.to}, yesterday=${etDay(1)} — re-capture is NOT allowed; investigate instead`);

  // NEW code: the 4th argument is the PARTNER id, reached through the key.
  const pm = (await db.execute(sql`
    SELECT p.id, p.slug, p.status, p.report_token_hash
    FROM partner_keys k JOIN partners p ON p.id = k.partner_id WHERE k.id = ${PML_KEY_ID}
  `)) as unknown as { id: number; slug: string; status: string; report_token_hash: string | null }[];
  check("key 77 has a partner and it is pml", pm[0]?.slug === "pml", JSON.stringify(pm[0]));
  const partnerId = pm[0].id;

  const scoped = await getPartnerReport(orgId, base.from, base.to, partnerId);
  const whole = await getPartnerReport(orgId, base.from, base.to);
  const rows = scoped.rows.map((r) => strip(r as unknown as Record<string, unknown>));
  console.log(`now:      ${rows.length} row(s), rate ${scoped.rate.rate} (${scoped.rate.source})`);
  check("lookup rate unchanged between the two runs", scoped.rate.rate === base.rate && scoped.rate.source === base.rateSource,
        `baseline ${base.rate} (${base.rateSource}) vs now ${scoped.rate.rate} (${scoped.rate.source})`);
  check("⭐ Q10: pml's rows are identical before and after", JSON.stringify(rows) === JSON.stringify(base.rows),
        `baseline ${JSON.stringify(base.rows)}\n        now      ${JSON.stringify(rows)}`);
  check("⭐ F2: scoping the report by pml's partner id == filtering the whole report to pml",
        JSON.stringify(scoped.rows) === JSON.stringify(whole.rows.filter((r) => r.partner_slug === "pml")));

  // F3: the resolver's EXACT WHERE, with key 77's copied hash. Same text as
  // resolveReportToken minus the hash parameter (the plaintext is the partner's).
  const resolved = (await db.execute(sql`
    SELECT p.id, p.slug
    FROM partners p
    WHERE p.report_token_hash = ${base.keyHash}
      AND p.status = 'active'
      AND (
        NOT EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id)
        OR EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id AND k.sandbox = false)
      )
    LIMIT 1
  `)) as unknown as { id: number; slug: string }[];
  check("⭐ F3: the resolver's WHERE with key 77's copied hash returns pml's partner", resolved[0]?.id === partnerId && resolved[0]?.slug === "pml", JSON.stringify(resolved));
  check("Q10: the hash on the partner is byte-identical to the key's", pm[0].report_token_hash === base.keyHash);

  console.log(failures === 0 ? "\nAll checks passed. Owner step: open pml's live report link and confirm it renders." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
