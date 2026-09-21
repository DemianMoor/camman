// Lib-level verification for dimension=creative on GET /api/reports/performance.
// READ-ONLY against the database in .env.local (production). Every compared
// figure comes from an INDEPENDENT SQL recount, never the report's own helpers.
// Seven CLOSED ET days ending yesterday — today is still moving.
// Run: npx tsx --conditions=react-server scripts/verify-creative-report.ts
import "./_env-preload";

import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { getPerformanceReport, type PerfRow } from "@/lib/reporting/performance-report";
import { requireReportingColumns } from "./_require-migration";

let failures = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
function skip(name: string, why: string) {
  console.log(`  - SKIPPED ${name}: ${why}`);
  skipped++;
}
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const keyOf = (creativeId: number | null, offerId: number | null) => `${creativeId ?? -1}:${offerId ?? -1}`;

async function rowsOf<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

// Per-key mismatches, at most five, for a failed check's detail.
function mismatches(rows: PerfRow[], want: (r: PerfRow) => unknown, got: (r: PerfRow) => unknown) {
  return rows
    .filter((r) => JSON.stringify(want(r)) !== JSON.stringify(got(r)))
    .slice(0, 5)
    .map((r) => ({ key: r.key, got: got(r), want: want(r) }));
}

async function main() {
  // getPerformanceReport reaches getStageMetricsInRange, whose projection needs
  // 0182 + 0185. Name the missing column instead of dying on a raw 42703.
  await requireReportingColumns(db, "verify-creative-report");
  const [{ org_id: orgId }] = await rowsOf<{ org_id: string }>(sql`
    SELECT org_id FROM campaigns GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`);
  const to = addDays(formatInCampaignTimezone(new Date(), "yyyy-MM-dd"), -1);
  const from = addDays(to, -6);
  const fromIso = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const toIso = fromZonedTime(`${addDays(to, 1)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  console.log(`org ${orgId} · range ${from}..${to} ET`);

  console.log("\nA. conversion_date — rows vs independent recounts");
  const rep = await getPerformanceReport(orgId, "creative", {
    from,
    to,
    providerPhoneId: null,
    attribution: "conversion_date",
  });
  const rows = rep.rows;
  check("control: at least 5 creative rows", rows.length >= 5, rows.length);
  check("control: at least one row has sales", rows.some((r) => r.sales > 0));
  check("rows' sent add up to totals", rows.reduce((a, r) => a + r.sent, 0) === rep.totals.sent, {
    rows: rows.reduce((a, r) => a + r.sent, 0),
    totals: rep.totals.sent,
  });
  check("rows' sales add up to totals", rows.reduce((a, r) => a + r.sales, 0) === rep.totals.sales);
  check(
    "rows' revenue adds up to totals",
    Math.abs(rows.reduce((a, r) => a + r.revenue, 0) - rep.totals.revenue) < 0.01,
  );
  check(
    "every key is creative_id:offer_id and every label is 'slug — offer'",
    rows.every((r) => r.key === keyOf(r.creative_id ?? null, r.offer_id ?? null) && r.label.includes(" — ")),
  );

  const sentTruth = new Map<string, number>();
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; n: number }>(sql`
    SELECT cs.creative_id, c.offer_id, count(*)::int AS n
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    JOIN campaigns c ON c.id = ss.campaign_id
    WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
      AND ss.sent_at >= ${fromIso}::timestamptz AND ss.sent_at < ${toIso}::timestamptz
      AND c.link_mode = 'tracked' AND cs.archived_at IS NULL
    GROUP BY 1, 2`)) {
    sentTruth.set(keyOf(r.creative_id, r.offer_id), Number(r.n));
  }
  const manualKeys = new Set<string>();
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; n: number }>(sql`
    SELECT cs.creative_id, c.offer_id, coalesce(sum(cs.sms_count), 0)::int AS n
    FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked' AND cs.archived_at IS NULL
      AND cs.sent_at >= ${fromIso}::timestamptz AND cs.sent_at < ${toIso}::timestamptz
    GROUP BY 1, 2`)) {
    const k = keyOf(r.creative_id, r.offer_id);
    manualKeys.add(k);
    sentTruth.set(k, (sentTruth.get(k) ?? 0) + Number(r.n));
  }
  check(
    "every row's sent = tracked sends in range + manual sms_count",
    rows.every((r) => r.sent === (sentTruth.get(r.key) ?? 0)),
    mismatches(rows, (r) => sentTruth.get(r.key) ?? 0, (r) => r.sent),
  );
  const rowKeys = new Set(rows.map((r) => r.key));
  check(
    "every recounted key with sends has a row",
    [...sentTruth.entries()].every(([k, n]) => n === 0 || rowKeys.has(k)),
    [...sentTruth.entries()].filter(([k, n]) => n > 0 && !rowKeys.has(k)).slice(0, 5),
  );

  const [{ n: manualSales }] = await rowsOf<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM stage_manual_sales
    WHERE org_id = ${orgId}::uuid
      AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz`);
  if (Number(manualSales) > 0) {
    skip("row sales = tracker sales", `${manualSales} manual sales entries in range`);
  } else {
    const salesTruth = new Map<string, number>();
    for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; n: number }>(sql`
      SELECT cs.creative_id, c.offer_id, sum(k.sales)::int AS n
      FROM keitaro_stage_results k
      JOIN campaigns c ON c.id = k.campaign_id
      LEFT JOIN campaign_stages cs ON cs.id = k.stage_id
      WHERE k.org_id = ${orgId}::uuid AND k.stat_date >= ${from}::date AND k.stat_date <= ${to}::date
      GROUP BY 1, 2`)) {
      salesTruth.set(keyOf(r.creative_id, r.offer_id), Number(r.n));
    }
    check(
      "every row's sales = tracker sales by conversion day",
      rows.every((r) => r.sales === (salesTruth.get(r.key) ?? 0)),
      mismatches(rows, (r) => salesTruth.get(r.key) ?? 0, (r) => r.sales),
    );
  }

  // Manual-mode stages add Keitaro visits that are not a set; compare only the
  // keys with no manual stage in range and no manual tracker row.
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null }>(sql`
    SELECT DISTINCT cs.creative_id, c.offer_id
    FROM keitaro_stage_results k
    JOIN campaigns c ON c.id = k.campaign_id
    LEFT JOIN campaign_stages cs ON cs.id = k.stage_id
    WHERE k.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked'
      AND k.stat_date >= ${from}::date AND k.stat_date <= ${to}::date`)) {
    manualKeys.add(keyOf(r.creative_id, r.offer_id));
  }
  const clickTruth = new Map<string, number>();
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; n: number }>(sql`
    SELECT s.creative_id, s.offer_id, count(DISTINCT cc.contact_id)::int AS n
    FROM counted_clickers cc
    JOIN LATERAL (
      SELECT cs.creative_id, c.offer_id
      FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.id = cc.stage_id
    ) s ON true
    WHERE cc.org_id = ${orgId}::uuid
      AND cc.first_click_at >= ${fromIso}::timestamptz AND cc.first_click_at < ${toIso}::timestamptz
    GROUP BY 1, 2`)) {
    clickTruth.set(keyOf(r.creative_id, r.offer_id), Number(r.n));
  }
  const trackedRows = rows.filter((r) => !manualKeys.has(r.key));
  check("control: tracked-only rows to compare clickers on", trackedRows.length >= 5, trackedRows.length);
  check(
    "every tracked row's counted_clickers = distinct human clickers at creative × offer",
    trackedRows.every((r) => r.counted_clickers === (clickTruth.get(r.key) ?? 0)),
    mismatches(trackedRows, (r) => clickTruth.get(r.key) ?? 0, (r) => r.counted_clickers),
  );

  const daysTruth = new Map<string, { first: string; last: string; days: number }>();
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; first: string; last: string; days: number }>(sql`
    SELECT cs.creative_id, c.offer_id,
           to_char(min((cs.sent_at AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS first,
           to_char(max((cs.sent_at AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS last,
           count(DISTINCT (cs.sent_at AT TIME ZONE 'America/New_York')::date)::int AS days
    FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL
      AND cs.sent_at >= ${fromIso}::timestamptz AND cs.sent_at < ${toIso}::timestamptz
    GROUP BY 1, 2`)) {
    daysTruth.set(keyOf(r.creative_id, r.offer_id), { first: r.first, last: r.last, days: Number(r.days) });
  }
  const daysOf = (r: PerfRow) => [r.first_sent_date, r.last_sent_date, r.distinct_send_days];
  const daysWant = (r: PerfRow) => {
    const t = daysTruth.get(r.key);
    return t ? [t.first, t.last, t.days] : [null, null, 0];
  };
  check(
    "every row's first / last / distinct send days = its stages sent in range",
    rows.every((r) => JSON.stringify(daysOf(r)) === JSON.stringify(daysWant(r))),
    mismatches(rows, daysWant, daysOf),
  );

  console.log("\nB. offer_id — totals equal the dimension=offer row");
  const topOffer = [...rows].sort((a, b) => b.sent - a.sent)[0]?.offer_id ?? null;
  if (topOffer == null) {
    skip("offer_id filter", "no row with an offer");
  } else {
    const bounds = { from, to, providerPhoneId: null, attribution: "conversion_date" as const };
    const byOffer = await getPerformanceReport(orgId, "creative", { ...bounds, offerId: topOffer });
    const offerReport = await getPerformanceReport(orgId, "offer", bounds);
    const offerRow = offerReport.rows.find((r) => r.key === String(topOffer));
    check("offer_id: every row belongs to that offer", byOffer.rows.length > 0 && byOffer.rows.every((r) => r.offer_id === topOffer));
    const unfiltered = rows.filter((r) => r.offer_id === topOffer);
    check(
      "offer_id: the same rows and sends as the unfiltered report's rows for that offer",
      JSON.stringify(byOffer.rows.map((r) => [r.key, r.sent]).sort()) ===
        JSON.stringify(unfiltered.map((r) => [r.key, r.sent]).sort()),
    );
    const FIELDS = ["sent", "opt_outs", "sales", "revenue", "cost", "reached", "counted_clickers", "lifetime_clickers"] as const;
    check(
      `offer_id ${topOffer}: totals = the dimension=offer row (${FIELDS.join(", ")})`,
      offerRow != null &&
        FIELDS.every((f) =>
          typeof byOffer.totals[f] === "number" && typeof offerRow[f] === "number"
            ? Math.abs((byOffer.totals[f] as number) - (offerRow[f] as number)) < 0.01
            : byOffer.totals[f] === offerRow[f],
        ),
      { totals: byOffer.totals, offerRow },
    );
  }

  console.log("\nC. send_date — the cohort of stages sent in range");
  const sd = await getPerformanceReport(orgId, "creative", {
    from,
    to,
    providerPhoneId: null,
    attribution: "send_date",
  });
  check("send_date: rows' sent add up to totals", sd.rows.reduce((a, r) => a + r.sent, 0) === sd.totals.sent);
  const cohortTruth = new Map<string, number>();
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; n: number }>(sql`
    SELECT cs.creative_id, c.offer_id,
           (count(ss.id) FILTER (WHERE c.link_mode = 'tracked' AND ss.status = 'sent'))::int AS n
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id
    LEFT JOIN stage_sends ss ON ss.stage_id = cs.id AND ss.org_id = ${orgId}::uuid
    WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL
      AND cs.sent_at >= ${fromIso}::timestamptz AND cs.sent_at < ${toIso}::timestamptz
    GROUP BY 1, 2`)) {
    cohortTruth.set(keyOf(r.creative_id, r.offer_id), Number(r.n));
  }
  for (const r of await rowsOf<{ creative_id: number | null; offer_id: number | null; n: number }>(sql`
    SELECT cs.creative_id, c.offer_id, coalesce(sum(cs.sms_count), 0)::int AS n
    FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked' AND cs.archived_at IS NULL
      AND cs.sent_at >= ${fromIso}::timestamptz AND cs.sent_at < ${toIso}::timestamptz
    GROUP BY 1, 2`)) {
    const k = keyOf(r.creative_id, r.offer_id);
    cohortTruth.set(k, (cohortTruth.get(k) ?? 0) + Number(r.n));
  }
  check(
    "send_date: every row's sent = all sends of its stages sent in range",
    sd.rows.every((r) => r.sent === (cohortTruth.get(r.key) ?? 0)),
    mismatches(sd.rows, (r) => cohortTruth.get(r.key) ?? 0, (r) => r.sent),
  );
  check("control: send_date has rows", sd.rows.length >= 5, sd.rows.length);

  console.log(
    failures === 0
      ? `\nverify-creative-report OK${skipped ? ` (${skipped} skipped)` : ""}.`
      : `\nFAILED: ${failures}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
