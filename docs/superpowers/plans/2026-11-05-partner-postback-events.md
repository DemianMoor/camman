# Partner postback events (sold / opt_out / invalid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partner postbacks fire for three per-key events — `purchase` (word `sold`), `opt_out`, `invalid` — through the existing queue, with a per-event status word and an `{event_id}` dedupe key.

**Architecture:** One additive migration adds an `event` column and per-event idempotency to `partner_postbacks`, and per-event words and "since" stamps to `partner_keys`. `opt_out` is a second idempotent INSERT…SELECT in `enqueuePartnerPostbacks`; `invalid` is one INSERT…SELECT inside the enrichment landline branch, in a savepoint. Delivery is unchanged.

**Tech Stack:** Next.js 16, TypeScript, Drizzle (hand-authored SQL migrations), Postgres (Supabase), tsx test scripts against the preview DB.

**Spec:** `docs/superpowers/specs/2026-11-05-partner-postback-events-design.md` (extends `2026-10-30-partner-postbacks-design.md`).

## Global Constraints

- Migration `0234_partner_postback_events`, additive only, starts with `SET LOCAL lock_timeout = '5s'`; journal `when` greater than origin/main's latest; snapshot cloned from 0233's and edited (migrations are hand-written).
- Event keys exactly `purchase`, `opt_out`, `invalid`. Default words exactly `sold`, `opt_out`, `invalid`. Word regex `^[A-Za-z0-9_.-]{1,32}$`.
- `event_id` exactly `purchase-<conversion_events.id>`, `opt_out-<drip_journeys.id>`, `invalid-<lead_inbox.id>`; test sends `test-<uuid>`.
- Every event: key `postback_enabled`, event ∈ `postback_event_keys`, `NOT k.sandbox`, source time ≥ `(k.postback_event_since ->> '<event>')::timestamptz`, required-fields rule from #422.
- No backfill for any event. `{payout}`, `{currency}`, `{conversion_id}` render empty for `opt_out` and `invalid`.
- Never from the send path: `scripts/test-postback-send-path-guard.ts` must stay green.
- Every DB-writing test/script runs through `node scripts/with-preview-env.mjs …` and calls `requirePreviewDb()`.
- PR1 = Tasks 1–6 (the server refuses `invalid` until PR2); PR2 = Tasks 7–8. Owner gate before the prod migration and before each merge.
- Docs are part of every task that changes behaviour (CLAUDE.md "Documentation maintenance"); `npm run check:docs` green.

## Review Focus

1. Adding `opt_out` to a key that has been live for weeks must not send the weeks of opt-outs before it (per-event since) — Task 3 test A7c, Task 4 test E12.
2. A first-purchase-only key still fires `opt_out` (first-only is a purchase rule) — Task 4 test E13.
3. A status word that needs URL-encoding or is empty — refused at save, never rendered raw — Task 2 test T8, Task 3 test A7b.
4. A failing `invalid` insert must never stop the lead's enrichment — Task 7 test I5.
5. Disable then re-enable a key: every live event's since is re-stamped, nothing from the gap is sent — Task 3 test A7d.

---

### Task 1: Migration 0234 + schema

**Files:**
- Create: `db/migrations/0234_partner_postback_events.sql`, `db/migrations/meta/0234_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts` (`partner_keys`, `partner_postbacks`)
- Test: `scripts/test-partner-postbacks-schema.ts` (new block S-E)

**Interfaces:**
- Produces: columns `partner_postbacks.event`, `partner_postbacks.lead_inbox_id`, `partner_keys.postback_status_words`, `partner_keys.postback_event_since`; indexes `partner_postbacks_key_journey_optout_uniq`, `partner_postbacks_key_inbox_invalid_uniq`; CHECKs `partner_postbacks_event_check`, widened `partner_keys_postback_event_keys_check`.

