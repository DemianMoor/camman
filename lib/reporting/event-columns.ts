import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// =============================================================================
// THE EVENT-TYPE COLUMN SPEC — the registry, turned into report columns.
//
// ⭐ THE CENTRAL RULE OF PHASE 5: adding an event type is CONFIG, not code.
// Nothing in this module, and nothing that consumes it, may branch on the string
// "purchase" or "registration". Every decision is taken from an event_types row:
//   is_retarget_signal  ranks the type ahead of purchases and makes it the LEFT
//                       side of a funnel ratio
//   is_purchase         makes it the RIGHT side of a funnel ratio, and is what
//                       keitaro_stage_results.sales counts
//   counts_revenue      is what earns a Revenue / Pending $ / EPC column
//   display_order, key  break ties, so the order is TOTAL and a re-render can
//                       never shuffle columns
//
// NOTE the deliberate divergence from display_order: production seeds
// purchase=10, registration=20 (migration 0181), but the funnel reads
// registration THEN purchase. Rather than rewrite the seed — and the copy inside
// handle_new_user(), migration 0183 — the sort puts signals first and uses
// display_order only as a tie-break within a class.
// =============================================================================

export interface EventTypeSpec {
  key: string;
  label: string;
  display_order: number;
  is_purchase: boolean;
  counts_revenue: boolean;
  is_retarget_signal: boolean;
  archived: boolean;
}

/** One event type's numbers inside one displayed row. Counts are EVENTS, not recipients. */
export interface EventTally {
  /** Counted events: status IN ('pending','approved'). Rejected and unmapped are not here. */
  n: number;
  /** Of those, the ones still held: status = 'pending'. A SUBSET of n, never added to it. */
  pending_n: number;
  /** counts_revenue types only, status='approved'. 0 for every other type, by construction. */
  revenue: number;
  /** counts_revenue types only, status='pending'. NEVER summed into revenue. */
  pending_revenue: number;
}

export type EventMap = Record<string, EventTally>;

/**
 * The all-zero tally, for READING ONLY — what a missing key is worth.
 *
 * ⭐ FROZEN, AND TYPED `Readonly`, BECAUSE IT IS SHARED. A consumer that seeds an
 * accumulator with it (`acc[key] = EMPTY_TALLY`, then `addEventMaps(acc, …)`)
 * used to mutate the ONE object every later missing-key read returns, so an
 * unrelated cell elsewhere in the process started reporting that consumer's
 * numbers instead of 0 — silently, with every test still green (found in review,
 * 2026-09-18).
 *
 * ⚠️ THE TWO GUARDS COVER DIFFERENT CASES, AND THE TYPE IS THE WEAKER ONE.
 * `Readonly<EventTally>` rejects a DIRECT write (`EMPTY_TALLY.n = 5`, TS2540) —
 * but TypeScript ignores `readonly` modifiers when checking assignability, so
 * `acc[key] = EMPTY_TALLY` compiles CLEAN (measured 2026-09-18). The aliasing
 * case — the one that actually happened — is caught only by `Object.freeze`, at
 * runtime, as a TypeError inside `addEventMaps` AT the mistake, instead of a
 * wrong number somewhere else later. Do not drop the freeze on the strength of
 * the type. Need a mutable zero? Call `emptyTally()`.
 * Bars S1–S4, scripts/test-event-columns.ts.
 */
export const EMPTY_TALLY: Readonly<EventTally> = Object.freeze({
  n: 0,
  pending_n: 0,
  revenue: 0,
  pending_revenue: 0,
});

