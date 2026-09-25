import "server-only";

import { sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { inUseSetBody, isDripPostureOn } from "@/lib/drip/in-use";
import { isStatementTimeout } from "@/lib/db/statement-timeout";

import { EXIT_TIER, campaignTierExpr, tierLiteral } from "./campaign-tier";
import {
  buildStageEligibilityExclusions,
  lifecycleExclusionLayers,
  LIFECYCLE_EXCLUSION_KEYS,
  ZERO_LIFECYCLE_EXCLUSIONS,
  type LifecycleExclusionCounts,
  type EligibilityLayer,
  type EligibilityLayerKey,
  type StageEligibilityParams,
} from "./sends/eligibility";
import { stageRecipientsSql } from "./sends/recipients";
import { splitBucketMatch } from "./sends/split-bucket";
import { buildSegmentAudienceClause } from "./segment-rules-eval";
import { LIFECYCLE_CHIP_STATUSES } from "./validators/campaigns";

// Compose the audience-source set (contact_ids, before status filters /
// opt-out / in-use exclusion) from the two selection dimensions:
//
//   * segments — INTERSECT'd together (a contact must be in EVERY selected
//     segment). Each additional segment can only NARROW the audience.
//   * contact groups — OR'd together (a contact in ANY selected group)
//
// The two dimensions INTERSECT when both are present: a contact must be in
// every selected segment AND in a selected group. When only one dimension is
// populated, that side is used alone (the empty dimension is ignored, not
// treated as "match nothing"). Each `segmentBranch` must already be a plain
// `SELECT contact_id …` (callers subquery-wrap the rule clauses) so the set
// operators here can't be mis-parenthesized by a segment clause's own.
//
// Segments AND-ing together is deliberate (changed 2026-08-17): a "filter-
// shaped" segment such as a lone `is_not` rule matches nearly the whole org,
// so OR-ing it in swamped the audience instead of narrowing it. To OR two
// audiences together, model it as rules inside ONE segment (rule combinator
// `or`) — that's the layer that still supports UNION. Kept in lockstep with
// previewAudience's `segments_matched` membership test; if these two diverge
// the preview stops predicting what activation snapshots.
function buildAudienceSourceClause(
  segmentBranches: SQL[],
  groupClause: SQL | null,
  excludeUnion: SQL | null = null,
): SQL {
  // All-INTERSECT chain: same operator throughout, so left-associativity is
  // unambiguous and no per-step parens are needed.
  const segmentIntersect =
    segmentBranches.length > 0
      ? segmentBranches.reduce((acc, branch, i) =>
          i === 0 ? branch : drizzleSql`${acc} INTERSECT ${branch}`,
        )
      : null;
  // Positive base P: segments ∩ group when both, else whichever side is present.
  // hasAnySource guards the callers, so at least one side is non-null here.
  const positive =
    segmentIntersect && groupClause
      ? drizzleSql`(${segmentIntersect}) INTERSECT (${groupClause})`
      : ((segmentIntersect ?? groupClause) as SQL);
  // Subtract the exclude-mode segments (migration 0114). No-op when none.
  if (excludeUnion) {
    return drizzleSql`(${positive}) EXCEPT (${excludeUnion})`;
  }
  return positive;
}

// Build the UNION of exclude-mode segments' audiences (contact_ids), or null
// when there are none. When a group is present the final audience is a subset
// of the group, so evaluate the exclude segments against the group universe —
// this preserves the same is_not perf lever the include side uses.
async function buildExcludeSegmentUnion(
  orgId: string,
  excludeSegmentIds: number[],
  restrictUniverse: SQL | undefined,
): Promise<SQL | null> {
  if (excludeSegmentIds.length === 0) return null;
  const clauses = await Promise.all(
    excludeSegmentIds.map((id) =>
      buildSegmentAudienceClause(id, orgId, restrictUniverse),
    ),
  );
  const branches = clauses.map(
    (clause) => drizzleSql`SELECT contact_id FROM (${clause}) exc_inner`,
  );
  return branches.reduce((acc, branch, i) =>
    i === 0 ? branch : drizzleSql`${acc} UNION ${branch}`,
  );
}

// The raw contact-group membership clause (`SELECT contact_id …`) for the
// selected groups, or null when none are selected. Reused as both the group
// side of the audience and — when both dimensions are present — the universe
// restriction handed to `buildSegmentAudienceClause` (see below).
function buildGroupMembershipClause(
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

// Deduped per-contact status sets, emitted as CTE bodies to splice into a
// `WITH` list (no leading `with`, no trailing comma). LEFT JOINing these once
// is dramatically cheaper than a correlated `EXISTS (…)` per candidate row —
// the planner builds each hash once instead of probing per row. `clickers` /
// `opt_ins` may be empty, in which case the join is a no-op.
// `offerExposureOfferId` is opt-in and only used by the campaign audience
// preview (content-dedup LAYER 3). When null/undefined the emitted CTE list is
// byte-for-byte identical to before — the shared snapshot/draft callers pass
// nothing and pay no extra cost. When set, an `oe_set` of leads who already
// received that offer is added (single index-only scan on
// offer_exposures(org_id, offer_id, contact_id)).
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
  if (lifecycleChips == null || lifecycleChips.length === 0) return withOffer;
  return drizzleSql`${withOffer},
    lc_set as (
      select id as contact_id, lifecycle_status from contacts
      where org_id = ${orgId}::uuid
        and lifecycle_status = ANY(${drizzleSql.raw(chipStatusArrayLiteral(lifecycleChips))})
    )${lifecycleExclusionCtes(lifecycleExclusions)}`;
}

// The lifecycle exclusion layers as CTEs named lx_<key>. Empty string when
// absent, so the emitted CTE list is unchanged for every caller that passes
// nothing. The SQL bodies come from lib/sends/eligibility.ts — the preview
// reports on the same fragments the send path subtracts.
function lifecycleExclusionCtes(layers?: EligibilityLayer[] | null): SQL {
  if (!layers || layers.length === 0) return drizzleSql``;
  return layers.reduce(
    (acc, l) =>
      drizzleSql`${acc},
    ${drizzleSql.raw(`lx_${l.key}`)} as (${l.sql})`,
    drizzleSql``,
  );
}

// The PR 4b breakdown columns for previewAudience's aggregate. Emits nothing
// for a legacy campaign, so its statement is byte-identical to before.
//
// The excluded_* counters are EXCLUSIVE and ordered: each successive bucket
// carries `not <every earlier predicate>`, so a lead who is suppressed AND in
// use elsewhere is counted once, under suppressed. The order is
// EXCLUSION_PRIORITY's, which is also the order the send path applies them —
// one ordering, not two.
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

  return drizzleSql`,
      jsonb_build_object(${byStatus}) as lc_by_status,
      count(*) filter (where ${sending} and ${freezeNotDue})::int as lc_freeze_not_due,
      count(*) filter (where ${sending} and ${bought})::int as lc_bought_offer,
      count(*) filter (where membership_ok and has_opt_out)::int as lc_excl_opted_out,
      count(*) filter (where membership_ok and not has_opt_out
        and ${suppressed})::int as lc_excl_suppressed,
      count(*) filter (where membership_ok and not has_opt_out
        and not ${suppressed} and not ${hasChip})::int as lc_excl_status_not_selected,
      count(*) filter (where membership_ok and not has_opt_out
        and not ${suppressed} and ${hasChip}
        and ${excludeInUse}::boolean and is_in_use_elsewhere)::int as lc_excl_in_use_elsewhere`;
}

// `is_<key>` booleans for each lifecycle exclusion layer, to be read by the
// FILTER clauses in the preview's aggregate.
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

// The LEFT JOINs that attach the flagSetCtes to a candidate relation aliased
// `alias` (which must expose a `contact_id` column). Pair with the boolean
// expressions `<set>.contact_id is not null` in the SELECT list.
// `includeOfferExposure` must match whether flagSetCtes was given an offer id.
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

export interface AudienceFilters {
  include_no_status?: boolean;
  include_opt_in?: boolean;
  include_clickers?: boolean;
  include_not_clicked?: boolean;
  // Lifecycle chips (PR 4b). Read only when the campaign has
  // lifecycle_rules = true; ignored entirely for a legacy campaign, whose
  // audience is still decided by the four booleans above. 'suppressed' is not
  // a member: suppressed contacts are always excluded, as an eligibility layer.
  lifecycle_statuses?: string[];
  // include_opt_out is implicitly false — opt-outs are always excluded.
  // Optional campaign carrier filter (migration 0098). Non-empty ⇒ only these
  // carrier_norm buckets participate; Unidentified always excluded; 'Unknown'
  // matches ('Unknown','Unmapped'). Applied in the shared builder so the frozen
  // snapshot, the preview, and send-time recompute all agree.
  carrier_filter?: string[];
}

// Expand a carrier selection to the carrier_norm values it matches. 'Unknown'
// also matches 'Unmapped' (the looked-up-undetermined family). Unidentified, if
// somehow present, matches only itself — but it is never a selectable filter value.
function expandCarrierSelection(sel: string[]): string[] {
  const out = new Set<string>();
  for (const c of sel) {
    out.add(c);
    if (c === "Unknown") out.add("Unmapped");
  }
  return [...out];
}

