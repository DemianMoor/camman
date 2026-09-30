import "server-only";

import { sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/db/client";
import type {
  AudiencePreviewInput,
  AudiencePreviewResult,
  LifecycleAudienceBreakdown,
} from "@/lib/audience-snapshot";
import { inUseSetBody, isDripPostureOn } from "@/lib/drip/in-use";
import {
  lifecycleExclusionLayers,
  offerRuleLayers,
  type EligibilityLayer,
} from "@/lib/sends/eligibility";
import { buildSegmentAudienceClause } from "@/lib/segment-rules-eval";
import { LIFECYCLE_CHIP_STATUSES } from "@/lib/validators/campaigns";

// ⚠️ FROZEN REFERENCE — the campaign audience preview as it was on
// 2026-09-30 (origin/main 94bc329d), before Task 2 rebuilt it.
//
// WHAT IT IS FOR. Two jobs, both temporary:
//   1. The parity oracle. scripts/verify-preview-parity.ts runs this and the
//      live previewAudience inside ONE read-only REPEATABLE READ transaction
//      and diffs every field. Task 2 may change how the live one computes;
//      it may not change a single number.
//   2. The kill switch (T1b). AUDIENCE_PREVIEW_IMPL=reference routes the
//      preview here, so a production problem is one env change away.
//
// DO NOT EDIT THE LOGIC. The bodies below are copied verbatim from
// lib/audience-snapshot.ts. Two changes only: the optional `runner` (the
// same one previewAudience got in T1) so the verifier can put both in one
// transaction, and `buildGroupMembershipClause` is exported so ./timing.ts can
// time segment evaluation against the same group universe. A fix to the live preview is NOT applied here — the difference
// is exactly what the verifier exists to show.
//
// ONE DELIBERATE EXCEPTION, applied to both copies in the same PR: the
// zero-chip fix of 2026-09-30 (a lifecycle preview with no chip selected
// 500ed with 42703). It is a bug fix outside Task 2, and the kill switch must
// not bring the 500 back. Anything else that changes here is a mistake.
//
// WHAT IS NOT COPIED, and why that is safe: the segment evaluator, the drip
// in-use set, the send path's layer builders (lifecycleExclusionLayers /
// offerRuleLayers) and LIFECYCLE_CHIP_STATUSES. Task 2 does not touch any of
// them (plan §3: segment evaluation and the send path are out of scope; the
// 4a gate guards the send path). If a Task 2 change ever needs to, freeze that
// function in here FIRST, or the oracle moves with the thing it checks.
//
// REMOVED TOGETHER WITH THE KILL SWITCH, in one PR, once Task 2 is accepted.

export type PreviewRunner = Pick<typeof db, "transaction">;

export function buildGroupMembershipClause(
  orgId: string,
  contactGroupIds: number[],
): SQL | null {
  if (contactGroupIds.length === 0) return null;
  // Landline hard stop (migration 0096): join contacts and keep only
  // messaging_status='eligible' (LITERAL, not a bind). This gates the group
  // dimension the same way buildSegmentAudienceClause gates the segment side, so
  // every consumer (snapshot, preview, draft counts) sees a landline-free audience
  // regardless of how it composes the two dimensions.
  return drizzleSql`
    SELECT ccg.contact_id
    FROM contact_contact_groups ccg
    INNER JOIN contacts c
      ON c.id = ccg.contact_id
      AND c.org_id = ${orgId}::uuid
      AND c.messaging_status = 'eligible'
    WHERE ccg.org_id = ${orgId}::uuid
      AND ccg.contact_group_id = ANY(${drizzleSql.raw(
        "ARRAY[" + contactGroupIds.join(",") + "]::int[]",
      )})
  `;
}

function flagSetCtes(
  orgId: string,
  offerExposureOfferId?: number | null,
  // ⚠️ Drip posture (ruling G2/R14). DEFAULTS FALSE, and the default is the
  // safe one: with it false the emitted `iu_set` is byte-identical to what this
  // function emitted before Phase 4, so regular-campaign activation plans are
  // unchanged BY CONSTRUCTION rather than by measurement. Always-UNION-ing an
  // empty drip branch was measured at +13% plan cost and rejected. The body
  // itself lives in lib/drip/in-use.ts so the SEGMENT-level in-use definition
  // (lib/segment-rules-eval.ts) cannot drift from this one.
  dripPostureOn = false,
  // The lifecycle chip set (PR 4b). Opt-in and null/empty by default, on the
  // same terms as offerExposureOfferId above: when absent the emitted CTE list
  // is byte-for-byte what it was before, so every legacy campaign's plan is
  // unchanged BY CONSTRUCTION rather than by measurement.
  //
  // It is a SET CTE rather than a join to contacts in the candidate relation
  // because that is this file's idiom and because a join would change the
  // emitted SQL for legacy campaigns too. lc_set is one index scan on
  // contacts_org_lifecycle_created_idx (migration 0188).
  lifecycleChips?: string[] | null,
  // The three lifecycle EXCLUSION layers (suppressed / bought_offer /
  // freeze_not_due), when the caller wants to report them. Only the preview
  // does — the send path EXCEPTs them instead. Null everywhere else, so every
  // other caller's CTE list is unchanged.
  lifecycleExclusions?: EligibilityLayer[] | null,
): SQL {
  const base = drizzleSql`
    oo_set as (select distinct contact_id from opt_outs where org_id = ${orgId}::uuid),
    oi_set as (select distinct contact_id from opt_ins where org_id = ${orgId}::uuid),
    cl_set as (select distinct contact_id from clickers where org_id = ${orgId}::uuid),
    iu_set as (${inUseSetBody(orgId, dripPostureOn)}
    )`;
  const withOffer =
    offerExposureOfferId == null
      ? base
      : drizzleSql`${base},
    oe_set as (
      select distinct contact_id from offer_exposures
      where org_id = ${orgId}::uuid and offer_id = ${offerExposureOfferId}::int
    )`;
  // ⚠️ THE EXCLUSION CTEs DO NOT DEPEND ON THE CHIPS. They used to be emitted
  // only inside the `lc_set` branch below, so a lifecycle campaign with ZERO
  // chips selected produced `is_suppressed` columns and `left join lx_*` against
  // CTEs that were never declared — a hard 42P01 ("relation lx_suppressed does
  // not exist"). It stayed hidden because the snapshot never asked for these
  // layers until 2026-09-28 and the preview is rarely run with no chip at all.
  // Emitting them beside lc_set rather than within it makes the two independent,
  // which is what the callers already assume.
  const exclusionCtes = lifecycleExclusionCtes(lifecycleExclusions);
  if (lifecycleChips == null || lifecycleChips.length === 0)
    return drizzleSql`${withOffer}${exclusionCtes}`;
  return drizzleSql`${withOffer},
    lc_set as (
      select id as contact_id, lifecycle_status from contacts
      where org_id = ${orgId}::uuid
        and lifecycle_status = ANY(${drizzleSql.raw(chipStatusArrayLiteral(lifecycleChips))})
    )${exclusionCtes}`;
}

function lifecycleExclusionCtes(layers?: EligibilityLayer[] | null): SQL {
  if (!layers || layers.length === 0) return drizzleSql``;
  return layers.reduce(
    (acc, l) =>
      drizzleSql`${acc},
    ${drizzleSql.raw(`lx_${l.key}`)} as (${l.sql})`,
    drizzleSql``,
  );
}

function lifecycleBreakdownCols(
  lifecycleRules: boolean,
  excludeInUse: boolean,
  layers?: EligibilityLayer[] | null,
): SQL {
  if (!lifecycleRules) return drizzleSql``;
  const has = (key: string) =>
    layers?.some((l) => l.key === key)
      ? drizzleSql.raw(`is_${key}`)
      : drizzleSql`false`;
  const suppressed = has("suppressed");
  const bought = has("bought_offer");
  const freezeNotDue = has("freeze_not_due");
  const offerLimit = has("offer_limit");
  const offerCooldown = has("offer_cooldown");
  // `has_lifecycle` is only projected when a chip is selected; with none
  // selected the audience is empty and every lead is "status not selected".
  const hasChip = layers
    ? drizzleSql`coalesce(has_lifecycle, false)`
    : drizzleSql`false`;

  // The sending audience, i.e. exactly what total_matching counts.
  const sending = drizzleSql`is_eligible and membership_ok`;
  const byStatus = LIFECYCLE_CHIP_STATUSES.reduce(
    (acc, st, i) => drizzleSql`${acc}${i === 0 ? drizzleSql`` : drizzleSql`,`}
        ${drizzleSql.raw(`'${st}'`)}, count(*) filter (where ${sending} and lifecycle_status = ${st})`,
    drizzleSql``,
  );

  // ⚠️ ORDER CHANGED 2026-09-28, along with the two new buckets. bought_offer
  // and freeze_not_due joined the chain when they stopped being a send-time
  // overlay and became audience exclusions, and `status_not_selected` moved
  // AHEAD of the cohort-specific layers.
  //
  // That move matters: a campaign targeting Hot would otherwise report
  // thousands of "freeze not due" against people who were never candidates for
  // it. The old ordering did exactly that with the offer buckets — a cooldown
  // bucket reading 117,975 beside an audience of 1,907. A bucket must only ever
  // describe the cohort the operator actually asked for, or it is noise that
  // looks like a finding.
  const inCohort = drizzleSql`membership_ok and not has_opt_out
        and not ${suppressed} and ${hasChip}`;
  return drizzleSql`,
      jsonb_build_object(${byStatus}) as lc_by_status,
      count(*) filter (where membership_ok and has_opt_out)::int as lc_excl_opted_out,
      count(*) filter (where membership_ok and not has_opt_out
        and ${suppressed})::int as lc_excl_suppressed,
      count(*) filter (where membership_ok and not has_opt_out
        and not ${suppressed} and not ${hasChip})::int as lc_excl_status_not_selected,
      count(*) filter (where ${inCohort} and ${bought})::int as lc_excl_bought_offer,
      count(*) filter (where ${inCohort} and not ${bought}
        and ${freezeNotDue})::int as lc_excl_freeze_not_due,
      count(*) filter (where ${inCohort} and not ${bought} and not ${freezeNotDue}
        and ${offerLimit})::int as lc_excl_offer_limit,
      count(*) filter (where ${inCohort} and not ${bought} and not ${freezeNotDue}
        and not ${offerLimit} and ${offerCooldown})::int as lc_excl_offer_cooldown,
      count(*) filter (where ${inCohort} and not ${bought} and not ${freezeNotDue}
        and not ${offerLimit} and not ${offerCooldown}
        and ${excludeInUse}::boolean and is_in_use_elsewhere)::int as lc_excl_in_use_elsewhere`;
}

function lifecycleFlagCols(layers?: EligibilityLayer[] | null): SQL {
  if (!layers || layers.length === 0) return drizzleSql``;
  return layers.reduce(
    (acc, l) => {
      const t = drizzleSql.raw(`lx_${l.key}`);
      const col = drizzleSql.raw(`is_${l.key}`);
      return drizzleSql`${acc}, (${t}.contact_id is not null) as ${col}`;
    },
    drizzleSql``,
  );
}

function lifecycleExclusionJoins(
  alias: string,
  layers?: EligibilityLayer[] | null,
): SQL {
  if (!layers || layers.length === 0) return drizzleSql``;
  const a = drizzleSql.raw(alias);
  return layers.reduce(
    (acc, l) => {
      const t = drizzleSql.raw(`lx_${l.key}`);
      return drizzleSql`${acc}
    left join ${t} on ${t}.contact_id = ${a}.contact_id`;
    },
    drizzleSql``,
  );
}

function flagJoins(
  alias: string,
  includeOfferExposure = false,
  includeLifecycle = false,
  lifecycleExclusions?: EligibilityLayer[] | null,
): SQL {
  const a = drizzleSql.raw(alias);
  const base = drizzleSql`
    left join oo_set on oo_set.contact_id = ${a}.contact_id
    left join oi_set on oi_set.contact_id = ${a}.contact_id
    left join cl_set on cl_set.contact_id = ${a}.contact_id
    left join iu_set on iu_set.contact_id = ${a}.contact_id`;
  const withOffer = !includeOfferExposure
    ? base
    : drizzleSql`${base}
    left join oe_set on oe_set.contact_id = ${a}.contact_id`;
  if (!includeLifecycle)
    return drizzleSql`${withOffer}${lifecycleExclusionJoins(alias, lifecycleExclusions)}`;
  return drizzleSql`${withOffer}
    left join lc_set on lc_set.contact_id = ${a}.contact_id${lifecycleExclusionJoins(alias, lifecycleExclusions)}`;
}

function expandCarrierSelection(sel: string[]): string[] {
  const out = new Set<string>();
  for (const c of sel) {
    out.add(c);
    if (c === "Unknown") out.add("Unmapped");
  }
  return [...out];
}

function carrierArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY['__none__']::text[]";
  return (
    "ARRAY[" +
    values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",") +
    "]::text[]"
  );
}

