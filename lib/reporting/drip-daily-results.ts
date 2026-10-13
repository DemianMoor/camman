import { sql } from "drizzle-orm";

import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { TIER_LABEL, type FollowupTier } from "@/lib/drip/followup-timing";
import { addEtDays } from "@/lib/reporting/delivery-rollup";
import { dailyMoney } from "@/lib/reporting/drip-daily-money";
import {
  type Basis,
  type DbOrTx,
  DRIP_DAILY_ROLLUP_JOB,
  DRIP_DAILY_ROLLUP_SETTLE_JOB,
  FRESH_DAYS,
  histogramMedian,
  sumHistograms,
} from "@/lib/reporting/drip-daily-rollup";

// The drip campaign "Daily results" tab's read layer (spec
// docs/superpowers/specs/2026-10-12-drip-daily-results-design.md, PR 4).
//
// ⭐ READS ONLY drip_daily_rollup (+ stage / partner names, change events and two
// heartbeats). Never stage_sends: that is the whole point of the rollup. Every
// ratio and money column is computed HERE from SUMMED cells — a day row, a
// breakdown row and the totals row go through the same rowFrom(), never an
// average of ratios.
//
// No auth and no Next imports, so scripts can call it (the API route wraps it).

export type Breakdown = "none" | "stage" | "partner";

export interface Sums {
  leads_admitted: number;
  admitted: number;
  admitted_carried: number;
  first_sends: number;
  followup_sends: number;
  dlr_sent: number;
  delivered: number;
  clicks: number;
  opt_outs: number;
  sales: number;
  revenue: number;
  send_cost: number;
  hist: number[];
}

export interface ResultRow {
  /** null on a stage row: admissions have no stage. */
  leads_admitted: number | null;
  admitted: number | null;
  admitted_same_day: number | null;
  admitted_carried: number | null;
  first_sends: number;
  followup_sends: number;
  sends: number;
  /** delivered ÷ sends on DLR-capable providers; null when there were none. */
  delivered_pct: number | null;
  clicks: number;
  /** clicks per send; null over 0 sends. */
  ctr: number | null;
  opt_outs: number;
  opt_out_pct: number | null;
  sales: number;
  /** sales ÷ clicks; null over 0 clicks. */
  conv_pct: number | null;
  send_cost: number;
  /** null where admissions cannot be attributed (stage rows). */
  lookup_cost: number | null;
  revenue: number;
  profit: number;
  roi: number | null;
  /** Cohort only: Σ revenue ÷ Σ admitted. */
  revenue_per_admitted: number | null;
  median_latency_sec: number | null;
}

export interface GroupRow {
  key: string;
  label: string;
  /** 1 = a lane nested under its parent stage. */
  depth: 0 | 1;
  row: ResultRow;
}

export interface Marker {
  at: string;
  kind: "settings" | "stage" | "status" | "pause";
  text: string;
}

export interface DayResult {
  day: string;
  row: ResultRow;
  groups: GroupRow[];
  markers: Marker[];
  /** Cohort only: still taking late sales / follow-ups. */
  maturing: boolean;
}

export interface DripDailyResults {
  campaign: { id: number; name: string; first_day: string | null };
  basis: Basis;
  breakdown: Breakdown;
  from: string;
  to: string;
  totals: ResultRow;
  totals_groups: GroupRow[];
  days: DayResult[];
  lookup_rate: { rate: number; source: string };
  /** Cohort rows younger than this many ET days are "maturing". */
  maturity_days: number;
  freshness: { fresh_as_of: string | null; settled_as_of: string | null; fresh_days: number };
}

const zero = (): Sums => ({
  leads_admitted: 0, admitted: 0, admitted_carried: 0, first_sends: 0, followup_sends: 0, dlr_sent: 0,
  delivered: 0, clicks: 0, opt_outs: 0, sales: 0, revenue: 0, send_cost: 0, hist: [],
});