// Text[] literal for a validated carrier set (single-quote escaped).
function carrierArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY['__none__']::text[]";
  return (
    "ARRAY[" +
    values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",") +
    "]::text[]"
  );
}

// Wrap a contact_id-producing source with the campaign carrier filter (join
// contacts, keep only rows whose carrier_norm is in the expanded selection). No-op
// when the filter is empty. carrier_norm literal-ish (validated set) → uses
// contacts_org_carrier_eligible_idx. Returns the (possibly unchanged) source.
function applyCarrierFilter(
  source: SQL,
  orgId: string,
  carrierFilter: string[] | undefined,
): SQL {
  if (!carrierFilter || carrierFilter.length === 0) return source;
  const expanded = carrierArrayLiteral(expandCarrierSelection(carrierFilter));
  return drizzleSql`
    SELECT cf_src.contact_id
    FROM (${source}) cf_src
    INNER JOIN contacts cf_c
      ON cf_c.id = cf_src.contact_id
      AND cf_c.org_id = ${orgId}::uuid
      AND cf_c.carrier_norm = ANY(${drizzleSql.raw(expanded)})
  `;
}

export interface AudiencePreviewInput {
  orgId: string;
  // campaigns.lifecycle_rules (migration 0187). When true the lifecycle chips
  // decide the audience; when false the four legacy chips do, byte-identically
  // to before PR 4b.
  //
  // ⚠️ REQUIRED, and it was optional until it caused a production bug. The
  // "every existing caller keeps today's behaviour without being touched"
  // reasoning was wrong in the one way that mattered: the create-mode PREVIEW
  // and BOTH activation snapshots never passed it, so they silently used the
  // legacy predicate — the chips changed nothing on screen, and a campaign
  // written with lifecycle_rules = true would have FROZEN THE LEGACY AUDIENCE.
  // Optional defaults hide exactly the call sites that were never updated.
  // Required makes the compiler name them, which is how the same field on
  // StageEligibilityParams found its missing callers in 4b.
  lifecycleRules: boolean;
  // The INCLUDE segment set (intersected with groups when both present).
  segmentIds: number[];
  // The EXCLUDE segment set (migration 0114). Members are subtracted from the
  // positive base: audience = (include ∩ group) EXCEPT exclude. Empty = no
  // excludes (current behavior). Disjoint from segmentIds.
  excludeSegmentIds?: number[];
  contactGroupIds?: number[];
  filters: AudienceFilters;
  // Optional cap. When set, the preview returns BOTH the total matching
  // count and the effective count (= min(total, cap)). The snapshot path
  // takes a random sample of `cap` contacts at activation time.
  cap?: number | null;
  // When true, drop any contact already snapshotted into another campaign
  // with status='active' from the WHOLE audience (segments + groups). The
  // cap then samples from the remaining unused pool only. Campaign-level
  // counterpart to the per-segment segments.exclude_in_use_contacts flag.
  excludeInUse?: boolean;
  // Content-dedup LAYER 3. When true AND offerId is set, contacts who already
  // received this offer in a previous campaign are dropped, and the preview
  // reports got_offer_in_prior_campaign. Applied by BOTH previewAudience AND the
  // frozen snapshot (buildQualifierFromRelation), so the frozen pool equals the
  // previewed will-send — no surprise re-filter when the stage materializes
  // (changed 2026-07-21; the snapshot was formerly NOT narrowed by this). The
  // send-time layer in lib/sends/eligibility.ts stays on as a live safety net —
  // it catches anyone exposed AFTER activation and protects pools frozen before
  // this change; for a fresh pool it removes ~nobody.
  excludePriorOffer?: boolean;
  // The campaign's offer. Only consumed when excludePriorOffer is true.
  offerId?: number | null;
}

export interface AudienceSnapshotInput extends AudiencePreviewInput {
  campaignId: number;
}

export interface AudiencePreviewResult {
  // Effective count after cap is applied (= total_matching if no cap or
  // if cap >= total_matching). This is the number the campaign will
  // actually send to.
  count: number;
  // Full matching pool size, ignoring any cap. Equal to count when no
  // cap is in effect.
  total_matching: number;
  applied_cap: number | null;
  // Composition breakdown. All counts are post-filter (qualified for
  // sending) unless noted. Sum from_segments + from_groups - overlap =
  // total_matching.
  from_segments: number;
  from_groups: number;
  overlap: number;
  // Count of contacts in the positive base (include ∩ group) who were dropped
  // because they belong to an exclude-mode segment (migration 0114). Zero when
  // no exclude segments are selected. Reported so the UI can show "N excluded
  // by segment".
  excluded_by_segments: number;
  // Count of contacts in the union (across all selected sources) who
  // have an opt_out record and were therefore dropped. Independent of
  // the include_* filter toggles.
  excluded_for_optout: number;
  // Count of qualifying contacts who are also in another *active*
  // campaign's audience_pool. Informational — whether they're excluded
  // from the snapshot depends on the per-segment exclude_in_use_contacts
  // flag (see segments.exclude_in_use_contacts). Drafts and the current
  // campaign itself are not counted as conflicts because they don't have
  // pool rows yet (pools materialize at activation).
  in_use_in_other_campaigns: number;
  // Count of qualifying, in-audience contacts who already received the
  // campaign's offer in a previous campaign (content-dedup LAYER 3). Reported
  // independently of the excludePriorOffer toggle; when the toggle is on these
  // are subtracted from total_matching. A point-in-time estimate — the
  // offer_exposures ledger grows as other campaigns send, so the send-time
  // exclusion can be larger. Zero when no offerId is supplied.
  got_offer_in_prior_campaign: number;
  // Per-bucket counts of contacts dropped by the campaign carrier filter (empty
  // {} when no filter). Keys are the six buckets + 'Unidentified'; 'Unknown'
  // aggregates Unknown+Unmapped. The UI surfaces "N removed as unidentified" and
  // the other non-zero buckets.
  carrier_removed: Record<string, number>;
  // PR 4b. Present ONLY for a lifecycle campaign (lifecycle_rules = true);
  // absent for every legacy one, so the legacy result shape is unchanged.
  lifecycle?: LifecycleAudienceBreakdown;
}

export interface LifecycleAudienceBreakdown {
  // The audience split by status. Keys are LIFECYCLE_CHIP_STATUSES; a status
  // nobody has is 0, not missing. Sums to total_matching.
  by_status: Record<string, number>;
  // ⚠️ TWO KINDS OF NUMBER, and the split is deliberate.
  //
  // `excluded` PARTITIONS the leads that are NOT in the audience: every lead in
  // the segment/group base is either in total_matching or under exactly ONE
  // bucket, counted by the FIRST reason that catches it (EXCLUSION_PRIORITY
  // order). That identity is what makes them worth showing, and
  // scripts/test-lifecycle-preview-breakdown.ts asserts it.
  //
  // The lifecycle reason names come from LifecycleExclusionCounts via Pick/Omit
  // rather than being retyped. `suppressed` is the ONE layer that keeps a lead
  // out of the audience entirely, so it is the one named here; every other
  // layer — including any added later — lands in send_time below, which is the
  // safe default: reported, never silently dropped.
  excluded: Pick<LifecycleExclusionCounts, "suppressed"> & {
    opted_out: number;
    // Their status is not among the selected chips.
    status_not_selected: number;
    // Only counted when exclude_in_use_contacts is ON. With it off these leads
    // DO send, so calling them excluded would be a lie.
    in_use_elsewhere: number;
  };
  // `send_time` OVERLAYS the audience: these leads ARE in it and WILL be
  // snapshotted, but the send-time eligibility layers will skip them on the
  // day. They are subsets of total_matching, NOT buckets, so they do not
  // participate in the identity above — exactly like got_offer_in_prior_campaign
  // already behaves when its toggle is off.
  //
  // Neither is baked into the frozen pool, and neither should be: freeze
  // due-ness moves with the clock, and purchases keep arriving after
  // activation. Freezing either would freeze a decision that has to be made
  // at send time.
  // freeze_not_due: in Freeze AND inside their own cadence right now.
  // bought_offer: already bought this campaign's offer.
  send_time: Omit<LifecycleExclusionCounts, "suppressed">;
}

export interface AudienceSnapshotResult {
  // Number of rows actually inserted into campaign_audience_pool.
  count: number;
  // Full matching pool size before the cap was applied. Equal to count
  // when no cap was in effect.
  total_matching: number;
}

