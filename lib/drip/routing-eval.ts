import { sql } from "drizzle-orm";

import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { admissionCloses, isCarried } from "./admission-window";
import { dripDailySendsPredicate, sendCapacity } from "./daily-sends";
import type { DbOrTx } from "./groups";
import { hourStartOf, inAnyWindow } from "./hourly-cap";
import { hourFullness, loadHourCounts, loadFirstSendWindows, type HourCounts } from "./hourly-room";
import { isTagRulesRefusal, type TagRules, type TagRulesRefusal } from "@/lib/messages/render";
import { TAGS, type RecipientData } from "@/lib/messages/tags";
import { loadCampaignTagRules } from "@/lib/sends/tag-rules";

// Drip routing eligibility (Drip Phase 4).
//
// ⭐ ONE EVALUATOR, TWO CALLERS. The routing worker and the "why not routed"
// debugging tool both call `evaluateLeadRouting`. That is deliberate and it is
// the whole value of the tool: a separate explain-path would be a SECOND
// implementation of the rules, and the first time the two drifted the tool would
// confidently explain a decision the router never made. An operator debugging a
// partner integration at 2am cannot afford a plausible lie.
//
// ⭐ EVERY RULE RETURNS A REASON, INCLUDING WHEN IT PASSES. The evaluator does
// not short-circuit on the first failure — it evaluates all of them and returns
// the full picture per candidate campaign. Short-circuiting is faster and would
// make the tool useless: "failed the tag check" tells you nothing about whether
// it would ALSO have failed three other rules once you fix the tag.
//
// ⭐ SKIP-IF-MISSING IS NOT THE SAME AS FAIL. Per the original spec, when a
// campaign sets a demographic filter and the lead has no value for it, the lead
// is SKIPPED for that campaign — not treated as non-matching-and-therefore-fine,
// and not treated as matching. The distinction shows up in the reason as
// `missing` rather than `mismatch`, because they need different fixes: one is a
// partner sending incomplete data, the other is correct targeting.

/** The demographic filters a drip campaign may set. All skip-if-missing. */
export const DEMOGRAPHIC_FILTERS = [
  "gender",
  "age_band",
  "state",
  "country",
  "income_band",
  "kids",
  "married",
] as const;

export type DemographicFilter = (typeof DEMOGRAPHIC_FILTERS)[number];

// ⭐ INCLUDE / EXCLUDE MODE for the two geo filters. Stored as `<filter>_mode`
// beside the list in the same `filters` JSONB. A config saved before the mode
// existed has no key and reads as include — so the read is POSITIVE: only the
// literal "exclude" flips it, and anything else (missing, null, a typo) keeps
// today's behaviour.
//
// ⚠️ EXCLUDE INVERTS THE MISSING RULE. Include mode skips a lead with no value
// (it cannot prove the lead is in the list). Exclude mode PASSES it: we exclude
// known matches, and unknown is not a known match.
export const GEO_MODE_FILTERS = ["state", "country"] as const;
export const GEO_FILTER_MODES = ["include", "exclude"] as const;
export type GeoFilterMode = (typeof GEO_FILTER_MODES)[number];

export function geoFilterMode(filters: Record<string, unknown>, f: string): GeoFilterMode {
  return filters[`${f}_mode`] === "exclude" ? "exclude" : "include";
}

export type RuleVerdict = "pass" | "mismatch" | "missing" | "blocked";

export interface CandidateVerdict {
  campaign_id: number;
  campaign_name: string | null;
  priority: number;
  eligible: boolean;
  /** rule -> verdict. Every rule appears, whether or not it passed. */
  rules: Record<string, RuleVerdict>;
  /** Human-readable detail for the rules that did not pass. */
  detail: Record<string, string>;
}

/** A higher-priority campaign the lead was eligible for in every way except
 *  today's capacity — so the lead went to the next candidate instead (0210) —
 *  or, with hour overflow on (0213), except THIS HOUR's capacity. */
export interface OverflowSkip {
  campaign_id: number;
  campaign_name: string | null;
  priority: number;
  /** "campaign full (X/Y today: …)", the admission-cap detail, or "hour full (N/cap this hour)". */
  detail: string;
  /** Present ONLY while the hour rule is on (0213): a row written with the flag
   *  off must stay byte-identical, so old and flag-off entries carry no kind and
   *  read as day. */
  kind?: "day" | "hour";
}

export interface LeadRoutingEvaluation {
  lead_event_id: string;
  contact_id: string;
  phone: string | null;
  interest_tag: string | null;
  partner_key_id: number;
  received_at: string;
  /** Reasons that block routing to ANY campaign. */
  global: Record<string, RuleVerdict>;
  globalDetail: Record<string, string>;
  candidates: CandidateVerdict[];
  winner: CandidateVerdict | null;
  /** Whether the send-capacity rule (0210, org_settings.drip_routing_send_capacity) ran. */
  send_capacity_on: boolean;
  /** Candidates ranked above the winner that were skipped only for being full
   *  today. Empty with no winner, and always empty while the flag is off. */
  overflowed_from: OverflowSkip[];
  /** O3 (0213): no candidate was fully eligible, so the best-ranked one failing
   *  ONLY hour_capacity won anyway — hour-fullness diverts, never defers. */
  hour_fallback: boolean;
}