function chipStatusArrayLiteral(values: string[]): string {
  const allowed = new Set<string>(LIFECYCLE_CHIP_STATUSES);
  const safe = [...new Set(values.filter((v) => allowed.has(v)))];
  if (safe.length === 0) return "ARRAY[]::text[]";
  return "ARRAY[" + safe.map((v) => `'${v}'`).join(",") + "]::text[]";
}

function lifecycleChipPredicate(
  filters: {
    include_no_status?: boolean | null;
    include_opt_in?: boolean | null;
    include_clickers?: boolean | null;
    include_not_clicked?: boolean | null;
    lifecycle_statuses?: string[] | null;
  },
  opts: { alias?: string; lifecycleRules?: boolean } = {},
): SQL {
  if (opts.lifecycleRules) {
    // ── The lifecycle chips (PR 4b) ────────────────────────────────────────
    // Reads contacts.lifecycle_status, the migration-0188 projection: NOT NULL
    // with default 'new', carrying the same value as contact_engagement.status
    // (the job writes both in one transaction) and indexed. So no coalesce and
    // no join — see docs/04-features/contact-lifecycle.md §3a.
    //
    // 'suppressed' is never a chip and is always excluded (spec §7.1); that is
    // an eligibility LAYER, not an audience choice, so it is absent here.
    const wanted = Array.isArray(filters.lifecycle_statuses)
      ? filters.lifecycle_statuses.filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    // The one-chip minimum is enforced by the form and by the create/PATCH
    // validators. Reaching here with an empty set means BOTH failed, and of the
    // two readings "match everybody" is the dangerous one — a campaign that
    // silently addresses the whole contact base. Match nobody instead.
    if (wanted.length === 0) return drizzleSql`false`;
    // Membership in lc_set, the CTE flagSetCtes emits when chips are present —
    // the same shape as every other flag here, and projected into the candidate
    // relation by flagJoins as `has_lifecycle`.
    const q = opts.alias ? `${opts.alias}.` : "";
    return drizzleSql`${drizzleSql.raw(`${q}has_lifecycle`)}`;
  }
  const q = opts.alias ? `${opts.alias}.` : "";
  const optIn = drizzleSql.raw(`${q}has_opt_in`);
  const clicker = drizzleSql.raw(`${q}has_clicker`);
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;
  return drizzleSql`(
        (${includeNoStatus}::boolean and not ${optIn} and not ${clicker})
        or (${includeOptIn}::boolean and ${optIn})
        or (${includeClickers}::boolean and ${clicker})
        or (${includeNotClicked}::boolean and not ${clicker})
      )`;
}