// Compose the raw audience-source set (contact_ids only, before any status
// filter / opt-out / in-use exclusion) from the segment + contact-group
// dimensions. See buildAudienceSourceClause for the intersection semantics.
// Pulled out of the qualifier so the snapshot path can materialize it into a
// temp table (see snapshotAudience).
async function buildAudienceSourceSql(
  // Narrower than AudiencePreviewInput on purpose: this builds the SEGMENT ∩
  // GROUP source set, which is the same whichever predicate then filters it.
  // Taking the full input would force every caller to supply a lifecycleRules
  // this function never reads — and a value invented to satisfy a type is how
  // a meaningless default gets copied into a place that DOES read it.
  input: Omit<AudiencePreviewInput, "lifecycleRules">,
): Promise<SQL> {
  const {
    orgId,
    segmentIds,
    contactGroupIds = [],
    excludeSegmentIds = [],
  } = input;

  // Contact-group clause: every contact tagged with any of the selected
  // groups. Built first so it can double as the universe restriction for the
  // segment evaluation (see below).
  const groupClause = buildGroupMembershipClause(orgId, contactGroupIds);
  const bothSides = segmentIds.length > 0 && contactGroupIds.length > 0;
  const hasGroup = contactGroupIds.length > 0;

  // Per-segment rule-filtered clauses. Each yields a set of contact_ids
  // honoring that segment's rules + manual membership UNION. Subquery-wrap
  // each so its own internal set operators can't bleed into the UNION below.
  // When both dimensions are selected the result is the segment∩group
  // intersection anyway, so we hand the group set as the is_not universe —
  // this keeps a near-universal `is_not` rule from scanning all contacts.
  const restrictUniverse = bothSides ? groupClause! : undefined;
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) =>
      buildSegmentAudienceClause(id, orgId, restrictUniverse),
    ),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause) => drizzleSql`SELECT contact_id FROM (${clause}) seg_inner`,
  );

  // Exclude-mode segments (migration 0114): subtracted from the positive base.
  // Restricted to the group universe when a group is present (final ⊆ group).
  const excludeUnion = await buildExcludeSegmentUnion(
    orgId,
    excludeSegmentIds,
    hasGroup ? groupClause! : undefined,
  );

  return buildAudienceSourceClause(segmentBranches, groupClause, excludeUnion);
}

// Build the SQL that yields one row per qualifying contact_id, with the
// per-contact snapshot booleans materialized, reading candidates from
// `candidateRelation` (a relation exposing a `contact_id` column, e.g. a
// materialized temp table). The qualifier WHERE clause OR-combines the
// filter toggles: a contact is in if ANY enabled category includes them,
// and they're never in if they have any opt-out record for this org.
// Postgres text[] literal for the lifecycle chip set. The values are already
// constrained to LIFECYCLE_CHIP_STATUSES by audienceFiltersSchema, and they are
// re-checked here rather than trusted: this builds a RAW fragment, so a value
// that reached it unvalidated would be an injection point. Anything unrecognised
// is dropped, which can only ever narrow the audience.
function chipStatusArrayLiteral(values: string[]): string {
  const allowed = new Set<string>(LIFECYCLE_CHIP_STATUSES);
  const safe = [...new Set(values.filter((v) => allowed.has(v)))];
  if (safe.length === 0) return "ARRAY[]::text[]";
  return "ARRAY[" + safe.map((v) => `'${v}'`).join(",") + "]::text[]";
}

// ── THE audience chip predicate ────────────────────────────────────────────
// The four campaign-level audience chips (No status / Opt-in / Clickers / Not
// clicked), OR'd together, evaluated against the per-contact has_opt_in /
// has_clicker flags that flagSetCtes + flagJoins produce.
//
// This existed as FIVE byte-identical copies — in buildQualifierFromRelation,
// computeStageAudienceCountForDraft, computeStageAudienceCountsBatchForDraft,
// previewAudience and computeStageEligibilityPreview — each preceded by the
// same four-line local block. Five copies of the predicate that decides who a
// campaign is allowed to message is five chances for them to drift, and the
// frozen pool (copy 1) and the preview the operator approved (copy 4) drifting
// apart is exactly the bug nobody notices until a send goes out wrong.
//
// `alias` exists because the batch-draft copy evaluates the flags through a
// joined relation (`flagged.has_opt_in`) while the other four have them in
// scope unqualified. Same predicate, one extra qualifier.
//
// `lifecycleRules` is the PR 4 switch. In 4a it is always false and this
// function returns exactly today's predicate for every campaign; 4b adds the
// lifecycle-chip branch. Threading it now keeps 4b to one edit here instead of
// five edits across this file.
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

/**
 * TEST SEAM. buildQualifierFromRelation is module-private and is what decides a
 * campaign's frozen pool — it carries copy 1 of the chip predicate. This exposes
 * its SQL (never executed) so scripts/test-eligibility-layers-identical.ts can
 * prove the PR 4a extraction changed nothing. Not used by application code.
 */
export function buildAudienceQualifierForTest(
  input: AudiencePreviewInput,
): SQL {
  return buildQualifierFromRelation(input, drizzleSql`audience_candidates`);
}

function buildQualifierFromRelation(
  input: AudiencePreviewInput,
  candidateRelation: SQL,
  dripPostureOn = false,
): SQL {
  const { orgId, filters } = input;
  const lifecycleRules = input.lifecycleRules === true;
  const excludeInUse = input.excludeInUse === true;
  // Content-dedup LAYER 3, baked into the FROZEN pool (not just the preview).
  // When the campaign opts into offer exclusion AND has an offer, contacts who
  // already received this offer in a previous campaign are dropped at snapshot
  // time, so the frozen pool equals the previewed will-send — no second, surprise
  // filtering when the stage materializes. Mirrors previewAudience's is_eligible
  // predicate EXACTLY (same flagSetCtes/flagJoins + oe_set) so the two counts
  // agree. Off (or no offer) ⇒ offerExposureId is null and the emitted SQL is
  // byte-for-byte the pre-LAYER-3 qualifier (no oe_set CTE, no extra join). The
  // send-time layer (lib/sends/eligibility.ts) stays on as a live safety net —
  // it catches anyone exposed AFTER activation and protects pools frozen before
  // this change; for a fresh pool it now removes ~nobody.
  const excludePriorOffer = input.excludePriorOffer === true;
  const offerExposureId =
    excludePriorOffer && input.offerId != null ? input.offerId : null;
  const useOfferExposure = offerExposureId != null;
  // Only emitted for a lifecycle campaign; a legacy one passes null and the CTE
  // list stays byte-identical to before PR 4b.
  const lifecycleChips = lifecycleRules
    ? ((filters.lifecycle_statuses as string[] | undefined) ?? [])
    : null;
  const useLifecycle = lifecycleChips != null && lifecycleChips.length > 0;

  return drizzleSql`
    with ${flagSetCtes(orgId, offerExposureId, dripPostureOn, lifecycleChips)},
    flagged as (
      select
        cand.contact_id,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere,
        ${
          useOfferExposure
            ? drizzleSql`(oe_set.contact_id is not null)`
            : drizzleSql`false`
        } as is_offer_exposed
        ${
          useLifecycle
            ? drizzleSql`, (lc_set.contact_id is not null) as has_lifecycle`
            : drizzleSql``
        }
      from ${candidateRelation} cand
      ${flagJoins("cand", useOfferExposure, useLifecycle)}
    )
    select
      contact_id,
      has_opt_in as was_opt_in,
      has_clicker as was_clicker,
      (not has_opt_in and not has_clicker) as was_no_status
    from flagged
    where has_opt_out = false
      and ${lifecycleChipPredicate(filters, { lifecycleRules })}
      and (not ${excludeInUse}::boolean or not is_in_use_elsewhere)
      and (not ${excludePriorOffer}::boolean or not is_offer_exposed)
  `;
}

function hasAnySource(input: AudiencePreviewInput): boolean {
  return (
    input.segmentIds.length > 0 || (input.contactGroupIds?.length ?? 0) > 0
  );
}

// Stage-level filter toggles. Mutex on include_clickers / exclude_clickers
// is enforced upstream (validator + DB check constraint).
export interface StageAudienceFilters {
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  // Optional A/B partition. When both are set, the audience is filtered
  // by `mod(hashtext(contact_id::text), split_total) = split_index - 1`.
  // Either-NULL ⇒ no partition. Bounds are enforced by the DB CHECK.
  split_index?: number | null;
  split_total?: number | null;
}

export interface StageAudienceCountResult {
  count: number;
  breakdown: {
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  };
}

