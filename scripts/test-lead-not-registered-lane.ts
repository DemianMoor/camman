import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { TIER_REGISTERED, campaignTierExpr } from "@/lib/campaign-tier";
import { LEAD_EVENT_TYPE } from "@/lib/conversions/standard-model";
import { RETARGET_EVENT_TYPE_IDS, reportedRegistrationClause } from "@/lib/sale-attribution";
import { PgDialect } from "drizzle-orm/pg-core";

// ⭐ GUARD (owner ruling 2026-11-04, migration 0232): leads count as
// Registrations IN REPORTS ONLY. A lead must NOT put a contact in the
// Registered lane — that decides who gets texted.
//
// Three halves:
//   S  source  — no lane / tier / lifecycle / send / audience file reads the
//                report-only flag; the lane set is still is_retarget_signal only;
//                the Lead definition is not a retarget signal.
//   D  data    — on the PREVIEW DB, in one transaction that is ROLLED BACK: a
//                contact with only a lead conversion is NOT tier 3 in the live
//                tier SQL, while a registration-only control IS, and the report
//                predicate counts both.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-lead-not-registered-lane.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// ── S: source ───────────────────────────────────────────────────────────────
console.log("Source:");
// ALLOWLIST: the only places the report-only flag may appear. Everything else
// under lib/ and app/ — lanes, tiers, lifecycle, sends, audience, segments —
// must not read it.
const ALLOWED = new Set([
  "lib/sale-attribution.ts", // defines the report-only set beside (not inside) the lane set
  "lib/reporting/event-columns.ts", // the report column merge
  "lib/reporting/drip-daily-rollup.ts", // drip Daily results "Leads"
  "lib/reporting/report-snapshot.ts", // Telegram lines
  "lib/conversions/standard-model.ts", // the Lead definition carries the flag
  "db/schema.ts",
]);
const TOKENS = /counts_as_registration|REPORT_REGISTRATION_EVENT_TYPE_IDS|reportedRegistration(Revenue)?Clause|registrationMerge|countedEventTypes/;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p.replace(/\\/g, "/")] : [];
  });
const offenders = [...walk("lib"), ...walk("app")].filter(
  (f) => !ALLOWED.has(f) && !f.startsWith("lib/reporting/") && TOKENS.test(readFileSync(f, "utf8")),
);
bar("S1 ⭐ no lane / tier / lifecycle / send / audience file reads the report-only registration flag", offenders.length === 0, offenders.join(", "));
const laneFiles = ["lib/campaign-tier.ts", "lib/drip/lifecycle.ts", "lib/stages/behavioral-split.ts", "lib/drip/followups.ts", "lib/sends/eligibility.ts", "lib/segment-rules-eval.ts"];
const laneHits = laneFiles.filter((f) => TOKENS.test(readFileSync(f, "utf8")));
bar("S2 the named lane files are clean (explicit, in case the scan's scope ever narrows)", laneHits.length === 0, laneHits.join(", "));
const rendered = new PgDialect().sqlToQuery(RETARGET_EVENT_TYPE_IDS).sql;
bar("S3 the LANE set is still is_retarget_signal and nothing else",
  rendered === "(SELECT et.id FROM event_types et WHERE et.is_retarget_signal)", rendered);
bar("S4 the Lead definition is NOT a retarget signal (and is the report-merged type)",
  LEAD_EVENT_TYPE.is_retarget_signal === false && LEAD_EVENT_TYPE.counts_as_registration === true);

// ── D: data, preview, rolled back ───────────────────────────────────────────
class Rollback extends Error {}
async function main() {
  requirePreviewDb();
  console.log("\nDB (preview, rolled back):");
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString(36);
      const one = async <T,>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${"lead-lane-guard " + sfx}) RETURNING id`)).id;
      const et = async (key: string, f: { sig?: boolean; car?: boolean; buy?: boolean; rev?: boolean }) =>
        (await one<{ id: number }>(sql`
          INSERT INTO event_types (org_id, key, label, is_retarget_signal, counts_as_registration, is_purchase, counts_revenue)
          VALUES (${org}::uuid, ${key}, ${key}, ${!!f.sig}, ${!!f.car}, ${!!f.buy}, ${!!f.rev}) RETURNING id`)).id;
      // Org seeding (handle_new_user) may already have created some types; take
      // whatever exists by FLAG, creating the missing ones.
      const existing = (await tx.execute(sql`
        SELECT id, is_retarget_signal, counts_as_registration FROM event_types WHERE org_id = ${org}::uuid`)) as unknown as
        { id: number; is_retarget_signal: boolean; counts_as_registration: boolean }[];
      const signal = existing.find((e) => e.is_retarget_signal)?.id ?? (await et("signup", { sig: true }));
      const leadT = existing.find((e) => e.counts_as_registration)?.id ?? (await et("form", { car: true, rev: true }));
      const camp = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status) VALUES (${org}::uuid, ${"llg-" + sfx}, 'LLG', 'paused') RETURNING id`)).id;
      const contact = async (i: number) =>
        (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${org}::uuid, ${"+1555" + String(Date.now() % 1e6).padStart(6, "0") + i}) RETURNING id`)).id;
      const leadOnly = await contact(1);
      const regOnly = await contact(2);
      let n = 0;
      const conv = (c: string, type: number, status: string) => tx.execute(sql`
        INSERT INTO conversion_events (keitaro_event_id, org_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
                                       contact_id, campaign_id, occurred_at)
        VALUES (${"llg-" + sfx + "-" + ++n}, ${org}::uuid, 'lead', 'lead', ${type}, ${status}, 5, ${c}::uuid, ${camp}, now())`);
      await conv(leadOnly, leadT, "approved");
      await conv(leadOnly, leadT, "pending");
      await conv(regOnly, signal, "approved");

      const tiers = (await tx.execute(sql`
        SELECT contact_id::text, tier FROM (${campaignTierExpr(camp, org)}) t`)) as unknown as { contact_id: string; tier: number }[];
      const tierOf = (c: string) => tiers.find((t) => t.contact_id === c)?.tier ?? 0;
      bar(`D1 ⭐ a contact with ONLY lead conversions is NOT in the Registered lane (tier ${tierOf(leadOnly)} ≠ ${TIER_REGISTERED})`,
        tierOf(leadOnly) !== TIER_REGISTERED);
      bar(`D2 control: a registration-only contact IS tier ${TIER_REGISTERED} (the fixture can see the lane at all)`,
        tierOf(regOnly) === TIER_REGISTERED, `got ${tierOf(regOnly)}`);
      const reported = await one<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM conversion_events ce WHERE ce.org_id = ${org}::uuid AND ${reportedRegistrationClause()}`);
      bar("D3 reports DO count the leads as registrations (3 = 2 leads + 1 registration)", reported.n === 3, `got ${reported.n}`);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
