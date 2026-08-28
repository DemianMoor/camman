// Today's Sends — group the fleet stage list by the number that sends it.
//
// Pure (no React, no fetch) so the ordering rules are testable on their own and
// the two surfaces that render groups — the "All" tab and a single-number tab —
// provably agree: both consume the output of this one function.
//
// A stage has exactly ONE provider_phone_id, stamped onto every stage_sends row
// at materialization (migration 0112). It is set on the stage itself, so the
// grouping is known BEFORE a stage is prepared — an unprepared stage still
// lands in its number's group rather than an "unknown" bucket.

import {
  STAGE_STATUS_META,
  type StageOperationalStatus,
} from "@/lib/stages/stage-status";

/** The subset of a fleet stage this module needs. Structural, so the page's
 *  richer FleetStage satisfies it without a cast. */
export interface GroupableStage {
  provider_phone_id: number | null;
  phone_number: string | null;
  number_type: string | null;
  provider_name: string | null;
  provider_color: string | null;
  provider_paused: boolean;
  scheduled_at: string | null;
  operational_status: StageOperationalStatus;
  counts: { total: number; sent: number };
}

export interface PhoneGroup<T extends GroupableStage> {
  /** Stable tab value / React key. "no-phone" for the null bucket. */
  key: string;
  provider_phone_id: number | null;
  phone_number: string | null;
  number_type: string | null;
  provider_name: string | null;
  provider_color: string | null;
  provider_paused: boolean;
  stages: T[];
  /** True when any stage in the group is in the needs-action band — drives the
   *  dot on the tab. */
  needsAction: boolean;
  /** Group totals, summed from the same counts the rows display. */
  totalPrepared: number;
  totalSent: number;
}

/**
 * The "needs action" band: every status the status model already weights at 0.
 *
 * Deriving this from sortWeight rather than listing the four statuses by name
 * means a future attention state joins the band automatically, and a benign one
 * cannot wander in. Today that is scheduled_unprepared (orange), missed_failed
 * (red), blocked (rose) and held (amber) — while skipped_empty (weight 90,
 * terminal and benign) and draft (40) correctly stay out.
 */
export function isNeedsAction(status: StageOperationalStatus): boolean {
  return STAGE_STATUS_META[status].sortWeight === 0;
}

/** Unscheduled stages sort after scheduled ones rather than at epoch. */
function scheduleKey(at: string | null): number {
  if (!at) return Number.POSITIVE_INFINITY;
  const t = Date.parse(at);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Within a block: the whole needs-action band on top, then everything else.
 * Ascending scheduled time WITHIN each band, so the band boundary is the only
 * thing that overrides chronology.
 */
function compareStages(a: GroupableStage, b: GroupableStage): number {
  const aAction = isNeedsAction(a.operational_status);
  const bAction = isNeedsAction(b.operational_status);
  if (aAction !== bAction) return aAction ? -1 : 1;
  return scheduleKey(a.scheduled_at) - scheduleKey(b.scheduled_at);
}

/**
 * Group today's stages by sending number.
 *
 * Group order: any group holding a needs-action stage first, then by the
 * group's earliest scheduled time — so the number that needs attention is
 * leftmost in the tab bar and topmost on the All tab. The null-phone bucket is
 * pinned last regardless (it is a data gap, not a number).
 */
export function groupStagesByPhone<T extends GroupableStage>(
  stages: T[],
): PhoneGroup<T>[] {
  const byKey = new Map<string, PhoneGroup<T>>();

  for (const s of stages) {
    const key =
      s.provider_phone_id == null ? "no-phone" : `phone-${s.provider_phone_id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        provider_phone_id: s.provider_phone_id,
        phone_number: s.phone_number,
        number_type: s.number_type,
        provider_name: s.provider_name,
        provider_color: s.provider_color,
        provider_paused: s.provider_paused,
        stages: [],
        needsAction: false,
        totalPrepared: 0,
        totalSent: 0,
      };
      byKey.set(key, g);
    }
    g.stages.push(s);
    if (isNeedsAction(s.operational_status)) g.needsAction = true;
    g.totalPrepared += s.counts.total;
    g.totalSent += s.counts.sent;
    // A number is "paused" if the provider behind any of its stages is paused.
    if (s.provider_paused) g.provider_paused = true;
  }

  const groups = [...byKey.values()];
  for (const g of groups) g.stages.sort(compareStages);

  groups.sort((a, b) => {
    // The data-gap bucket always sits last.
    const aNull = a.provider_phone_id == null;
    const bNull = b.provider_phone_id == null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
    return earliestSchedule(a) - earliestSchedule(b);
  });

  return groups;
}

function earliestSchedule(g: PhoneGroup<GroupableStage>): number {
  let min = Number.POSITIVE_INFINITY;
  for (const s of g.stages) min = Math.min(min, scheduleKey(s.scheduled_at));
  return min;
}

/**
 * Number-type badge text. Mirrors the abbreviations the "Prepared for today →
 * By number" card already uses, so the two surfaces read the same.
 */
export function numberTypeAbbrev(numberType: string | null): string | null {
  if (!numberType) return null;
  if (numberType === "10dlc") return "10DLC";
  if (numberType === "toll_free") return "TF";
  if (numberType === "short_code") return "SC";
  return numberType;
}
