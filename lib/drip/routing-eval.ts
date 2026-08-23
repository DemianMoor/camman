import { sql } from "drizzle-orm";

import type { DbOrTx } from "./groups";

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
  in_use_regular: boolean;
  in_use_drip: boolean;
  prior_event_count: number;
  attr_gender: string | null;
  attr_state: string | null;
  attr_country: string | null;
  attr_income_band: string | null;
  attr_kids: boolean | null;
  attr_married: boolean | null;
  attr_age_band: string | null;
  campaign_id: number | null;
  campaign_name: string | null;
  campaign_offer_id: number | null;
  cfg_tag: string | null;
  cfg_partner_key_id: number | null;
  cfg_start_at: string | null;
  cfg_end_at: string | null;
  cfg_priority: number | null;
  cfg_filters: Record<string, unknown> | null;
  cfg_campaign_cap: number | null;
  cfg_admission_cap: number | null;
  carrier_filter: string[] | null;
  journeys_total: number;
  journeys_today: number;
  had_offer_exposure: boolean;
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

/**
 * Evaluate one lead against every drip campaign in the org.
 *
 * Read-only. Writes nothing — the caller decides what to do with the verdict,
 * which is what lets the debugging tool run it against an already-routed lead.
 */
export async function evaluateLeadRouting(
  dbc: DbOrTx,
  { orgId, leadEventId, now = new Date() }: { orgId: string; leadEventId: string; now?: Date },
): Promise<LeadRoutingEvaluation | null> {
  const rows = (await dbc.execute(sql`
    WITH le AS (
      SELECT e.id, e.contact_id, e.partner_key_id, e.interest_tag, e.received_at,
             c.created_at AS contact_created_at, c.carrier_norm, c.phone_number
      FROM lead_events e
      JOIN contacts c ON c.id = e.contact_id
      WHERE e.id = ${leadEventId}::uuid AND e.org_id = ${orgId}::uuid
    )
    SELECT
      le.id AS lead_event_id, le.contact_id, le.phone_number AS phone,
      le.interest_tag AS lead_tag, le.partner_key_id AS lead_partner_key_id,
      le.received_at, le.contact_created_at, le.carrier_norm,
      EXISTS (SELECT 1 FROM opt_outs oo
              WHERE oo.org_id = ${orgId}::uuid AND oo.contact_id = le.contact_id) AS is_opted_out,
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
      ca2.gender AS attr_gender, ca2.state AS attr_state, ca2.country AS attr_country,
      ca2.income_band AS attr_income_band, ca2.kids AS attr_kids, ca2.married AS attr_married,
      CASE WHEN ca2.dob IS NULL THEN NULL
           ELSE extract(year from age((${now.toISOString()}::timestamptz
                                       AT TIME ZONE 'America/New_York')::date, ca2.dob))::int
      END AS attr_age_years,
      c.id AS campaign_id, c.name AS campaign_name, c.offer_id AS campaign_offer_id,
      cfg.interest_tag AS cfg_tag, cfg.partner_key_id AS cfg_partner_key_id,
      cfg.start_at AS cfg_start_at, cfg.end_at AS cfg_end_at,
      cfg.priority AS cfg_priority, cfg.filters AS cfg_filters,
      cfg.campaign_cap AS cfg_campaign_cap,
      cfg.routing_daily_admission_cap AS cfg_admission_cap,
      (c.audience_filters -> 'carrier_filter') AS carrier_filter,
      COALESCE((SELECT count(*)::int FROM drip_journeys j2
                WHERE j2.campaign_id = c.id
                  AND j2.state <> 'unroutable'), 0) AS journeys_total,
      COALESCE((SELECT count(*)::int FROM drip_journeys j3
                WHERE j3.campaign_id = c.id AND j3.state <> 'unroutable'
                  AND j3.routed_at >= date_trunc('day', ${now.toISOString()}::timestamptz
                        AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'), 0)
        AS journeys_today,
      EXISTS (SELECT 1 FROM offer_exposures oe
              WHERE oe.org_id = ${orgId}::uuid AND oe.contact_id = le.contact_id
                AND c.offer_id IS NOT NULL AND oe.offer_id = c.offer_id) AS had_offer_exposure
    FROM le
    LEFT JOIN contact_attributes ca2 ON ca2.contact_id = le.contact_id
    LEFT JOIN campaigns c
      ON c.org_id = ${orgId}::uuid AND c.type = 'drip' AND c.status = 'active'
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
  `)) as unknown as (RawRow & { attr_age_years: number | null })[];

  if (rows.length === 0) return null;
  const head = rows[0];

  // ── rules that block routing to ANY campaign ──────────────────────────────
  const global: Record<string, RuleVerdict> = {};
  const globalDetail: Record<string, string> = {};

  global.opted_out = head.is_opted_out ? "blocked" : "pass";
  if (head.is_opted_out) globalDetail.opted_out = "contact is on the opt-out list";

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
    rules.creative_check = "pass";
    detail.creative_check = "deferred_p5";

    // Caps.
    const capOk = r.cfg_campaign_cap == null || r.journeys_total < r.cfg_campaign_cap;
    rules.campaign_cap = capOk ? "pass" : "blocked";
    if (!capOk) {
      detail.campaign_cap = `campaign cap ${r.cfg_campaign_cap} reached (${r.journeys_total} journeys)`;
    }
    const admOk = r.cfg_admission_cap == null || r.journeys_today < r.cfg_admission_cap;
    rules.routing_daily_admission = admOk ? "pass" : "blocked";
    if (!admOk) {
      detail.routing_daily_admission =
        `today's routing admission cap ${r.cfg_admission_cap} reached ` +
        `(${r.journeys_today} routed today) — this is NOT the send-time daily cap`;
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
  const winner = globallyBlocked
    ? null
    : (candidates
        .filter((c) => c.eligible)
        .sort((a, b) => a.priority - b.priority || b.campaign_id - a.campaign_id)[0] ?? null);

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
  };
}
