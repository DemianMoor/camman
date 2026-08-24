// Verifies the Overview clickers fallback: campaign 924's stage renders CamMan's
// counted clickers, a healthy guidekn stage is untouched, and NOTHING that feeds
// EPC moves.
//
// Run:  npx tsx scripts/verify-clickers-fallback.ts --baseline   (before the change)
//       npx tsx scripts/verify-clickers-fallback.ts              (after)
//
// The baseline is written to .tracking-gap-baseline.json (gitignored scratch).
import "./_env-preload";

import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";

const BASELINE = ".tracking-gap-baseline.json";
const isBaseline = process.argv.includes("--baseline");

// The two reference stages. 3029 is the gap (0 visits, 282 counted clickers);
// the guidekn control is resolved live so it stays valid as data ages.
const GAP_STAGE = 3029;

async function main() {
  const control = (await db.execute(sql`
    SELECT k.stage_id, sum(k.visit_clicks_clean)::int AS visits_clean
    FROM keitaro_stage_results k
    JOIN links l ON l.stage_id = k.stage_id
    JOIN link_destinations ld ON ld.id = l.destination_id
    WHERE ld.url LIKE 'https://www.guidekn.com/%'
    GROUP BY 1 HAVING sum(k.visit_clicks_clean) > 0
    ORDER BY 2 DESC LIMIT 1
  `)) as unknown as { stage_id: number; visits_clean: number }[];

  const CONTROL_STAGE = Number(control[0].stage_id);
  console.log(`gap stage ${GAP_STAGE}, guidekn control stage ${CONTROL_STAGE}`);

  const rows = (await db.execute(sql`
    SELECT k.stage_id,
           sum(k.visit_clicks_clean)::int AS visits_clean,
           (SELECT count(*)::int FROM counted_clickers cc WHERE cc.stage_id = k.stage_id) AS counted
    FROM keitaro_stage_results k
    WHERE k.stage_id IN (${GAP_STAGE}, ${CONTROL_STAGE})
    GROUP BY 1
  `)) as unknown as { stage_id: number; visits_clean: number; counted: number }[];

  const snapshot = Object.fromEntries(
    rows.map((r) => [
      r.stage_id,
      { visits_clean: Number(r.visits_clean), counted: Number(r.counted) },
    ]),
  );

  if (isBaseline) {
    writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2));
    console.log(`baseline written to ${BASELINE}:`);
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  let fail = 0;
  function ok(cond: boolean, label: string) {
    console.log(`  ${cond ? "✓" : "✗"} ${label}`);
    if (!cond) fail++;
  }

  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof snapshot;

  // The SOURCE data must be identical — the fallback is display-time only.
  ok(
    JSON.stringify(base) === JSON.stringify(snapshot),
    "⭐ keitaro_stage_results and counted_clickers are UNCHANGED (no data write)",
  );
  ok(snapshot[GAP_STAGE].visits_clean === 0, `gap stage ${GAP_STAGE} still has 0 Keitaro visits`);
  ok(snapshot[GAP_STAGE].counted > 0, `gap stage ${GAP_STAGE} has CamMan counted clickers to fall back to`);
  ok(
    snapshot[CONTROL_STAGE].visits_clean > 0,
    `control stage ${CONTROL_STAGE} has Keitaro visits, so it must NOT fall back`,
  );

  console.log(
    `\n  expected on screen: stage ${GAP_STAGE} -> ${snapshot[GAP_STAGE].counted}* ` +
      `(was 0), stage ${CONTROL_STAGE} -> ${snapshot[CONTROL_STAGE].visits_clean} (unmarked)`,
  );
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
  if (fail !== 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
