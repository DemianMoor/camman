import "./_env-preload";

// The preflight cron skipped a stage that was materialized early (PR fix,
// 2026-09-27). Source-level bars: the predicate is a SQL string inside a
// cron, so what is under test is which rows it selects, and the cheapest
// honest way to pin that is to read it.
//
// ⭐ WHY THIS IS A SOURCE TEST. The defect was an ABSENT row, not a wrong
// value: stage 4791 was never selected, so nothing was computed and
// preflight_result stayed NULL. A behaviour test would have to stand up a
// scheduled tracked campaign with a materialized stage and run the cron — and
// would then assert on the same predicate this reads, one indirection later.
//
// Run: npx tsx scripts/test-preflight-materialized-early.ts   (no database)

import { readFileSync } from "node:fs";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

function main() {
  console.log("PART P — the preflight cron's due-stage predicate");
  const src = readFileSync("lib/sends/send-preflight.ts", "utf-8");
  const start = src.indexOf("FROM campaign_stages s");
  const end = src.indexOf("ORDER BY s.scheduled_at ASC", start);
  const pred = src.slice(start, end);
  // Comments explain the absence; they must not be mistaken for the code.
  const code = pred.replace(/^\s*--.*$/gm, "");

  bar(
    "P1 ⭐ the materialized_at guard is GONE from the predicate",
    !/AND\s+s\.materialized_at\s+IS\s+NULL/.test(code),
    "a stage built early for a later send must still be preflighted",
  );
  bar(
    "P2 …and the reason is written down where the guard was",
    /materialized_at IS NULL/.test(pred) && /4791/.test(pred),
    "the next person to re-add it needs to know why it went",
  );
  // The guards that actually keep a fired or firing stage out.
  bar(
    "P3 sent_at IS NULL still excludes a stage that has fired",
    /AND\s+s\.sent_at\s+IS\s+NULL/.test(code),
  );
  bar(
    "P4 scheduled_at > now excludes a stage that is firing",
    /AND\s+s\.scheduled_at\s+>\s+\$\{nowIso\}/.test(code),
  );
  bar(
    "P5 the lead-window upper bound is still there",
    /AND\s+s\.scheduled_at\s+<=\s+\$\{leadIso\}/.test(code),
  );
  // The post-once claim is what stops a second tick re-notifying.
  bar(
    "P6 the write still claims preflight_notified_at IS NULL",
    /WHERE id = \$\{r\.stage_id\} AND preflight_notified_at IS NULL/.test(src),
    "without it, relaxing the predicate would re-notify every tick",
  );
  // Everything else that kept a bad stage out must survive.
  for (const g of [
    "s.send_approved = true",
    "s.schedule_missed_at IS NULL",
    "s.slip_hold_at IS NULL",
    "s.preflight_aborted_at IS NULL",
    "s.archived_at IS NULL",
    "c.status = 'active'",
  ]) {
    bar(`P7 still guarded: ${g}`, code.includes(g));
  }

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main();
