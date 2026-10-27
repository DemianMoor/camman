import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { lifetimeManualSalesByStage } from "@/lib/reporting/attribution";
import { etDayBounds, sentCountsByStage } from "@/lib/reporting/delivery-rollup";
import { dripCostByStageInRange } from "@/lib/reporting/stage-funnel";
import { hasNoKeitaroVisits, stageIsMatureForGap } from "@/lib/reporting/tracking-gap-rules";
import { approvedRevenueClause, purchasedClause } from "@/lib/sale-attribution";

// /reports/landing-pages — results per landing page for ONE offer, on a
// SEND-DATE basis (docs/04-features/landing-page-report.md).
//
// Two passes, because the two campaign types disagree about what a stage is:
//
// - REGULAR stages are dated by their send day and read at STAGE grain. A
//   regular stage sends in minutes (8 of 2,927 span two ET days; 0.08% of sends
//   fall off the stage's day), and every one of its sent rows was minted to ONE
//   page (recon 2026-10-23: 0 disagreements between config and minted slug).
//   Sends come from stage_delivery_rollup by send day; everything else the stage
//   produced (cost, opt-outs, sales, clicks, reach) belongs to it whole.
// - DRIP stages are read PER SEND: a drip stage sends for weeks and its page can
//   be switched mid-flight (stage 5064: 8,927 sends to `mdc`, then 22,492 to
//   `mdc2`), so the page is read from each send's minted link.
//
// The landing-page key is the slug AS MINTED on a sent row, falling back to the
// stage's configured page, then (manual mode, which mints nothing) the declared
// full_url. A destination that is not `/<landing_path>/<slug>` keys by its HOST.

export type LpKey =
  | { kind: "slug"; value: string }
  | { kind: "host"; value: string };

export interface LpSourceStage {
  stage_id: number;
  type: "regular" | "drip";
  link_mode: string;
}

/** Raw per-row figures. Ratios are derived on the client (components/reports/report-metrics.tsx `derive`). */
export interface LandingPageRow {
  key: string;
  kind: LpKey["kind"];
  /** The slug (kind=slug) or the host (kind=host). */
  value: string;
  /** offer_landing_pages.title matched on (offer_id, slug); null for host rows and unregistered slugs. */
  title: string | null;
  in_registry: boolean;
  brand_id: number | null;
  brand_name: string | null;
  sends: number;
  cost: number;
  revenue: number;
  sales: number;
  /** Counted clickers (human or Rule F), COUNT(DISTINCT contact) at this row, plus manual stages' visits. */
  clicks: number;
  /** Of `clicks`, the summed Keitaro visits of manual-mode stages (not deduplicated). */
  manual_visits: number;
  optouts: number;
  /** Sales % (of reached) inputs — Keitaro-covered tracked stages only. */
  reached: number;
  reach_sales: number;
  reach_covered_stages: number;
  /** CTR denominator: counted clickers (deduplicated like `clicks`) on the Keitaro-covered tracked stages only. */
  reach_clicks: number;
  /** CTR numerator: of `reach_clicks`, those who also reached the offer page on a send in this row. */
  redirected_visitors: number;
  stages: { regular: number; drip: number; manual: number; gap: number };
  /** Stages in this row with total_cost = 0 and at least one send in range. */
  zero_cost_stages_with_sends: number;
  /** What the row is built from (regular: stages dated in range; drip: stage × minted URL) — for the verify script's independent recount. */
  sources: { stage_ids: number[]; drip: { stage_id: number; url: string | null }[] };
}

export type LandingPageTotal = Omit<
  LandingPageRow,
  "key" | "kind" | "value" | "title" | "in_registry" | "brand_id" | "brand_name" | "sources"
>;

export interface LandingPageReport {
  offer: { id: number; name: string; created_at: string };
  range: { from: string; to: string; all_time: boolean };
  split_by_brand: boolean;
  rows: LandingPageRow[];
  /** Clicks are offer-distinct here, so they do not foot to the rows; every other figure does. */
  total: LandingPageTotal;
  subtotals: Record<"regular" | "drip", { sends: number; cost: number; sales: number; revenue: number }>;
  /** Drip conversions with no stage_send_id cannot be placed on a page; counted here, not dropped silently. */
  unattributed_drip_conversions: number;
  duration_ms: number;
}