interface RawRow {
  lead_event_id: string;
  contact_id: string;
  phone: string | null;
  lead_tag: string | null;
  lead_partner_key_id: number;
  received_at: string;
  contact_created_at: string;
  is_opted_out: boolean;
  carrier_norm: string | null;
  line_type: string;
  line_type_blocked: boolean;
  in_use_regular: boolean;
  in_use_drip: boolean;
  prior_event_count: number;
  attr_gender: string | null;
  attr_first_name: string | null;
  attr_zip: string | null;
  attr_state: string | null;
  attr_country: string | null;
  attr_income_band: string | null;
  attr_kids: boolean | null;
  attr_married: boolean | null;
  attr_age_band: string | null;
  org_cutoff_minutes: number | null;
  org_carry_days: number | null;
  org_widened_at: string | null;
  org_send_capacity: boolean | null;
  /** drip_routing_hour_overflow AND drip_routing_send_capacity AND drip_hourly_cap_enabled. */
  org_hour_rule: boolean | null;
  campaign_id: number | null;
  campaign_name: string | null;
  campaign_offer_id: number | null;
  campaign_status: string | null;
  campaign_send_paused: boolean | null;
  cfg_cutoff_minutes: number | null;
  cfg_carry_days: number | null;
  cfg_widened_at: string | null;
  cfg_tag: string | null;
  cfg_partner_key_id: number | null;
  cfg_start_at: string | null;
  cfg_end_at: string | null;
  cfg_priority: number | null;
  cfg_filters: Record<string, unknown> | null;
  cfg_campaign_cap: number | null;
  cfg_admission_cap: number | null;
  cfg_daily_cap: number | null;
  cfg_hourly_cap: number | null;
  carrier_filter: string[] | null;
  journeys_total: number;
  journeys_today: number;
  journeys_reserve: number;
  sends_today: number;
  journeys_unsent: number;
  had_offer_exposure: boolean;
  active_creative_ids: (number | null)[] | null;
  seen_creative_ids: (number | null)[] | null;
}

/** ET-day-aware age band, matching the 1c definition used by segment rules. */
function bandFromAge(age: number): string | null {
  if (age < 18) return null;
  if (age <= 24) return "18_24";
  if (age <= 34) return "25_34";
  if (age <= 44) return "35_44";
  if (age <= 54) return "45_54";
  if (age <= 64) return "55_64";
  return "65_plus";
}

/** Per campaign: journeys (excluding 'unroutable') all-time, current ET day, and
 *  the carry-over RESERVE — same-day journeys routed yesterday from this time of
 *  day to midnight, i.e. the fresh volume today's afternoon is expected to bring.
 *  Plus the send-capacity operands (0210): `sendsToday` (S, today's drip sends)
 *  and `unsent` (U, routed journeys with no first send, from any day). */
export interface CampaignCounts {
  total: number;
  today: number;
  reserve: number;
  sendsToday: number;
  unsent: number;
  /** The hour rule's operands (0213). REQUIRED (§11b — it changes who is
   *  routed): null ⇔ the rule is inactive for this campaign this run (a flag
   *  off, no hourly cap, or no first-send window open now). */
  hour: HourCapacity | null;
}
export type CampaignJourneyCounts = Map<number, CampaignCounts>;

/** A campaign's current-hour counts and its hourly cap. */
export interface HourCapacity { counts: HourCounts; cap: number }

export const ZERO_COUNTS: CampaignCounts = { total: 0, today: 0, reserve: 0, sendsToday: 0, unsent: 0, hour: null };

/**
 * Hour-rule operands for hourly-capped campaigns whose first-send window is
 * open NOW (O1): one windows query + one grouped hour-count query, both through
 * the ONE formula in hourly-room.ts (O4). A campaign with no open window gets
 * no entry — the rule is absent for it. Callers check the org flags first.
 */
export async function loadHourCapacity(
  dbc: DbOrTx, { now, campaigns }: { now: Date; campaigns: { id: number; cap: number }[] },
): Promise<Map<number, HourCapacity>> {
  const out = new Map<number, HourCapacity>();
  if (campaigns.length === 0) return out;
  const windows = await loadFirstSendWindows(dbc, { campaignIds: campaigns.map((c) => c.id) });
  const open = campaigns.filter((c) => inAnyWindow(now, windows.get(c.id) ?? []));
  if (open.length === 0) return out;
  const counts = await loadHourCounts(dbc, {
    campaigns: open.map((c) => ({ id: c.id, windows: windows.get(c.id) ?? [] })),
    hourStart: hourStartOf(now),
  });
  for (const c of open) out.set(c.id, { counts: counts.get(c.id)!, cap: c.cap });
  return out;
}

/**
 * The per-campaign journey counts the cap rules read, for every drip campaign
 * in the org. The routing worker computes this ONCE per tick and passes it to
 * every evaluation (incrementing it as it routes): counting a 20K-journey
 * campaign per lead was ~11 ms of every evaluation and grows with the campaign.
 */