// Compute the resolved audience count + breakdown for a stage's filters on
// top of a campaign's frozen pool, with live opt-outs excluded. Shared by
// the audience-preview endpoint (hypothetical filters posted in the body),
// the audience-count endpoint (filters read from the saved stage row), and
// the stages list endpoint (per-row audience_count column).
//
// One round-trip per call. The caller is responsible for verifying the
// campaign belongs to the org BEFORE calling — this function trusts that
// (campaignId, orgId) was already authorized.
export async function computeStageAudienceCount(
  campaignId: number,
  orgId: string,
  filters: StageAudienceFilters,
): Promise<StageAudienceCountResult> {
  const { include_no_status, include_clickers, exclude_clickers } = filters;
  const splitIndex = filters.split_index ?? null;
  const splitTotal = filters.split_total ?? null;
  const splitActive = splitIndex !== null && splitTotal !== null;
  // Row-number partitioning instead of hash partitioning so splits are
  // ALWAYS as equal as possible: every sibling gets either floor(N/M)
  // or ceil(N/M) contacts, never the ±2-5% variance hashtext produces.
  // The qualifying set is established first (opt-outs excluded, stage
  // filters applied), then ROW_NUMBER over a stable ORDER BY contact_id
  // assigns each contact to a bucket = (rn-1) % split_total. Bucket
  // membership is stable across previews so long as the qualifying set
  // is stable (i.e. same filter on each sibling, as the split endpoint
  // clones).
  const rows = (await db.execute(drizzleSql`
    with joined as (
      select
        p.contact_id,
        p.was_clicker_at_snapshot,
        p.was_no_status_at_snapshot,
        exists (
          select 1 from opt_outs oo
          where oo.contact_id = p.contact_id and oo.org_id = ${orgId}::uuid
        ) as is_opt_out_now
      from campaign_audience_pool p
      where p.campaign_id = ${campaignId}::int and p.org_id = ${orgId}::uuid
    ),
    qualified as (
      select
        contact_id,
        was_clicker_at_snapshot,
        was_no_status_at_snapshot
      from joined
      where not is_opt_out_now
        and (
          (${include_no_status}::boolean and was_no_status_at_snapshot)
          or (${include_clickers}::boolean and was_clicker_at_snapshot)
        )
        and not (${exclude_clickers}::boolean and was_clicker_at_snapshot)
    )
    select
      count(*) filter (
        where not ${splitActive}::boolean
          or ${splitBucketMatch(drizzleSql`contact_id`, drizzleSql`${splitTotal ?? 1}`, drizzleSql`${splitIndex ?? 1}`)}
      )::int as count,
      (select count(*) from joined where not is_opt_out_now and was_no_status_at_snapshot)::int as no_status,
      (select count(*) from joined where not is_opt_out_now and was_clicker_at_snapshot)::int as clickers,
      (select count(*) from joined where is_opt_out_now)::int as excluded_for_optout
    from qualified
  `)) as unknown as {
    count: number;
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  }[];

  const row = rows[0] ?? {
    count: 0,
    no_status: 0,
    clickers: 0,
    excluded_for_optout: 0,
  };
  return {
    count: row.count,
    breakdown: {
      no_status: row.no_status,
      clickers: row.clickers,
      excluded_for_optout: row.excluded_for_optout,
    },
  };
}

// Projected stage audience for *draft* campaigns whose pool hasn't been
// frozen yet. Computes the count live against the campaign's selected
// segments + contact groups + campaign-level filters, then layers the
// stage filters on top. Returns the same shape as
// computeStageAudienceCount for a drop-in swap at the call site.
//
// Cap is honored as a clamp on the final count (the at-activation
// snapshot will random-sample, but for preview a clamp gives the right
// upper bound). Splits are honored by ANDing the hashtext partition
// into the WHERE.
//
// This intentionally lives parallel to previewAudience instead of
// merging: previewAudience handles the campaign-level question ("how
// many contacts would this campaign reach if activated now"), whereas
// this answers the stage-level question ("how many would THIS stage
// reach inside that campaign"). The two queries share buildSegment-
// AudienceClause and the qualifier SQL, but the SELECT shape differs.
export async function computeStageAudienceCountForDraft(
  campaign: {
    id: number;
    orgId: string;
    segmentIds: number[];
    excludeSegmentIds?: number[];
    contactGroupIds: number[];
    filters: AudienceFilters;
    cap: number | null;
    excludeInUse?: boolean;
    // campaigns.lifecycle_rules — see AudiencePreviewInput.
    lifecycleRules?: boolean;
  },
  stageFilters: StageAudienceFilters,
): Promise<StageAudienceCountResult> {
  const { orgId, segmentIds, contactGroupIds, filters, cap } = campaign;
  const excludeSegmentIds = campaign.excludeSegmentIds ?? [];
  const lifecycleRules = campaign.lifecycleRules === true;
  // Only emitted for a lifecycle campaign; a legacy one passes null and the
  // CTE list stays byte-identical to before PR 4b.
  const lifecycleChips = lifecycleRules
    ? ((filters.lifecycle_statuses as string[] | undefined) ?? [])
    : null;
  const useLifecycle = lifecycleChips != null && lifecycleChips.length > 0;
  const excludeInUse = campaign.excludeInUse === true;
  // No audience source on the parent campaign → trivially zero.
  if (segmentIds.length === 0 && contactGroupIds.length === 0) {
    return {
      count: 0,
      breakdown: { no_status: 0, clickers: 0, excluded_for_optout: 0 },
    };
  }

  const stageIncludeNoStatus = stageFilters.include_no_status;
  const stageIncludeClickers = stageFilters.include_clickers;
  const stageExcludeClickers = stageFilters.exclude_clickers;
  const splitIndex = stageFilters.split_index ?? null;
  const splitTotal = stageFilters.split_total ?? null;
  const splitActive = splitIndex !== null && splitTotal !== null;

  // Mirror previewAudience's source composition — segments AND together,
  // groups OR together, the two dimensions INTERSECT when both are present.
  // The group set doubles as the is_not universe restriction when both
  // dimensions are present (perf — see buildSegmentAudienceClause).
  const groupClause = buildGroupMembershipClause(orgId, contactGroupIds);
  const bothSides = segmentIds.length > 0 && contactGroupIds.length > 0;
  const restrictUniverse = bothSides ? groupClause! : undefined;
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) =>
      buildSegmentAudienceClause(id, orgId, restrictUniverse),
    ),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause) => drizzleSql`SELECT contact_id FROM (${clause}) seg_inner`,
  );
  // Exclude-mode segments subtracted from the base (migration 0114).
  const excludeUnion = await buildExcludeSegmentUnion(
    orgId,
    excludeSegmentIds,
    contactGroupIds.length > 0 ? groupClause! : undefined,
  );
  const source = applyCarrierFilter(
    buildAudienceSourceClause(segmentBranches, groupClause, excludeUnion),
    orgId,
    filters.carrier_filter,
  );
  // Drip posture (G2/R14). Read once per call; false means the emitted
  // in-use CTE is byte-identical to pre-Phase-4.
  const dripPostureOn = await isDripPostureOn(orgId);

  // Row-number partitioning over the qualified set so splits are as
  // equal as possible. Mirrors the active-pool path.
  const rows = (await db.execute(drizzleSql`
    with sources as (
      select distinct contact_id from (${source}) u
    ),
    ${flagSetCtes(orgId, null, dripPostureOn, lifecycleChips)},
    flagged as (
      select
        s.contact_id,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere
        ${
          useLifecycle
            ? drizzleSql`, (lc_set.contact_id is not null) as has_lifecycle`
            : drizzleSql``
        }
      from sources s
      ${flagJoins("s", false, useLifecycle)}
    ),
    qualified as (
      select
        contact_id
      from flagged
      where has_opt_out = false
        and ${lifecycleChipPredicate(filters, { lifecycleRules })}
        and (not ${excludeInUse}::boolean or not is_in_use_elsewhere)
        and (
          (${stageIncludeNoStatus}::boolean and not has_opt_in and not has_clicker)
          or (${stageIncludeClickers}::boolean and has_clicker)
        )
        and not (${stageExcludeClickers}::boolean and has_clicker)
    )
    select
      count(*) filter (
        where not ${splitActive}::boolean
          or ${splitBucketMatch(drizzleSql`contact_id`, drizzleSql`${splitTotal ?? 1}`, drizzleSql`${splitIndex ?? 1}`)}
      )::int as count,
      (select count(*) from flagged
        where has_opt_out = false and not has_opt_in and not has_clicker)::int as no_status,
      (select count(*) from flagged
        where has_opt_out = false and has_clicker)::int as clickers,
      (select count(*) from flagged where has_opt_out)::int as excluded_for_optout
    from qualified
  `)) as unknown as {
    count: number;
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  }[];

  const row = rows[0] ?? {
    count: 0,
    no_status: 0,
    clickers: 0,
    excluded_for_optout: 0,
  };
  // Apply the campaign cap as an upper-bound clamp. At activation the
  // snapshot will random-sample, but a clamp here gives the right
  // ceiling for the preview.
  const cappedCount = cap !== null && cap < row.count ? cap : row.count;
  return {
    count: cappedCount,
    breakdown: {
      no_status: row.no_status,
      clickers: row.clickers,
      excluded_for_optout: row.excluded_for_optout,
    },
  };
}

// ── Batched per-stage audience counts ────────────────────────────────────────
// The stages-list endpoint needs the audience_count for EVERY stage of a
// campaign. Doing that as one query per stage (computeStageAudienceCount* per
// row) is an N+1 that dominates the page's latency. These two functions compute
// the count for MANY non-lane stages in a SINGLE pass and are numerically
// identical to calling the per-stage function for each stage — proven by
// scripts/tmp-verify-batch.ts across real campaigns before this shipped.
//
// Identity argument (must hold for both):
//   • the candidate set (frozen pool, or segment∩group source) is scanned ONCE
//     and is the same set the per-stage query reads;
//   • the live opt-out exclusion is the same membership test — an `oo_set` hash
//     anti-join is logically identical to the per-row `EXISTS (opt_outs …)`
//     (one opt_out row ⇒ excluded; the pool has a unique row per contact so the
//     join can't fan out);
//   • per-stage filters/split come from a per-stage relation, and the split
//     bucket uses ROW_NUMBER() PARTITIONed BY stage_id ORDERed BY contact_id —
//     within each partition that is byte-identical to the per-stage
//     ROW_NUMBER() OVER (ORDER BY contact_id).
// Lane stages (behavioral_tier set) are NOT handled here — they keep using
// countStageRecipients (live tier + aliveness), which is left untouched.