/** Parse a destination URL into the report key. `paths` = the org's landing path segments ('lp' plus each brand's landing_path). */
export function lpKeyFromUrl(url: string | null, paths: readonly string[]): LpKey | null {
  if (!url) return null;
  const m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(url.trim());
  if (!m) return null;
  const host = m[1].toLowerCase();
  const segs = (m[2] ?? "").split("/").filter(Boolean);
  if (segs.length >= 2 && paths.includes(segs[0])) return { kind: "slug", value: segs[1] };
  return { kind: "host", value: host };
}

const idArray = (ids: number[]): SQL =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;

type StageRow = {
  stage_id: number;
  type: "regular" | "drip";
  link_mode: string;
  brand_id: number | null;
  brand_name: string | null;
  sent_at: Date | null;
  total_cost: number;
  sms_count: number;
  cfg_slug: string | null;
  cfg_url: string | null;
  minted_url: string | null;
  visits_raw: number;
  visits_clean: number;
};

function emptyRow(): Omit<LandingPageRow, "key" | "kind" | "value" | "title" | "in_registry" | "brand_id" | "brand_name"> {
  return {
    sends: 0, cost: 0, revenue: 0, sales: 0, clicks: 0, manual_visits: 0, optouts: 0,
    reached: 0, reach_sales: 0, reach_covered_stages: 0, reach_clicks: 0, redirected_visitors: 0,
    stages: { regular: 0, drip: 0, manual: 0, gap: 0 },
    zero_cost_stages_with_sends: 0,
    sources: { stage_ids: [], drip: [] },
  };
}

export async function offersWithSends(orgId: string) {
  return (await db.execute(sql`
    SELECT o.id, o.name, o.status, o.created_at
    FROM offers o
    WHERE o.org_id = ${orgId}::uuid
      AND EXISTS (
        SELECT 1 FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE c.org_id = o.org_id AND c.offer_id = o.id AND cs.sent_at IS NOT NULL
      )
    ORDER BY o.name
  `)) as unknown as { id: number; name: string; status: string; created_at: string }[];
}

