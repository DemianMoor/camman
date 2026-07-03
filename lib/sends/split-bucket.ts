import { sql, type SQL } from "drizzle-orm";

// Stable per-contact split bucket — the SINGLE definition of "is this contact in
// split bucket (splitIndex/splitTotal)". A contact's bucket depends ONLY on its
// own id (hashtextextended is deterministic), never on the surrounding set.
//
// This stability is load-bearing for windowed / resumable materialization: the
// original split used `row_number() over (order by contact_id) % splitTotal`,
// which re-numbered the SHRINKING not-yet-materialized set on every resume, so
// the modulo picked a different subset each pass and leaked the sibling stage's
// half into this one (incident: campaign 8_62_070326_1 sent 7500 instead of 5000
// per split half, 5000 contacts in BOTH stages).
//
// EVERY place that reproduces the stage split — the send recipient query, the CSV
// exports, the audience-count previews, and the send reconciliation — MUST use
// this so preview/export/reconcile mirror EXACTLY what actually sends. Passing SQL
// fragments (not JS numbers) lets callers supply either bound params or column
// references (e.g. a per-stage `split_total` column in a batched count).
//
// The double-modulo `((h % n) + n) % n` normalizes the signed int8 hash into
// [0, splitTotal). Distribution is approximately even (hash uniformity), not
// exactly 50/50 — acceptable for A/B splits.
export function splitBucketMatch(
  contactId: SQL,
  splitTotal: SQL,
  splitIndex: SQL,
): SQL {
  return sql`((hashtextextended((${contactId})::text, 0) % (${splitTotal})::int) + (${splitTotal})::int) % (${splitTotal})::int = ((${splitIndex})::int - 1)`;
}
