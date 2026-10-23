import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE WARM SPLIT AT ITS BOUNDARIES — 30/31, 60/61, 120/121 days.
//
// A send's report cohort is decided in two steps: the EVALUATOR
// (lib/engagement/status-sql.ts) produced the stamped status, and
// reportCohortSql (lib/reporting/lifecycle-report.ts) splits a warm stamp by
// days since its last human click. Both read "days" as intervals from an
// instant, so this runs BOTH, exactly as production composes them: the
// evaluator at asOf = the send instant, then the split over its output.
//
// No rows are written — the inputs are a VALUES relation. It needs a database
// only to execute the SQL.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-warm-split.ts

import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { evaluationSelectSql } = await import("@/lib/engagement/status-sql");
  const { reportCohortSql, WARM_SPLIT_DAYS } = await import("@/lib/reporting/lifecycle-report");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  // The send instant. Every last click is placed an exact interval before it.
  const SENT = new Date("2026-10-15T16:00:00.000Z");
  const DAY = 86_400_000;
  const back = (days: number, plusSeconds = 0) =>
    new Date(SENT.getTime() - days * DAY - plusSeconds * 1000);

  const cases: { label: string; at: Date; expect: string }[] = [
    { label: "B1 ⭐ exactly 30 days ⇒ Hot (the evaluator's edge)", at: back(30), expect: "hot" },
    { label: "B2 30 days + 1 s ⇒ Warm 31–60", at: back(30, 1), expect: "warm_31_60" },
    { label: "B3 ⭐ 31 days ⇒ Warm 31–60", at: back(31), expect: "warm_31_60" },
    { label: "B4 ⭐ exactly 60 days ⇒ still Warm 31–60", at: back(60), expect: "warm_31_60" },
    { label: "B5 60 days + 1 s ⇒ Warm 61–120", at: back(60, 1), expect: "warm_61_120" },
    { label: "B6 ⭐ 61 days ⇒ Warm 61–120", at: back(61), expect: "warm_61_120" },
    { label: "B7 ⭐ exactly 120 days ⇒ still Warm 61–120", at: back(120), expect: "warm_61_120" },
    { label: "B8 120 days + 1 s ⇒ Cold", at: back(120, 1), expect: "cold" },
    { label: "B9 ⭐ 121 days ⇒ Cold", at: back(121), expect: "cold" },
  ];

  // The evaluator's input shape (see scripts/test-engagement-db.ts): a contact
  // messaged 5 times, 1 since the click — so freeze never interferes. Org
  // thresholds 30 / 120, the production values.
  const values = sql.join(
    cases.map(
      (c) => sql`(
      ${c.label}::text, 'cold'::text, NULL::timestamptz, NULL::timestamptz,
      5::int, 1::int, 0::int, 0::int, 0::int, 0::int,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, ${c.at.toISOString()}::timestamptz,
      NULL::timestamptz, 0::int,
      30::int, 120::int, 10::int, 14::int, 60::int, 2::int, '{}'::int[])`,
    ),
    sql`, `,
  );
  const input = sql`(SELECT * FROM (VALUES ${values}) v(
    contact_id, prev_status, prev_status_changed_at, prev_freeze_entered_at,
    msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
    first_sent_at, last_sent_at, first_click_at, last_click_at,
    calc_freeze_started_at, calc_freeze_msgs,
    hot_days, warm_days, freeze_after_messages, freeze_cadence_days,
    suppress_after_days, suppress_min_freeze_messages, override_group_ids))`;
  const sentAt = sql`${SENT.toISOString()}::timestamptz`;

  const out = (await db.execute(sql`
    SELECT e.contact_id AS label, e.status,
           ${reportCohortSql(sql`e.status`, sql`e.last_click_at`, sentAt)} AS cohort
    FROM (${evaluationSelectSql(input, sentAt, "backfill")}) e`)) as unknown as {
    label: string;
    status: string;
    cohort: string;
  }[];

  console.log(`PART B — boundaries (split at ${WARM_SPLIT_DAYS} days)`);
  for (const c of cases) {
    const r = out.find((o) => o.label === c.label);
    bar(c.label, r?.cohort === c.expect, `evaluator ${r?.status} → cohort ${r?.cohort}`);
  }

  console.log("\nPART N — stamps the split must not invent");
  const odd = (await db.execute(sql`
    SELECT v.k,
           ${reportCohortSql(sql`v.status`, sql`v.lca`, sentAt)} AS cohort
    FROM (VALUES
      ('warm_no_click', 'warm', NULL::timestamptz),
      ('hot_passthrough', 'hot', ${back(5).toISOString()}::timestamptz),
      ('freeze_passthrough', 'freeze', ${back(90).toISOString()}::timestamptz)
    ) v(k, status, lca)`)) as unknown as { k: string; cohort: string }[];
  const o = (k: string) => odd.find((x) => x.k === k)?.cohort;
  bar("N1 ⭐ a warm stamp with NO click time stays 'warm' (shown, never guessed into a bucket)",
    o("warm_no_click") === "warm", `${o("warm_no_click")}`);
  bar("N2 non-warm statuses pass through untouched",
    o("hot_passthrough") === "hot" && o("freeze_passthrough") === "freeze");

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