export async function loadCampaignJourneyCounts(
  dbc: DbOrTx,
  { orgId, now = new Date() }: { orgId: string; now?: Date },
): Promise<CampaignJourneyCounts> {
  const rows = (await dbc.execute(sql`
    SELECT j.campaign_id,
           count(*)::int AS total,
           count(*) FILTER (
             WHERE j.routed_at >= date_trunc('day', ${now.toISOString()}::timestamptz
                     AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')::int AS today,
           count(*) FILTER (
             WHERE j.carried_days = 0
               AND j.routed_at >= ${now.toISOString()}::timestamptz - interval '24 hours'
               AND j.routed_at < date_trunc('day', ${now.toISOString()}::timestamptz
                     AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')::int AS reserve,
           count(*) FILTER (WHERE j.state = 'routed' AND j.first_send_at IS NULL)::int AS unsent
    FROM drip_journeys j
    JOIN campaigns c ON c.id = j.campaign_id
    WHERE j.org_id = ${orgId}::uuid AND j.state <> 'unroutable'
      AND c.type = 'drip' AND c.status IN ('active', 'paused')
    GROUP BY j.campaign_id
  `)) as unknown as { campaign_id: number; total: number; today: number; reserve: number; unsent: number }[];
  // S for the send-capacity rule — the scheduler's own daily-cap count. The
  // hour rule's flags and caps ride on this same per-campaign row, so a run
  // with the hour flag off costs no extra query.
  const { start: dayStart, end: dayEnd } = campaignDayBoundsUtc(now);
  const sends = (await dbc.execute(sql`
    SELECT c.id AS campaign_id, s.n, cfg.hourly_cap,
           COALESCE(os.drip_routing_hour_overflow AND os.drip_routing_send_capacity
                    AND os.drip_hourly_cap_enabled, false) AS hour_rule
    FROM campaigns c
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    LEFT JOIN org_settings os ON os.org_id = c.org_id
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM stage_sends ss
      WHERE ss.campaign_id = c.id AND ${dripDailySendsPredicate(dayStart, dayEnd)}
    ) s
    WHERE c.org_id = ${orgId}::uuid AND c.type = 'drip' AND c.status IN ('active', 'paused')
  `)) as unknown as { campaign_id: number; n: number; hourly_cap: number | null; hour_rule: boolean }[];
  const out: CampaignJourneyCounts = new Map();
  for (const r of rows) {
    out.set(Number(r.campaign_id), { ...ZERO_COUNTS, total: r.total, today: r.today, reserve: r.reserve, unsent: r.unsent });
  }
  for (const r of sends) {
    const id = Number(r.campaign_id);
    out.set(id, { ...(out.get(id) ?? ZERO_COUNTS), sendsToday: r.n });
  }
  // The hour rule (0213): only when every flag is on — then ONE windows query
  // and ONE grouped hour-count query for the whole run. routing.ts keeps it
  // true in-tick by incrementing pendingFresh.
  const capped = sends
    .filter((r) => r.hour_rule === true && r.hourly_cap != null)
    .map((r) => ({ id: Number(r.campaign_id), cap: Number(r.hourly_cap) }));
  for (const [id, hour] of await loadHourCapacity(dbc, { now, campaigns: capped })) {
    out.set(id, { ...(out.get(id) ?? ZERO_COUNTS), hour });
  }
  return out;
}

/**
 * Evaluate one lead against every drip campaign in the org.
 *
 * Read-only. Writes nothing — the caller decides what to do with the verdict,
 * which is what lets the debugging tool run it against an already-routed lead.
 *
 * `counts` is the routing worker's per-tick cache (loadCampaignJourneyCounts).
 * Without it — the debugging tool — the counts are read per call, as before.
 */
/** Each candidate's personalization rules: the worker's per-tick cache, or
 *  "load" to read them for this call (the why-not-routed tool, tests). */
export type CampaignTagRulesSource = Map<number, TagRules | TagRulesRefusal> | "load";

/**
 * PURE (P5). The `creative_tags` verdict for one lead against one campaign's
 * rules. Called only for a campaign whose first-send message uses a contact
 * tag; a tag-less campaign gets no rule at all (byte-identical stored reasons).
 * Not in the temporary sets, so a failure is PERMANENT: the lead falls through
 * to the next candidate or becomes unroutable.
 */
export function creativeTagsVerdict(
  rules: TagRules | TagRulesRefusal,
  lead: RecipientData,
): { verdict: RuleVerdict; detail?: string } {
  if (isTagRulesRefusal(rules)) {
    return { verdict: "blocked", detail: `message cannot be sent: ${rules.refused.replace(/_/g, " ")}` };
  }
  const contactTags = rules.required.filter((k): k is Exclude<typeof k, "brand"> => k !== "brand");
  const missing = contactTags.filter((k) => TAGS[k].normalize(lead[k]) === null);
  if (missing.length > 0) return { verdict: "missing", detail: `missing data: ${missing.join(", ")}` };
  const max = rules.firstNameMaxLength;
  const name = contactTags.includes("first_name") ? TAGS.first_name.normalize(lead.first_name) : null;
  if (max != null && name != null && name.length > max) {
    return { verdict: "blocked", detail: `segment limit (first_name ${name.length} > ${max})` };
  }
  return { verdict: "pass" };
}

