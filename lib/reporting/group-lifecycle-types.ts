// Client-safe constants and shapes for the contact group x lifecycle
// breakdown. Separated from lib/reporting/group-lifecycle.ts ONLY because that
// module is `server-only`: the table component needs GROUP_LIFECYCLE_STATUSES
// at runtime to render its columns, and importing it from the server module
// would drag `server-only` into the client bundle. Types alone would have been
// fine (they erase); the status list is a value.

export const DEFAULT_RECENT_DAYS = 3;
/** Above this the "messaged recently" filter would exclude almost everyone. */
export const MAX_RECENT_DAYS = 90;

export const GROUP_LIFECYCLE_STATUSES = [
  "new",
  "cold",
  "hot",
  "warm",
  "freeze",
  "suppressed",
] as const;

export type GroupLifecycleStatus = (typeof GROUP_LIFECYCLE_STATUSES)[number];

export interface StatusPair {
  sendable: number;
  available: number;
}

export interface GroupLifecycleRow {
  /** "group" rows are one contact group; "cluster" rows are a DISTINCT union. */
  kind: "group" | "cluster";
  key: string;
  label: string;
  /** Only on group rows — for linking to the group's detail page. */
  group_id: number | null;
  /** Only on group rows. */
  code: string | null;
  /** Only on group rows: whether a cluster already covers it. */
  clustered: boolean;
  by_status: Record<GroupLifecycleStatus, StatusPair>;
  total: StatusPair;
}

export interface GroupLifecycleReport {
  groups: GroupLifecycleRow[];
  recent_days: number;
  computed_ms: number;
}

/**
 * The cluster rollups and the distinct footer — a SEPARATE request.
 *
 * ⚠️ THEY DO NOT FIT IN THE TABLE'S QUERY, and that was measured rather than
 * assumed. Both need DISTINCT contacts across a set of groups, which means
 * deduplicating ~1.1M membership rows; every shape tried cost seconds on top of
 * the table itself:
 *
 *   groups only, with available_today     1,803-1,957 ms   (the bar is 2,000)
 *   + clusters via count(DISTINCT)        ~8,200 ms
 *   + clusters via per-contact array_agg  6,169-14,101 ms
 *
 * The dedup is inherent, so the table ships fast and these arrive after it.
 * A reader gets usable per-group numbers immediately instead of waiting ~10s
 * for every number at once.
 */
export interface GroupLifecycleRollups {
  clusters: GroupLifecycleRow[];
  /**
   * ⚠️ The DISTINCT figure across every active group. The group rows count a
   * contact once per group it belongs to, so they do NOT sum to this — measured
   * on production, 765,567 summed against 667,142 distinct, a 98,425 overcount.
   * Without it on screen, adding the column up is the obvious and wrong way to
   * size a send.
   */
  distinct_total: GroupLifecycleRow;
  recent_days: number;
  computed_ms: number;
}