function hasAnySource(input: AudiencePreviewInput): boolean {
  return (
    input.segmentIds.length > 0 || (input.contactGroupIds?.length ?? 0) > 0
  );
}

export async function referencePreviewAudience(
  input: AudiencePreviewInput,
  runner?: PreviewRunner,
): Promise<AudiencePreviewResult> {
  const cap = input.cap ?? null;
  if (!hasAnySource(input)) {
    return {
      count: 0,
      total_matching: 0,
      applied_cap: cap,
      from_segments: 0,
      from_groups: 0,
      overlap: 0,
      excluded_by_segments: 0,
      excluded_for_optout: 0,
      in_use_in_other_campaigns: 0,
      got_offer_in_prior_campaign: 0,
      carrier_removed: {},
    };
  }

  const {
    orgId,
    segmentIds,
    excludeSegmentIds = [],
    contactGroupIds = [],
    filters,
  } = input;
  const lifecycleRules = input.lifecycleRules === true;
  // Only emitted for a lifecycle campaign; a legacy one passes null and the CTE
  // list stays byte-identical to before PR 4b.
  const lifecycleChips = lifecycleRules
    ? ((filters.lifecycle_statuses as string[] | undefined) ?? [])
    : null;
  const useLifecycle = lifecycleChips != null && lifecycleChips.length > 0;
  // The SAME three fragments the send path EXCEPTs — reported here instead of
  // subtracted, so "why isn't this lead in the audience" and "why didn't this
  // lead get the message" can never give different answers.
  // ⚠️ The offer rules are reported here too, because PR 4d makes them
  // AUDIENCE exclusions — they replace the permanent "ever got this offer"
  // DELETE, so a lead they catch never reaches the pool. Reporting them beside
  // the send-time layers would say the opposite.
  const offerRulesOn =
    input.excludePriorOffer === true && input.offerRulesEnabled === true;
  const lifecycleExclusions = lifecycleRules
    ? [
        ...lifecycleExclusionLayers({ orgId, offerId: input.offerId ?? null }),
        ...(offerRulesOn
          ? offerRuleLayers({
              orgId,
              offerId: input.offerId ?? null,
              // No campaign exists yet at preview time, so nothing can be
              // "the current campaign" to carve out. Every row counts — which
              // is the honest preview of a campaign that has sent nothing.
              currentCampaignId: -1,
              cooldownDays: input.offerCooldownDays ?? 7,
              limitTimes: input.offerLimitTimes ?? 5,
            })
          : []),
      ]
    : null;
  const excludeInUse = input.excludeInUse === true;
  // Content-dedup LAYER 3: only computed when the toggle is on AND an offer is
  // set. When off, `offerExposureId` stays null so flagSetCtes/flagJoins emit
  // the exact same SQL as before — no oe_set CTE, no extra join.
  //
  // ⚠️ AND NOT WHEN THE Y/N RULES ARE ON. PR 4d made the cooldown/limit pair
  // REPLACE the permanent "ever got this offer" rule, and snapshotAudience does
  // exactly that — it builds its qualifier with excludePriorOffer: false and
  // then runs one DELETE or the other. This function did not get that change,
  // so the preview applied the permanent rule as well and the two disagreed.
  //
  // Measured on production before the fix, Hot/Warm × three Weight Loss groups
  // × one offer, cooldown 30 / limit 5: the preview showed **77** while
  // activation would freeze **1,907**. The 77 was exactly "never received this
  // offer, ever" — the 1,830 contacts who had it once or twice and have since
  // rested past their cooldown were on screen as excluded, and would have been
  // sent to anyway. The operator sizes a campaign from this number.
  const excludePriorOffer = input.excludePriorOffer === true && !offerRulesOn;
  const offerExposureId =
    excludePriorOffer && input.offerId != null ? input.offerId : null;
  const useOfferExposure = offerExposureId != null;
  // Campaign carrier filter (migration 0098). Only wire the contacts join +
  // carrier logic when a filter is set, so the common no-filter preview is byte-for-
  // byte unchanged (no perf regression). Unidentified is never selectable, so it is
  // always in the "removed" set once any filter is active.
  // ⚠️ THE OFFER RULES ARE SUBTRACTED HERE, not merely counted. They are
  // AUDIENCE exclusions (PR 4d): a lead they catch never reaches the pool, and
  // snapshotAudience DELETEs them. Reporting them in `excluded` while leaving
  // them inside total_matching said "excluded" about people the screen was
  // still counting as sendable — the buckets read 117,975 while the audience
  // did not move when the cooldown was set to 0, which is how the omission was
  // found.
  //
  // ⚠️ AND SO IS EVERY OTHER LIFECYCLE LAYER, since 2026-09-28 (owner): "the
  // audience on the campaign configuration level should only show allowed
  // sendable contacts... that should be the rule for every lifecycle cohort."
  // freeze_not_due and bought_offer used to be reported as a `send_time`
  // overlay — leads counted INSIDE total_matching that the send would skip.
  // That is what let a freeze-cohort campaign size itself at 1,500 and then
  // send to 28. The term below is now built from the whole layer list, so a
  // layer added later is subtracted by construction rather than by someone
  // remembering to extend this expression.
  const exclusionTerm = (lifecycleExclusions ?? []).reduce(
    (acc, l) =>
      drizzleSql`${acc}
          and not coalesce(q.${drizzleSql.raw(`is_${l.key}`)}, false)`,
    drizzleSql``,
  );
  const carrierFilter = input.filters.carrier_filter ?? [];
  const hasCarrierFilter = carrierFilter.length > 0;
  const carrierMatchSql = hasCarrierFilter
    ? drizzleSql`carrier_norm = ANY(${drizzleSql.raw(carrierArrayLiteral(expandCarrierSelection(carrierFilter)))})`
    : drizzleSql`true`;
  const carrierJoin = hasCarrierFilter
    ? drizzleSql`inner join contacts pc on pc.id = s.contact_id`
    : drizzleSql``;
  const carrierCol = hasCarrierFilter
    ? drizzleSql`, pc.carrier_norm`
    : drizzleSql``;
  // When BOTH dimensions are selected the audience is their INTERSECTION:
  // a contact must be in EVERY selected segment AND in a selected group. With
  // only one dimension populated, that side stands alone (no intersection).
  const bothSides = segmentIds.length > 0 && contactGroupIds.length > 0;

  // Group side, built first so it can double as the is_not universe
  // restriction for the segment evaluation when both dimensions are present
  // (see buildSegmentAudienceClause). This is the key perf lever: it keeps a
  // near-universal `is_not` rule from materializing the entire contacts table
  // before the intersection narrows it to the group.
  const groupClause = buildGroupMembershipClause(orgId, contactGroupIds);
  const restrictUniverse = bothSides ? groupClause! : undefined;

  // Per-source clauses tagged with segment_ord / from_group /
  // from_exclude_segment markers so the aggregate query can attribute each
  // contact to a source and apply the include/exclude membership rule. UNION
  // ALL because the GROUP BY downstream dedupes.
  //
  // Each include-segment branch carries its ORDINAL rather than a boolean:
  // segments AND together, so the membership test is "matched every selected
  // segment", which needs a distinct count, not a BOOL_OR. Group and
  // exclude branches carry a NULL ordinal so they never inflate that count
  // (count(distinct …) ignores NULLs).
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) =>
      buildSegmentAudienceClause(id, orgId, restrictUniverse),
    ),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause, i) => drizzleSql`
      SELECT contact_id, ${i}::int AS segment_ord, false::boolean AS from_group, false::boolean AS from_exclude_segment
      FROM (${clause}) seg_inner
    `,
  );
  const groupBranches = groupClause
    ? [
        drizzleSql`
          SELECT contact_id, null::int AS segment_ord, true::boolean AS from_group, false::boolean AS from_exclude_segment
          FROM (${groupClause}) grp_inner
        `,
      ]
    : [];
  // Exclude-mode segments (migration 0114). Restricted to the group universe
  // when a group is present (final ⊆ group). Tagged from_exclude_segment=true.
  const perExcludeClauses = await Promise.all(
    excludeSegmentIds.map((id) =>
      buildSegmentAudienceClause(
        id,
        orgId,
        contactGroupIds.length > 0 ? groupClause! : undefined,
      ),
    ),
  );
  const excludeBranches = perExcludeClauses.map(
    (clause) => drizzleSql`
      SELECT contact_id, null::int AS segment_ord, false::boolean AS from_group, true::boolean AS from_exclude_segment
      FROM (${clause}) exc_inner
    `,
  );
  const allBranches = [
    ...segmentBranches,
    ...groupBranches,
    ...excludeBranches,
  ];
  const unionedWithSources = allBranches.reduce((acc, branch, i) =>
    i === 0 ? branch : drizzleSql`${acc} UNION ALL ${branch}`,
  );

  // Positive-base membership expression, resolved from which dimensions are
  // populated: include ∩ group when both, else whichever side is present.
  const hasInc = segmentIds.length > 0;
  const hasGrp = contactGroupIds.length > 0;
  // Segments AND together: a contact counts as "from segments" only when it
  // matched EVERY selected segment. This is the preview-side mirror of
  // buildAudienceSourceClause's INTERSECT chain — the two MUST agree or the
  // preview stops predicting what activation actually snapshots.
  const fromSegmentExpr = hasInc
    ? drizzleSql`(s.segments_matched = ${segmentIds.length}::int)`
    : drizzleSql`false`;
  const positiveExpr =
    hasInc && hasGrp
      ? drizzleSql`(q.from_segment and q.from_group)`
      : hasInc
        ? drizzleSql`q.from_segment`
        : hasGrp
          ? drizzleSql`q.from_group`
          : drizzleSql`false`;

  // Drip posture (G2/R14). Read once per call; false means the emitted
  // in-use CTE is byte-identical to pre-Phase-4.
  const dripPostureOn = await isDripPostureOn(orgId);

  // ⚠️ WRAPPED IN A TRANSACTION ONLY SO `SET LOCAL statement_timeout` APPLIES.
  // No temp table: materialising the source and each exclusion layer was tried
  // on 2026-09-30 and measured SLOWER in a controlled interleaved A/B on a
  // quiet database (old 33.6s / 18.5s, materialised 35.1s / 27.8s, identical
  // 25,267 out). An earlier "36.8s -> 25.5s" reading compared runs taken under
  // different load and did not survive the controlled test. The snapshot's
  // temp-table treatment (§10b) earns its keep there and does not here — don't
  // re-derive it for this function without an interleaved measurement.
  const rows = (await (runner ?? db).transaction(async (tx) => {
    // A CEILING ON THE DAMAGE, not a tuning knob. An abandoned HTTP request
    // does NOT cancel the query behind it: Vercel kills the function at 60s and
    // Postgres keeps going. Measured on production 2026-09-30, four preview
    // queries ran at once, the oldest 49s, because the form fired a new one on
    // every edit while the previous kept burning. The client now aborts
    // superseded requests; this is the backstop for everything else -- a
    // bookmarked tab, a retry, a second operator on the same groups. Postgres
    // raises 57014, which the route maps to a sentence the operator can act on.
    await tx.execute(drizzleSql`set local statement_timeout = '30s'`);
    return await tx.execute(drizzleSql`
    with unionized as (${unionedWithSources}),
    sources as (
      select
        contact_id,
        count(distinct segment_ord) as segments_matched,
        bool_or(from_group) as from_group,
        bool_or(from_exclude_segment) as from_exclude_segment
      from unionized
      group by contact_id
    ),
    ${flagSetCtes(orgId, offerExposureId, dripPostureOn, lifecycleChips, lifecycleExclusions)},
    flagged as (
      select
        s.contact_id,
        ${fromSegmentExpr} as from_segment,
        s.from_group,
        s.from_exclude_segment,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere,
        ${
          useOfferExposure
            ? drizzleSql`(oe_set.contact_id is not null)`
            : drizzleSql`false`
        } as is_offer_exposed${carrierCol}
        ${
          useLifecycle
            ? drizzleSql`, (lc_set.contact_id is not null) as has_lifecycle,
          lc_set.lifecycle_status as lifecycle_status`
            : lifecycleRules
              ? // ZERO chips on a lifecycle campaign: nothing is selected, so the
                // audience is empty — but the breakdown columns still read these
                // two, and without them Postgres raised 42703 and the route
                // 500ed (2026-09-30). Projected as "no chip matched"; the legacy
                // path stays byte-identical.
                drizzleSql`, false as has_lifecycle, null::text as lifecycle_status`
              : drizzleSql``
        }
        ${lifecycleFlagCols(lifecycleExclusions)}
      from sources s
      ${flagJoins("s", useOfferExposure, useLifecycle, lifecycleExclusions)}
      ${carrierJoin}
    ),
    qualified as (
      select
        f.*,
        (
          not has_opt_out and ${lifecycleChipPredicate(filters, { lifecycleRules })}
        ) as qualifies
      from flagged f
    ),
    eligible as (
      -- The actual pool the cap samples from. When the campaign-level
      -- exclude_in_use flag is on, in-use contacts are dropped here so
      -- total_matching reflects the unused pool.
      --   membership_positive = the positive base (include ∩ group, or the
      --     single populated dimension).
      --   membership_ok = positive base MINUS exclude-mode segments (0114).
      -- A contact only sends when in the positive base and not excluded.
      select
        q.*,
        (
          q.qualifies
          and (not ${excludeInUse}::boolean or not q.is_in_use_elsewhere)
          and (not ${excludePriorOffer}::boolean or not q.is_offer_exposed)
          ${exclusionTerm}
        ) as is_eligible,
        (${positiveExpr}) as membership_positive,
        ((${positiveExpr}) and not q.from_exclude_segment) as membership_ok
      from qualified q
    )
    select
      -- The audience that actually sends = eligible ∩ membership rule ∩ carrier filter.
      count(*) filter (where is_eligible and membership_ok and (${carrierMatchSql}))::int as total_matching,
      -- Per-bucket counts of contacts dropped BY the carrier filter (empty when no
      -- filter). Unidentified is its own line. Reported over the eligible ∩ membership
      -- audience so the UI can show "N removed as unidentified" + per-bucket removals.
      ${
        hasCarrierFilter
          ? drizzleSql`jsonb_build_object(
            'AT&T', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm = 'AT&T'),
            'T-Mobile', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm = 'T-Mobile'),
            'Verizon', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm = 'Verizon'),
            'Other Mobile', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm = 'Other Mobile'),
            'VoIP', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm = 'VoIP'),
            'Unknown', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm in ('Unknown','Unmapped')),
            'Unidentified', count(*) filter (where is_eligible and membership_ok and not (${carrierMatchSql}) and carrier_norm = 'Unidentified')
          )`
          : drizzleSql`'{}'::jsonb`
      } as carrier_removed,
      -- Per-source contributions stay PRE-intersection (eligible on each
      -- side) so the UI can show how the two dimensions narrow down; the
      -- intersection itself is the overlap column, which equals
      -- total_matching when both dimensions are selected.
      count(*) filter (where is_eligible and from_segment)::int as from_segments,
      count(*) filter (where is_eligible and from_group)::int as from_groups,
      count(*) filter (where is_eligible and from_segment and from_group)::int as overlap,
      -- Contacts in the positive base dropped because they belong to an
      -- exclude-mode segment (migration 0114). Zero when no exclude segments.
      count(*) filter (where is_eligible and membership_positive and from_exclude_segment)::int as excluded_by_segments,
      count(*) filter (where has_opt_out)::int as excluded_for_optout,
      -- Reported on the in-audience set (post-intersection, pre in-use
      -- exclusion) so the UI's "N excluded" reflects the real audience.
      count(*) filter (where qualifies and membership_ok and is_in_use_elsewhere)::int as in_use_in_other_campaigns,
      -- In-audience leads who already got this offer (post-intersection, pre
      -- offer exclusion). Zero when the toggle is off (is_offer_exposed=false).
      count(*) filter (where qualifies and membership_ok and is_offer_exposed)::int as got_offer_in_prior_campaign
      ${lifecycleBreakdownCols(lifecycleRules, excludeInUse, lifecycleExclusions)}
    from eligible
  `);
  })) as unknown as {
    total_matching: number;
    from_segments: number;
    from_groups: number;
    overlap: number;
    excluded_by_segments: number;
    excluded_for_optout: number;
    in_use_in_other_campaigns: number;
    got_offer_in_prior_campaign: number;
    carrier_removed: Record<string, number>;
    lc_by_status?: Record<string, number>;
    lc_excl_opted_out?: number;
    lc_excl_suppressed?: number;
    lc_excl_status_not_selected?: number;
    lc_excl_bought_offer?: number;
    lc_excl_freeze_not_due?: number;
    lc_excl_offer_limit?: number;
    lc_excl_offer_cooldown?: number;
    lc_excl_in_use_elsewhere?: number;
  }[];

  const row = Array.isArray(rows) ? rows[0] : null;
  const total = row?.total_matching ?? 0;
  const effective = cap !== null && cap < total ? cap : total;
  return {
    count: effective,
    total_matching: total,
    applied_cap: cap,
    from_segments: row?.from_segments ?? 0,
    from_groups: row?.from_groups ?? 0,
    overlap: row?.overlap ?? 0,
    excluded_by_segments: row?.excluded_by_segments ?? 0,
    excluded_for_optout: row?.excluded_for_optout ?? 0,
    in_use_in_other_campaigns: row?.in_use_in_other_campaigns ?? 0,
    got_offer_in_prior_campaign: row?.got_offer_in_prior_campaign ?? 0,
    carrier_removed: row?.carrier_removed ?? {},
    // Absent, not zeroed, for a legacy campaign — see AudiencePreviewResult.
    ...(lifecycleRules
      ? {
          lifecycle: {
            by_status: Object.fromEntries(
              LIFECYCLE_CHIP_STATUSES.map((st) => [
                st,
                Number(row?.lc_by_status?.[st] ?? 0),
              ]),
            ),
            excluded: {
              opted_out: Number(row?.lc_excl_opted_out ?? 0),
              suppressed: Number(row?.lc_excl_suppressed ?? 0),
              status_not_selected: Number(
                row?.lc_excl_status_not_selected ?? 0,
              ),
              bought_offer: Number(row?.lc_excl_bought_offer ?? 0),
              freeze_not_due: Number(row?.lc_excl_freeze_not_due ?? 0),
              in_use_elsewhere: Number(row?.lc_excl_in_use_elsewhere ?? 0),
              offer_limit: Number(row?.lc_excl_offer_limit ?? 0),
              offer_cooldown: Number(row?.lc_excl_offer_cooldown ?? 0),
            },
          } satisfies LifecycleAudienceBreakdown,
        }
      : {}),
  };
}
