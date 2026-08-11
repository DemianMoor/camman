import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql, type SQL } from "drizzle-orm";

import { DATACENTER_ASNS, isDatacenterAsn } from "../lib/links/datacenter-asns";
import { scoreClick } from "../lib/links/scoring";

// Rescore backfill for the 2026-08-11 datacenter-ASN fix (removal of the
// org-name substring fallback + consumer-relay carve-out).
//
// DETERMINISTIC AND OFFLINE: `asn` / `asn_org` are already stored on every
// scored click, so this recomputes `is_datacenter` from the NEW list and re-runs
// the SAME pure scoreClick() the cron uses. No MaxMind lookup, no re-enrichment,
// no network. Re-running it is a no-op once applied (idempotent).
//
// SCOPE: only rows whose is_datacenter verdict actually flips. The new rule is
// strictly narrower than the old one, so only true -> false is possible; the
// script asserts the reverse direction is empty rather than assuming it.
//
// DRY RUN BY DEFAULT. Pass --apply to write.
//   npx tsx scripts/backfill-rescore-datacenter.ts
//   npx tsx scripts/backfill-rescore-datacenter.ts --apply

const APPLY = process.argv.includes("--apply");
const CHUNK = 1000;

interface Row {
  id: number;
  asn: number | null;
  asn_org: string | null;
  user_agent: string | null;
  classification: string;
  bot_score: number | null;
  is_datacenter: boolean | null;
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const dcList = sql.join([...DATACENTER_ASNS].map((n) => sql`${n}`), sql`, `);

  console.log(`\n=== Rescore backfill — datacenter ASN fix ===`);
  console.log(`mode: ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}\n`);

  // Guard: the new rule must be strictly narrower. Anything that would flip
  // false -> true means an assumption broke; stop rather than write.
  const reverse = (await d.execute(sql`
    SELECT count(*)::int AS n FROM clicks
    WHERE scored_at IS NOT NULL AND is_datacenter IS DISTINCT FROM TRUE
      AND asn IN (${dcList})
  `)) as unknown as { n: number }[];
  const reverseN = Number(reverse[0]?.n ?? 0);
  console.log(`reverse-direction rows (false -> true, expected 0): ${reverseN}`);
  if (reverseN > 0) {
    console.error("ABORT: the new list is not strictly narrower. Investigate before writing.");
    await c.end();
    process.exit(1);
  }

  // Candidates: currently datacenter, but not under the new exact-ASN list.
  const rows = (await d.execute(sql`
    SELECT id, asn, asn_org, user_agent, classification, bot_score, is_datacenter
    FROM clicks
    WHERE scored_at IS NOT NULL
      AND is_datacenter IS TRUE
      AND (asn IS NULL OR asn NOT IN (${dcList}))
    ORDER BY id
  `)) as unknown as Row[];
  console.log(`candidate rows (is_datacenter true -> false): ${rows.length}\n`);

  const transitions = new Map<string, number>();
  const byAsn = new Map<string, number>();
  const updates: SQL[] = [];

  for (const r of rows) {
    const newIsDc = isDatacenterAsn(r.asn);
    if (newIsDc === r.is_datacenter) continue; // nothing to do

    const scored = scoreClick({
      firstPassClassification: r.classification,
      userAgent: r.user_agent,
      asn: r.asn,
      asnOrg: r.asn_org,
      isDatacenter: newIsDc,
    });

    const key = `${r.classification} (${r.bot_score}) -> ${scored.classification} (${scored.score})`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    const akey = `${r.asn ?? "(null)"} ${r.asn_org ?? ""}`.trim();
    byAsn.set(akey, (byAsn.get(akey) ?? 0) + 1);

    updates.push(sql`(
      ${r.id}::bigint, ${newIsDc}::boolean, ${scored.score}::integer,
      ${JSON.stringify(scored.reasons)}::jsonb, ${scored.classification}::text
    )`);
  }

  console.log("=== transitions ===");
  console.table([...transitions.entries()].map(([transition, rows]) => ({ transition, rows })));
  console.log("=== by ASN ===");
  console.table(
    [...byAsn.entries()].sort((a, b) => b[1] - a[1]).map(([asn, rows]) => ({ asn, rows })),
  );
  console.log(`\nrows to update: ${updates.length}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    await c.end();
    return;
  }

  let written = 0;
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const res = (await tx.execute(sql`
        UPDATE clicks AS c SET
          is_datacenter = v.is_datacenter,
          bot_score     = v.bot_score,
          bot_reasons   = v.bot_reasons,
          classification = v.classification
        FROM (VALUES ${sql.join(chunk, sql`, `)})
          AS v(id, is_datacenter, bot_score, bot_reasons, classification)
        WHERE c.id = v.id
        RETURNING c.id
      `)) as unknown as { id: number }[];
      written += res.length;
      console.log(`  committed ${written}/${updates.length}`);
    }
  });

  console.log(`\nAPPLIED. rows actually changed: ${written}`);

  // Post-state, for the audit record.
  const after = (await d.execute(sql`
    SELECT classification, count(*)::text AS taps FROM clicks GROUP BY 1 ORDER BY count(*) DESC
  `)) as unknown as unknown[];
  console.log("\n=== post-backfill classification counts ===");
  console.table(after);

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