export interface StageCountBatchItem {
  stageId: number;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
}

// One row per stage, as a typed UNION ALL of SELECTs (robust against VALUES
// type inference): stage_id + the three filter booleans + the split bounds.
// The split filter (split_total/split_index null ⇒ no split, else the stable
// hash bucket in BATCH_SPLIT_FILTER) reproduces the per-stage send split exactly.
function buildStagesCte(stages: StageCountBatchItem[]): SQL {
  const rows = stages.map(
    (s) => drizzleSql`select
      ${s.stageId}::int as stage_id,
      ${s.include_no_status}::boolean as inc_ns,
      ${s.include_clickers}::boolean as inc_cl,
      ${s.exclude_clickers}::boolean as exc_cl,
      ${s.split_index}::int as split_index,
      ${s.split_total}::int as split_total`,
  );
  return rows.reduce((acc, r, i) =>
    i === 0 ? r : drizzleSql`${acc} union all ${r}`,
  );
}

const BATCH_SPLIT_FILTER = drizzleSql`count(*) filter (
        where split_total is null or split_index is null
          or ${splitBucketMatch(drizzleSql`contact_id`, drizzleSql`split_total`, drizzleSql`split_index`)}
      )::int as count`;

// Batched equivalent of computeStageAudienceCount(...).count for the ACTIVE
// (frozen-pool) path. Returns stage_id → count; a stage with zero qualifying
// contacts is absent from the map (the caller defaults it to 0, matching the
// per-stage function which returns count 0).
export async function computeStageAudienceCountsBatch(
  campaignId: number,
  orgId: string,
  stages: StageCountBatchItem[],
): Promise<Map<number, number>> {
  if (stages.length === 0) return new Map();
  const stagesCte = buildStagesCte(stages);
  const rows = (await db.execute(drizzleSql`
    with oo_set as (
      select distinct contact_id from opt_outs where org_id = ${orgId}::uuid
    ),
    -- MATERIALIZED: compute the pool ∩ opt-out base ONCE, then the per-stage
    -- relation cross-joins it. Without this the planner can re-scan the base per
    -- stage in a nested loop (one statement doing N× the work) instead of N
    -- cheap statements.
    base as materialized (
      select
        p.contact_id,
        p.was_clicker_at_snapshot,
        p.was_no_status_at_snapshot,
        (oo_set.contact_id is not null) as is_opt_out_now
      from campaign_audience_pool p
      left join oo_set on oo_set.contact_id = p.contact_id
      where p.campaign_id = ${campaignId}::int and p.org_id = ${orgId}::uuid
    ),
    st as (${stagesCte}),
    qualified as (
      select
        st.stage_id,
        st.split_index,
        st.split_total,
        base.contact_id
      from st
      join base on
        not base.is_opt_out_now
        and (
          (st.inc_ns and base.was_no_status_at_snapshot)
          or (st.inc_cl and base.was_clicker_at_snapshot)
        )
        and not (st.exc_cl and base.was_clicker_at_snapshot)
    )
    select stage_id, ${BATCH_SPLIT_FILTER}
    from qualified
    group by stage_id
  `)) as unknown as { stage_id: number; count: number }[];
  return new Map(rows.map((r) => [Number(r.stage_id), Number(r.count)]));
}

// Batched equivalent of computeStageAudienceCountForDraft(...).count for the
// DRAFT (projected) path. Source set is built ONCE (it depends only on the
// campaign, not the stage) — the per-stage function rebuilt it for every stage.
export async function computeStageAudienceCountsBatchForDraft(
  campaign: {
    id: number;
    orgId: string;
    segmentIds: number[];
    excludeSegmentIds?: number[];
    contactGroupIds: number[];
    filters: AudienceFilters;
    cap: number | null;
    excludeInUse?: boolean;
    // campaigns.lifecycle_rules — see AudiencePreviewInput.
    lifecycleRules?: boolean;
  },
  stages: StageCountBatchItem[],
): Promise<Map<number, number>> {
  if (stages.length === 0) return new Map();
  const { orgId, segmentIds, contactGroupIds, filters, cap } = campaign;
  const excludeInUse = campaign.excludeInUse === true;
  const lifecycleRules = campaign.lifecycleRules === true;
  // Only emitted for a lifecycle campaign; a legacy one passes null and the
  // CTE list stays byte-identical to before PR 4b.
  const lifecycleChips = lifecycleRules
    ? ((filters.lifecycle_statuses as string[] | undefined) ?? [])
    : null;
  const useLifecycle = lifecycleChips != null && lifecycleChips.length > 0;
  // No audience source on the parent campaign → every stage is trivially zero
  // (mirrors computeStageAudienceCountForDraft's short-circuit).
  if (segmentIds.length === 0 && contactGroupIds.length === 0) {
    return new Map(stages.map((s) => [s.stageId, 0]));
  }

  // Identical source composition to computeStageAudienceCountForDraft (it uses
  // the same buildAudienceSourceSql logic inline).
  const source = await buildAudienceSourceSql({
    orgId,
    segmentIds,
    excludeSegmentIds: campaign.excludeSegmentIds ?? [],
    contactGroupIds,
    filters,
    excludeInUse,
  });
  // Drip posture (G2/R14). Read once per call; false means the emitted
  // in-use CTE is byte-identical to pre-Phase-4.
  const dripPostureOn = await isDripPostureOn(orgId);
  const stagesCte = buildStagesCte(stages);

  const rows = (await db.execute(drizzleSql`
    with sources as (
      select distinct contact_id from (${source}) u
    ),
    ${flagSetCtes(orgId, null, dripPostureOn, lifecycleChips)},
    -- MATERIALIZED is load-bearing: the source set-ops (segment-rule SQL) are
    -- expensive. Computing the flagged set once and reusing it across the
    -- per-stage cross-join keeps the batch at one source evaluation. Without it
    -- the planner can re-evaluate the source per stage inside this single
    -- statement, blowing statement_timeout where the old per-stage path (N
    -- separate statements) did not. MATERIALIZED changes execution, not results.
    flagged as materialized (
      select
        s.contact_id,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere
        ${
          useLifecycle
            ? drizzleSql`, (lc_set.contact_id is not null) as has_lifecycle`
            : drizzleSql``
        }
      from sources s
      ${flagJoins("s", false, useLifecycle)}
    ),
    st as (${stagesCte}),
    qualified as (
      select
        st.stage_id,
        st.split_index,
        st.split_total,
        row_number() over (partition by st.stage_id order by flagged.contact_id) - 1 as rn
      from st
      join flagged on
        flagged.has_opt_out = false
        and ${lifecycleChipPredicate(filters, { alias: "flagged", lifecycleRules })}
        and (not ${excludeInUse}::boolean or not flagged.is_in_use_elsewhere)
        and (
          (st.inc_ns and not flagged.has_opt_in and not flagged.has_clicker)
          or (st.inc_cl and flagged.has_clicker)
        )
        and not (st.exc_cl and flagged.has_clicker)
    )
    select stage_id, ${BATCH_SPLIT_FILTER}
    from qualified
    group by stage_id
  `)) as unknown as { stage_id: number; count: number }[];

  const counts = new Map<number, number>(
    rows.map((r) => [Number(r.stage_id), Number(r.count)]),
  );
  // Per-stage cap clamp, exactly as computeStageAudienceCountForDraft (min(cap, count)).
  const result = new Map<number, number>();
  for (const s of stages) {
    const c = counts.get(s.stageId) ?? 0;
    result.set(s.stageId, cap !== null && cap < c ? cap : c);
  }
  return result;
}

// ── Batched behavioral-lane audience counts ──────────────────────────────────
// Lane stages (behavioral_tier set) show a LIVE preview: alive (received the
// parent position) ∩ exact current tier − opt-outs, purchased (tier 4) excluded. The
// per-lane path (countStageRecipients → campaignTierExpr) recomputes the SAME
// expensive live-tier scan (links⋈clicks + stage_sends) once PER LANE — a
// behavioral split has 3 lanes, so a single page load paid ~3× the same ~6.6s
// query. This computes ALL lanes of one campaign in a SINGLE statement:
//   • the campaign tier map (contact_id → high-water tier) is a MATERIALIZED CTE
//     built ONCE and reused across the per-lane cross-join;
//   • the parent "alive" set (contacts sent the parent stage) is built ONCE for
//     all distinct parents;
//   • each lane is a row in a per-lane CTE, cross-joined to the frozen pool and
//     filtered by its tier / parent / toggles / split — byte-identical logic to
//     stageRecipientsSql's lane overlays, proven equal by scripts/tmp-verify-
//     lane-batch.ts before ship.
// Returns stage_id → count; a lane with zero qualifying contacts is absent from
// the map (caller defaults to 0, matching countStageRecipients returning 0).