function add(into: Sums, c: Record<string, unknown>): void {
  into.leads_admitted += Number(c.leads_admitted);
  into.admitted += Number(c.admitted);
  into.admitted_carried += Number(c.admitted_carried);
  into.first_sends += Number(c.first_sends);
  into.followup_sends += Number(c.followup_sends);
  into.dlr_sent += Number(c.dlr_sent);
  into.delivered += Number(c.delivered);
  into.clicks += Number(c.clicks);
  into.opt_outs += Number(c.opt_outs);
  into.sales += Number(c.sales);
  into.revenue += Number(c.revenue);
  into.send_cost += Number(c.send_cost);
  if (c.latency_hist) into.hist = sumHistograms([into.hist.length ? into.hist : null, c.latency_hist as number[]]);
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

/**
 * One row from summed cells. `lookupRate` null = admissions are not attributable
 * to this row (a stage), so it carries no lookup cost and its profit/ROI are
 * before lookup — the campaign total row carries it.
 */
export function rowFrom(s: Sums, lookupRate: number | null, basis: Basis): ResultRow {
  const m = dailyMoney({ revenue: s.revenue, send_cost: s.send_cost, admitted: s.admitted }, lookupRate ?? 0);
  const sends = s.first_sends + s.followup_sends;
  // A stage row (lookupRate null) has no admissions to show — "—", not 0.
  const leads = lookupRate != null;
  return {
    leads_admitted: leads ? s.leads_admitted : null,
    admitted: leads ? s.admitted : null,
    admitted_same_day: leads ? s.admitted - s.admitted_carried : null,
    admitted_carried: leads ? s.admitted_carried : null,
    first_sends: s.first_sends,
    followup_sends: s.followup_sends,
    sends,
    delivered_pct: ratio(s.delivered, s.dlr_sent),
    clicks: s.clicks,
    ctr: ratio(s.clicks, sends),
    opt_outs: s.opt_outs,
    opt_out_pct: ratio(s.opt_outs, sends),
    sales: s.sales,
    conv_pct: ratio(s.sales, s.clicks),
    send_cost: s.send_cost,
    lookup_cost: lookupRate == null ? null : m.lookup_cost_usd,
    revenue: s.revenue,
    profit: m.profit_usd,
    roi: m.roi,
    revenue_per_admitted: basis === "cohort" && leads ? m.revenue_per_admitted_usd : null,
    median_latency_sec: histogramMedian(s.hist),
  };
}

/** Inclusive list of ET days, newest first. */
function daysDesc(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = to; d >= from; d = addEtDays(d, -1)) out.push(d);
  return out;
}

