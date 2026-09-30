// Build the `.set()` payload for a PATCH from a parsed body.
//
// ⚠️ A PATCH MUST NEVER WRITE A FIELD THE CLIENT DID NOT SEND, and that is not
// what `v === undefined` gives you. A Zod schema can produce a value for a key
// that was absent from the request — via `.default()`, or via a `.transform()`
// that sits outside `.optional()` and so receives `undefined` and returns
// something. Those values are not `undefined`, so a loop that only skips
// `undefined` writes them over whatever was stored.
//
// Measured on production 2026-09-30. Three update schemas inject on an absent
// key:
//
//   campaignUpdateSchema      {name}          -> audience_filters: {}
//   offerUpdateSchema         {name}          -> sales_pages: []
//   providerPhoneUpdateSchema {dashboard_id}  -> opt_out_footer: null
//
// The campaigns one had been live since at least 2026-06-03 and silently
// emptied `audience_filters` on EVERY PATCH — a rename, a note, a date change.
// 77 campaigns carry `{}` as a result, and the correlation is exact: of 650
// campaigns with a create event, **36 were renamed and all 36 have empty
// filters; 614 were never renamed and all 614 are intact**. Reproduced
// end-to-end on the preview database.
//
// The audience lock could not catch it. That check reads the RAW body on
// purpose (so a `{ link_mode }` PATCH is not wrongly blocked by an injected
// default) — correct for its own job, but it guards the REJECT decision, not
// the write. This function makes the write agree with it: the raw body is the
// single source of truth for "did the client touch this field?".
export function buildUpdates(
  /** The schema's output. */
  parsed: Record<string, unknown>,
  /** The request body as it arrived, BEFORE validation. */
  rawBody: Record<string, unknown>,
  opts: {
    /** Columns a PATCH may never write, whatever the client sends. */
    nonUpdatable?: ReadonlySet<string>;
    /** Keys handled elsewhere (child tables, relations). */
    skip?: ReadonlySet<string>;
    /** Per-key value coercion. Return the value to store. */
    coerce?: (key: string, value: unknown) => unknown;
  } = {},
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    // The guard. Everything below is the pre-existing behaviour.
    if (!Object.prototype.hasOwnProperty.call(rawBody, k)) continue;
    if (v === undefined) continue;
    if (opts.nonUpdatable?.has(k)) continue;
    if (opts.skip?.has(k)) continue;
    updates[k] = opts.coerce ? opts.coerce(k, v) : v;
  }
  return updates;
}