export interface LaneCountBatchItem {
  stageId: number;
  behavioralTier: number;
  parentStageId: number | null;
  // 0174 campaign-level split. When the lane's group has a resolved source set,
  // aliveness is "received ANY of these" instead of "received parentStageId".
  // NULL/empty ⇒ the parentStageId path, byte-identical to pre-0174 — which is
  // what every legacy lane (~569 in production, none backfilled) keeps using.
  // MUST mirror stageRecipientsSql's overlay or the count shown on the stages
  // list stops predicting what materializes.
  sourceStageIds?: number[] | null;
  // The lane's split group. Lanes became INDEPENDENT on 2026-09-07 (they no
  // longer wait for each other to release), so a contact already taken by a
  // SIBLING lane is excluded from this one at materialization. The count must
  // mirror that or it over-predicts once one lane has run. NULL ⇒ overlay off,
  // which is what every legacy (pre-0174) lane keeps using.
  splitGroupId?: string | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
}

// One row per lane as a typed UNION ALL of SELECTs (mirrors buildStagesCte):
// stage_id + tier + parent + the three filter booleans + the split bounds.
// A lane's ALIVENESS KEY: the set of stages whose recipients it may draw from.
// Lanes that share a key share one `alive` branch, so a 3-lane group costs one
// scan, not three. Legacy lanes key on their single parent; 0174 lanes key on
// their (already-resolved) source set.
function alivenessKey(l: LaneCountBatchItem): string | null {
  const src = l.sourceStageIds ?? null;
  if (src !== null && src.length > 0)
    return `g:${[...src].sort((a, b) => a - b).join(",")}`;
  if (l.parentStageId != null) return `p:${l.parentStageId}`;
  return null; // aliveness off
}

function alivenessStageIds(l: LaneCountBatchItem): number[] {
  const src = l.sourceStageIds ?? null;
  if (src !== null && src.length > 0) return src;
  return l.parentStageId != null ? [l.parentStageId] : [];
}

function buildLanesCte(lanes: LaneCountBatchItem[]): SQL {
  const rows = lanes.map(
    (l) => drizzleSql`select
      ${l.stageId}::int as stage_id,
      ${l.behavioralTier}::int as tier,
      ${alivenessKey(l)}::text as alive_key,
      ${l.include_no_status}::boolean as inc_ns,
      ${l.include_clickers}::boolean as inc_cl,
      ${l.exclude_clickers}::boolean as exc_cl,
      ${l.split_index}::int as split_index,
      ${l.split_total}::int as split_total,
      ${l.splitGroupId ?? null}::uuid as split_group_id`,
  );
  return rows.reduce((acc, r, i) =>
    i === 0 ? r : drizzleSql`${acc} union all ${r}`,
  );
}

export async function computeLaneAudienceCountsBatch(
  campaignId: number,
  orgId: string,
  lanes: LaneCountBatchItem[],
): Promise<Map<number, number>> {
  if (lanes.length === 0) return new Map();
  const lanesCte = buildLanesCte(lanes);

  // The aliveness universe, one branch per DISTINCT key (see alivenessKey). A
  // 3-lane group shares one branch. Lanes with aliveness off contribute nothing.
  const byKey = new Map<string, number[]>();
  for (const l of lanes) {
    const key = alivenessKey(l);
    if (key === null) continue;
    if (!byKey.has(key)) byKey.set(key, alivenessStageIds(l));
  }
  const aliveBranches = [...byKey.entries()].map(
    ([key, ids]) => drizzleSql`
      select distinct ${key}::text as alive_key, contact_id
      from stage_sends
      where campaign_id = ${campaignId}::int
        and org_id = ${orgId}::uuid
        and status = 'sent'
        and stage_id = any (array[${drizzleSql.join(
          ids.map((i) => drizzleSql`${i}::int`),
          drizzleSql`, `,
        )}]::int[])`,
  );
  // No lane has aliveness on: emit a shape-compatible empty relation so the
  // LEFT JOIN below still type-checks (every such lane escapes via the
  // `alive_key is null` branch anyway).
  const aliveCte =
    aliveBranches.length > 0
      ? aliveBranches.reduce((acc, b, i) =>
          i === 0 ? b : drizzleSql`${acc} union all ${b}`,
        )
      : drizzleSql`select null::text as alive_key, null::uuid as contact_id where false`;

  const rows = (await db.execute(drizzleSql`
    with tier_map as materialized (
      ${campaignTierExpr(campaignId, orgId)}
    ),
    -- Contacts who received (status='sent') any stage in each distinct ALIVENESS
    -- KEY. Built once per key — a 0174 group's three lanes share one branch; the
    -- per-lane join below reproduces stageRecipientsSql's aliveness EXISTS check.
    alive as (
      ${aliveCte}
    ),
    ln as (${lanesCte}),
    qualified as (
      select
        ln.stage_id,
        ln.split_index,
        ln.split_total,
        p.contact_id
      from ln
      join campaign_audience_pool p
        on p.campaign_id = ${campaignId}::int and p.org_id = ${orgId}::uuid
      -- Aliveness: LEFT JOIN so a lane with aliveness off (alive_key null) keeps
      -- every contact via the null escape; a lane WITH a key keeps only rows that
      -- matched (a.contact_id is not null).
      left join alive a
        on a.alive_key = ln.alive_key and a.contact_id = p.contact_id
      left join tier_map t on t.contact_id = p.contact_id
      where not exists (
          select 1 from opt_outs oo
          where oo.contact_id = p.contact_id and oo.org_id = ${orgId}::uuid
        )
        and (ln.alive_key is null or a.contact_id is not null)
        and (
          (ln.inc_ns and p.was_no_status_at_snapshot)
          or (ln.inc_cl and p.was_clicker_at_snapshot)
        )
        and not (ln.exc_cl and p.was_clicker_at_snapshot)
        and coalesce(t.tier, 0) = ln.tier
        -- The exit guard, mirroring stageRecipientsSql's Block 2. 4 since
        -- Phase 4: tier 3 is the Registered lane and must NOT be excluded here,
        -- or its displayed count would always be 0.
        and coalesce(t.tier, 0) <> ${tierLiteral(EXIT_TIER)}
        -- Sibling exclusion — mirrors "Block 3" in stageRecipientsSql. Lanes are
        -- independent now, so the first lane to materialize a contact owns them;
        -- without this the displayed count would over-predict every lane that
        -- runs after the first. NULL split_group_id ⇒ vacuously true (legacy).
        and (
          ln.split_group_id is null
          or not exists (
            select 1 from stage_sends sib
            join campaign_stages sibs on sibs.id = sib.stage_id
            where sibs.split_group_id = ln.split_group_id
              and sibs.id <> ln.stage_id
              and sib.contact_id = p.contact_id
              and sib.org_id = ${orgId}::uuid
              and sib.status <> 'rejected'
          )
        )
    )
    select stage_id, ${BATCH_SPLIT_FILTER}
    from qualified
    group by stage_id
  `)) as unknown as { stage_id: number; count: number }[];
  return new Map(rows.map((r) => [Number(r.stage_id), Number(r.count)]));
}

// Compute the count + composition breakdown for the UI's audience
// preview. No DB write.
//
// Returns total_matching (pre-cap), count (post-cap, what actually gets
// sent to), and a per-source breakdown so the UI can show how segments
// vs contact groups vs overlap contribute. One SQL round-trip; the
// breakdown reuses the same CTE chain as the count.
//
// The snapshot path (snapshotAudience) builds its own row-level projection
// via buildQualifierFromRelation (against a materialized temp table) for the
// actual insert. The preview takes a different shape because it aggregates
// instead.
export async function previewAudience(
  input: AudiencePreviewInput,
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
  const lifecycleExclusions = lifecycleRules
    ? lifecycleExclusionLayers({ orgId, offerId: input.offerId ?? null })
    : null;
  const excludeInUse = input.excludeInUse === true;
  // Content-dedup LAYER 3: only computed when the toggle is on AND an offer is
  // set. When off, `offerExposureId` stays null so flagSetCtes/flagJoins emit
  // the exact same SQL as before — no oe_set CTE, no extra join.
  const excludePriorOffer = input.excludePriorOffer === true;
  const offerExposureId =
    excludePriorOffer && input.offerId != null ? input.offerId : null;
  const useOfferExposure = offerExposureId != null;
  // Campaign carrier filter (migration 0098). Only wire the contacts join +
  // carrier logic when a filter is set, so the common no-filter preview is byte-for-
  // byte unchanged (no perf regression). Unidentified is never selectable, so it is
  // always in the "removed" set once any filter is active.
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

  const rows = (await db.execute(drizzleSql`
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
  `)) as unknown as {
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
    lc_freeze_not_due?: number;
    lc_bought_offer?: number;
    lc_excl_opted_out?: number;
    lc_excl_suppressed?: number;
    lc_excl_status_not_selected?: number;
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
              in_use_elsewhere: Number(row?.lc_excl_in_use_elsewhere ?? 0),
            },
            send_time: {
              freeze_not_due: Number(row?.lc_freeze_not_due ?? 0),
              bought_offer: Number(row?.lc_bought_offer ?? 0),
            },
          } satisfies LifecycleAudienceBreakdown,
        }
      : {}),
  };
}