/** A FRESH, mutable all-zero tally — the accumulator seed. Never the shared constant. */
export const emptyTally = (): EventTally => ({ n: 0, pending_n: 0, revenue: 0, pending_revenue: 0 });

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Coerce a jsonb value from keitaro_stage_results.events into an EventMap.
 *
 * It accepts a number OR a numeric string for every field, and it must: what a
 * numeric arrives as depends on where it sits. postgres-js `JSON.parse`s a jsonb
 * column, so integers, bigints and `numeric(12,4)` INSIDE the json all come back
 * as JS numbers (measured exact at 1234567.8901 and 0.0001, 2026-09-18) — while a
 * TOP-LEVEL `numeric` column arrives as a STRING, which is how any caller that
 * assembles a tally from ordinary aggregate columns will hand it over. Neither
 * branch is dead. Never throws: a NULL column, a pre-events row and a hand-edited
 * value all become an empty map.
 *
 * ⭐ BOTH HALVES ARE NOW MEASURED AGAINST THE REAL COLUMN.
 * `keitaro_stage_results.events` landed in migration 0185, and bars S13–S15 of
 * scripts/test-stage-event-columns-db.ts read ONE row through the driver: the
 * jsonb hands this function numbers (exact at 1234567.8901 and 0.0001), while
 * `pending_revenue` — a top-level numeric(12,4) on that same row, holding the
 * same value — hands it a string.
 */
export function parseEventMap(v: unknown): EventMap {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: EventMap = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw == null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    out[k] = {
      n: num(r.n),
      pending_n: num(r.pending_n),
      revenue: num(r.revenue),
      pending_revenue: num(r.pending_revenue),
    };
  }
  return out;
}

/** Add `from` into `into`, in place, deep-copying any key `into` does not have. */
export function addEventMaps(into: EventMap, from: EventMap): EventMap {
  for (const [k, t] of Object.entries(from)) {
    const cur = into[k];
    if (cur === undefined) {
      into[k] = { ...t };
      continue;
    }
    cur.n += t.n;
    cur.pending_n += t.pending_n;
    cur.revenue += t.revenue;
    cur.pending_revenue += t.pending_revenue;
  }
  return into;
}

/** A NEW map with every field multiplied by `f` — the By-Group fractional split. */
export function scaleEventMap(m: EventMap, f: number): EventMap {
  const out: EventMap = {};
  for (const [k, t] of Object.entries(m)) {
    out[k] = {
      n: t.n * f,
      pending_n: t.pending_n * f,
      revenue: t.revenue * f,
      pending_revenue: t.pending_revenue * f,
    };
  }
  return out;
}

/**
 * The registry for one org, or MERGED ACROSS ORGS when `orgId` is null.
 *
 * `orgId = null` serves exactly one caller — the scheduled Telegram report, which
 * has no user session and reports the whole business
 * (lib/reporting/report-snapshot.ts). Merging is by `key`, because
 * event_types.id is a global serial while the natural key is (org_id, key)
 * (event_types_org_key_uniq, migration 0181). Two orgs' rows for the same key
 * collapse to one spec: the lowest display_order wins and carries its label, the
 * flags are OR-ed (a key that counts revenue in ANY org earns its revenue
 * column), and `archived` is true only when EVERY org has archived it. Inert
 * today — one org sends tracker traffic — and stated so it is a rule rather than
 * an accident the second org discovers.
 *
 * NO `status = 'active'` FILTER HERE, deliberately: archiving must never erase
 * history (lib/sale-attribution.ts:43-45). `archived` is carried and
 * visibleEventTypes() decides. Anything serving a request passes a real org id.
 */
export async function loadEventTypes(
  dbc: DbOrTx,
  orgId: string | null,
): Promise<EventTypeSpec[]> {
  const org = orgId === null ? sql`` : sql`WHERE et.org_id = ${orgId}::uuid`;
  const rows = (await dbc.execute(sql`
    SELECT et.key,
           (array_agg(et.label ORDER BY et.display_order, et.id))[1] AS label,
           min(et.display_order)::int AS display_order,
           bool_or(et.is_purchase) AS is_purchase,
           bool_or(et.counts_revenue) AS counts_revenue,
           bool_or(et.is_retarget_signal) AS is_retarget_signal,
           bool_and(et.status = 'archived') AS archived
    FROM event_types et
    ${org}
    GROUP BY et.key
  `)) as unknown as {
    key: string;
    label: string;
    display_order: number;
    is_purchase: boolean;
    counts_revenue: boolean;
    is_retarget_signal: boolean;
    archived: boolean;
  }[];
  return orderEventTypes(
    rows.map((r) => ({
      key: r.key,
      label: r.label,
      display_order: Number(r.display_order),
      is_purchase: !!r.is_purchase,
      counts_revenue: !!r.counts_revenue,
      is_retarget_signal: !!r.is_retarget_signal,
      archived: !!r.archived,
    })),
  );
}

