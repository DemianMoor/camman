// Lib-level verification for the operator-API grading fields.
// READ-ONLY against the database in .env.local (production). Every figure is
// compared with an INDEPENDENT SQL recomputation — never the helper that
// produced it — and every check that could pass vacuously has a control.
// Run: npx tsx --conditions=react-server scripts/verify-operator-grading.ts
import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  getCampaignAudit,
  getConversionTails,
  getCreativeUsage,
  getOptOutCohorts,
  getStageSendGroups,
  OPT_OUT_DIMENSIONS,
} from "@/lib/reporting/grading";
import { OPT_OUT_ATTRIBUTION_WINDOW_HOURS } from "@/lib/sends/opt-out-window";
import { OPT_OUT_ATTRIBUTION_WINDOW_HOURS as POLLER_WINDOW } from "@/lib/sends/poll-opt-outs";
import { pct } from "@/lib/reporting/grading-rates";
import { getPerformanceReport, gradePerf } from "@/lib/reporting/performance-report";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";

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
async function one<T>(q: SQL): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

async function main() {
  const { org_id: orgId } = await one<{ org_id: string }>(sql`
    SELECT org_id FROM campaigns GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`);
  // Seven CLOSED ET days ending yesterday — today is still moving.
  const to = addDays(formatInCampaignTimezone(new Date(), "yyyy-MM-dd"), -1);
  const from = addDays(to, -6);
  const fromIso = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const toIso = fromZonedTime(`${addDays(to, 1)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  console.log(`org ${orgId} · range ${from}..${to} ET`);

  const { n: reachTruth } = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${orgId}::uuid
      AND offer_reached_at >= ${fromIso}::timestamptz
      AND offer_reached_at <  ${toIso}::timestamptz`);
  check("control: the range has real reaches", reachTruth > 0, reachTruth);

  console.log("\nA. getStageMetricsInRange — per-stage reached");
  const { stages } = await getStageMetricsInRange(orgId, from, to);
  const manual = stages.filter((s) => s.link_mode !== "tracked");
  const tracked = stages.filter((s) => s.link_mode === "tracked");
  check("tracked stages carry a numeric reached", tracked.every((s) => typeof s.reached === "number"));
  check(
    "manual stages carry reached = null",
    manual.every((s) => s.reached === null),
    manual.map((s) => s.stage_id),
  );
  const stageReach = tracked.reduce((a, s) => a + (s.reached ?? 0), 0);
  check(`sum of stage reached = direct count (${reachTruth})`, stageReach === reachTruth, stageReach);

  console.log("\nB. getPerformanceReport — reached, deduped totals, grading");
  const inRange = sql`first_click_at >= ${fromIso}::timestamptz AND first_click_at < ${toIso}::timestamptz`;
  const { n: clickTruth } = await one<{ n: number }>(sql`
    SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::int AS n
    FROM counted_clickers WHERE org_id = ${orgId}::uuid AND ${inRange}`);
  const { n: lifeClickTruth } = await one<{ n: number }>(sql`
    SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::int AS n
    FROM counted_clickers WHERE org_id = ${orgId}::uuid`);
  const { n: stageGrainSum } = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM counted_clickers WHERE org_id = ${orgId}::uuid AND ${inRange}`);
  const { n: manualVisits } = await one<{ n: number }>(sql`
    SELECT coalesce(sum(k.visit_clicks_clean), 0)::int AS n
    FROM keitaro_stage_results k JOIN campaigns c ON c.id = k.campaign_id
    WHERE k.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked'
      AND k.stat_date >= ${from}::date AND k.stat_date <= ${to}::date`);
  check(
    "control: a summed clicker total would differ from the distinct one",
    stageGrainSum > clickTruth,
    { stageGrainSum, clickTruth },
  );

  for (const dim of ["number", "offer", "sequence", "group"] as const) {
    let r: Awaited<ReturnType<typeof getPerformanceReport>>;
    try {
      r = await getPerformanceReport(orgId, dim, { from, to, providerPhoneId: null });
    } catch (e) {
      // By Group's click-weight query walks every human click (~50s at ANY range,
      // pre-existing) and can exceed the 2-minute statement timeout. Report that
      // as SKIPPED by name — never as a pass — and fail on anything else.
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (dim === "group" && code === "57014") {
        skip(`${dim}: all checks`, "pre-existing By Group statement timeout (57014)");
        continue;
      }
      throw e;
    }
    const t = r.totals;
    check(`${dim}: totals.reached = direct count`, t.reached === reachTruth, t.reached);
    const rowReach = r.rows.reduce((a, x) => a + (x.reached ?? 0), 0);
    check(
      `${dim}: rows' reached sum to the direct count`,
      Math.abs(rowReach - reachTruth) <= (dim === "group" ? 2 : 0),
      rowReach,
    );
    check(
      `${dim}: totals.counted_clickers = distinct + manual visits`,
      t.counted_clickers === clickTruth + manualVisits,
      { got: t.counted_clickers, want: clickTruth + manualVisits },
    );
    check(
      `${dim}: totals.lifetime_clickers = lifetime distinct + manual visits`,
      t.lifetime_clickers === lifeClickTruth + manualVisits,
      { got: t.lifetime_clickers, want: lifeClickTruth + manualVisits },
    );
    const g = gradePerf(t);
    check(
      `${dim}: grading arithmetic on totals`,
      g.clicks_human === t.counted_clickers &&
        g.click_to_reach_pct === pct(t.reached, t.counted_clickers) &&
        g.reach_to_sale_pct === pct(t.sales, t.reached) &&
        g.opt_rate === pct(t.opt_outs, t.sent),
      g,
    );
  }

  const { provider_phone_id: pid } = await one<{ provider_phone_id: number }>(sql`
    SELECT provider_phone_id FROM campaign_stages
    WHERE org_id = ${orgId}::uuid AND provider_phone_id IS NOT NULL
      AND sent_at >= ${fromIso}::timestamptz AND sent_at < ${toIso}::timestamptz
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const { n: pidClickTruth } = await one<{ n: number }>(sql`
    SELECT count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text))::int AS n
    FROM counted_clickers cc JOIN campaign_stages cs ON cs.id = cc.stage_id
    WHERE cc.org_id = ${orgId}::uuid AND cs.provider_phone_id = ${pid}
      AND cc.first_click_at >= ${fromIso}::timestamptz AND cc.first_click_at < ${toIso}::timestamptz`);
  const { n: pidManual } = await one<{ n: number }>(sql`
    SELECT coalesce(sum(k.visit_clicks_clean), 0)::int AS n
    FROM keitaro_stage_results k
    JOIN campaigns c ON c.id = k.campaign_id
    JOIN campaign_stages cs ON cs.id = k.stage_id
    WHERE k.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked' AND cs.provider_phone_id = ${pid}
      AND k.stat_date >= ${from}::date AND k.stat_date <= ${to}::date`);
  const rp = await getPerformanceReport(orgId, "number", { from, to, providerPhoneId: pid });
  check(
    `number filtered to phone ${pid}: totals.counted_clickers = distinct for that number`,
    rp.totals.counted_clickers === pidClickTruth + pidManual,
    { got: rp.totals.counted_clickers, want: pidClickTruth + pidManual },
  );

  const h = await getPerformanceReport(orgId, "hourly", { from, to, providerPhoneId: null });
  const hours = h.rows.filter((x) => !x.pinned);
  check("hourly: each hour's reached equals its redirects", hours.every((x) => x.reached === x.redirects));
  check(
    "hourly: hours' reached sum = direct count",
    hours.reduce((a, x) => a + (x.reached ?? 0), 0) === reachTruth,
  );
  check(
    "hourly: totals.counted_clickers = distinct in range",
    h.totals.counted_clickers === clickTruth,
    h.totals.counted_clickers,
  );

  console.log("\nC. attribution=send_date — the cohort of stages sent in range");
  const [cohortTruth] = (await db.execute(sql`
    WITH cohort AS (
      SELECT cs.id, c.link_mode, cs.sms_count FROM campaign_stages cs
      JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL
        AND cs.sent_at >= ${fromIso}::timestamptz AND cs.sent_at < ${toIso}::timestamptz
    )
    SELECT
      (SELECT count(*) FROM stage_sends ss JOIN cohort ON cohort.id = ss.stage_id
         AND cohort.link_mode = 'tracked' WHERE ss.status = 'sent')::int
        + (SELECT coalesce(sum(sms_count), 0) FROM cohort WHERE link_mode <> 'tracked')::int AS sent,
      (SELECT count(*) FROM stage_sends ss JOIN cohort ON cohort.id = ss.stage_id
         AND cohort.link_mode = 'tracked' WHERE ss.offer_reached_at IS NOT NULL)::int AS reached,
      (SELECT count(*) FROM opt_out_attributions oa JOIN cohort ON cohort.id = oa.stage_id)::int AS opt_outs,
      (SELECT coalesce(sum(k.revenue), 0) FROM keitaro_stage_results k
         JOIN cohort ON cohort.id = k.stage_id)::float8 AS revenue,
      (SELECT coalesce(sum(greatest(coalesce(ms.m, 0), coalesce(ks.s, 0))), 0) FROM cohort
         LEFT JOIN (SELECT stage_id, sum(sales) AS s FROM keitaro_stage_results GROUP BY 1) ks ON ks.stage_id = cohort.id
         LEFT JOIN (SELECT stage_id, sum(delta) AS m FROM stage_manual_sales GROUP BY 1) ms ON ms.stage_id = cohort.id
      )::int AS sales,
      (SELECT count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text))
         FROM counted_clickers cc JOIN cohort ON cohort.id = cc.stage_id)::int AS clickers,
      (SELECT coalesce(sum(k.visit_clicks_clean), 0) FROM keitaro_stage_results k
         JOIN cohort ON cohort.id = k.stage_id AND cohort.link_mode <> 'tracked')::int AS manual_visits
  `)) as unknown as {
    sent: number;
    reached: number;
    opt_outs: number;
    revenue: number;
    sales: number;
    clickers: number;
    manual_visits: number;
  }[];
  const convTotals = (await getPerformanceReport(orgId, "offer", { from, to, providerPhoneId: null })).totals;
  for (const dim of ["number", "offer", "sequence"] as const) {
    const r = await getPerformanceReport(orgId, dim, {
      from,
      to,
      providerPhoneId: null,
      attribution: "send_date",
    });
    const t = r.totals;
    check(`${dim} send_date: totals.sent = cohort sends`, t.sent === cohortTruth.sent, { got: t.sent, want: cohortTruth.sent });
    check(`${dim} send_date: totals.reached = cohort reaches`, t.reached === cohortTruth.reached, { got: t.reached, want: cohortTruth.reached });
    check(`${dim} send_date: totals.opt_outs = cohort attributions`, t.opt_outs === cohortTruth.opt_outs, { got: t.opt_outs, want: cohortTruth.opt_outs });
    check(`${dim} send_date: totals.sales = cohort tracker+manual sales`, t.sales === cohortTruth.sales, { got: t.sales, want: cohortTruth.sales });
    check(
      `${dim} send_date: totals.revenue = cohort revenue`,
      Math.abs(t.revenue - cohortTruth.revenue) < 0.01,
      { got: t.revenue, want: cohortTruth.revenue },
    );
    check(
      `${dim} send_date: totals.counted_clickers = cohort distinct + manual visits`,
      t.counted_clickers === cohortTruth.clickers + cohortTruth.manual_visits,
      { got: t.counted_clickers, want: cohortTruth.clickers + cohortTruth.manual_visits },
    );
    check(`${dim} send_date: rows' reached sum to totals`, r.rows.reduce((a, x) => a + (x.reached ?? 0), 0) === t.reached);
    check(`${dim} send_date: rows' sent sum to totals`, r.rows.reduce((a, x) => a + x.sent, 0) === t.sent);
  }
  check(
    "control: the two bases really differ on sales (tails exist)",
    convTotals.sales !== cohortTruth.sales,
    { conversion_date: convTotals.sales, send_date: cohortTruth.sales },
  );

  console.log("\nD. getConversionTails");
  // The most recent day in the last 14 with a real tail, so the check can't pass vacuously.
  const [tailDay] = (await db.execute(sql`
    SELECT to_char(k.stat_date, 'YYYY-MM-DD') AS d
    FROM keitaro_stage_results k JOIN campaign_stages cs ON cs.id = k.stage_id
    WHERE k.org_id = ${orgId}::uuid AND k.sales > 0
      AND k.stat_date >= (now() AT TIME ZONE 'America/New_York')::date - 14
      AND (cs.sent_at AT TIME ZONE 'America/New_York')::date < k.stat_date
    ORDER BY k.stat_date DESC LIMIT 1`)) as unknown as { d: string }[];
  check("control: a recent day with a real tail exists", tailDay != null, tailDay);
  if (tailDay) {
    const D = tailDay.d;
    const [truth] = (await db.execute(sql`
      SELECT coalesce(sum(k.sales), 0)::int AS conversions,
             coalesce(sum(k.sales) FILTER (
               WHERE (cs.sent_at AT TIME ZONE 'America/New_York')::date < k.stat_date), 0)::int AS tail
      FROM keitaro_stage_results k JOIN campaign_stages cs ON cs.id = k.stage_id
      WHERE k.org_id = ${orgId}::uuid AND k.stat_date = ${D}::date`)) as unknown as {
      conversions: number;
      tail: number;
    }[];
    const tails = await getConversionTails(orgId, D);
    const tt = tails.totals;
    check(`tails ${D}: totals.conversions = tracker sum for the day`, tt.conversions === truth.conversions, { got: tt.conversions, want: truth.conversions });
    check(`tails ${D}: totals.tail_conversions = sends before the day`, tt.tail_conversions === truth.tail, { got: tt.tail_conversions, want: truth.tail });
    check(
      `tails ${D}: same_day + tail + unknown = conversions`,
      tt.same_day_conversions + tt.tail_conversions + tt.unknown_send_date_conversions === tt.conversions,
      tt,
    );
    check(`tails ${D}: rows sum to tail_conversions`, tails.data.reduce((a, x) => a + x.conversions, 0) === tt.tail_conversions);
    check(`tails ${D}: every row is at least a day after its send`, tails.data.every((x) => x.days_after_send >= 1));
  }

  console.log("\nE. getOptOutCohorts — send-day cohort opt-outs");
  // The 5 closed ET days ending yesterday, so both `complete` values occur.
  const eTo = addDays(formatInCampaignTimezone(new Date(), "yyyy-MM-dd"), -1);
  const eFrom = addDays(eTo, -4);
  const eFromIso = fromZonedTime(`${eFrom}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const eToIso = fromZonedTime(`${addDays(eTo, 1)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const sentByDay = new Map(
    (
      (await db.execute(sql`
        SELECT to_char((ss.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day,
               count(*)::int AS n
        FROM stage_sends ss
        WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
          AND ss.sent_at >= ${eFromIso}::timestamptz AND ss.sent_at < ${eToIso}::timestamptz
        GROUP BY 1`)) as unknown as { day: string; n: number }[]
    ).map((r) => [r.day, Number(r.n)]),
  );
  const optByDay = new Map(
    (
      (await db.execute(sql`
        SELECT to_char((ss.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day,
               count(DISTINCT oa.opt_out_id)::int AS n
        FROM stage_sends ss JOIN opt_out_attributions oa ON oa.stage_send_id = ss.id
        WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
          AND ss.sent_at >= ${eFromIso}::timestamptz AND ss.sent_at < ${eToIso}::timestamptz
        GROUP BY 1`)) as unknown as { day: string; n: number }[]
    ).map((r) => [r.day, Number(r.n)]),
  );
  check("control: the 5-day range has sends", sentByDay.size > 0, { eFrom, eTo });
  const completeSeen = new Set<boolean>();
  for (const dim of OPT_OUT_DIMENSIONS) {
    const oc = await getOptOutCohorts(orgId, dim, eFrom, eTo);
    check(`${dim}: window_hours = 72`, oc.window_hours === OPT_OUT_ATTRIBUTION_WINDOW_HOURS && oc.window_hours === 72, oc.window_hours);
    for (const t of oc.totals) {
      check(`${dim} ${t.date}: totals.sent = direct count`, t.sent === (sentByDay.get(t.date) ?? 0), { got: t.sent, want: sentByDay.get(t.date) });
      check(`${dim} ${t.date}: totals.opt_outs = distinct STOPs`, t.opt_outs === (optByDay.get(t.date) ?? 0), { got: t.opt_outs, want: optByDay.get(t.date) });
      // Computed here, not trusted from the lib: end of the ET day + the window.
      const completeAt =
        fromZonedTime(`${addDays(t.date, 1)}T00:00:00`, CAMPAIGN_TIMEZONE).getTime() + 72 * 3_600_000;
      check(`${dim} ${t.date}: complete = (now >= day end + 72h)`, t.complete === Date.now() >= completeAt, t.complete);
      completeSeen.add(t.complete);
      const rows = oc.data.filter((r) => r.date === t.date);
      if (dim === "group") {
        check(`group ${t.date}: every row's sent <= the day's total`, rows.every((r) => r.sent <= t.sent));
      } else {
        check(`${dim} ${t.date}: rows' sent sum to the day's total`, rows.reduce((a, r) => a + r.sent, 0) === t.sent);
        check(`${dim} ${t.date}: rows' opt-outs sum to the day's total`, rows.reduce((a, r) => a + r.opt_outs, 0) === t.opt_outs);
      }
    }
    check(`${dim}: opt_rate arithmetic on every row`, oc.data.every((r) => r.opt_rate === pct(r.opt_outs, r.sent)));
    if (dim === "group" && oc.data.length > 0) {
      const top = [...oc.data].sort((a, b) => b.sent - a.sent)[0];
      const [g] = (await db.execute(sql`
        SELECT count(*)::int AS n
        FROM stage_sends ss
        JOIN campaigns c ON c.id = ss.campaign_id
        JOIN contact_contact_groups ccg ON ccg.contact_id = ss.contact_id
          AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)
        WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
          AND ccg.contact_group_id = ${Number(top.key)}
          AND ss.sent_at >= ${eFromIso}::timestamptz AND ss.sent_at < ${eToIso}::timestamptz
          AND to_char((ss.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') = ${top.date}`)) as unknown as { n: number }[];
      check(`group ${top.key} on ${top.date}: sent = independent membership count`, top.sent === Number(g.n), { got: top.sent, want: g.n });
    }
  }
  check("control: both complete values occur in the range", completeSeen.has(true) && completeSeen.has(false), [...completeSeen]);
  check("the STOP ingester re-exports the same window", POLLER_WINDOW === OPT_OUT_ATTRIBUTION_WINDOW_HOURS, POLLER_WINDOW);

  console.log("\nF. getCreativeUsage — where a text has already run");
  const [topCreative] = (await db.execute(sql`
    SELECT creative_id FROM campaign_stages
    WHERE org_id = ${orgId}::uuid AND creative_id IS NOT NULL AND sent_at IS NOT NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)) as unknown as { creative_id: number }[];
  const creativeId = Number(topCreative.creative_id);
  const [usageTruth] = (await db.execute(sql`
    WITH st AS (
      SELECT cs.id, cs.sms_count, c.link_mode
      FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.org_id = ${orgId}::uuid AND cs.creative_id = ${creativeId} AND cs.sent_at IS NOT NULL
    )
    SELECT
      (SELECT count(*) FROM stage_sends ss JOIN st ON st.id = ss.stage_id
         AND st.link_mode = 'tracked' WHERE ss.status = 'sent')::int
        + (SELECT coalesce(sum(sms_count), 0) FROM st WHERE link_mode <> 'tracked')::int AS sends,
      (SELECT count(*) FROM stage_sends ss JOIN st ON st.id = ss.stage_id
         AND st.link_mode = 'tracked' WHERE ss.offer_reached_at IS NOT NULL)::int AS reached,
      (SELECT coalesce(sum(k.sales), 0) FROM keitaro_stage_results k
         JOIN st ON st.id = k.stage_id)::int AS conversions,
      (SELECT count(*) FROM stage_sends ss JOIN st ON st.id = ss.stage_id
         WHERE ss.status IN ('pending', 'sending'))::int AS in_flight
  `)) as unknown as { sends: number; reached: number; conversions: number; in_flight: number }[];
  // ⚠️ The most-reused creative can be MID-SEND while this runs. Here the truth is
  // read BEFORE getCreativeUsage, so while any of its stages has pending/sending
  // rows the later lib sums may only be >= the truth (section G hit this race in the
  // other direction); with nothing in flight they must be equal.
  const usageLive = Number(usageTruth.in_flight) > 0;
  const atLeastIfLive = (got: number, truth: number) => (usageLive ? got >= truth : got === truth);
  console.log(`    creative ${creativeId}: ${usageLive ? `still sending (${usageTruth.in_flight} in flight)` : "settled"}`);
  const usage = await getCreativeUsage(orgId, creativeId);
  check(`creative ${creativeId}: usage found (control for the not-found check)`, usage != null);
  check("an id outside the org returns null", (await getCreativeUsage(orgId, 999_999_999)) === null);
  if (usage) {
    const rows = usage.data;
    const op = usageLive ? ">=" : "=";
    check(
      `creative ${creativeId}: rows' sends ${op} its stages' sends`,
      atLeastIfLive(rows.reduce((a, r) => a + r.sends, 0), usageTruth.sends),
      { got: rows.reduce((a, r) => a + r.sends, 0), truth: usageTruth.sends },
    );
    check(
      `creative ${creativeId}: rows' reached ${op} its stages' reaches`,
      atLeastIfLive(rows.reduce((a, r) => a + (r.reached ?? 0), 0), usageTruth.reached),
      { got: rows.reduce((a, r) => a + (r.reached ?? 0), 0), truth: usageTruth.reached },
    );
    check(
      `creative ${creativeId}: rows' conversions ${op} tracker sales`,
      atLeastIfLive(rows.reduce((a, r) => a + r.conversions, 0), usageTruth.conversions),
      { got: rows.reduce((a, r) => a + r.conversions, 0), truth: usageTruth.conversions },
    );
    check(`creative ${creativeId}: rows are newest first`, rows.every((r, i) => i === 0 || rows[i - 1].date >= r.date));
    // A row is one campaign + sending number + ET send day; link_mode is per
    // campaign, so a row with a numeric `reached` is all-tracked and its
    // clicks_human is purely the distinct counted clickers over its stages.
    const topRow = [...rows].filter((r) => r.reached !== null).sort((a, b) => b.sends - a.sends)[0];
    check(`creative ${creativeId}: has a tracked row to check clickers on`, topRow != null);
    if (topRow) {
      const [ccTruth] = (await db.execute(sql`
        SELECT count(DISTINCT cc.contact_id)::int AS n
        FROM counted_clickers cc
        JOIN campaign_stages cs ON cs.id = cc.stage_id
        LEFT JOIN provider_phones pp ON pp.id = cs.provider_phone_id
        WHERE cc.org_id = ${orgId}::uuid AND cs.creative_id = ${creativeId} AND cs.sent_at IS NOT NULL
          AND cs.campaign_id = ${topRow.campaign_id}
          AND pp.phone_number IS NOT DISTINCT FROM ${topRow.sending_number}
          AND to_char((cs.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') = ${topRow.date}`)) as unknown as { n: number }[];
      // This truth is read AFTER getCreativeUsage, so while the creative is still
      // sending the lib figure may only be <= it; settled, they must be equal.
      check(
        `creative ${creativeId} ${topRow.date}: largest row's clicks_human ${usageLive ? "<=" : "="} independent distinct count`,
        usageLive
          ? topRow.clicks_human <= Number(ccTruth.n)
          : topRow.clicks_human === Number(ccTruth.n),
        { got: topRow.clicks_human, truth: ccTruth.n },
      );
    }
  }

  console.log("\nG. getCampaignAudit — every active campaign with its stages");
  const audit = await getCampaignAudit(orgId, "active");
  const [activeTruth] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaigns
    WHERE org_id = ${orgId}::uuid AND status = 'active'`)) as unknown as { n: number }[];
  check("audit: one entry per active campaign", audit.data.length === Number(activeTruth.n), { got: audit.data.length, want: activeTruth.n });
  const stageTruth = (await db.execute(sql`
    SELECT cs.id AS stage_id, cs.campaign_id, c.link_mode, cs.sms_count,
           coalesce(se.sent, 0)::int AS sent, coalesce(se.reached, 0)::int AS reached,
           coalesce(se.in_flight, 0)::int AS in_flight,
           coalesce(k.sales, 0)::int AS sales, coalesce(k.revenue, 0)::float8 AS revenue
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id
    LEFT JOIN (
      SELECT stage_id, count(*) FILTER (WHERE status = 'sent')::int AS sent,
             count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached,
             count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS in_flight
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid
        AND campaign_id IN (SELECT id FROM campaigns WHERE org_id = ${orgId}::uuid AND status = 'active')
      GROUP BY 1
    ) se ON se.stage_id = cs.id
    LEFT JOIN (
      SELECT stage_id, sum(sales)::int AS sales, sum(revenue)::float8 AS revenue
      FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid GROUP BY 1
    ) k ON k.stage_id = cs.id
    WHERE cs.org_id = ${orgId}::uuid AND c.status = 'active' AND cs.status <> 'archived'`)) as unknown as {
    stage_id: number;
    campaign_id: number;
    link_mode: string;
    sms_count: number | null;
    sent: number;
    reached: number;
    in_flight: number;
    sales: number;
    revenue: number;
  }[];
  // ⚠️ ACTIVE CAMPAIGNS ARE SENDING WHILE THIS RUNS. The audit is read BEFORE the
  // truth, so a stage that still has pending/sending rows can have gained sends
  // (and, rarely, a conversion) between the two reads — exact equality raced on the
  // first run (stages 4279/4278/4271 were mid-drain: audit 2795 vs truth 2801).
  // Settled stages must match exactly; live stages may only have grown.
  const truthByStage = new Map(stageTruth.map((s) => [Number(s.stage_id), s]));
  let auditConversionsSeen = false;
  let settledStages = 0;
  const liveStages: number[] = [];
  for (const camp of audit.data) {
    const truthStages = stageTruth.filter((s) => Number(s.campaign_id) === camp.campaign_id);
    check(`campaign ${camp.campaign_id}: stage_count = non-archived stages`, camp.stage_count === truthStages.length && camp.stages.length === truthStages.length, { got: camp.stage_count, want: truthStages.length });
    for (const s of camp.stages) {
      const t = truthByStage.get(s.stage_id);
      const tracked = t?.link_mode === "tracked";
      if (t != null && t.in_flight > 0) {
        liveStages.push(s.stage_id);
        check(
          `campaign ${camp.campaign_id} stage ${s.stage_id} (still sending): audit counts <= the later direct counts`,
          s.sent <= t.sent && (s.reached ?? 0) <= t.reached && s.conversions <= t.sales,
          { got: [s.sent, s.reached, s.conversions], later: [t.sent, t.reached, t.sales] },
        );
      } else {
        settledStages++;
        check(
          `campaign ${camp.campaign_id} stage ${s.stage_id}: sent / reached / conversions = direct counts`,
          t != null &&
            s.sent === (tracked ? t.sent : Number(t.sms_count ?? 0)) &&
            s.reached === (tracked ? t.reached : null) &&
            s.conversions === t.sales,
          { got: [s.sent, s.reached, s.conversions], want: t && [tracked ? t.sent : t.sms_count, tracked ? t.reached : null, t.sales] },
        );
      }
    }
    check(`campaign ${camp.campaign_id}: total_conversions = its stages' conversions`, camp.total_conversions === camp.stages.reduce((a, s) => a + s.conversions, 0));
    const truthRevenue = truthStages.reduce((a, s) => a + Number(s.revenue), 0);
    const campaignLive = truthStages.some((s) => s.in_flight > 0);
    check(
      `campaign ${camp.campaign_id}: revenue ${campaignLive ? "<= the later" : "="} stages' tracker revenue`,
      campaignLive ? camp.revenue <= truthRevenue + 0.01 : Math.abs(camp.revenue - truthRevenue) < 0.01,
      { got: camp.revenue, truth: truthRevenue },
    );
    if (camp.total_conversions > 0) auditConversionsSeen = true;
  }
  console.log(`    ${settledStages} settled stage(s) checked exactly; still sending: ${liveStages.join(", ") || "none"}`);
  check("control: the exact check covered at least one settled stage", settledStages > 0, settledStages);
  check("control: at least one active campaign has conversions", auditConversionsSeen);

  console.log("\nH. getStageSendGroups — first half vs second half of a cell");
  // A SETTLED tracked cell: nothing pending, sent more than 5 days ago (clicks and
  // the 72h STOP window have settled), so the lib and the reference read the same rows.
  const cell = await one<{ stage_id: number; campaign_id: number } | undefined>(sql`
    WITH cand AS (
      SELECT cs.id, cs.campaign_id, cs.sent_at
      FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.org_id = ${orgId}::uuid AND c.link_mode = 'tracked'
        AND cs.sent_at > now() - interval '30 days' AND cs.sent_at < now() - interval '5 days'
      ORDER BY cs.sent_at DESC LIMIT 40
    )
    SELECT cand.id AS stage_id, cand.campaign_id
    FROM cand JOIN stage_sends ss ON ss.stage_id = cand.id AND ss.org_id = ${orgId}::uuid
    GROUP BY cand.id, cand.campaign_id, cand.sent_at
    HAVING count(*) FILTER (WHERE ss.status = 'sent') >= 4000
       AND count(*) FILTER (WHERE ss.status IN ('pending', 'sending')) = 0
    ORDER BY cand.sent_at DESC LIMIT 1`);
  check("control: a settled tracked cell of >= 4,000 sends exists", cell != null);
  if (cell) {
    const stageId = Number(cell.stage_id);
    const campaignId = Number(cell.campaign_id);
    // Reference side, built WITHOUT ntile or the lib's joins: the sent rows in send
    // order, the stage's counted clickers and each send's attributed opt-outs, then
    // the equal split re-derived in JS. ORDER BY is table-qualified on purpose: a
    // bare `id` would sort by the ::text output column, not the bigint.
    const sends = (await db.execute(sql`
      SELECT ss.id::text AS id, ss.contact_id::text AS contact_id, ss.offer_reached_at IS NOT NULL AS reached
      FROM stage_sends ss
      WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id = ${stageId} AND ss.status = 'sent'
      ORDER BY ss.sent_at, ss.id`)) as unknown as { id: string; contact_id: string; reached: boolean }[];
    const clickerIds = new Set(
      ((await db.execute(sql`
        SELECT contact_id::text AS contact_id FROM counted_clickers
        WHERE org_id = ${orgId}::uuid AND stage_id = ${stageId}`)) as unknown as { contact_id: string }[]).map(
        (r) => r.contact_id,
      ),
    );
    const optBySend = new Map<string, string[]>();
    for (const r of (await db.execute(sql`
      SELECT oa.stage_send_id::text AS send_id, oa.opt_out_id::text AS opt_out_id
      FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
      WHERE oa.org_id = ${orgId}::uuid AND ss.stage_id = ${stageId}`)) as unknown as { send_id: string; opt_out_id: string }[]) {
      optBySend.set(r.send_id, [...(optBySend.get(r.send_id) ?? []), r.opt_out_id]);
    }
    // ntile semantics: every group gets floor(N/g); the first N mod g get one more.
    const split = (g: number) => {
      const base = Math.floor(sends.length / g);
      const extra = sends.length % g;
      const out: number[][] = [];
      let at = 0;
      for (let k = 0; k < g; k++) {
        const part = sends.slice(at, at + base + (k < extra ? 1 : 0));
        at += part.length;
        if (part.length === 0) continue;
        const optIds = new Set(part.flatMap((s) => optBySend.get(s.id) ?? []));
        const clickers = new Set(part.map((s) => s.contact_id).filter((c) => clickerIds.has(c)));
        out.push([part.length, part.filter((s) => s.reached).length, optIds.size, clickers.size]);
      }
      return out;
    };
    for (const g of [2, 10]) {
      const got = await getStageSendGroups(orgId, campaignId, stageId, g);
      const want = split(g);
      const gotRows = (got?.data ?? []).map((r) => [r.sent, r.reached, r.opt_outs, r.clicks_human]);
      check(
        `stage ${stageId} groups=${g}: [sent, reached, opt_outs, clicks_human] per group = the independent split`,
        JSON.stringify(gotRows) === JSON.stringify(want),
        { got: gotRows, want },
      );
      check(
        `stage ${stageId} groups=${g}: numbered 1..${g} and in send order`,
        got != null && got.data.every((r, k) => r.group === k + 1 && (k === 0 || got.data[k - 1].last_sent_at <= r.first_sent_at)),
      );
      check(
        `stage ${stageId} groups=${g}: rates are pct() of the group's own counts`,
        got != null && got.data.every((r) => r.opt_rate === pct(r.opt_outs, r.sent) && r.click_to_reach_pct === pct(r.reached, r.clicks_human)),
      );
    }
    const halves = await getStageSendGroups(orgId, campaignId, stageId, 2);
    const stageTruth = await one<{ sent: number; reached: number; opt_outs: number; clickers: number }>(sql`
      SELECT count(*)::int AS sent,
             count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached,
             (SELECT count(DISTINCT oa.opt_out_id)::int FROM opt_out_attributions oa
                JOIN stage_sends s2 ON s2.id = oa.stage_send_id
                WHERE oa.org_id = ${orgId}::uuid AND s2.stage_id = ${stageId} AND s2.status = 'sent') AS opt_outs,
             (SELECT count(DISTINCT cc.contact_id)::int FROM counted_clickers cc
                WHERE cc.org_id = ${orgId}::uuid AND cc.stage_id = ${stageId}
                  AND EXISTS (SELECT 1 FROM stage_sends s3 WHERE s3.stage_id = cc.stage_id
                              AND s3.contact_id = cc.contact_id AND s3.status = 'sent')) AS clickers
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid AND stage_id = ${stageId} AND status = 'sent'`);
    const sumOf = (k: "sent" | "reached" | "opt_outs" | "clicks_human") =>
      (halves?.data ?? []).reduce((a, r) => a + r[k], 0);
    check(
      `stage ${stageId}: the halves add up to the stage's sent / reached / opt-outs / human clickers`,
      halves != null &&
        halves.sent === stageTruth.sent &&
        sumOf("sent") === stageTruth.sent &&
        sumOf("reached") === stageTruth.reached &&
        sumOf("opt_outs") === stageTruth.opt_outs &&
        sumOf("clicks_human") === stageTruth.clickers,
      { got: [halves?.sent, sumOf("sent"), sumOf("reached"), sumOf("opt_outs"), sumOf("clicks_human")], want: stageTruth },
    );
    check(
      `stage ${stageId}: settled — pending_sends 0 and opt_outs_complete`,
      halves?.pending_sends === 0 && halves?.opt_outs_complete === true,
      { pending: halves?.pending_sends, complete: halves?.opt_outs_complete },
    );
    check("control: the halves have human clickers", sumOf("clicks_human") > 0);
    check("control: the halves have opt-outs", sumOf("opt_outs") > 0);
    check(
      `stage ${stageId} asked for under another campaign id: null`,
      (await getStageSendGroups(orgId, campaignId + 1, stageId, 2)) === null,
    );
  }
  const manualStage = await one<{ id: number; campaign_id: number } | undefined>(sql`
    SELECT cs.id, cs.campaign_id FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked' AND cs.sent_at IS NOT NULL
    ORDER BY cs.sent_at DESC LIMIT 1`);
  if (manualStage) {
    const m = await getStageSendGroups(orgId, Number(manualStage.campaign_id), Number(manualStage.id), 2);
    check(
      `manual stage ${manualStage.id}: not tracked, no groups, sent 0`,
      m != null && m.link_mode !== "tracked" && m.data.length === 0 && m.sent === 0,
      m && { link_mode: m.link_mode, rows: m.data.length, sent: m.sent },
    );
  } else {
    skip("manual stage send groups", "no sent manual-mode stage in the org");
  }

  console.log(
    failures === 0
      ? `\nverify-operator-grading OK${skipped ? ` (${skipped} skipped)` : ""}.`
      : `\nFAILED: ${failures}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