// Snapshot the audience for a campaign: inserts one row into
// campaign_audience_pool for each qualifying contact with its per-row
// snapshot booleans. Returns the count of inserted rows + the full
// matching pool size. Caller is responsible for running this inside a
// transaction with the campaign row itself, so a failure rolls back the
// whole campaign.
//
// When `cap` is set and less than the resolved pool, applies
// ORDER BY RANDOM() LIMIT cap to take a random sample. The sample is
// frozen in the pool — there's no reseeding.
export async function snapshotAudience(
  input: AudienceSnapshotInput,
  // MUST be a transaction handle: this materializes a `ON COMMIT DROP` temp
  // table, so it only works inside a transaction. Both callers (campaign
  // create + draft→active) pass their tx. Falls back to the top-level db
  // only for the no-source short-circuit, which never reaches the temp table.
  tx?: Pick<typeof db, "execute">,
): Promise<AudienceSnapshotResult> {
  if (!hasAnySource(input)) return { count: 0, total_matching: 0 };
  const runner = tx ?? db;
  const cap = input.cap ?? null;

  // Materialize the candidate set (segment ∩ group composition) into a temp
  // table and ANALYZE it before joining the status flags. This is the crux
  // of the perf fix: the source is built from UNION/INTERSECT/EXCEPT set ops,
  // whose output cardinality Postgres can't estimate — it defaults to ~200
  // rows. At real scale (100K+ candidates) that misestimate makes the planner
  // pick nested-loop anti-joins for the opt-out / in-use exclusions, which
  // never finish (statement timeout on activation). A materialized + analyzed
  // temp table gives the planner true row counts, so the exclusions hash-join
  // and the whole snapshot runs in ~2s instead of timing out. The temp table
  // also lets count + insert share one evaluation of the source set ops.
  const source = applyCarrierFilter(
    await buildAudienceSourceSql(input),
    input.orgId,
    input.filters.carrier_filter,
  );
  await runner.execute(drizzleSql`
    create temp table audience_candidates on commit drop as
    select distinct contact_id from (${source}) src
  `);
  await runner.execute(drizzleSql`analyze audience_candidates`);

  // Resolve the qualified set (status filters + opt-out / in-use exclusions,
  // with the snapshot booleans) into a second temp table. Doing this once —
  // rather than re-running the qualifier for both the count and the insert —
  // means the (now correctly-planned) flag hash-joins evaluate a single time;
  // the count is then a trivial read and the insert just samples this set.
  //
  // The prior-offer exclusion is deliberately NOT part of this statement — it
  // runs below, against the materialized+ANALYZEd result. See the comment there.
  const dripPostureOn = await isDripPostureOn(input.orgId);
  const qualifying = buildQualifierFromRelation(
    { ...input, excludePriorOffer: false },
    drizzleSql`audience_candidates`,
    dripPostureOn,
  );
  await runner.execute(drizzleSql`
    create temp table audience_qualified on commit drop as ${qualifying}
  `);

  // Prior-offer exclusion (content-dedup LAYER 3) as a SEPARATE statement, for
  // the same reason the candidate set is materialized above: planner stats.
  // Folded into the qualifier it is an anti-join whose outer estimate collapses
  // to rows=1 (a chain of anti-joins over a temp table), while `offer_id` for a
  // newer/small offer is absent from the column's MCV list so `offer_exposures`
  // is estimated at 1 row too. Both wrong in the same direction ⇒ the planner
  // picks a Nested Loop Anti Join and re-scans offer_exposures ONCE PER
  // CANDIDATE — measured at 23K loops × 5K rows = 115.7M heap fetches, 84s,
  // past the route's 60s limit (campaign create timed out, transaction rolled
  // back). Splitting it out lets ANALYZE give the planner the real cardinality
  // of the qualified set, so it hash-anti-joins instead: 67.5s → 4.2s on the
  // same recipe, byte-identical rows out.
  if (input.excludePriorOffer === true && input.offerId != null) {
    await runner.execute(drizzleSql`analyze audience_qualified`);
    await runner.execute(drizzleSql`
      delete from audience_qualified q
      where exists (
        select 1 from offer_exposures oe
        where oe.org_id = ${input.orgId}::uuid
          and oe.offer_id = ${input.offerId}::int
          and oe.contact_id = q.contact_id
      )
    `);
  }

  const totalRows = (await runner.execute(drizzleSql`
    select count(*)::int as count from audience_qualified
  `)) as unknown as { count: number }[];
  const total = Array.isArray(totalRows) ? (totalRows[0]?.count ?? 0) : 0;

  const limitClause =
    cap !== null && cap < total
      ? drizzleSql`order by random() limit ${cap}`
      : drizzleSql``;

  const result = (await runner.execute(drizzleSql`
    insert into campaign_audience_pool
      (campaign_id, contact_id, org_id, was_clicker_at_snapshot, was_opt_in_at_snapshot, was_no_status_at_snapshot)
    select
      ${input.campaignId}::int,
      contact_id,
      ${input.orgId}::uuid,
      was_clicker,
      was_opt_in,
      was_no_status
    from audience_qualified
    ${limitClause}
    on conflict (campaign_id, contact_id) do nothing
    returning contact_id
  `)) as unknown as { contact_id: string }[];
  const count = Array.isArray(result) ? result.length : 0;
  return { count, total_matching: total };
}

// ── Content-dedup eligibility preview (Phase 2, §5 of the brief) ──────────────
// Build-time "what will the dedup filter do" breakdown for ONE stage:
//   segment_total = the stage's qualifying audience (pool/projection ∩ stage
//                   filters ∩ split) BEFORE dedup
//   saw_creative  = of those, how many already got THIS creative elsewhere
//   got_offer     = of those, how many already got THIS offer (only when the
//                   campaign opts into offer exclusion)
//   will_send     = after all dedup EXCEPTs — equals the real materialized count
//                   for the same inputs (same qualifying base + same eligibility
//                   layers as stageRecipientsSql), so preview == reality.
// ONE query: the qualifying set resolves once, the indexed ledgers are cheap
// LEFT JOINs on top. Wrapped in the segment-preview timeout mechanism (SET LOCAL
// statement_timeout in a txn; 57014 ⇒ truncated) — pooler-safe (the SET LOCAL +
// query run in the same explicit transaction, so they share one backend).
export interface StageEligibilityPreviewResult {
  segment_total: number | null;
  saw_creative: number;
  got_offer: number;
  will_send: number | null;
  truncated: boolean;
  duration_ms: number;
  // Spread, not listed — see LifecycleExclusionCounts. All zero for a legacy
  // campaign and on a timeout.
  excluded_lifecycle: LifecycleExclusionCounts;
}

export interface StageEligibilityPreviewInput {
  orgId: string;
  campaignId: number;
  mode: "active" | "draft";
  // Stage filter toggles + optional split, identical to the audience preview.
  stageFilters: StageAudienceFilters;
  // Resolved once by the caller: the stage's creative, the campaign's offer, the
  // opt-in toggle. (org/campaign come from above.)
  eligibility: Pick<
    StageEligibilityParams,
    | "currentCreativeId"
    | "currentOfferId"
    | "excludePriorOffer"
    // campaigns.lifecycle_rules. Required, so a new call site cannot forget it
    // and silently preview the legacy predicate for a lifecycle campaign.
    | "lifecycleRules"
  >;
  // Draft mode needs the campaign's planned audience recipe (no frozen pool yet).
  draft?: {
    segmentIds: number[];
    excludeSegmentIds?: number[];
    contactGroupIds: number[];
    filters: AudienceFilters;
    excludeInUse?: boolean;
  };
}

// An always-empty `SELECT contact_id` relation — substituted for an absent
// eligibility layer so the LEFT JOIN + FILTER math is uniform (that layer simply
// never matches: saw_creative/got_offer = 0, will_send doesn't subtract it).
const EMPTY_CONTACTS = drizzleSql`SELECT NULL::uuid AS contact_id WHERE false`;