/**
 * TOTAL order: signals, then everything else, then purchases — display_order and
 * key as tie-breaks. A total order matters more than it looks: the column set is
 * rebuilt on every render and on every request, and a partial order would let two
 * equal rows swap places between renders.
 */
export function orderEventTypes(types: readonly EventTypeSpec[]): EventTypeSpec[] {
  const rank = (t: EventTypeSpec) => (t.is_retarget_signal ? 0 : t.is_purchase ? 2 : 1);
  return [...types].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.display_order - b.display_order ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * Which types get a column for THIS result set.
 *
 * An ACTIVE type always gets one, even with zero conversions — the column comes
 * from the registry, not from the data, so a newly configured event type reads 0
 * rather than vanishing. An ARCHIVED type gets one only while the displayed rows
 * still contain a non-zero entry for it, so retiring a type eventually retires
 * its column without ever erasing money that is still on screen.
 */
export function visibleEventTypes(
  types: readonly EventTypeSpec[],
  seen: Iterable<EventMap>,
): EventTypeSpec[] {
  const live = new Set<string>();
  for (const m of seen) {
    for (const [k, t] of Object.entries(m)) {
      if (t.n !== 0 || t.pending_n !== 0 || t.revenue !== 0 || t.pending_revenue !== 0) live.add(k);
    }
  }
  return orderEventTypes(types).filter((t) => !t.archived || live.has(t.key));
}

export type EventColumnKind =
  | "count"
  | "rate"
  | "pending_n"
  | "revenue"
  | "pending_revenue"
  | "epc"
  | "funnel";

export interface EventColumn {
  /** `evt:<key>:<kind>` or `evtfunnel:<signalKey>:<purchaseKey>`. Stable, and the persisted sort key. */
  id: string;
  header: string;
  kind: EventColumnKind;
  /** "a" = always visible; "b" = behind the Event breakdown toggle. */
  tier: "a" | "b";
  /** For "funnel", the DENOMINATOR's key (the signal). Otherwise the type's own key. */
  eventKey: string;
  /** "funnel" only: the NUMERATOR's key (the purchase type). */
  toKey?: string;
  muted: boolean;
}

/**
 * Pluralise a header. DELIBERATELY DUMB AND TOTAL, because it runs on free text:
 * event_types.label is `text NOT NULL` with no CHECK (migration 0181) and no UI,
 * so it can be an empty string, an emoji, or a sentence. It never throws and
 * never returns an empty result for a non-empty input.
 *
 * Only the COUNT header is pluralised. The others keep the singular stem, which
 * reads better and is closer to the owner's own shorthand ("Reg rate", not
 * "Regs rate"). The DATA stays singular — event_types.label is also what the
 * campaign-activity badge renders for ONE conversion (latestConversionForSend,
 * lib/sale-attribution.ts:196), where the singular is right — so the plural is
 * the generator's doing and never a migration's.
 *
 * It does not double consonants ("Quiz" ⇒ "Quizes") and it does not know
 * irregulars. That is a accepted limitation, not a bug to fix here: a label that
 * pluralises badly is corrected with one UPDATE on a config row, which is the
 * whole point of a registry.
 */
export function pluralizeLabel(label: string): string {
  const s = label.trimEnd();
  if (s.length === 0) return label;
  const lower = s.toLowerCase();
  if (lower.endsWith("s")) return label;
  const suffix = label.slice(s.length); // trailing whitespace, preserved
  if (/(x|z|ch|sh)$/.test(lower)) return `${s}es${suffix}`;
  if (/[^aeiou]y$/.test(lower)) return `${s.slice(0, -1)}ies${suffix}`;
  return `${s}s${suffix}`;
}

/**
 * The generated column set: every column of one type together, in registry
 * order, then the funnel ratios.
 *
 * ⭐ TIER A IS THE OWNER'S SPECIFIED COLUMN LIST AND IS ALWAYS VISIBLE: a count,
 * a rate and a held count per type, plus the signal→purchase ratio. Tier B — the
 * toggle — holds ONLY the three per-event money columns, and it holds them
 * precisely because each one duplicates an aggregate column that is already on
 * screen while exactly one counts_revenue type exists. Nothing the owner named is
 * ever behind the toggle.
 *
 * ⭐ THAT PREMISE IS A CONFIGURATION FACT, AND IT IS PINNED, NOT ASSUMED: bar R1
 * in scripts/test-event-columns-db.ts fails the moment a SECOND counts_revenue
 * type is configured. It has to, because the aggregate these columns duplicate —
 * approvedRevenueClause / REVENUE_EVENT_TYPE_IDS, lib/sale-attribution.ts:50,66 —
 * has NO per-type filter: with two revenue types the aggregate is their sum and
 * the tier-B columns become the only decomposition of it, still hidden behind a
 * toggle. When R1 goes red, revisit the hard-coded tier below.
 *
 * A Revenue / Pending $ / EPC column exists ONLY for a counts_revenue type. That
 * is not cosmetic: approvedRevenueClause (lib/sale-attribution.ts) is gated on
 * the same flag, so a non-revenue type's revenue is 0 everywhere by construction,
 * and a permanently-$0.00 column would read as "this earned nothing" rather than
 * "this does not carry money".
 */
export function buildEventColumns(types: readonly EventTypeSpec[]): EventColumn[] {
  const ordered = orderEventTypes(types);
  const out: EventColumn[] = [];
  for (const t of ordered) {
    out.push({ id: `evt:${t.key}:count`, header: pluralizeLabel(t.label), kind: "count", tier: "a", eventKey: t.key, muted: false });
    out.push({ id: `evt:${t.key}:rate`, header: `${t.label} rate`, kind: "rate", tier: "a", eventKey: t.key, muted: true });
    out.push({ id: `evt:${t.key}:pending_n`, header: `${t.label} pending`, kind: "pending_n", tier: "a", eventKey: t.key, muted: true });
    if (t.counts_revenue) {
      out.push({ id: `evt:${t.key}:revenue`, header: `${t.label} $`, kind: "revenue", tier: "b", eventKey: t.key, muted: false });
      out.push({ id: `evt:${t.key}:pending_revenue`, header: `${t.label} pending $`, kind: "pending_revenue", tier: "b", eventKey: t.key, muted: true });
      out.push({ id: `evt:${t.key}:epc`, header: `${t.label} EPC`, kind: "epc", tier: "b", eventKey: t.key, muted: true });
    }
  }
  for (const s of ordered.filter((t) => t.is_retarget_signal)) {
    for (const p of ordered.filter((t) => t.is_purchase)) {
      // ⭐ NEVER A TYPE AGAINST ITSELF. Nothing stops a row carrying BOTH
      // is_retarget_signal and is_purchase — no CHECK in 0181 forbids it, and it
      // is a plausible thing for an operator to tick (a deposit that both earns
      // money and marks a lane). The cross product then emitted
      // `evtfunnel:deposit:deposit`, "Deposit→Deposit %", whose value is n/n = 1
      // for every row that has one at all: a column that is constant by
      // construction and can only mislead. Its OTHER pairings still generate.
      if (s.key === p.key) continue;
      out.push({
        id: `evtfunnel:${s.key}:${p.key}`,
        header: `${s.label}→${p.label} %`,
        kind: "funnel",
        tier: "a",
        eventKey: s.key,
        toKey: p.key,
        muted: true,
      });
    }
  }
  return out;
}

const synthetic = (key: string, f: Partial<EventTypeSpec> = {}): EventTypeSpec => ({
  key,
  // ⭐ A PLACEHOLDER LABEL. The label lives in event_types and is NOT encoded in
  // the id, so a caller holding only an id cannot recover it. Rendering a header
  // from this is a bug; a caller with the registry in hand must look the id up in
  // buildEventColumns() instead. Everything else — kind, tier, eventKey, toKey,
  // muted — is exact, because it is generated by the same function.
  label: key,
  display_order: 0,
  is_purchase: false,
  counts_revenue: false,
  is_retarget_signal: false,
  archived: false,
  ...f,
});

/**
 * Parse a generated column id back into its column, WITHOUT the registry.
 *
 * The id is the persisted sort key: it arrives from a URL query parameter or from
 * localStorage, possibly long after the registry that generated it changed. This
 * answers "is this a generated event column, and if so which kind of one" for a
 * caller that has an id and nothing else — a stale or hand-typed key returns null
 * and falls back rather than throwing.
 *
 * ⭐ IT REBUILDS THROUGH buildEventColumns() RATHER THAN RE-DERIVING. A second
 * copy of the id/tier/muted rules would be a fork waiting to drift the moment a
 * column kind is added. The only thing it cannot reproduce is the header (see
 * `synthetic`).
 *
 * The split is EXACT, not a guess: `event_types_key_format_check` (migration
 * 0181:43) constrains `key` to `^[a-z][a-z0-9_]*$`, so a key can never contain a
 * `:` and a generated id always has exactly three segments. The arity check still
 * earns its keep — the input is a URL parameter or a localStorage value and can be
 * anything at all — but it is rejecting a malformed ID, not a legal key.
 */
export function eventColumnById(id: string): EventColumn | null {
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const [prefix, a, b] = parts;
  if (!a || !b) return null;
  if (prefix === "evtfunnel") {
    return (
      buildEventColumns([
        synthetic(a, { is_retarget_signal: true }),
        synthetic(b, { is_purchase: true }),
      ]).find((c) => c.id === id) ?? null
    );
  }
  if (prefix !== "evt") return null;
  // counts_revenue is forced on so the money kinds are generated too; which kinds
  // a key legitimately HAS is a registry question, not an id-parsing one.
  return buildEventColumns([synthetic(a, { counts_revenue: true })]).find((c) => c.id === id) ?? null;
}

/**
 * The value of one generated cell.
 *
 * ⭐ NULL MEANS UNKNOWN AND RENDERS AS "—". A ratio over a zero denominator is
 * not zero: "0.0% of 0 clicks" is a statement nobody can act on, and the same
 * rule already governs PartnerReportRow.ctr and PerfMetrics.reached.
 *
 * ⭐ RATIOS ARE NOT CLAMPED. Both can legitimately exceed 1:
 *   rate   — the EPC denominator (counted_clickers) rescues purchase- or
 *            revenue-bearing recipients only (rescueSendIds), so a registrant
 *            whose click was never scored human is in the numerator and not the
 *            denominator.
 *   funnel — a purchase can arrive with no preceding registration (PsychoBook's
 *            two independent postback URLs; a lost registration postback).
 * Clamping would hide a real signal behind a plausible number.
 */
export function eventCellValue(
  col: EventColumn,
  events: EventMap,
  countedClickers: number,
): number | null {
  const t = events[col.eventKey] ?? EMPTY_TALLY;
  switch (col.kind) {
    case "count":
      return t.n;
    case "pending_n":
      return t.pending_n;
    case "revenue":
      return t.revenue;
    case "pending_revenue":
      return t.pending_revenue;
    case "rate":
      return countedClickers > 0 ? t.n / countedClickers : null;
    case "epc":
      return countedClickers > 0 ? t.revenue / countedClickers : null;
    case "funnel": {
      // toKey is optional on the interface, so a hand-built funnel column can
      // arrive without one. That is UNKNOWN, not zero: `events[undefined!]` falls
      // through to EMPTY_TALLY and would render a confident 0.0%.
      if (col.toKey === undefined) return null;
      const to = events[col.toKey] ?? EMPTY_TALLY;
      return t.n > 0 ? to.n / t.n : null;
    }
  }
}