export async function evaluateLeadRouting(
  dbc: DbOrTx,
  { orgId, leadEventId, now = new Date(), counts, tagRules }:
    {
      orgId: string; leadEventId: string; now?: Date; counts?: CampaignJourneyCounts;
      // P5: REQUIRED (CLAUDE.md §11b) — it decides who is routed where.
      tagRules: CampaignTagRulesSource;
    },
): Promise<LeadRoutingEvaluation | null> {
  const { start: dayStart, end: dayEnd } = campaignDayBoundsUtc(now);
  const rows = (await dbc.execute(sql`
    WITH le AS (
      SELECT e.id, e.contact_id, e.partner_key_id, e.interest_tag, e.received_at,
             c.created_at AS contact_created_at, c.carrier_norm, c.phone_number,
             c.line_type
      FROM lead_events e
      JOIN contacts c ON c.id = e.contact_id
      WHERE e.id = ${leadEventId}::uuid AND e.org_id = ${orgId}::uuid
    )
    SELECT
      le.id AS lead_event_id, le.contact_id, le.phone_number AS phone,
      le.interest_tag AS lead_tag, le.partner_key_id AS lead_partner_key_id,
      le.received_at, le.contact_created_at, le.carrier_norm, le.line_type,
      EXISTS (SELECT 1 FROM opt_outs oo
              WHERE oo.org_id = ${orgId}::uuid AND oo.contact_id = le.contact_id) AS is_opted_out,
      -- Group line-type gate (migration 0218): any ACTIVE group of this contact
      -- that disallows its line type. Same predicate as
      -- lib/contact-groups/line-type-gate.ts, for one contact.
      EXISTS (SELECT 1 FROM contact_contact_groups lt_ccg
              JOIN contact_groups lt_g ON lt_g.id = lt_ccg.contact_group_id
              WHERE lt_ccg.org_id = ${orgId}::uuid AND lt_ccg.contact_id = le.contact_id
                AND lt_g.status = 'active'
                AND ((lt_g.allow_voip = false AND le.line_type = 'voip')
                  OR (lt_g.allow_unknown = false AND le.line_type = 'unknown'))) AS line_type_blocked,
      -- "In use" BOTH DIRECTIONS (G2): a regular campaign's frozen pool, or
      -- another live drip journey. Either blocks.
      EXISTS (SELECT 1 FROM campaign_audience_pool p
              JOIN campaigns ca ON ca.id = p.campaign_id
              WHERE p.org_id = ${orgId}::uuid AND p.contact_id = le.contact_id
                AND ca.status = 'active') AS in_use_regular,
      EXISTS (SELECT 1 FROM drip_journeys j
              WHERE j.org_id = ${orgId}::uuid AND j.contact_id = le.contact_id
                AND j.state IN ('routed','active')) AS in_use_drip,
      (SELECT count(*)::int FROM lead_events pe
       WHERE pe.org_id = ${orgId}::uuid AND pe.contact_id = le.contact_id
         AND pe.received_at < le.received_at) AS prior_event_count,
      ca2.gender AS attr_gender, ca2.first_name AS attr_first_name, ca2.zip AS attr_zip,
      ca2.state AS attr_state, ca2.country AS attr_country,
      ca2.income_band AS attr_income_band, ca2.kids AS attr_kids, ca2.married AS attr_married,
      CASE WHEN ca2.dob IS NULL THEN NULL
           ELSE extract(year from age((${now.toISOString()}::timestamptz
                                       AT TIME ZONE 'America/New_York')::date, ca2.dob))::int
      END AS attr_age_years,
      -- Freshness (item 3 + carry-over): the window itself is computed in JS
      -- by lib/drip/admission-window.ts from these settings.
      (SELECT os.drip_admission_cutoff_minutes FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_cutoff_minutes,
      (SELECT os.drip_carry_days FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_carry_days,
      (SELECT os.drip_admission_widened_at FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_widened_at,
      (SELECT os.drip_routing_send_capacity FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_send_capacity,
      (SELECT os.drip_routing_hour_overflow AND os.drip_routing_send_capacity
              AND os.drip_hourly_cap_enabled FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_hour_rule,
      c.id AS campaign_id, c.name AS campaign_name, c.offer_id AS campaign_offer_id,
      c.status AS campaign_status, c.send_paused AS campaign_send_paused,
      cfg.admission_cutoff_minutes AS cfg_cutoff_minutes,
      cfg.carry_days AS cfg_carry_days, cfg.admission_widened_at AS cfg_widened_at,
      cfg.interest_tag AS cfg_tag, cfg.partner_key_id AS cfg_partner_key_id,
      cfg.start_at AS cfg_start_at, cfg.end_at AS cfg_end_at,
      cfg.priority AS cfg_priority, cfg.filters AS cfg_filters,
      cfg.campaign_cap AS cfg_campaign_cap,
      cfg.routing_daily_admission_cap AS cfg_admission_cap,
      cfg.daily_cap AS cfg_daily_cap, cfg.hourly_cap AS cfg_hourly_cap,
      (c.audience_filters -> 'carrier_filter') AS carrier_filter,
      ${counts
        ? sql`0 AS journeys_total, 0 AS journeys_today, 0 AS journeys_reserve,
               0 AS sends_today, 0 AS journeys_unsent,`
        : sql`COALESCE((SELECT count(*)::int FROM drip_journeys j2
                WHERE j2.campaign_id = c.id
                  AND j2.state <> 'unroutable'), 0) AS journeys_total,
      COALESCE((SELECT count(*)::int FROM drip_journeys j3
                WHERE j3.campaign_id = c.id AND j3.state <> 'unroutable'
                  AND j3.routed_at >= date_trunc('day', ${now.toISOString()}::timestamptz
                        AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'), 0)
        AS journeys_today,
      COALESCE((SELECT count(*)::int FROM drip_journeys j4
                WHERE j4.campaign_id = c.id AND j4.state <> 'unroutable' AND j4.carried_days = 0
                  AND j4.routed_at >= ${now.toISOString()}::timestamptz - interval '24 hours'
                  AND j4.routed_at < date_trunc('day', ${now.toISOString()}::timestamptz
                        AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'), 0)
        AS journeys_reserve,
      (SELECT count(*)::int FROM stage_sends ss
        WHERE ss.campaign_id = c.id AND ${dripDailySendsPredicate(dayStart, dayEnd)}) AS sends_today,
      (SELECT count(*)::int FROM drip_journeys j5
        WHERE j5.campaign_id = c.id AND j5.state = 'routed' AND j5.first_send_at IS NULL)
        AS journeys_unsent,`}
      EXISTS (SELECT 1 FROM offer_exposures oe
              WHERE oe.org_id = ${orgId}::uuid AND oe.contact_id = le.contact_id
                AND c.offer_id IS NOT NULL AND oe.offer_id = c.offer_id) AS had_offer_exposure,
      -- The creatives this campaign could currently send: ACTIVE first-send
      -- stages only. A creative on a deactivated stage is not something the
      -- lead would receive, so it must not count as "already covered".
      (SELECT array_agg(DISTINCT s2.creative_id) FROM campaign_stages s2
       WHERE s2.campaign_id = c.id AND s2.drip_active IS TRUE
         AND s2.archived_at IS NULL AND s2.creative_id IS NOT NULL) AS active_creative_ids,
      -- What this contact has already been sent, from ANY campaign on this offer.
      -- ⚠️ Only read when the contact HAS an exposure to the offer — the only
      -- case the creative rule consults it. The planner walks every send of
      -- every campaign on the offer to find this contact (no contact index on
      -- stage_sends), ~28 ms per campaign per lead, so skipping it for the
      -- common no-exposure lead is most of the per-lead cost.
      CASE WHEN c.offer_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM offer_exposures oe2
             WHERE oe2.org_id = ${orgId}::uuid AND oe2.contact_id = le.contact_id
               AND oe2.offer_id = c.offer_id)
      THEN (SELECT array_agg(DISTINCT s3.creative_id)
       FROM stage_sends ss3
       JOIN campaign_stages s3 ON s3.id = ss3.stage_id
       JOIN campaigns c3 ON c3.id = ss3.campaign_id
       WHERE ss3.org_id = ${orgId}::uuid AND ss3.contact_id = le.contact_id
         AND ss3.status = 'sent' AND s3.creative_id IS NOT NULL
         AND c3.offer_id = c.offer_id)
      END AS seen_creative_ids
    FROM le
    LEFT JOIN contact_attributes ca2 ON ca2.contact_id = le.contact_id
    -- A PAUSED drip campaign is still a candidate: it owns its tag, so a lead
    -- matching it is deferred (temporary), never "no campaign exists".
    LEFT JOIN campaigns c
      ON c.org_id = ${orgId}::uuid AND c.type = 'drip' AND c.status IN ('active', 'paused')
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
  `)) as unknown as (RawRow & { attr_age_years: number | null })[];

  if (rows.length === 0) return null;
  const head = rows[0];

  // ── rules that block routing to ANY campaign ──────────────────────────────
  const global: Record<string, RuleVerdict> = {};
  const globalDetail: Record<string, string> = {};

  global.opted_out = head.is_opted_out ? "blocked" : "pass";
  if (head.is_opted_out) globalDetail.opted_out = "contact is on the opt-out list";

  // Group line-type gate (migration 0218). PERMANENT — not in
  // TEMPORARY_GLOBAL_RULES — so the lead is marked unroutable, like an opt-out.
  global.line_type = head.line_type_blocked ? "blocked" : "pass";
  if (head.line_type_blocked) {
    globalDetail.line_type =
      `contact line type is ${head.line_type} and one of its groups disallows ${head.line_type} numbers`;
  }

  const inUse = head.in_use_regular || head.in_use_drip;
  global.in_use = inUse ? "blocked" : "pass";
  if (inUse) {
    globalDetail.in_use = head.in_use_regular
      ? "contact is in an active REGULAR campaign's audience pool"
      : "contact already has a live DRIP journey";
  }

  // The >1-week re-entry rule. A contact who has arrived before may only be
  // treated as a new drip lead once they have been in the system more than a
  // week — otherwise a partner resending the same list every hour would
  // re-route the same people continuously.
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const inSystemMs = now.getTime() - new Date(head.contact_created_at).getTime();
  const isRepeat = head.prior_event_count > 0;
  const weekOk = !isRepeat || inSystemMs > weekMs;
  global.week_rule = weekOk ? "pass" : "blocked";
  if (!weekOk) {
    globalDetail.week_rule =
      `repeat lead (${head.prior_event_count} prior arrival(s)) and the contact has been ` +
      `in the system only ${Math.floor(inSystemMs / 86400000)} day(s) — needs more than 7`;
  }

  const ageBand = head.attr_age_years == null ? null : bandFromAge(head.attr_age_years);

  // The hour rule's operands (0213). With the worker's cache they are already in
  // `counts`; without it (the debugging tool) they are read here through the
  // same helper, so the tool explains exactly what the router decides.
  const hourRuleOn = head.org_hour_rule === true;
  const liveHour = hourRuleOn && !counts
    ? await loadHourCapacity(dbc, {
        now,
        campaigns: rows
          .filter((r) => r.campaign_id != null && r.cfg_hourly_cap != null)
          .map((r) => ({ id: Number(r.campaign_id), cap: Number(r.cfg_hourly_cap) })),
      })
    : null;

  // P5: each candidate's personalization rules (first-send stages only).
  const tagRuleMap = tagRules === "load"
    ? await loadCampaignTagRules(dbc, orgId, [
        ...new Set(rows.filter((r) => r.campaign_id != null).map((r) => Number(r.campaign_id))),
      ])
    : tagRules;
  const leadData: RecipientData = { first_name: head.attr_first_name, zip: head.attr_zip, state: head.attr_state };

  // ── per-campaign rules ────────────────────────────────────────────────────
  const candidates: CandidateVerdict[] = [];
  for (const r of rows) {
    if (r.campaign_id == null) continue; // no drip campaigns at all
    const rules: Record<string, RuleVerdict> = {};
    const detail: Record<string, string> = {};

    if (r.cfg_tag == null) {
      rules.config = "blocked";
      detail.config = "drip campaign has no config row";
    } else {
      rules.config = "pass";
    }

    rules.interest_tag = r.cfg_tag && r.cfg_tag === head.lead_tag ? "pass" : "mismatch";
    if (rules.interest_tag !== "pass") {
      detail.interest_tag = `lead tag ${head.lead_tag ?? "(none)"} != campaign tag ${r.cfg_tag ?? "(none)"}`;
    }

    if (r.cfg_partner_key_id == null) {
      rules.partner = "pass";
    } else if (r.cfg_partner_key_id === head.lead_partner_key_id) {
      rules.partner = "pass";
    } else {
      rules.partner = "mismatch";
      detail.partner = `campaign restricted to partner key ${r.cfg_partner_key_id}`;
    }

    // A paused campaign (status 'paused' OR the send-pause latch) still owns
    // its tag: TEMPORARY, so the lead is deferred and re-checked, never treated
    // as having no campaign.
    const paused = r.campaign_status !== "active" || r.campaign_send_paused === true;
    rules.campaign_paused = paused ? "blocked" : "pass";
    if (paused) {
      detail.campaign_paused = r.campaign_status !== "active"
        ? `campaign status is ${r.campaign_status}`
        : "campaign sending is paused";
    }

    // Freshness (drip only): admitted only until the end of the lead's arrival
    // ET day plus the cutoff — the campaign's override, else the org default.
    // Past it the lead is skipped for this campaign and nothing is written.
    const adm = admissionCloses(head.received_at, {
      cfgCarryDays: r.cfg_carry_days, cfgCutoffMinutes: r.cfg_cutoff_minutes, cfgWidenedAt: r.cfg_widened_at,
      orgCarryDays: head.org_carry_days, orgCutoffMinutes: head.org_cutoff_minutes, orgWidenedAt: head.org_widened_at,
    });
    rules.freshness = now.getTime() < adm.closesAt.getTime() ? "pass" : "mismatch";
    if (rules.freshness !== "pass") {
      detail.freshness = adm.preWidening
        ? `lead arrived ${head.received_at}, before this campaign's admission window was widened ` +
          `(${adm.widenedAt!.toISOString()}) — same day only; admission closed ${adm.closesAt.toISOString()}`
        : `lead arrived ${head.received_at}; admission closed ${adm.closesAt.toISOString()} ` +
          (adm.carryDays === 0
            ? `(end of arrival ET day + ${adm.cutoffMinutes} min)`
            : `(end of arrival ET day + ${adm.carryDays} day(s) + ${adm.cutoffMinutes} min)`);
    }

    const rec = new Date(head.received_at).getTime();
    const startOk = !r.cfg_start_at || rec >= new Date(r.cfg_start_at).getTime();
    const endOk = !r.cfg_end_at || rec < new Date(r.cfg_end_at).getTime();
    rules.window = startOk && endOk ? "pass" : "mismatch";
    if (rules.window !== "pass") {
      detail.window =
        `received_at ${head.received_at} outside [${r.cfg_start_at ?? "-inf"}, ${r.cfg_end_at ?? "+inf"})`;
    }

    // Demographic filters — skip-if-missing.
    const filters = (r.cfg_filters ?? {}) as Record<string, unknown>;
    const attrValue: Record<DemographicFilter, unknown> = {
      gender: head.attr_gender,
      age_band: ageBand,
      state: head.attr_state,
      country: head.attr_country,
      income_band: head.attr_income_band,
      kids: head.attr_kids,
      married: head.attr_married,
    };
    for (const f of DEMOGRAPHIC_FILTERS) {
      const want = filters[f];
      if (want === undefined || want === null || (Array.isArray(want) && want.length === 0)) {
        continue; // filter not set — nothing to check
      }
      const have = attrValue[f];
      if ((GEO_MODE_FILTERS as readonly string[]).includes(f) && Array.isArray(want)) {
        // State/country are free-text in the form, so compare case-insensitively:
        // in exclude mode a typed "tx" silently failing to exclude TX is a leak.
        const list = (want as unknown[]).map((x) => String(x).trim().toUpperCase());
        const val = have == null ? null : String(have).trim().toUpperCase();
        if (geoFilterMode(filters, f) === "exclude") {
          if (val !== null && list.includes(val)) {
            rules[`filter_${f}`] = "mismatch";
            detail[`filter_${f}`] =
              `lead ${f}=${String(have)} is in the excluded list ${JSON.stringify(want)} ` +
              `(exclude mode; a lead with no ${f} would have passed)`;
          } else {
            rules[`filter_${f}`] = "pass";
          }
          continue;
        }
        if (val === null) {
          rules[`filter_${f}`] = "missing";
          detail[`filter_${f}`] = `campaign filters on ${f} but the lead has no value`;
          continue;
        }
        const ok = list.includes(val);
        rules[`filter_${f}`] = ok ? "pass" : "mismatch";
        if (!ok) detail[`filter_${f}`] = `lead ${f}=${String(have)} not in ${JSON.stringify(want)}`;
        continue;
      }
      if (have === null || have === undefined) {
        // ⚠️ MISSING, not mismatch. The campaign asked for a value the lead does
        // not have, so the lead is skipped — but the fix is the partner sending
        // the field, not the targeting.
        rules[`filter_${f}`] = "missing";
        detail[`filter_${f}`] = `campaign filters on ${f} but the lead has no value`;
        continue;
      }
      const ok = Array.isArray(want)
        ? (want as unknown[]).map(String).includes(String(have))
        : String(want) === String(have);
      rules[`filter_${f}`] = ok ? "pass" : "mismatch";
      if (!ok) detail[`filter_${f}`] = `lead ${f}=${String(have)} not in ${JSON.stringify(want)}`;
    }

    // Carrier filter, reusing the regular-campaign representation.
    const carriers = Array.isArray(r.carrier_filter) ? r.carrier_filter : null;
    if (carriers && carriers.length > 0) {
      const have = head.carrier_norm;
      if (!have || have === "Unidentified") {
        rules.carrier = "missing";
        detail.carrier = "campaign sets a carrier filter and the contact carrier is unidentified";
      } else {
        const ok = carriers.includes(have);
        rules.carrier = ok ? "pass" : "mismatch";
        if (!ok) detail.carrier = `carrier ${have} not in ${JSON.stringify(carriers)}`;
      }
    } else {
      rules.carrier = "pass";
    }

    // Same-offer skip. ⚠️ OFFER HALF ONLY in Phase 4 — the creative half has no
    // operand until drip stages exist (P5). Recorded, not silently passed.
    rules.same_offer = r.had_offer_exposure ? "blocked" : "pass";
    if (r.had_offer_exposure) {
      detail.same_offer = `contact already has an exposure to offer ${r.campaign_offer_id}`;
    }
    // ⭐ THE CREATIVE HALF — completed in Phase 5, now that drip stages exist.
    //
    // The spec's rule: a lead already inside a journey that arrives again may be
    // routed again ONLY if it would get a NEW creative or a DIFFERENT offer;
    // same offer + same creative ⇒ skip. Phase 4 could not evaluate this because
    // drip stages did not exist, so it recorded `deferred_p5` rather than
    // silently passing — a rule that always passes looks implemented.
    //
    // "Would receive" is defined against the campaign's ACTIVE first-send
    // creatives: those are the only messages this campaign can currently send.
    // A creative on a deactivated stage is not something the lead would get.
    if (r.had_offer_exposure && r.active_creative_ids && r.seen_creative_ids) {
      const wouldSend = new Set(r.active_creative_ids.filter((x) => x != null));
      const alreadySeen = new Set(r.seen_creative_ids.filter((x) => x != null));
      const somethingNew = [...wouldSend].some((c) => !alreadySeen.has(c));
      rules.creative_check = somethingNew ? "pass" : "blocked";
      if (!somethingNew) {
        detail.creative_check =
          `contact already received every active creative of this campaign ` +
          `(${[...wouldSend].join(", ") || "none"}) for offer ${r.campaign_offer_id}`;
      }
    } else {
      // No prior exposure to this offer ⇒ nothing to be a repeat of.
      rules.creative_check = "pass";
    }

    // Caps. From the worker's per-tick counts when given, else the per-call SQL.
    const cached = counts ? (counts.get(Number(r.campaign_id)) ?? ZERO_COUNTS) : null;
    const journeysTotal = cached ? cached.total : r.journeys_total;
    const journeysToday = cached ? cached.today : r.journeys_today;
    // ⭐ Fresh leads first (carry-over D1): a CARRIED lead may only use the cap
    // left after holding back yesterday's same-time-onward fresh volume. A fresh
    // lead ignores the reserve, so with carry off nothing here changes.
    const carried = isCarried(head.received_at, now);
    const reserve = carried ? (cached ? cached.reserve : Number(r.journeys_reserve ?? 0)) : 0;
    const capOk = r.cfg_campaign_cap == null || journeysTotal < r.cfg_campaign_cap;
    rules.campaign_cap = capOk ? "pass" : "blocked";
    if (!capOk) {
      detail.campaign_cap = `campaign cap ${r.cfg_campaign_cap} reached (${journeysTotal} journeys)`;
    }
    const admOk = r.cfg_admission_cap == null || journeysToday + reserve < r.cfg_admission_cap;
    rules.routing_daily_admission = admOk ? "pass" : "blocked";
    if (!admOk) {
      detail.routing_daily_admission = carried && journeysToday < r.cfg_admission_cap!
        ? `carried lead held back for today's fresh arrivals: ${journeysToday} routed today + ` +
          `reserve ${reserve} >= cap ${r.cfg_admission_cap}`
        : `today's routing admission cap ${r.cfg_admission_cap} reached ` +
          `(${journeysToday} routed today) — this is NOT the send-time daily cap`;
    }

    // ⭐ SEND CAPACITY (0210, flag org_settings.drip_routing_send_capacity).
    // Full when today's sends + the routed-unsent backlog already reach the
    // daily SEND cap: admitting more would only queue leads the campaign cannot
    // text today. A full campaign is just ineligible, so the lead goes to the
    // next candidate by priority, and is deferred only when every candidate is
    // full. Flag off ⇒ the rule is ABSENT, not "pass", so stored reasons and the
    // debugging tool are identical to before.
    if (head.org_send_capacity === true) {
      const cap = sendCapacity(
        r.cfg_daily_cap,
        cached ? cached.sendsToday : Number(r.sends_today ?? 0),
        cached ? cached.unsent : Number(r.journeys_unsent ?? 0),
      );
      rules.send_capacity = cap.full ? "blocked" : "pass";
      if (cap.detail) detail.send_capacity = cap.detail;
    }

    // ⭐ HOUR CAPACITY (0213, flag org_settings.drip_routing_hour_overflow; only
    // with send capacity + the hourly cap also on). Full when this hour's
    // committed leads (sent + assigned + pending fresh + carry-ON queue) reach
    // the hourly cap, and only while a first-send window is open now (O1). It
    // DIVERTS to a sibling with room and never defers: if every otherwise-
    // eligible candidate is hour-full, the O3 fallback below routes anyway.
    // Inactive ⇒ ABSENT, not "pass" (flag-off byte identity).
    const hour = !hourRuleOn ? null
      : cached ? cached.hour
      : (liveHour?.get(Number(r.campaign_id)) ?? null);
    if (hour) {
      const h = hourFullness(hour.cap, hour.counts);
      rules.hour_capacity = h.full ? "blocked" : "pass";
      if (h.detail) detail.hour_capacity = h.detail;
    }

    // ⭐ CREATIVE TAGS (P5). ABSENT for a campaign whose first-send message has
    // no contact tag — not "pass" — so stored reasons and the tool are identical
    // to before for every tag-less campaign.
    const tr = tagRuleMap.get(Number(r.campaign_id));
    if (tr && tr.required.length > 0) {
      const ct = creativeTagsVerdict(tr, leadData);
      rules.creative_tags = ct.verdict;
      if (ct.detail) detail.creative_tags = ct.detail;
    }

    const eligible = Object.values(rules).every((v) => v === "pass");
    candidates.push({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      priority: r.cfg_priority ?? 100,
      eligible,
      rules,
      detail,
    });
  }

  const globallyBlocked = Object.values(global).some((v) => v !== "pass");
  // Winner: priority ASC, tie -> newest campaign (highest id).
  let winner = globallyBlocked
    ? null
    : (candidates.filter((c) => c.eligible).sort(byRoutingRank)[0] ?? null);
  // ⭐ O3 DIVERT, NEVER DEFER: no fully eligible candidate, but some fail ONLY
  // hour_capacity ⇒ the best-ranked of those wins (the lead joins its queue,
  // exactly as without the rule). Hour-fullness alone never defers a lead.
  let hourFallback = false;
  if (!globallyBlocked && !winner) {
    winner = candidates.filter((c) => {
      const failed = failingRules(c);
      return failed.length === 1 && failed[0] === "hour_capacity";
    }).sort(byRoutingRank)[0] ?? null;
    hourFallback = winner !== null;
  }
  const sendCapacityOn = head.org_send_capacity === true;

  return {
    lead_event_id: head.lead_event_id,
    contact_id: head.contact_id,
    phone: head.phone,
    interest_tag: head.lead_tag,
    partner_key_id: head.lead_partner_key_id,
    received_at: head.received_at,
    global,
    globalDetail,
    candidates,
    winner,
    send_capacity_on: sendCapacityOn,
    overflowed_from: sendCapacityOn && winner ? overflowSkips(candidates, winner, { hourRuleOn }) : [],
    hour_fallback: hourFallback,
  };
}

function failingRules(c: CandidateVerdict): string[] {
  return Object.entries(c.rules).filter(([, v]) => v !== "pass").map(([k]) => k);
}

/** Routing order: priority ASC, tie -> newest campaign (highest id). */
function byRoutingRank(a: CandidateVerdict, b: CandidateVerdict): number {
  return a.priority - b.priority || b.campaign_id - a.campaign_id;
}

/** Day-level capacity rules: the ones a lead overflows past. The lifetime
 *  campaign_cap is not "full for today", so it is not one of them. */
const DAY_CAPACITY_RULES: readonly string[] = ["send_capacity", "routing_daily_admission"];

/** Candidates ranked above the winner whose ONLY failing rules are capacity —
 *  day-level, or (0213) this hour's: the lead would have gone there had it not
 *  been full. `kind` is emitted only while the hour rule is on, so flag-off
 *  entries stay byte-identical; a skip failing day AND hour is kind "day" with
 *  the unchanged day text. Exported for the pure test. */
export function overflowSkips(
  candidates: CandidateVerdict[], winner: CandidateVerdict, { hourRuleOn }: { hourRuleOn: boolean },
): OverflowSkip[] {
  return [...candidates]
    .sort(byRoutingRank)
    .filter((c) => byRoutingRank(c, winner) < 0)
    .flatMap((c) => {
      const failed = failingRules(c);
      const capacityOnly = failed.length > 0 &&
        failed.every((k) => DAY_CAPACITY_RULES.includes(k) || k === "hour_capacity");
      if (!capacityOnly) return [];
      const day = failed.some((k) => DAY_CAPACITY_RULES.includes(k));
      const skip: OverflowSkip = {
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        priority: c.priority,
        detail: day
          ? DAY_CAPACITY_RULES.map((k) => c.detail[k]).filter(Boolean).join("; ")
          : (c.detail.hour_capacity ?? ""),
      };
      return [hourRuleOn ? { ...skip, kind: day ? ("day" as const) : ("hour" as const) } : skip];
    });
}

// ── what the routing worker does with a verdict (card 869ency4b item 1) ──────
//
// ⭐ PERMANENT vs TEMPORARY. A lead that can never be routed must leave the
// queue on its FIRST evaluation; before this, every unrouted lead sat at the
// head of the oldest-first batch for 7 days and was re-checked every minute
// (2026-10-10: ~180 dead leads starved 44,968 good ones).
//
//   permanent — gets a terminal 'unroutable' row now: opted out, or every
//               candidate fails a rule that cannot change today (tag, partner,
//               window, demographic/carrier filters, same offer + creative), or
//               there is no live-or-paused drip campaign at all.
//   defer     — only TEMPORARY rules fail somewhere (contact in use, week rule,
//               a cap, a paused campaign): re-checked later, behind fresh leads.
//   expired   — the only remaining candidates are past their freshness cutoff:
//               skipped, nothing terminal written (the lead stays an ordinary
//               contact).

/** Global rules that clear on their own (the contact leaves a campaign, the week passes). */
const TEMPORARY_GLOBAL_RULES = new Set(["in_use", "week_rule"]);
/** Per-campaign rules that can clear within the day. */
const TEMPORARY_CANDIDATE_RULES = new Set([
  "campaign_paused", "campaign_cap", "routing_daily_admission", "send_capacity",
]);

export type RoutingOutcome = "route" | "permanent" | "defer" | "expired";

// ⚠️ hour_capacity (0213) is NEITHER temporary nor permanent — classification
// ignores it. Alone it never gets here (the O3 fallback routes); beside another
// failure the outcome must be what that other failure alone gives, exactly as
// with the flag off. Treated like an unknown rule it would count as PERMANENT and
// write a terminal 'unroutable' for a lead that is merely day-full or in use. It
// is deliberately not in TEMPORARY_CANDIDATE_RULES either (O3: never a deferral).
const CLASSIFICATION_IGNORED_RULE = "hour_capacity";

export function classifyRoutingOutcome(v: LeadRoutingEvaluation): RoutingOutcome {
  if (v.winner) return "route";
  const failedGlobal = Object.entries(v.global).filter(([, x]) => x !== "pass").map(([k]) => k);
  if (failedGlobal.some((k) => !TEMPORARY_GLOBAL_RULES.has(k))) return "permanent";

  let anyOpen = false;   // eligible, or failing only temporary rules
  let anyExpired = false;
  for (const c of v.candidates) {
    const failed = failingRules(c).filter((k) => k !== CLASSIFICATION_IGNORED_RULE);
    if (failed.some((k) => k !== "freshness" && !TEMPORARY_CANDIDATE_RULES.has(k))) continue;
    if (failed.includes("freshness")) { anyExpired = true; continue; }
    anyOpen = true;
  }
  if (anyOpen) return "defer";
  if (anyExpired) return "expired";
  return "permanent";
}