export async function computeStageEligibilityPreview(
  input: StageEligibilityPreviewInput,
  timeoutMs = 10_000,
): Promise<StageEligibilityPreviewResult> {
  const { orgId, campaignId, mode, stageFilters: sf } = input;
  // Split is applied to the POST-dedup set (in the final query below), exactly
  // like stageRecipientsSql (base → EXCEPT layers → split). So `qualifying` is
  // the pre-dedup, PRE-split base ∩ stage-filters; subtracting the layers then
  // splitting reproduces the send path bucket-for-bucket ⇒ will_send == reality.
  const splitIndex = sf.split_index ?? null;
  const splitTotal = sf.split_total ?? null;
  const splitActive = splitIndex !== null && splitTotal !== null;

  // The qualifying contact_id set (pre-dedup, pre-split), post stage-filters.
  // ACTIVE reuses stageRecipientsSql WITHOUT eligibility AND WITHOUT split (the
  // exact send base). DRAFT projects from the campaign's planned audience.
  let qualifying: SQL;
  if (mode === "active") {
    qualifying = stageRecipientsSql({
      campaignId,
      orgId,
      filters: {
        includeNoStatus: sf.include_no_status,
        includeClickers: sf.include_clickers,
        excludeClickers: sf.exclude_clickers,
        splitIndex: null,
        splitTotal: null,
      },
    });
  } else {
    const draft = input.draft;
    if (
      !draft ||
      (draft.segmentIds.length === 0 && draft.contactGroupIds.length === 0)
    ) {
      return {
        segment_total: 0,
        saw_creative: 0,
        got_offer: 0,
        will_send: 0,
        truncated: false,
        duration_ms: 0,
        excluded_lifecycle: { ...ZERO_LIFECYCLE_EXCLUSIONS },
      };
    }
    const source = await buildAudienceSourceSql({
      orgId,
      segmentIds: draft.segmentIds,
      excludeSegmentIds: draft.excludeSegmentIds ?? [],
      contactGroupIds: draft.contactGroupIds,
      filters: draft.filters,
      excludeInUse: draft.excludeInUse,
    });
    const dripPostureOn = await isDripPostureOn(orgId);
    const excludeInUse = draft.excludeInUse === true;
    // Only emitted for a lifecycle campaign; a legacy one passes null and the
    // CTE list stays byte-identical to before PR 4b.
    const lifecycleChips = input.eligibility.lifecycleRules
      ? ((draft.filters.lifecycle_statuses as string[] | undefined) ?? [])
      : null;
    const useLifecycle = lifecycleChips != null && lifecycleChips.length > 0;
    // No split here — applied post-dedup in the final query (see above).
    qualifying = drizzleSql`
      with sources as (select distinct contact_id from (${source}) u),
      ${flagSetCtes(orgId, null, dripPostureOn, lifecycleChips)},
      flagged as (
        select
          s.contact_id,
          (oo_set.contact_id is not null) as has_opt_out,
          (oi_set.contact_id is not null) as has_opt_in,
          (cl_set.contact_id is not null) as has_clicker,
          (iu_set.contact_id is not null) as is_in_use_elsewhere
          ${
            useLifecycle
              ? drizzleSql`, (lc_set.contact_id is not null) as has_lifecycle`
              : drizzleSql``
          }
        from sources s
        ${flagJoins("s", false, useLifecycle)}
      )
      select contact_id
      from flagged
      where has_opt_out = false
        and ${lifecycleChipPredicate(draft.filters, {
          lifecycleRules: input.eligibility.lifecycleRules === true,
        })}
        and (not ${excludeInUse}::boolean or not is_in_use_elsewhere)
        and (
          (${sf.include_no_status}::boolean and not has_opt_in and not has_clicker)
          or (${sf.include_clickers}::boolean and has_clicker)
        )
        and not (${sf.exclude_clickers}::boolean and has_clicker)
    `;
  }

  const ex = buildStageEligibilityExclusions({
    orgId,
    currentCampaignId: campaignId,
    currentCreativeId: input.eligibility.currentCreativeId,
    currentOfferId: input.eligibility.currentOfferId,
    excludePriorOffer: input.eligibility.excludePriorOffer,
    lifecycleRules: input.eligibility.lifecycleRules === true,
  });
  // Look up by key rather than by field: `ex` is an ordered layer list now, so
  // a layer that does not apply is simply absent. EMPTY_CONTACTS keeps the CTE
  // shape constant whether or not a layer is present.
  const layerSql = (key: EligibilityLayerKey): SQL =>
    ex.find((l) => l.key === key)?.sql ?? EMPTY_CONTACTS;
  const creativeRel = layerSql("creative");
  const inFlightRel = layerSql("in_flight");
  const offerRel = layerSql("offer");
  // The lifecycle layers, emitted generically so adding one needs no edit here.
  // Absent for a legacy campaign ⇒ the statement is unchanged.
  const lcLayers = ex.filter((l) =>
    (LIFECYCLE_EXCLUSION_KEYS as readonly string[]).includes(l.key),
  );
  const lcCtes = lcLayers.reduce(
    (acc, l) => drizzleSql`${acc}
        ${drizzleSql.raw(`el_${l.key}`)} as (${l.sql}),`,
    drizzleSql``,
  );
  const lcCols = lcLayers.reduce(
    (acc, l) => drizzleSql`${acc},
            (${drizzleSql.raw(`el_${l.key}`)}.contact_id is not null) as ${drizzleSql.raw(`f_${l.key}`)}`,
    drizzleSql``,
  );
  const lcJoins = lcLayers.reduce(
    (acc, l) => drizzleSql`${acc}
          left join ${drizzleSql.raw(`el_${l.key}`)} on ${drizzleSql.raw(`el_${l.key}`)}.contact_id = q.contact_id`,
    drizzleSql``,
  );
  // will_send must subtract these too: the send path EXCEPTs them, so leaving
  // them in would make the preview promise messages that never go out.
  const lcNotHit = lcLayers.reduce(
    (acc, l) => drizzleSql`${acc} and not ${drizzleSql.raw(`f_${l.key}`)}`,
    drizzleSql``,
  );
  // Exclusive, in EXCLUSION_PRIORITY order (lcLayers is already sorted).
  const lcCounts = lcLayers.reduce(
    (acc, l, i) => {
      const earlier = lcLayers
        .slice(0, i)
        .reduce(
          (a, e) => drizzleSql`${a} and not ${drizzleSql.raw(`f_${e.key}`)}`,
          drizzleSql``,
        );
      return drizzleSql`${acc},
          (select count(*) from joined where ${drizzleSql.raw(`f_${l.key}`)}${earlier})::int as ${drizzleSql.raw(`x_${l.key}`)}`;
    },
    drizzleSql``,
  );

  const start = Date.now();
  try {
    const rows = await db.transaction(async (tx) => {
      const ms = Math.max(1, Math.floor(timeoutMs));
      await tx.execute(drizzleSql.raw(`SET LOCAL statement_timeout = ${ms}`));
      return (await tx.execute(drizzleSql`
        with q as (${qualifying}),
        ec as (${creativeRel}),
        ei as (${inFlightRel}),
        eo as (${offerRel}),
        ${lcCtes}
        joined as (
          select
            q.contact_id,
            (ec.contact_id is not null) as f_creative,
            (ei.contact_id is not null) as f_inflight,
            (eo.contact_id is not null) as f_offer${lcCols}
          from q
          left join ec on ec.contact_id = q.contact_id
          left join ei on ei.contact_id = q.contact_id
          left join eo on eo.contact_id = q.contact_id${lcJoins}
        ),
        -- Post-dedup set, split by the stable hash bucket — exactly the send
        -- path (base EXCEPT layers, THEN split), so will_send == materialized.
        eligible as (
          select contact_id
          from joined
          where not f_creative and not f_inflight and not f_offer${lcNotHit}
        )
        select
          (select count(*) from joined)::int as segment_total,
          (select count(*) from joined where f_creative)::int as saw_creative,
          (select count(*) from joined where f_offer)::int as got_offer,
          (select count(*) from eligible
            where not ${splitActive}::boolean
              or ${splitBucketMatch(drizzleSql`contact_id`, drizzleSql`${splitTotal ?? 1}`, drizzleSql`${splitIndex ?? 1}`)}
          )::int as will_send${lcCounts}
      `)) as unknown as {
        segment_total: number;
        saw_creative: number;
        got_offer: number;
        will_send: number;
        [layerKey: string]: number;
      }[];
    });
    const r = rows[0] ?? {
      segment_total: 0,
      saw_creative: 0,
      got_offer: 0,
      will_send: 0,
    };
    return {
      segment_total: r.segment_total,
      saw_creative: r.saw_creative,
      got_offer: r.got_offer,
      will_send: r.will_send,
      truncated: false,
      duration_ms: Date.now() - start,
      excluded_lifecycle: {
        ...ZERO_LIFECYCLE_EXCLUSIONS,
        ...Object.fromEntries(
          lcLayers.map((l) => [
            l.key,
            Number((r as Record<string, unknown>)[`x_${l.key}`] ?? 0),
          ]),
        ),
      } as LifecycleExclusionCounts,
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    // The 57014 code lives on err.cause (drizzle wraps the driver error), so
    // detect it through the cause chain — a message-only check re-throws a
    // timeout we mean to degrade. See lib/db/statement-timeout.ts.
    if (isStatementTimeout(err)) {
      // Headline number unavailable; the screen shows a "too large to preview"
      // state rather than failing (mirrors the segment-rules preview contract).
      return {
        segment_total: null,
        saw_creative: 0,
        got_offer: 0,
        will_send: null,
        truncated: true,
        duration_ms,
        excluded_lifecycle: { ...ZERO_LIFECYCLE_EXCLUSIONS },
      };
    }
    throw err;
  }
}