- [ ] **Step 1: Write the failing test** — block S-E in `test-partner-postbacks-schema.ts`, inside its rollback transaction:
  - `event` defaults to `'purchase'`; inserting `event='refund'` raises 23514.
  - Two non-test `opt_out` rows with the same `(partner_key_id, drip_journey_id)` raise 23505; a test row with the same pair does not.
  - Two non-test `invalid` rows with the same `(partner_key_id, lead_inbox_id)` raise 23505.
  - A `purchase` row and an `opt_out` row for the same journey coexist.
  - `postback_event_keys = '{purchase,opt_out,invalid}'` saves; `'{refund}'` raises 23514.
  - `postback_status_words` and `postback_event_since` default to `'{}'::jsonb`.
  - Backfill: `SELECT count(*) FROM partner_keys WHERE postback_active_since IS NOT NULL AND (postback_event_since ->> 'purchase')::timestamptz IS DISTINCT FROM postback_active_since` = 0.
- [ ] **Step 2: Run** `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-partner-postbacks-schema.ts` — Expected: FAIL (column "event" does not exist).
- [ ] **Step 3: Write the migration** — DDL per the spec's Schema section; the two unique indexes are partial `WHERE NOT is_test AND event = '<event>'`; backfill `UPDATE partner_keys SET postback_event_since = jsonb_build_object('purchase', to_jsonb(postback_active_since)) WHERE postback_active_since IS NOT NULL`. Mirror everything in `db/schema.ts`.
- [ ] **Step 4: Apply to preview and rerun** — `node scripts/with-preview-env.mjs npm run db:migrate`, then the test. Expected: ALL PASS. Also `npx tsx scripts/test-migration-numbering-guard.ts` PASS.
- [ ] **Step 5: Docs + commit** — `docs/03-data-model.md` (columns, indexes, ERD block), CHANGELOG line. `git commit -m "feat(partner-postbacks): 0234 per-event postbacks schema"`

### Task 2: Payload, placeholders, status words (pure)

**Files:**
- Modify: `lib/partners/postbacks/template.ts`, `lib/intake/passthrough.ts` (`SYSTEM_PLACEHOLDERS`)
- Test: `scripts/test-postback-template.ts`, `scripts/test-intake-passthrough.ts`

**Interfaces:**
- Produces (from `template.ts`, client-safe):
  - `export const POSTBACK_EVENTS = ["purchase", "opt_out", "invalid"] as const; export type PostbackEvent = (typeof POSTBACK_EVENTS)[number];`
  - `export const DEFAULT_STATUS_WORDS: Record<PostbackEvent, string> = { purchase: "sold", opt_out: "opt_out", invalid: "invalid" };`
  - `export const STATUS_WORD_RE = /^[A-Za-z0-9_.-]{1,32}$/;`
  - `export function statusWordFor(words: Record<string, unknown>, event: PostbackEvent): string` — the stored word if it is a string matching `STATUS_WORD_RE`, else the default.
  - `PostbackPayload` gains `event: PostbackEvent` and `event_id: string`.
  - `samplePayload(passthroughFields, words: Record<string, unknown>)` — `event: "purchase"`, `event_id: "test-<uuid>"`, `status: statusWordFor(words, "purchase")`.
- `SYSTEM_PLACEHOLDERS` gains `"event_id"`; `renderRaw` renders `{event_id}`.