export async function getLandingPageReport(args: {
  orgId: string;
  offerId: number;
  /** Inclusive ET days; null = All Time (offer created_at → today). */
  from: string | null;
  to: string | null;
  splitByBrand: boolean;
  now?: Date;
}): Promise<LandingPageReport | null> {
  const t0 = Date.now();
  const now = args.now ?? new Date();
  const { orgId, offerId } = args;

  const [offer] = (await db.execute(sql`
    SELECT id, name, created_at FROM offers WHERE id = ${offerId} AND org_id = ${orgId}::uuid
  `)) as unknown as { id: number; name: string; created_at: string }[];
  if (!offer) return null;

  const allTime = args.from == null && args.to == null;
  const todayEt = formatInCampaignTimezone(now, "yyyy-MM-dd");
  const from = args.from ?? formatInCampaignTimezone(offer.created_at, "yyyy-MM-dd");
  const to = args.to ?? todayEt;
  const { fromUtc, toExclusiveUtc } = etDayBounds({ from, to });

  const pathRows = (await db.execute(sql`
    SELECT DISTINCT landing_path FROM brands
    WHERE org_id = ${orgId}::uuid AND landing_host IS NOT NULL AND landing_path IS NOT NULL
  `)) as unknown as { landing_path: string }[];
  const paths = ["lp", ...pathRows.map((r) => r.landing_path)];

  const pages = (await db.execute(sql`
    SELECT slug, title FROM offer_landing_pages
    WHERE org_id = ${orgId}::uuid AND offer_id = ${offerId} AND kind = 'slug'
  `)) as unknown as { slug: string; title: string }[];
  const titleBySlug = new Map(pages.map((p) => [p.slug, p.title]));

  // Every sent stage of the offer — ARCHIVED ONES INCLUDED: archiving does not
  // unsend, and the Overview already counts an archived stage's sends and
  // revenue (via its tracker rows). Only 4 such stages exist (all drip, offer
  // 152, 44,881 sends — 2026-10-23); excluding them hid half that offer. The configured destination is
  // the page's slug, else its external URL or the stage's stored full_url. `minted_url` is ONE sent row's minted destination, for
  // regular tracked stages only (drip is read per send below).
  const stages = (await db.execute(sql`
    SELECT cs.id AS stage_id, c.type, c.link_mode, c.brand_id, b.name AS brand_name,
           cs.sent_at, COALESCE(cs.total_cost, 0)::float8 AS total_cost, COALESCE(cs.sms_count, 0) AS sms_count,
           CASE WHEN p.kind = 'slug' THEN p.slug END AS cfg_slug,
           CASE WHEN p.kind = 'external_url' THEN p.external_url ELSE cs.full_url END AS cfg_url,
           CASE WHEN c.type = 'regular' AND c.link_mode = 'tracked' THEN (
             SELECT d.url FROM stage_sends ss
             JOIN links l ON l.id = ss.link_id
             JOIN link_destinations d ON d.id = l.destination_id
             WHERE ss.stage_id = cs.id AND ss.status = 'sent'
             LIMIT 1) END AS minted_url,
           COALESCE(k.vr, 0)::int AS visits_raw, COALESCE(k.vc, 0)::int AS visits_clean
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN offer_landing_pages p ON p.id = cs.landing_page_id
    LEFT JOIN (
      SELECT stage_id, sum(visit_clicks_raw) AS vr, sum(visit_clicks_clean) AS vc
      FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid GROUP BY 1
    ) k ON k.stage_id = cs.id
    WHERE c.org_id = ${orgId}::uuid AND c.offer_id = ${offerId}
      AND cs.sent_at IS NOT NULL
  `)) as unknown as StageRow[];

  const inRange = (d: Date | null) => d != null && new Date(d) >= fromUtc && new Date(d) < toExclusiveUtc;
  const regular = stages.filter((s) => s.type !== "drip");
  const drip = stages.filter((s) => s.type === "drip");
  // A regular stage belongs to the window by its send day (the Overview's rule
  // for cost); its sends are counted per send day from the rollup.
  const cohort = regular.filter((s) => inRange(s.sent_at));
  const cohortIds = cohort.map((s) => s.stage_id);
  const trackedRegularIds = regular.filter((s) => s.link_mode === "tracked").map((s) => s.stage_id);
  const dripIds = drip.map((s) => s.stage_id);
  const cfgKey = (s: StageRow): LpKey | null =>
    s.cfg_slug ? { kind: "slug", value: s.cfg_slug } : lpKeyFromUrl(s.cfg_url, paths);
  const isGap = (s: StageRow) =>
    s.link_mode === "tracked" && stageIsMatureForGap(s.sent_at, now) && hasNoKeitaroVisits(s.visits_raw, s.visits_clean);

  const none = Promise.resolve([] as never[]);
  const [regularSent, manualSales, regOptOuts, regLedger, regReached, regClickers, dripSends, dripClickers, dripReached, dripCost, unattributed] =
    await Promise.all([
      sentCountsByStage(db, { orgId, stageIds: trackedRegularIds, fromEtDay: from, toEtDay: to, toExclusiveUtc }, now),
      lifetimeManualSalesByStage({ orgId, stageIds: cohortIds }),
      cohortIds.length
        ? (db.execute(sql`
            SELECT stage_id, count(*)::int AS n FROM opt_out_attributions
            WHERE org_id = ${orgId}::uuid AND stage_id = ANY(${idArray(cohortIds)}) GROUP BY 1
          `) as unknown as Promise<{ stage_id: number; n: number }[]>)
        : none,
      cohortIds.length
        ? (db.execute(sql`
            SELECT ce.stage_id,
                   count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS sales,
                   COALESCE(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0)::float8 AS revenue
            FROM conversion_events ce
            WHERE ce.org_id = ${orgId}::uuid AND ce.stage_id = ANY(${idArray(cohortIds)}) GROUP BY 1
          `) as unknown as Promise<{ stage_id: number; sales: number; revenue: number }[]>)
        : none,
      // Reach happens after the send, so a lower bound on offer_reached_at at
      // the window start keeps this on the partial offer_reached_at index
      // instead of walking every send of the offer.
      cohortIds.length
        ? (db.execute(sql`
            SELECT stage_id, contact_id FROM stage_sends
            WHERE offer_reached_at IS NOT NULL AND offer_reached_at >= ${fromUtc.toISOString()}::timestamptz
              AND org_id = ${orgId}::uuid AND status = 'sent' AND stage_id = ANY(${idArray(cohortIds)})
          `) as unknown as Promise<{ stage_id: number; contact_id: string }[]>)
        : none,
      cohortIds.length
        ? (db.execute(sql`
            SELECT stage_id, contact_id FROM counted_clickers
            WHERE org_id = ${orgId}::uuid AND stage_id = ANY(${idArray(cohortIds)})
          `) as unknown as Promise<{ stage_id: number; contact_id: string }[]>)
        : none,
      dripIds.length ? dripSendGroups(orgId, dripIds, fromUtc, toExclusiveUtc) : none,
      dripIds.length
        ? (db.execute(sql`
            SELECT DISTINCT ss.stage_id, d.url, cc.contact_id
            FROM stage_sends ss
            JOIN counted_clickers cc ON cc.stage_id = ss.stage_id AND cc.contact_id = ss.contact_id
            LEFT JOIN links l ON l.id = ss.link_id
            LEFT JOIN link_destinations d ON d.id = l.destination_id
            WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id = ANY(${idArray(dripIds)}) AND ss.status = 'sent'
              AND ss.sent_at >= ${fromUtc.toISOString()}::timestamptz AND ss.sent_at < ${toExclusiveUtc.toISOString()}::timestamptz
          `) as unknown as Promise<{ stage_id: number; url: string | null; contact_id: string }[]>)
        : none,
      dripIds.length
        ? (db.execute(sql`
            SELECT DISTINCT ss.stage_id, d.url, ss.contact_id
            FROM stage_sends ss
            LEFT JOIN links l ON l.id = ss.link_id
            LEFT JOIN link_destinations d ON d.id = l.destination_id
            WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id = ANY(${idArray(dripIds)}) AND ss.status = 'sent'
              AND ss.offer_reached_at IS NOT NULL
              AND ss.sent_at >= ${fromUtc.toISOString()}::timestamptz AND ss.sent_at < ${toExclusiveUtc.toISOString()}::timestamptz
          `) as unknown as Promise<{ stage_id: number; url: string | null; contact_id: string }[]>)
        : none,
      dripIds.length ? dripCostByStageInRange(orgId, fromUtc, toExclusiveUtc, { includeArchived: true }) : Promise.resolve(new Map<number, number>()),
      dripIds.length
        ? (db.execute(sql`
            SELECT count(*)::int AS n FROM conversion_events
            WHERE org_id = ${orgId}::uuid AND stage_id = ANY(${idArray(dripIds)}) AND stage_send_id IS NULL
              AND ${purchasedClause("conversion_events")}
          `) as unknown as Promise<{ n: number }[]>)
        : none,
    ]);

  const rowsByKey = new Map<string, LandingPageRow>();
  const clickSets = new Map<string, Set<string>>();
  const allClickers = new Set<string>();
  // The same clickers, restricted to reach-covered stages — CTR's denominator.
  const reachClickSets = new Map<string, Set<string>>();
  const allReachClickers = new Set<string>();

  function rowFor(key: LpKey | null, brandId: number | null, brandName: string | null): LandingPageRow {
    const k: LpKey = key ?? { kind: "host", value: "(no destination)" };
    const id = `${k.kind}:${k.value}${args.splitByBrand ? `:${brandId ?? "none"}` : ""}`;
    let r = rowsByKey.get(id);
    if (!r) {
      const title = k.kind === "slug" ? titleBySlug.get(k.value) ?? null : null;
      r = {
        key: id, kind: k.kind, value: k.value, title,
        in_registry: k.kind === "slug" && titleBySlug.has(k.value),
        brand_id: args.splitByBrand ? brandId : null,
        brand_name: args.splitByBrand ? brandName : null,
        ...emptyRow(),
      };
      rowsByKey.set(id, r);
      clickSets.set(id, new Set());
      reachClickSets.set(id, new Set());
    }
    return r;
  }

  // ---- regular pass (stage grain) ----
  const optOutBy = new Map(regOptOuts.map((r) => [Number(r.stage_id), Number(r.n)]));
  const ledgerBy = new Map(regLedger.map((r) => [Number(r.stage_id), r]));
  const reachedBy = new Map<number, number>();
  for (const r of regReached) reachedBy.set(Number(r.stage_id), (reachedBy.get(Number(r.stage_id)) ?? 0) + 1);
  // Contacts who reached the offer page, per row — intersected with the row's
  // visitors for CTR's numerator, so CTR is people ÷ people and never > 100%.
  const reachedSets = new Map<string, Set<string>>();
  const allReached = new Set<string>();
  const markReached = (key: string, contactId: string) => {
    const set = reachedSets.get(key) ?? new Set<string>();
    set.add(contactId);
    reachedSets.set(key, set);
    allReached.add(contactId);
  };
  const stageKey = new Map<number, string>();
  const reachCovered = new Set<number>();
  const subtotals = {
    regular: { sends: 0, cost: 0, sales: 0, revenue: 0 },
    drip: { sends: 0, cost: 0, sales: 0, revenue: 0 },
  };

  for (const s of regular) {
    const inCohort = inRange(s.sent_at);
    const sends = s.link_mode === "tracked" ? regularSent.get(s.stage_id) ?? 0 : inCohort ? s.sms_count : 0;
    if (!inCohort && sends === 0) continue;
    const key = lpKeyFromUrl(s.minted_url, paths) ?? cfgKey(s);
    const r = rowFor(key, s.brand_id, s.brand_name);
    r.sends += sends;
    subtotals.regular.sends += sends;
    if (!inCohort) continue; // sends on a day in range from a stage dated outside it (the 0.08% edge)
    stageKey.set(s.stage_id, r.key);
    r.sources.stage_ids.push(s.stage_id);
    if (s.link_mode === "manual") r.stages.manual += 1;
    else r.stages.regular += 1;
    const gap = isGap(s);
    if (gap) r.stages.gap += 1;
    r.cost += s.total_cost;
    if (s.total_cost === 0 && sends > 0) r.zero_cost_stages_with_sends += 1;
    const led = ledgerBy.get(s.stage_id);
    const ledSales = led ? Number(led.sales) : 0;
    // Manual tally tops the tracker up, never adds to it — combineSales' max().
    const sales = ledSales + Math.max(0, (manualSales.get(s.stage_id) ?? 0) - ledSales);
    r.sales += sales;
    r.revenue += led ? Number(led.revenue) : 0;
    r.optouts += optOutBy.get(s.stage_id) ?? 0;
    if (s.link_mode === "manual") {
      r.manual_visits += s.visits_clean;
    } else if (!gap) {
      r.reach_covered_stages += 1;
      reachCovered.add(s.stage_id);
      r.reached += reachedBy.get(s.stage_id) ?? 0;
      r.reach_sales += sales;
    }
    subtotals.regular.cost += s.total_cost;
    subtotals.regular.sales += sales;
    subtotals.regular.revenue += led ? Number(led.revenue) : 0;
  }
  for (const c of regClickers) {
    const k = stageKey.get(Number(c.stage_id));
    if (!k) continue;
    clickSets.get(k)!.add(c.contact_id);
    allClickers.add(c.contact_id);
    if (reachCovered.has(Number(c.stage_id))) {
      reachClickSets.get(k)!.add(c.contact_id);
      allReachClickers.add(c.contact_id);
    }
  }
  for (const c of regReached) {
    const k = stageKey.get(Number(c.stage_id));
    if (k && reachCovered.has(Number(c.stage_id))) markReached(k, c.contact_id);
  }

  // ---- drip pass (per send) ----
  const dripById = new Map(drip.map((s) => [s.stage_id, s]));
  const dripStageCost = new Map<number, { total: number; parts: { r: LandingPageRow; w: number }[] }>();
  const dripRowsTouched = new Map<number, Set<string>>();
  for (const g of dripSends) {
    const s = dripById.get(Number(g.stage_id))!;
    const r = rowFor(lpKeyFromUrl(g.url, paths) ?? cfgKey(s), s.brand_id, s.brand_name);
    r.sources.drip.push({ stage_id: s.stage_id, url: g.url });
    const touched = dripRowsTouched.get(s.stage_id) ?? new Set<string>();
    if (!touched.has(r.key)) {
      touched.add(r.key);
      r.stages.drip += 1;
      if (isGap(s)) r.stages.gap += 1;
      else r.reach_covered_stages += 1;
    }
    dripRowsTouched.set(s.stage_id, touched);
    r.sends += Number(g.sends);
    r.sales += Number(g.sales);
    r.revenue += Number(g.revenue);
    r.optouts += Number(g.optouts);
    if (!isGap(s)) {
      r.reached += Number(g.reached);
      r.reach_sales += Number(g.sales);
    }
    const c = dripStageCost.get(s.stage_id) ?? { total: dripCost.get(s.stage_id) ?? 0, parts: [] };
    c.parts.push({ r, w: Number(g.send_cost) });
    dripStageCost.set(s.stage_id, c);
    subtotals.drip.sends += Number(g.sends);
    subtotals.drip.sales += Number(g.sales);
    subtotals.drip.revenue += Number(g.revenue);
  }
  // Drip cost is dripCostByStageInRange's per-stage figure (the Overview's),
  // apportioned across a stage's pages by its sends' own cost — so a stage that
  // switched pages splits, and the stage total still foots.
  for (const [stageId, total] of dripCost) {
    if (!dripById.has(stageId)) continue;
    const c = dripStageCost.get(stageId);
    if (!c) {
      // Cost in range (an opt-out reply) with no send in range: book it on the
      // stage's configured page.
      const s = dripById.get(stageId)!;
      const r = rowFor(cfgKey(s), s.brand_id, s.brand_name);
      r.cost += total;
      subtotals.drip.cost += total;
      continue;
    }
    const w = c.parts.reduce((n, p) => n + p.w, 0);
    for (const p of c.parts) p.r.cost += w > 0 ? (total * p.w) / w : total / c.parts.length;
    subtotals.drip.cost += total;
  }
  for (const c of dripClickers) {
    const s = dripById.get(Number(c.stage_id))!;
    const r = rowFor(lpKeyFromUrl(c.url, paths) ?? cfgKey(s), s.brand_id, s.brand_name);
    clickSets.get(r.key)!.add(c.contact_id);
    allClickers.add(c.contact_id);
    if (!isGap(s)) {
      reachClickSets.get(r.key)!.add(c.contact_id);
      allReachClickers.add(c.contact_id);
    }
  }
  for (const c of dripReached) {
    const s = dripById.get(Number(c.stage_id))!;
    if (isGap(s)) continue;
    markReached(rowFor(lpKeyFromUrl(c.url, paths) ?? cfgKey(s), s.brand_id, s.brand_name).key, c.contact_id);
  }
  const countIn = (a: Set<string>, b: Set<string> | undefined) => {
    let n = 0;
    if (b) for (const x of a) if (b.has(x)) n++;
    return n;
  };

  const rows = [...rowsByKey.values()];
  for (const r of rows) {
    r.clicks = clickSets.get(r.key)!.size + r.manual_visits;
    r.reach_clicks = reachClickSets.get(r.key)!.size;
    r.redirected_visitors = countIn(reachClickSets.get(r.key)!, reachedSets.get(r.key));
  }
  rows.sort((a, b) => b.sends - a.sends || a.key.localeCompare(b.key));

  const sum = (f: (r: LandingPageRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const manualVisits = sum((r) => r.manual_visits);
  const total: LandingPageTotal = {
    sends: sum((r) => r.sends),
    cost: sum((r) => r.cost),
    revenue: sum((r) => r.revenue),
    sales: sum((r) => r.sales),
    // Offer-distinct: a contact who clicked two pages is one offer clicker.
    clicks: allClickers.size + manualVisits,
    manual_visits: manualVisits,
    optouts: sum((r) => r.optouts),
    reached: sum((r) => r.reached),
    reach_sales: sum((r) => r.reach_sales),
    reach_covered_stages: sum((r) => r.reach_covered_stages),
    // Offer-distinct, like clicks.
    reach_clicks: allReachClickers.size,
    redirected_visitors: countIn(allReachClickers, allReached),
    stages: {
      regular: sum((r) => r.stages.regular),
      drip: dripRowsTouched.size,
      manual: sum((r) => r.stages.manual),
      gap: sum((r) => r.stages.gap),
    },
    zero_cost_stages_with_sends: sum((r) => r.zero_cost_stages_with_sends),
  };

  return {
    offer: { id: Number(offer.id), name: offer.name, created_at: new Date(offer.created_at).toISOString() },
    range: { from, to, all_time: allTime },
    split_by_brand: args.splitByBrand,
    rows,
    total,
    subtotals,
    unattributed_drip_conversions: Number(unattributed[0]?.n ?? 0),
    duration_ms: Date.now() - t0,
  };
}

// Drip sends in the window, grouped by (stage, minted destination), with the
// send-keyed facts riding the same rows: reach, the send's own cost (the
// apportioning weight), and the conversions and opt-outs attributed to those
// exact sends. Materialized once so the three joins read it, not stage_sends.
async function dripSendGroups(orgId: string, dripIds: number[], fromUtc: Date, toExclusiveUtc: Date) {
  return (await db.execute(sql`
    WITH ds AS MATERIALIZED (
      SELECT ss.id, ss.stage_id, d.url, (ss.offer_reached_at IS NOT NULL) AS reached,
             COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0) AS cost
      FROM stage_sends ss
      LEFT JOIN links l ON l.id = ss.link_id
      LEFT JOIN link_destinations d ON d.id = l.destination_id
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id = ANY(${idArray(dripIds)}) AND ss.status = 'sent'
        AND ss.sent_at >= ${fromUtc.toISOString()}::timestamptz AND ss.sent_at < ${toExclusiveUtc.toISOString()}::timestamptz
    ),
    led AS (
      SELECT ds.stage_id, ds.url,
             count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS sales,
             COALESCE(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0) AS revenue
      FROM conversion_events ce JOIN ds ON ds.id = ce.stage_send_id
      WHERE ce.org_id = ${orgId}::uuid
      GROUP BY 1, 2
    ),
    oo AS (
      SELECT ds.stage_id, ds.url, count(*)::int AS n
      FROM opt_out_attributions oa JOIN ds ON ds.id = oa.stage_send_id
      WHERE oa.org_id = ${orgId}::uuid
      GROUP BY 1, 2
    ),
    s AS (
      SELECT stage_id, url, count(*)::int AS sends, count(*) FILTER (WHERE reached)::int AS reached, sum(cost) AS send_cost
      FROM ds GROUP BY 1, 2
    )
    SELECT s.stage_id, s.url, s.sends, s.reached, s.send_cost::float8 AS send_cost,
           COALESCE(led.sales, 0) AS sales, COALESCE(led.revenue, 0)::float8 AS revenue, COALESCE(oo.n, 0) AS optouts
    FROM s
    LEFT JOIN led ON led.stage_id = s.stage_id AND led.url IS NOT DISTINCT FROM s.url
    LEFT JOIN oo ON oo.stage_id = s.stage_id AND oo.url IS NOT DISTINCT FROM s.url
  `)) as unknown as {
    stage_id: number; url: string | null; sends: number; reached: number; send_cost: number;
    sales: number; revenue: number; optouts: number;
  }[];
}