export async function getDripDailyResults(
  dbc: DbOrTx,
  input: {
    orgId: string;
    campaignId: number;
    basis: Basis;
    from: string;
    to: string;
    breakdown: Breakdown;
    lookupRate: { rate: number; source: string };
    now?: Date;
  },
): Promise<DripDailyResults | null> {
  const { orgId, campaignId, basis, breakdown, lookupRate } = input;
  const now = input.now ?? new Date();
  const today = formatInCampaignTimezone(now, "yyyy-MM-dd");

  const camp = (await dbc.execute(sql`
    SELECT c.id, c.name,
           (SELECT min(day_et)::text FROM drip_daily_rollup r WHERE r.campaign_id = c.id) AS first_day,
           (SELECT COALESCE(max(drip_followup_minutes), 0)::int FROM campaign_stages s
             WHERE s.campaign_id = c.id AND s.archived_at IS NULL) AS max_followup_min
    FROM campaigns c
    WHERE c.id = ${campaignId} AND c.org_id = ${orgId}::uuid AND c.type = 'drip'`)) as unknown as {
    id: number; name: string; first_day: string | null; max_followup_min: number;
  }[];
  if (!camp[0]) return null;
  // Clamp to the campaign's life: "since launch" asks from far back, and a day
  // before the first cell is an empty row, not information.
  const firstDay = camp[0].first_day;
  const to = input.to;
  const from = firstDay == null ? to : input.from < firstDay ? (firstDay > to ? to : firstDay) : input.from;
  // A cohort is still maturing until its follow-ups can have gone out (the
  // longest configured follow-up delay, rounded up to days) plus 3 days of
  // outcome tail (conversions p99 57 h, max 68 h; opt-out window 72 h — 2026-10-12).
  const maturityDays = Math.ceil(camp[0].max_followup_min / 1440) + 3;

  const [cells, stages, partners, events, beats] = await Promise.all([
    dbc.execute(sql`
      SELECT day_et::text AS day, stage_id, partner_key_id, leads_admitted, admitted, admitted_carried,
             first_sends, followup_sends, dlr_sent, delivered, clicks, opt_outs, sales,
             revenue::float8 AS revenue, send_cost::float8 AS send_cost, latency_hist
      FROM drip_daily_rollup
      WHERE org_id = ${orgId}::uuid AND campaign_id = ${campaignId} AND basis = ${basis}
        AND day_et BETWEEN ${from}::date AND ${to}::date`) as unknown as Promise<Record<string, unknown>[]>,
    dbc.execute(sql`
      SELECT id, stage_number, label, parent_stage_id, behavioral_tier
      FROM campaign_stages WHERE campaign_id = ${campaignId} AND org_id = ${orgId}::uuid`) as unknown as Promise<
      { id: number; stage_number: number | null; label: string | null; parent_stage_id: number | null; behavioral_tier: number | null }[]
    >,
    dbc.execute(sql`
      SELECT k.id AS key_id, COALESCE(p.id, -k.id) AS partner_id, COALESCE(p.name, k.name) AS name
      FROM partner_keys k LEFT JOIN partners p ON p.id = k.partner_id
      WHERE k.org_id = ${orgId}::uuid`) as unknown as Promise<{ key_id: number; partner_id: number; name: string }[]>,
    dbc.execute(sql`
      SELECT created_at, event_type AS kind, summary AS text FROM campaign_events
      WHERE campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
        AND event_type IN ('drip_config_changed', 'drip_stage_changed', 'campaign_status_changed')
        AND created_at >= (${from}::date::timestamp AT TIME ZONE ${CAMPAIGN_TIMEZONE})
        AND created_at <  (${addEtDays(to, 1)}::date::timestamp AT TIME ZONE ${CAMPAIGN_TIMEZONE})
      UNION ALL
      SELECT created_at, 'pause', (CASE WHEN event = 'resumed' THEN 'Sending resumed' ELSE 'Sending paused' END)
             || COALESCE(' — ' || reason, '')
      FROM campaign_circuit_events
      WHERE campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
        AND created_at >= (${from}::date::timestamp AT TIME ZONE ${CAMPAIGN_TIMEZONE})
        AND created_at <  (${addEtDays(to, 1)}::date::timestamp AT TIME ZONE ${CAMPAIGN_TIMEZONE})
      ORDER BY 1`) as unknown as Promise<{ created_at: string; kind: string; text: string }[]>,
    dbc.execute(sql`
      SELECT job_name, watermark::text AS w FROM cron_locks
      WHERE job_name IN (${DRIP_DAILY_ROLLUP_JOB}, ${DRIP_DAILY_ROLLUP_SETTLE_JOB})`) as unknown as Promise<
      { job_name: string; w: string | null }[]
    >,
  ]);

  // ── group keys ────────────────────────────────────────────────────────────
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const keyToPartner = new Map(partners.map((p) => [p.key_id, p]));
  const stageLabel = (s: (typeof stages)[number]) =>
    s.parent_stage_id != null
      ? `${TIER_LABEL[(s.behavioral_tier ?? 0) as FollowupTier] ?? `Tier ${s.behavioral_tier}`} lane`
      : `Stage ${s.stage_number ?? "?"}${s.label ? ` · ${s.label}` : ""}`;
  // A stable order: parent stages by number, each followed by its lanes by tier.
  const stageOrder = (id: number): string => {
    const s = stageById.get(id);
    if (!s) return `9999-${id}`;
    const parent = s.parent_stage_id != null ? stageById.get(s.parent_stage_id) : s;
    const p = String(parent?.stage_number ?? 999).padStart(4, "0");
    return s.parent_stage_id != null ? `${p}-1-${s.behavioral_tier ?? 9}` : `${p}-0`;
  };
  function groupOf(c: Record<string, unknown>): { key: string; label: string; depth: 0 | 1; order: string } | null {
    if (breakdown === "stage") {
      if (c.stage_id == null) return null; // the lead row: campaign-level only
      const id = Number(c.stage_id);
      const s = stageById.get(id);
      return {
        key: `s${id}`,
        label: s ? stageLabel(s) : `Stage #${id}`,
        depth: s?.parent_stage_id != null ? 1 : 0,
        order: stageOrder(id),
      };
    }
    if (breakdown === "partner") {
      if (c.partner_key_id == null) return { key: "unattributed", label: "Unattributed", depth: 0, order: "zzz" };
      const p = keyToPartner.get(Number(c.partner_key_id));
      return { key: `p${p?.partner_id ?? c.partner_key_id}`, label: p?.name ?? `Key #${c.partner_key_id}`, depth: 0, order: p?.name ?? "" };
    }
    return null;
  }
  // Lookup cost is attributable wherever admissions are: the campaign total and
  // partner rows — never a stage (owner: "Lookup cost on the campaign total row").
  const groupLookup = breakdown === "partner" ? lookupRate.rate : null;

  // ── sum ─────────────────────────────────────────────────────────────────────
  const total = zero();
  const totalGroups = new Map<string, { meta: NonNullable<ReturnType<typeof groupOf>>; s: Sums }>();
  const perDay = new Map<string, { s: Sums; groups: Map<string, { meta: NonNullable<ReturnType<typeof groupOf>>; s: Sums }> }>();
  for (const c of cells) {
    const day = String(c.day);
    const d = perDay.get(day) ?? { s: zero(), groups: new Map() };
    perDay.set(day, d);
    add(d.s, c);
    add(total, c);
    const g = groupOf(c);
    if (g) {
      const dg = d.groups.get(g.key) ?? { meta: g, s: zero() };
      d.groups.set(g.key, dg);
      add(dg.s, c);
      const tg = totalGroups.get(g.key) ?? { meta: g, s: zero() };
      totalGroups.set(g.key, tg);
      add(tg.s, c);
    }
  }
  const toGroups = (m: Map<string, { meta: NonNullable<ReturnType<typeof groupOf>>; s: Sums }>): GroupRow[] =>
    [...m.values()]
      .sort((a, b) => a.meta.order.localeCompare(b.meta.order))
      .map(({ meta, s }) => ({ key: meta.key, label: meta.label, depth: meta.depth, row: rowFrom(s, groupLookup, basis) }));

  const markersByDay = new Map<string, Marker[]>();
  for (const e of events) {
    const at = new Date(e.created_at);
    const day = formatInCampaignTimezone(at, "yyyy-MM-dd");
    const kind: Marker["kind"] =
      e.kind === "drip_config_changed" ? "settings" : e.kind === "drip_stage_changed" ? "stage" : e.kind === "pause" ? "pause" : "status";
    const list = markersByDay.get(day) ?? [];
    list.push({ at: at.toISOString(), kind, text: e.text });
    markersByDay.set(day, list);
  }

  const days: DayResult[] = daysDesc(from, to).map((day) => {
    const d = perDay.get(day);
    return {
      day,
      row: rowFrom(d?.s ?? zero(), lookupRate.rate, basis),
      groups: d ? toGroups(d.groups) : [],
      markers: markersByDay.get(day) ?? [],
      maturing: basis === "cohort" && addEtDays(day, maturityDays) > today,
    };
  });

  const beat = (j: string) => beats.find((b) => b.job_name === j)?.w ?? null;
  return {
    campaign: { id: camp[0].id, name: camp[0].name, first_day: camp[0].first_day },
    basis,
    breakdown,
    from,
    to,
    totals: rowFrom(total, lookupRate.rate, basis),
    totals_groups: toGroups(totalGroups),
    days,
    lookup_rate: lookupRate,
    maturity_days: maturityDays,
    freshness: {
      fresh_as_of: beat(DRIP_DAILY_ROLLUP_JOB),
      settled_as_of: beat(DRIP_DAILY_ROLLUP_SETTLE_JOB),
      fresh_days: FRESH_DAYS,
    },
  };
}