- [ ] **Step 1: Failing tests** — T8 in `test-postback-template.ts`: `statusWordFor({}, "opt_out") === "opt_out"`; `statusWordFor({purchase: "sold!"}, "purchase") === "sold"` (invalid stored word falls back); `statusWordFor({purchase: "SALE"}, "purchase") === "SALE"`; rendering `?e={event_id}&s={status}` with `{event: "opt_out", event_id: "opt_out-abc", status: "opt_out", conversion_id: "", payout: null, currency: null}` gives `?e=opt_out-abc&s=opt_out`; `postbackConfigError` accepts `{event_id}`; `samplePayload([], {}).event_id` starts with `test-` and `.status === "sold"`. In `test-intake-passthrough.ts`: `passthroughNamesError(["event_id"])` is non-null.
- [ ] **Step 2: Run** `npx tsx scripts/test-postback-template.ts` and `npx tsx scripts/test-intake-passthrough.ts` — FAIL.
- [ ] **Step 3: Implement** in the two files (signatures above). Update `sendTestPostback` in `deliver.ts` to pass the key's `postback_status_words` to `samplePayload` (read it in the same SELECT).
- [ ] **Step 4: Rerun both** — PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(partner-postbacks): event + event_id in the payload, per-event status words`

### Task 3: Key config — event keys, words, per-event since

**Files:**
- Modify: `lib/validators/partner-keys.ts`, `lib/partners/postbacks/config.ts` (`applyPartnerKeyPatch`), `lib/partners/queries.ts` (select + JSON type)
- Test: `scripts/test-partner-postbacks-api.ts` (new block A7)

**Interfaces:**
- Consumes: `POSTBACK_EVENTS`, `STATUS_WORD_RE` (Task 2).
- Produces:
  - validator: `postback_event_keys: z.array(z.enum(["purchase", "opt_out"])).min(1).optional()` (PR2 adds `"invalid"`); `postback_status_words: z.record(z.enum(POSTBACK_EVENTS), z.string().regex(STATUS_WORD_RE)).optional()`.
  - `export function nextEventSince(prev: Record<string, string>, wasLive: { enabled: boolean; events: string[] }, nowLive: { enabled: boolean; events: string[] }, nowIso: string): Record<string, string>` in `config.ts` — keeps the stamp of an event live before and after, stamps `nowIso` on an event that becomes live, drops an event that stops being live. Pure.
  - `PartnerKeyJson` gains `postback_status_words`, `postback_event_since`.

- [ ] **Step 1: Failing tests** — A7 in `test-partner-postbacks-api.ts`:
  - A7a `nextEventSince` table: off→on with `[purchase, opt_out]` stamps both; on with `[purchase]` → on with `[purchase, opt_out]` keeps purchase's old stamp, stamps opt_out; on → off drops all; on with `[purchase, opt_out]` → on with `[purchase]` drops opt_out.
  - A7b PATCH `postback_status_words: {purchase: "sold now"}` → 400 (space); `{purchase: ""}` → 400; `{opt_out: "STOPPED"}` → 200 and stored merged with existing words.
  - A7c on an enabled key with `postback_event_since.purchase` 10 days old, PATCH `postback_event_keys: ["purchase","opt_out"]` → `opt_out` stamp is within 5 s of now, `purchase` unchanged.
  - A7d disable then enable → every live event re-stamped to the enable time.
  - A7e PATCH `postback_event_keys: ["invalid"]` → 400 (PR1).
- [ ] **Step 2: Run** `node scripts/with-preview-env.mjs npx tsx --conditions=react-server --conditions=import scripts/test-partner-postbacks-api.ts` — FAIL.
- [ ] **Step 3: Implement** — merge words (`{...existing, ...input}`), compute `postback_event_since` with `nextEventSince` against the merged enabled/events, keep `postback_active_since` behaviour as is.
- [ ] **Step 4: Rerun** — ALL PASS.
- [ ] **Step 5: Commit** `feat(partner-postbacks): per-key event list, status words, per-event since`

### Task 4: Enqueue — shared rules, purchase on the new shape, opt_out

**Files:**
- Modify: `lib/partners/postbacks/enqueue.ts`
- Test: `scripts/test-postback-enqueue-db.ts` (new E10–E14; existing E1–E9 must stay green with fixtures updated to set `postback_event_since`)

**Interfaces:**
- Consumes: Task 1 columns, Task 2 defaults (`DEFAULT_STATUS_WORDS` mirrored in SQL as `coalesce(k.postback_status_words ->> '<event>', '<default>')` — validated on write, so no regex in SQL).
- Produces:
  - `enqueuePartnerPostbacks(dbc): Promise<{ queued: number; queuedByEvent: { purchase: number; opt_out: number } }>` (callers reading `.queued` unchanged).
  - exported from `enqueue.ts` for Task 7: `eventLive(event: PostbackEvent, sourceTime: SQL): SQL` (predicate over alias `k`) and `requiredFieldsPresent(partnerData: SQL): SQL` (predicate over alias `k`).

- [ ] **Step 1: Failing tests:**
  - E10 purchase row now has `event='purchase'`, `payload.status === "sold"` (or the key's word), `payload.event_id === "purchase-<ce.id>"`.
  - E11 opted-out journey (closed 1 h ago, since 2 h ago) → 1 `opt_out` row: `payload.status "opt_out"`, `event_id "opt_out-<j.id>"`, `occurred_at` = `closed_at` (UTC `Z`), `conversion_id ""`, `payout null`, `fields` = partner data; enqueue twice ⇒ still 1.
  - E12 journey closed before the opt_out since ⇒ 0 rows; key without `opt_out` in its events ⇒ 0; sandbox key ⇒ 0 (also for purchase); lead missing the template's passthrough field ⇒ 0.
  - E13 first-only key: journey with a purchase AND an opt-out ⇒ 1 purchase + 1 opt_out row.
  - E14 a journey in another org with the same contact id ⇒ 0 (org-matched joins).
- [ ] **Step 2: Run** `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-postback-enqueue-db.ts` — FAIL.
- [ ] **Step 3: Implement** — extract the key predicate into one `sql` fragment `eventLive(event: PostbackEvent, sourceTime: SQL)` (enabled, event ∈ keys, NOT sandbox, source time ≥ since) and the #422 required-fields fragment `requiredFieldsPresent(partnerData: SQL)`; purchase INSERT uses both and writes `event`, word, `event_id`; add the opt_out INSERT (source `drip_journeys j` with `j.state = 'opted_out' AND j.closed_at > now() - interval '30 days'`, joined org-matched to `lead_events` and `partner_keys`), `ON CONFLICT DO NOTHING`, same advisory lock.
- [ ] **Step 4: Rerun** — ALL PASS (E1–E14). Then on prod, read-only: `EXPLAIN` the opt_out SELECT inside `BEGIN READ ONLY` and record the plan + time in the PR body (expected: `drip_journeys_org_state_routed_idx`, < 50 ms).
- [ ] **Step 5: Commit** `feat(partner-postbacks): opt_out postbacks from opted-out journeys`

### Task 5: Key card UI + log Event column

**Files:**
- Modify: `components/settings/partner-key-postback.tsx`, `lib/partners/postbacks/config.ts` (`listKeyPostbacks` returns `event`)
- Test: `scripts/test-partner-postbacks-api.ts` A5 (field set gains `event`); visual check

**Interfaces:**
- Consumes: Task 2 exports (client-safe `template.ts` only), Task 3 PATCH fields.

- [ ] **Step 1:** Replace "Fires on: Purchase (approved)" with checkboxes **Purchase (approved)** and **Opt-out** (Invalid hidden until PR2), each with a status-word input (placeholder = default word, `STATUS_WORD_RE` checked client-side, server message shown inline); at least one event checked; chips gain `{event_id}`; log table gains an **Event** column. Saves through the existing PATCH (`postback_event_keys`, `postback_status_words`).
- [ ] **Step 2:** Update A5's expected field set to include `event`; run the API test — PASS. `npx tsc --noEmit`, eslint on changed files.
- [ ] **Step 3: Visual check** on a local dev server against preview with a throwaway owner (recipe: memory `reference_playwright_visual_check_recipe`), fixture torn down: both checkboxes and word inputs render, saving `opt_out` + word `STOPPED` persists, the log shows an Event column. Screenshots deleted afterwards.
- [ ] **Step 4: Commit** `feat(partner-postbacks): event checkboxes and status words on the key card`

### Task 6: PR1 docs

**Files:** `lib/intake/api-contract.ts` (`POSTBACK_DOC`, `API_CHANGELOG`), `docs/partners/lead-intake.md` (regenerated), `docs/04-features/partner-postbacks.md`, `docs/05-flows.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md`

- [ ] **Step 1:** Public page — the events a partner can receive (purchase, opt-out; invalid added in PR2), `{status}` = the agreed word per event, `{event_id}` as the dedupe key (replacing `{conversion_id}` in that rule; `{conversion_id}` stays documented as sale-only), which values are empty per event; API changelog entry dated the merge day. No per-partner values.
- [ ] **Step 2:** Internal docs — feature doc (events table, per-event since, words snapshotted at enqueue), flows (opt_out path into the queue), conventions (event_id format; per-event since; "opt_out is journey-only, by owner ruling"), CHANGELOG.
- [ ] **Step 3:** `npx tsx scripts/generate-partner-docs.ts`, `npm run check:docs`, `npm run check:guards` — PASS.
- [ ] **Step 4: Commit** `docs(partner-postbacks): events, status words, event_id`

**PR1 gate:** owner go → apply 0234 to prod (only pending migration, verify by query, integrity check) → merge → deploy → inert proof (no key has `opt_out` enabled; pml's purchase rows unchanged) → owner switches pml to `status={status}` and ticks Opt-out.

### Task 7: invalid at enrichment (PR2)

**Files:**
- Create: `lib/partners/postbacks/invalid.ts`
- Modify: `lib/drip/enrichment.ts` (landline branch), `lib/validators/partner-keys.ts` (enum adds `"invalid"`), `components/settings/partner-key-postback.tsx` (show Invalid checkbox)
- Test: create `scripts/test-postback-invalid-db.ts`; add a source bar to `scripts/test-postback-send-path-guard.ts` or a new guard in `check:guards`

**Interfaces:**
- Produces:
  - `export async function enqueueInvalidPostback(tx: DbOrTx, o: { orgId: string; partnerKeyId: number; leadInboxId: string; partnerData: Record<string, unknown> | null; at: Date }): Promise<boolean>` — one INSERT…SELECT FROM `partner_keys` with `eventLive("invalid", at)` and `requiredFieldsPresent`, `event='invalid'`, `lead_inbox_id`, `event_id 'invalid-<id>'`, `occurred_at = at`, `ON CONFLICT DO NOTHING`; returns whether a row was inserted.
  - `export async function tryEnqueueInvalidPostback(tx: DbOrTx, o: Parameters<typeof enqueueInvalidPostback>[1], insert = enqueueInvalidPostback): Promise<void>` — runs `insert` in a savepoint (`tx.transaction`), on error logs and latches alert `partner-postbacks-invalid-failed` (gated on `postbacksLive()`), never throws.

- [ ] **Step 1: Failing tests** (`test-postback-invalid-db.ts`, rollback transaction):
  - I1 enabled key with `invalid` ⇒ 1 row, `payload.status "invalid"`, `event_id "invalid-<uuid>"`, `conversion_id ""`, `drip_journey_id` and `lead_event_id` NULL; twice ⇒ 1.
  - I2 key without `invalid`, disabled key, sandbox key, `at` before since, missing required field ⇒ 0 each.
  - I3 enrichment end-to-end on preview: a landline inbox row (fixture `phone_lookups` row `line_type='landline'`, no Telnyx call) ⇒ inbox row deleted, counters +1 landline, exactly 1 `invalid` postback row.
  - I4 a non-landline (unknown) row ⇒ 0 postback rows (G19).
  - I5 `tryEnqueueInvalidPostback` with an `insert` that throws ⇒ resolves, the outer transaction is still usable (a following `SELECT 1` succeeds), the lead's DELETE still happens.
- [ ] **Step 2: Run** `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-postback-invalid-db.ts` — FAIL.
- [ ] **Step 3: Implement**; in `enrichment.ts` call `tryEnqueueInvalidPostback` after `bumpIntakeCounters` and BEFORE the `DELETE FROM lead_inbox` (the claim query already selects `partner_data` and `partner_key_id`). Source bar: `enrichment.ts` contains the call and it precedes the DELETE in the landline block.
- [ ] **Step 4: Rerun** — ALL PASS; `npm run check:guards` (send-path guard green; `lib/drip/enrichment.ts` is not a send-path file).
- [ ] **Step 5: Commit** `feat(partner-postbacks): invalid postbacks for landline leads at enrichment`

### Task 8: PR2 docs

- [ ] Public page and API changelog add `invalid` (landline numbers only); feature doc, flows (enrichment → queue), conventions ("invalid = landline only; unknown stays sendable (G19)"), CHANGELOG; regenerate partner docs; `npm run check:docs` PASS. Commit `docs(partner-postbacks): invalid event`.

**PR2 gate:** owner go → merge → deploy → owner ticks Invalid on pml → watch the log for the first `invalid` rows.
