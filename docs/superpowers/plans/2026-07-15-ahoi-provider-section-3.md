# Ahoi Provider — Section 3 (DLR + CDR Intake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Boundary this plan draws (PRESSURE-TEST THIS FIRST)

Spec §5 titles this section "DLR + CDR intake (capture + reconcile + two derived signals)" and explicitly scopes it to **capture + reconcile only** — no `stage_sends` status column write (deferred, §8). This plan reads that boundary literally and draws it one notch tighter than "capture + reconcile":

- **IN SCOPE (this plan):** DLR webhook capture, DLR→`stage_sends` reconcile, the reject-rate circuit-breaker signal, CDR poll capture (inbound rows only), inbound (STOP) webhook capture, and — carried forward from Section 2's final review — the no-sender-number kickoff guard.
- **OUT OF SCOPE (Section 4, spec §6):** any `opt_outs` INSERT. That means no keyword matching, no contact upsert, no suppression, no `opt_out_attributions`. Section 3 defensively **classifies** a DLR's `send_status` against the known-good values and **logs distinctly** when it sees something unrecognized (G4) — it does not decide "this is an opt-out" and act on it.

Why this split and not "fold opt-out writes into Section 3": every table Section 3 creates (`ahoi_inbound_events`) is built with the exact columns Section 4 needs to fill (`matched_contact_id`, `matched_stage_send_id`, `result`, `processed_at`) so Section 4 needs **zero migration of its own** — it only UPDATEs rows Section 3 already captured. This mirrors `texthub_inbound_events` (migration 0055) precisely: that table's own header comment says "Stage A — capture only... Stage B [is] built against the captured payload shape." Section 3 IS this project's Stage A for Ahoi; Section 4 is Stage B. Folding opt-out writes in here would also pull in the go-live harness (spec §6, a hard blocker with its own 4-part test matrix) — a materially bigger, separately-checkpointed unit of work the spec already treats as its own section. **Recommendation: keep the boundary as drawn.** If the user's pressure-test disagrees, the natural alternate cut is "Task 9: opt-out writes," not a wholesale re-scope.

---

## Goal

Implement Ahoi's DLR delivery-receipt intake, its inbound-message CDR poll backstop, and its inbound (STOP-carrying) webhook — all as **capture + reconcile**, wired into the existing circuit-breaker machinery for one new derived signal (DLR reject-rate). Close a fail-safe gap surfaced in Section 2's final review: an Ahoi stage with no `provider_phone_id` currently sails through kickoff, materializes every recipient, and only fails at drain (wasting the attempt and risking a false failure-spike pause) — Section 3 refuses it at kickoff instead.

## Architecture

Three independent capture pipelines feeding two new append-only tables, plus one small kickoff addition:

- **DLR pipeline:** `POST /api/webhooks/ahoi/dlr/[token]` → `ahoiAdapter.parseDlr()` (pure) → `captureAhoiDlrEvent()` (raw archival) → `reconcileAhoiDlrEvent()` (match to `stage_sends` + feed the reject-rate breaker). All three run in one request; unlike TextHub's historical Stage-A/Stage-B split, Ahoi's DLR capture and reconcile are cheap enough (single-row lookup, no fan-out) to do together from day one.
- **Inbound webhook pipeline:** `POST /api/webhooks/ahoi/inbound/[token]` → `ahoiAdapter.parseInbound()` (pure) → `captureAhoiInboundEvent()` (raw archival only — no reconcile, no opt-out write; Section 4's job).
- **CDR poll pipeline:** `*/15` cron → `pollAhoiCdr()` fetches a rolling ET window from `/cdrs/download/csv`, filters `direction=in`, and idempotently captures into the same `ahoi_inbound_events` table (`source='cdr'`) the webhook pipeline writes to (`source='webhook'`) — a reconciliation backstop for webhook-outage gaps, not because the webhook is known to be lossy (Phase 0 recon measured 0% webhook-layer loss; the ~50% observed loss was upstream-carrier, unrecoverable by any ingestion method).
- **Kickoff guard:** `lib/sends/kickoff.ts` gains a pre-materialization refusal for an Ahoi stage with no sender number, gated on the provider's key so TextHub (which doesn't need a `provider_phone_id` — its number is bound to the api_key account-side) is unaffected.

One column-naming wrinkle carried from Section 2, **not fixed here**: `stage_sends.texthub_message_id` now also holds Ahoi's send-time uuid. DLR reconcile matches against this column as-is; renaming it is out of scope (G2) and flagged with a comment at every touch point.

## Tech Stack

Next.js 16 (App Router route handlers) · TypeScript · Drizzle ORM · Postgres (Supabase) · `papaparse` (already a dependency, used for CDR CSV) · `date-fns-tz` (already a dependency, reused via `lib/campaign-timezone.ts`'s `CAMPAIGN_TIMEZONE`/`campaignDayBoundsUtc` for the ET poll window) · `tsx` test scripts (no vitest/jest — tests are `scripts/test-*.ts` run via `npx tsx`).

## Global Constraints

- **`SEND_ENABLED` stays OFF** the entire phase (never flipped in this plan).
- **G1 — path-token auth only.** Both new webhook routes authenticate via the token in the URL path (resolved to a `provider_credentials` row), exactly like `/api/webhooks/texthub/opt-out/[token]`. The 207.181.190.0/24 IP allowlist is **defense-in-depth only** — an out-of-range source IP is logged (`console.warn`), never rejected. Rejecting on IP would risk bricking the real webhook on an infra change at Ahoi's end; the token is the actual gate.
- **G2 — TextHub unchanged.** No file under `lib/sends/texthub.ts` / `lib/sends/providers/texthub.ts` is touched. `stage_sends.texthub_message_id` is **not renamed** — every touch point gets a one-line "naming debt" comment instead. `scripts/verify-drain.ts` must stay green (nothing in this plan changes the drain's send path).
- **G4 — defensive DLR classification.** Only `send_status` values Ahoi is confirmed to emit (`carrier_sent`, `delivered`) are treated as known; `rejected` is written defensively (spec O1: doc-inferred, never observed live) and anything else logs a **distinct** `console.warn` line so a real opt-out-error signature is spottable in production logs the first time it appears. Section 3 never writes `opt_outs` off this signal.
- **G5 — separate Ahoi tables.** `ahoi_dlr_events` and `ahoi_inbound_events` are new, Ahoi-only tables. `texthub_inbound_events` is not touched, not generalized, not reused.
- **Migrations are hand-authored, not generated** (next index is `0109`); the migration task is a **HARD USER GATE** — same protocol as Section 1 Task 4 / Section 2 Task 4 (implementer authors, confirms RED, a human approves, controller applies + confirms GREEN). `DATABASE_URL` points at the shared prod DB.
- **The `stage_sends` index in 0109 is built CONCURRENTLY, out-of-band.** `stage_sends` is large + hot (820K+ rows / ~490 MB in prod); a plain in-migration `CREATE INDEX` would take an ACCESS EXCLUSIVE lock and block live sends during apply. Established repo pattern (migrations 0101/0096/0088): the migration statement is `CREATE INDEX IF NOT EXISTS`, and a standalone `postgres`-client script runs `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (CONCURRENTLY can't run inside drizzle's migration transaction) BEFORE `db:migrate`, so the migration statement no-ops. The two brand-new EMPTY tables carry no lock risk and stay as normal in-migration `CREATE TABLE`.
- **Prod data writes outside a migration are also gated.** Task 3 (minting the shared Ahoi webhook token) is a plain `UPDATE` against the shared prod `provider_credentials` row — not a schema change, but still a live-DB write, so it gets the same author-then-human-approves protocol, just without the migration/journal/snapshot machinery.
- Tests are `tsx` scripts run via `npx tsx scripts/test-*.ts`, using the repo's `check(name, cond, detail)` idiom.
- **Webhook route tests must not hit the real Ahoi network.** They invoke the exported route handler function directly with a hand-built `NextRequest` (form-encoded body) — no dev server required, no outbound `fetch` to Ahoi (capture-only routes never call out). Two of these tests (`test-ahoi-dlr-webhook.ts`, `test-ahoi-inbound-webhook.ts`) write real rows into the new, empty, append-only `ahoi_dlr_events` / `ahoi_inbound_events` tables against the shared DB (there is no way to inject a transaction into a Next.js route handler that imports the `db` singleton, matching TextHub's own webhook route shape) — every written row carries a `test-` prefixed marker and is deleted in a `finally` block. This never touches `contacts`, `opt_outs`, `campaigns`, or any table with real production data.
- **Migration snapshot finding (verified, changes how Task 2 is done):** `db/migrations/meta/0108_snapshot.json`'s `"tables"` map is missing `stage_sends`, `send_attempts`, `send_circuit_events`, `provider_credentials`, and `texthub_inbound_events` — i.e. this project's hand-authored migrations have **never** kept the snapshot's table definitions in sync with reality; only `id`/`prevId` chain continuity and the `creatives` entry (touched directly by Section 2 Task 4) are current. `scripts/verify-migration-integrity.ts` confirms this is harmless: it checks SQL-file existence, a SHA-256 hash of the SQL against `drizzle.__drizzle_migrations`, and `prevId` chaining — it never inspects `"tables"` contents. **Task 2 therefore clones `0109_snapshot.json` forward with only `id`/`prevId` bumped**, consistent with how every other new hand-authored table in this project's history has been handled (i.e. not added to the snapshot). Hand-crafting two multi-column table entries into the JSON would be new, unverified, unrewarded work.

---

## File Structure

**New:**
- `db/migrations/0109_ahoi_dlr_inbound_events.sql` — `ahoi_dlr_events`, `ahoi_inbound_events`, RLS, + one new (`IF NOT EXISTS`) index on `stage_sends.texthub_message_id`.
- `db/migrations/meta/0109_snapshot.json` — cloned from `0108_snapshot.json`, `id`/`prevId` bumped only (see Global Constraints finding).
- `scripts/apply-ahoi-stage-sends-index-concurrent.ts` — builds the `stage_sends` index `CONCURRENTLY` out-of-band (large/hot table) BEFORE `db:migrate`; the in-migration `IF NOT EXISTS` then no-ops. Mirrors `scripts/apply-eligible-indexes-concurrent.ts`.
- `scripts/seed-ahoi-webhook-token.ts` — one-time mint of `provider_credentials.inbound_webhook_token` for the Ahoi provider-default credential; prints both webhook URLs for manual portal registration (no Ahoi registration API exists, unlike TextHub's `registerOptOutCallback`).
- `lib/sends/ahoi-webhook-shared.ts` — tiny shared helpers used by both new webhook routes: `headersToObject`, `queryToObject`, `extractClientIp`, `isKnownAhoiIp`.
- `lib/sends/ahoi-dlr.ts` — `captureAhoiDlrEvent`, `reconcileAhoiDlrEvent` (dbc-parameterized, transaction-testable).
- `lib/sends/ahoi-inbound.ts` — `captureAhoiInboundEvent` (dbc-parameterized).
- `lib/sends/ahoi-cdr-poll.ts` — `computeCdrPollWindow`, `fetchAhoiCdr` (real), `pollAhoiCdr`.
- `app/api/webhooks/ahoi/dlr/[token]/route.ts` — DLR webhook endpoint.
- `app/api/webhooks/ahoi/inbound/[token]/route.ts` — inbound (STOP-carrying) webhook endpoint.
- `app/api/cron/ahoi-cdr-poll/route.ts` — CDR poll cron + manual-trigger route (under the existing `/api/cron/` namespace).
- `scripts/test-ahoi-parse.ts` — `parseDlr`/`parseInbound` pure unit tests.
- `scripts/test-ahoi-events-tables-columns.ts` — `information_schema` check for migration 0109.
- `scripts/test-ahoi-webhook-token.ts` — checks `inbound_webhook_token` is set.
- `scripts/test-ahoi-dlr-webhook.ts` — DLR route capture (marker-cleanup).
- `scripts/test-ahoi-dlr-reconcile.ts` — reconcile + reject-breaker (rolled-back tx).
- `scripts/test-ahoi-inbound-webhook.ts` — inbound route capture (marker-cleanup).
- `scripts/test-ahoi-cdr-poll.ts` — window computation (pure) + poll idempotency/direction-filter (rolled-back tx, injected fetcher).
- `scripts/test-kickoff-no-sender.ts` — no-sender-number kickoff refusal (rolled-back tx).

**Modified:**
- `lib/sends/providers/ahoi.ts` — real `parseDlr`/`parseInbound` + exported `extractAhoiWebhookFields`, `ahoiBaseUrl` (Task 1, Task 7).
- `db/schema.ts` — `ahoi_dlr_events`, `ahoi_inbound_events` tables; new partial index on `stage_sends.texthub_message_id` (Task 2).
- `db/migrations/meta/_journal.json` — new entry for `0109` (Task 2).
- `lib/sends/circuit-breakers.ts` — `ahoiDlrRejectSpikeThreshold()`, `ahoiDlrRejectWindowSeconds()` (env-backed config helpers), `countAhoiDlrRejectsSince` (Task 5).
- `lib/sends/kickoff.ts` — `KickoffRefusal` gains `no_sender_number`; `MainRow` gains `provider_phone_id`; provider query gains `sms_provider_id`; new guard (Task 8).
- `lib/sends/kickoff-refusals.ts` — message for `no_sender_number` (Task 8).
- `lib/sends/scheduled.ts` — `PERMANENT_REFUSALS` gains `no_sender_number` (Task 8).
- `vercel.json` — new cron entry for `/api/cron/ahoi-cdr-poll` at `13,28,43,58 * * * *` (staggered off the other pollers' offsets) (Task 7).
- `.env.example` — no new variables (CDR poll reuses `AHOI_API_BASE_URL` + the DB-stored `api_key`).
- `docs/03-data-model.md`, `docs/04-features/sms-send-pipeline.md`, `docs/05-flows.md`, `docs/06-integrations.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md` — updated per task (see each task's doc step).

---

## Task 1: `ahoiAdapter.parseDlr` / `parseInbound` (pure)

**Files:**
- Modify: `lib/sends/providers/ahoi.ts`
- Test: `scripts/test-ahoi-parse.ts`

**Interfaces:**
- Consumes: `RawWebhook`, `DlrEvent`, `InboundEvent` from `./types` (unchanged — Section 2's final review confirmed these shapes need no churn for Section 3).
- Produces: `ahoiAdapter.parseDlr(raw)` / `ahoiAdapter.parseInbound(raw)` are real; new exported `extractAhoiWebhookFields(raw): Record<string,string>` (merges `raw.query` and form-decoded `raw.body`, body wins) — used internally by both parsers AND directly by Task 4/6's capture functions to archive `source`/`destination` fields that `DlrEvent` doesn't carry (that type only carries what reconcile needs: `providerUuid`, `sendStatus`, `status`, `smppStatus`, `smppCode`, `error` — extending it would be schema churn the Section 2 review already ruled unnecessary).

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-parse.ts`

```ts
// ahoiAdapter.parseDlr / parseInbound — pure functions, no DB, no network.
// Field shapes are Phase 0 recon facts (form-encoded POST bodies).
// Run: npx tsx scripts/test-ahoi-parse.ts
import { ahoiAdapter, extractAhoiWebhookFields } from "@/lib/sends/providers/ahoi";
import type { RawWebhook } from "@/lib/sends/providers/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function raw(body: string, query: Record<string, string> = {}): RawWebhook {
  return { query, body, headers: {} };
}

// ---- extractAhoiWebhookFields ----
const merged = extractAhoiWebhookFields(raw("a=1&b=2", { c: "3" }));
check("merges query + form body", merged.a === "1" && merged.b === "2" && merged.c === "3", JSON.stringify(merged));
const bodyWins = extractAhoiWebhookFields(raw("a=body", { a: "query" }));
check("body wins over query on key collision", bodyWins.a === "body");

// ---- parseDlr ----
// Observed live (Phase 0 recon): intermediate + final callbacks.
const intermediate = ahoiAdapter.parseDlr(raw(
  "uuid=s-abc123-05152026&source=3158359592&destination=5642155963&send_status=carrier_sent&status=sent&smpp_status=sent&smpp_code=&error=000",
));
check("intermediate DLR parses", intermediate !== null);
check("intermediate providerUuid", intermediate?.providerUuid === "s-abc123-05152026");
check("intermediate sendStatus", intermediate?.sendStatus === "carrier_sent");
check("intermediate status", intermediate?.status === "sent");
check("intermediate smppStatus", intermediate?.smppStatus === "sent");
check("intermediate error", intermediate?.error === "000");

const final = ahoiAdapter.parseDlr(raw(
  "uuid=s-abc123-05152026&source=3158359592&destination=5642155963&send_status=delivered&status=delivered&smpp_status=DELIVRD&smpp_code=&error=000",
));
check("final DLR: status is lowercase 'delivered'", final?.status === "delivered");
check("final DLR: smppStatus carries the real spelling DELIVRD", final?.smppStatus === "DELIVRD");

// Multi-segment extra: numeric-only uuid, still parses (reconcile handles the
// non-match separately — parseDlr's job is just to extract the fields).
const numericUuid = ahoiAdapter.parseDlr(raw(
  "uuid=4131784060328527222&source=3158359592&destination=5642155963&send_status=delivered&status=delivered&smpp_status=DELIVRD&error=000",
));
check("numeric-uuid multi-segment extra still parses", numericUuid?.providerUuid === "4131784060328527222");

// Empty smpp_code/error -> null, not empty string (cleaner downstream logic).
check("empty smpp_code -> null", intermediate?.smppCode === null);

// Missing uuid -> null (nothing to reconcile against).
const noUuid = ahoiAdapter.parseDlr(raw("source=3158359592&destination=5642155963&send_status=sent&status=sent"));
check("DLR with no uuid -> null (can't reconcile)", noUuid === null);

// Doc-inferred rejected/600 shape (O1 — never observed live, written defensively).
const rejected = ahoiAdapter.parseDlr(raw("uuid=s-xyz-05152026&send_status=rejected&status=rejected&error=600"));
check("doc-inferred rejected DLR still parses (defensive)", rejected?.sendStatus === "rejected");

// ---- parseInbound ----
const inbound = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Hello&type=sms&cost=0"));
check("inbound parses", inbound !== null);
check("inbound source", inbound?.source === "5642155963");
check("inbound destination", inbound?.destination === "3158359592");
check("inbound message", inbound?.message === "Hello");
check("inbound type", inbound?.type === "sms");

// Form/URL-encoded message (recon fact: %0A=newline, +=space) — proven via
// standard URLSearchParams decoding, no custom decode step needed.
const encoded = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Stop+please%0Athanks&type=sms"));
check("form-encoded message decodes (+ -> space, %0A -> newline)", encoded?.message === "Stop please\nthanks", JSON.stringify(encoded));

// Bare "Stop" (recon: Ahoi forwards this, doesn't swallow it).
const bareStop = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Stop&type=sms"));
check("bare Stop message parses (keyword matching is Section 4's job, not this)", bareStop?.message === "Stop");

// Missing source/destination -> null.
const noSource = ahoiAdapter.parseInbound(raw("destination=3158359592&message=Hi"));
check("inbound with no source -> null", noSource === null);

// type defaults to "sms" when absent.
const noType = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Hi"));
check("missing type defaults to 'sms'", noType?.type === "sms");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-parse.ts`
Expected: FAIL — `parseDlr`/`parseInbound` still throw `"not implemented until Section 3"`; `extractAhoiWebhookFields` doesn't exist.

- [ ] **Step 3: Implement in `lib/sends/providers/ahoi.ts`**

Add near the top (after `toAhoiRecipient`), export the base-URL resolver (needed by Task 7's CDR poll — small deviation from "only touch what Task 1 needs" justified by avoiding a duplicate `AHOI_API_BASE_URL` fallback elsewhere):

```ts
export function ahoiBaseUrl(): string {
  return process.env.AHOI_API_BASE_URL ?? AHOI_DEFAULT_BASE_URL;
}
```

(Remove the old unexported `function ahoiBaseUrl()` — same body, just add `export`.)

Add after `toAhoiRecipient`:

```ts
// Merge query params + form-decoded body into one flat field map. Body wins
// on key collision (Ahoi's confirmed shape is POST form-encoded; query is a
// defensive fallback in case a future callback arrives as GET). Used by both
// parseDlr/parseInbound (which need the typed subset) AND the capture
// functions in lib/sends/ahoi-dlr.ts / lib/sends/ahoi-inbound.ts (which
// archive raw source/destination fields that DlrEvent doesn't carry) — so
// both paths extract fields identically and can never disagree.
export function extractAhoiWebhookFields(raw: RawWebhook): Record<string, string> {
  const out: Record<string, string> = { ...raw.query };
  if (raw.body) {
    const params = new URLSearchParams(raw.body);
    params.forEach((v, k) => {
      out[k] = v;
    });
  }
  return out;
}
```

Replace the `parseDlr`/`parseInbound` stubs inside `ahoiAdapter`:

```ts
  parseDlr(raw: RawWebhook): DlrEvent | null {
    const f = extractAhoiWebhookFields(raw);
    const uuid = f.uuid?.trim();
    if (!uuid) return null; // nothing to reconcile against
    return {
      providerUuid: uuid,
      sendStatus: (f.send_status ?? "").trim(),
      status: (f.status ?? "").trim(),
      smppStatus: f.smpp_status?.trim() || null,
      smppCode: f.smpp_code?.trim() || null,
      error: f.error?.trim() || null,
    };
  },
  parseInbound(raw: RawWebhook): InboundEvent | null {
    const f = extractAhoiWebhookFields(raw);
    const source = f.source?.trim();
    const destination = f.destination?.trim();
    if (!source || !destination) return null;
    return {
      source,
      destination,
      message: f.message ?? "",
      type: (f.type ?? "sms").trim(),
      cost: f.cost?.trim() || null,
    };
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-parse.ts`
Expected: PASS — `ALL PASS`, exit 0.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/sends/providers/ahoi.ts scripts/test-ahoi-parse.ts
git commit -m "feat(ahoi): implement parseDlr/parseInbound (pure, form-encoded field extraction)"
```

---

## Task 2: `ahoi_dlr_events` + `ahoi_inbound_events` migration (HARD USER GATE)

**Files:**
- Create: `db/migrations/0109_ahoi_dlr_inbound_events.sql`
- Create: `db/migrations/meta/0109_snapshot.json`
- Create: `scripts/apply-ahoi-stage-sends-index-concurrent.ts`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts`
- Modify: `docs/03-data-model.md`
- Test: `scripts/test-ahoi-events-tables-columns.ts`

**Interfaces:**
- Produces: `ahoi_dlr_events`, `ahoi_inbound_events` tables (both DB + Drizzle schema); a new partial index `stage_sends_texthub_message_id_idx`.

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-events-tables-columns.ts`

```ts
// Verifies migration 0109 landed: both new tables + their key columns, plus
// the new stage_sends index. information_schema only — no writes.
// Run: npx tsx scripts/test-ahoi-events-tables-columns.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const dlrCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ahoi_dlr_events'
  `;
  const dlrColNames = new Set(dlrCols.map((r) => r.column_name as string));
  check("ahoi_dlr_events exists", dlrCols.length > 0);
  for (const c of ["provider_uuid", "send_status", "smpp_status", "smpp_code", "matched_stage_send_id", "result", "processed_at"]) {
    check(`ahoi_dlr_events.${c} exists`, dlrColNames.has(c));
  }

  const inboundCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ahoi_inbound_events'
  `;
  const inboundColNames = new Set(inboundCols.map((r) => r.column_name as string));
  check("ahoi_inbound_events exists", inboundCols.length > 0);
  for (const c of ["source", "source_number", "destination_number", "provider_uuid", "matched_contact_id", "matched_stage_send_id", "result", "processed_at"]) {
    check(`ahoi_inbound_events.${c} exists`, inboundColNames.has(c));
  }

  const uniq = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'ahoi_inbound_events' AND indexname = 'ahoi_inbound_events_provider_uuid_uniq'
  `;
  check("ahoi_inbound_events provider_uuid partial unique index exists", uniq.length === 1);

  const stageSendsIdx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'stage_sends' AND indexname = 'stage_sends_texthub_message_id_idx'
  `;
  check("stage_sends_texthub_message_id_idx exists", stageSendsIdx.length === 1);

  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx scripts/test-ahoi-events-tables-columns.ts`
Expected: FAIL — all checks ✗ (tables don't exist yet).

- [ ] **Step 3: Author `db/migrations/0109_ahoi_dlr_inbound_events.sql`**

```sql
-- Ahoi Phase 1, Section 3 (DLR + CDR intake) — capture + reconcile tables.
--
-- G5: separate Ahoi-specific tables, mirroring texthub_inbound_events' shape
-- (migration 0055) rather than generalizing it.
--
-- Scope note: this migration creates the FULL column shape for
-- ahoi_inbound_events (including matched_contact_id/matched_stage_send_id/
-- result/processed_at) even though Section 3's code does not populate them —
-- Section 4 (opt-out intake) will UPDATE these existing columns rather than
-- needing its own migration, exactly mirroring how texthub_inbound_events'
-- 0055 pre-created its own "Stage B" columns ahead of the code that fills
-- them ("NOTHING here parses STOP... that is Stage B, built against the
-- captured payload shape").

-- DLR (delivery receipt) capture + reconcile. Deliberately NO uniqueness
-- constraint on provider_uuid: Ahoi sends TWO callbacks per message ~1s apart
-- (intermediate + final) plus EXTRA DLRs under numeric-only uuids for
-- multi-segment sends (Phase 0 recon) — all are legitimate distinct rows.
CREATE TABLE public.ahoi_dlr_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  -- Exactly what arrived, captured verbatim (mirrors texthub_inbound_events).
  method                text NOT NULL,
  query                 jsonb,
  headers               jsonb,
  raw_body              text,
  -- Parsed via ahoiAdapter.parseDlr() at capture time. Section 3 does its own
  -- parse+reconcile in one request (unlike TextHub's deferred Stage A/B
  -- split) since a single-row uuid lookup is cheap.
  provider_uuid         text,
  source                text,
  destination           text,
  send_status           text,
  status                text,
  smpp_status           text,
  smpp_code             text,
  error                 text,
  -- Reconcile result: match provider_uuid -> stage_sends.texthub_message_id.
  -- NAMING DEBT: that column is named after TextHub but also holds Ahoi's
  -- send-time uuid since Section 2 — not renamed here (G2). See the comment
  -- at the match site in lib/sends/ahoi-dlr.ts.
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz
);
--> statement-breakpoint

CREATE INDEX ahoi_dlr_events_org_id_idx ON public.ahoi_dlr_events (org_id);
--> statement-breakpoint
CREATE INDEX ahoi_dlr_events_received_at_idx ON public.ahoi_dlr_events (received_at);
--> statement-breakpoint
-- Serves the reject-rate circuit-breaker's rolling-window count
-- (lib/sends/circuit-breakers.ts countAhoiDlrRejectsSince).
CREATE INDEX ahoi_dlr_events_provider_reject_idx
  ON public.ahoi_dlr_events (provider_id, send_status, received_at);
--> statement-breakpoint

ALTER TABLE public.ahoi_dlr_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ahoi_dlr_events_select_own_org"
  ON public.ahoi_dlr_events FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- Reconcile lookups (DLR provider_uuid -> stage_sends row by
-- texthub_message_id) need this index; any future TextHub DLR use would
-- share it too (same column, shared index — see the naming-debt note above).
--
-- stage_sends is LARGE (820K+ rows / ~490 MB in prod) and hot — a plain
-- CREATE INDEX would take an ACCESS EXCLUSIVE lock and block sends during
-- apply. So this index is built OUT-OF-BAND, CONCURRENTLY, by
-- scripts/apply-ahoi-stage-sends-index-concurrent.ts BEFORE `db:migrate`
-- runs (CONCURRENTLY cannot run inside drizzle's migration transaction).
-- The IF NOT EXISTS below then NO-OPS, leaving the migration recorded in the
-- chain. Same established pattern as migration 0101 (contacts_phone_number_idx)
-- / 0088 / 0096. The two CREATE TABLE statements above are brand-new EMPTY
-- tables — no lock risk, so they stay as normal in-migration statements.
CREATE INDEX IF NOT EXISTS stage_sends_texthub_message_id_idx
  ON public.stage_sends (texthub_message_id)
  WHERE texthub_message_id IS NOT NULL;
--> statement-breakpoint

-- Inbound (STOP / general reply) capture — TWO ingestion channels sharing one
-- table (G5): 'webhook' (real-time push, Task 6) and 'cdr' (the */15 poll
-- backstop, Task 7). CDR rows carry a real provider_uuid (plain 5-group hex,
-- Phase 0 recon) and are deduped by it; Ahoi's inbound WEBHOOK payload has NO
-- uuid field at all, so webhook rows leave provider_uuid NULL — the partial
-- unique index below therefore only ever constrains CDR rows.
CREATE TABLE public.ahoi_inbound_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  source                text NOT NULL,  -- ingestion channel: 'webhook' | 'cdr'
  source_number         text,
  destination_number    text,
  message                text,
  type                  text,
  cost                  numeric(12, 4),
  provider_uuid         text,           -- CDR only; NULL for webhook rows
  received_at           timestamptz NOT NULL DEFAULT now(),
  method                text NOT NULL,
  raw_body              text,
  -- Section 4 (opt-out intake) fills these when it processes a captured row —
  -- pre-created here so Section 4 needs no migration of its own.
  matched_contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz,
  CONSTRAINT ahoi_inbound_events_source_check CHECK (source IN ('webhook', 'cdr'))
);
--> statement-breakpoint

CREATE INDEX ahoi_inbound_events_org_id_idx ON public.ahoi_inbound_events (org_id);
--> statement-breakpoint
CREATE INDEX ahoi_inbound_events_received_at_idx ON public.ahoi_inbound_events (received_at);
--> statement-breakpoint
CREATE UNIQUE INDEX ahoi_inbound_events_provider_uuid_uniq
  ON public.ahoi_inbound_events (provider_id, provider_uuid)
  WHERE provider_uuid IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.ahoi_inbound_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ahoi_inbound_events_select_own_org"
  ON public.ahoi_inbound_events FOR SELECT
  USING (org_id = public.current_org_id());
```

- [ ] **Step 4: Add the Drizzle schema tables**

In `db/schema.ts`, after `texthub_inbound_events`'s type exports (after `export type NewTexthubInboundEvent = ...`), insert:

```ts
// ============ Ahoi DLR + inbound capture (Phase 1 Section 3, G5) ============
// Provider-specific capture tables mirroring texthub_inbound_events' shape
// (migration 0055) rather than generalizing it. See lib/sends/ahoi-dlr.ts /
// lib/sends/ahoi-inbound.ts / lib/sends/ahoi-cdr-poll.ts for the write paths.

export const ahoi_dlr_events = pgTable(
  "ahoi_dlr_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credential_id: integer("credential_id").references(
      () => provider_credentials.id,
      { onDelete: "set null" },
    ),
    provider_id: integer("provider_id").references(() => sms_providers.id, {
      onDelete: "set null",
    }),
    received_at: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    method: text("method").notNull(),
    query: jsonb("query"),
    headers: jsonb("headers"),
    raw_body: text("raw_body"),
    provider_uuid: text("provider_uuid"),
    source: text("source"),
    destination: text("destination"),
    send_status: text("send_status"),
    status: text("status"),
    smpp_status: text("smpp_status"),
    smpp_code: text("smpp_code"),
    error: text("error"),
    // NAMING DEBT: matches stage_sends.texthub_message_id, which also holds
    // Ahoi's send-time uuid since Section 2 — not renamed (G2).
    matched_stage_send_id: uuid("matched_stage_send_id").references(
      () => stage_sends.id,
      { onDelete: "set null" },
    ),
    result: text("result"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("ahoi_dlr_events_org_id_idx").on(table.org_id),
    index("ahoi_dlr_events_received_at_idx").on(table.received_at),
    index("ahoi_dlr_events_provider_reject_idx").on(
      table.provider_id,
      table.send_status,
      table.received_at,
    ),
  ],
);

export type AhoiDlrEvent = typeof ahoi_dlr_events.$inferSelect;
export type NewAhoiDlrEvent = typeof ahoi_dlr_events.$inferInsert;

export const ahoi_inbound_events = pgTable(
  "ahoi_inbound_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credential_id: integer("credential_id").references(
      () => provider_credentials.id,
      { onDelete: "set null" },
    ),
    provider_id: integer("provider_id").references(() => sms_providers.id, {
      onDelete: "set null",
    }),
    // Ingestion channel ('webhook' | 'cdr') — NOT the sending phone number,
    // see source_number for that.
    source: text("source").notNull(),
    source_number: text("source_number"),
    destination_number: text("destination_number"),
    message: text("message"),
    type: text("type"),
    cost: numeric("cost", { precision: 12, scale: 4 }),
    provider_uuid: text("provider_uuid"),
    received_at: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    method: text("method").notNull(),
    raw_body: text("raw_body"),
    // Section 4 fills these (opt-out intake) — pre-created, see migration 0109.
    matched_contact_id: uuid("matched_contact_id").references(
      () => contacts.id,
      { onDelete: "set null" },
    ),
    matched_stage_send_id: uuid("matched_stage_send_id").references(
      () => stage_sends.id,
      { onDelete: "set null" },
    ),
    result: text("result"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("ahoi_inbound_events_org_id_idx").on(table.org_id),
    index("ahoi_inbound_events_received_at_idx").on(table.received_at),
    uniqueIndex("ahoi_inbound_events_provider_uuid_uniq")
      .on(table.provider_id, table.provider_uuid)
      .where(sql`provider_uuid IS NOT NULL`),
    check(
      "ahoi_inbound_events_source_check",
      sql`${table.source} IN ('webhook', 'cdr')`,
    ),
  ],
);

export type AhoiInboundEvent = typeof ahoi_inbound_events.$inferSelect;
export type NewAhoiInboundEvent = typeof ahoi_inbound_events.$inferInsert;
```

In `db/schema.ts`'s `stage_sends` table's index array (immediately after `stage_sends_org_sending_idx`, the last entry before the closing `],`), add:

```ts
    // Migration 0109: DLR reconcile looks up stage_sends by this column
    // (Ahoi's send-time uuid — see the naming-debt note on ahoi_dlr_events).
    index("stage_sends_texthub_message_id_idx")
      .on(table.texthub_message_id)
      .where(sql`texthub_message_id IS NOT NULL`),
```

No new top-level imports needed — `check`, `index`, `jsonb`, `numeric`, `text`, `timestamp`, `uniqueIndex`, `uuid` are all already imported at the top of `db/schema.ts`.

- [ ] **Step 5: Add the `_journal.json` entry**

In `db/migrations/meta/_journal.json`, append after the `0108_creatives_allow_multi_segment` entry (currently the last):

```json
    ,
    {
      "idx": 109,
      "version": "7",
      "when": 1785801600000,
      "tag": "0109_ahoi_dlr_inbound_events",
      "breakpoints": true
    }
```

- [ ] **Step 6: Clone the snapshot (id/prevId only — see Global Constraints finding)**

Copy `db/migrations/meta/0108_snapshot.json` to `db/migrations/meta/0109_snapshot.json`. Edit only:
- `"id"` → `"0109a000-0109-4109-8109-000000000109"`
- `"prevId"` → `"0108a000-0108-4108-8108-000000000108"`

Do **not** attempt to add `ahoi_dlr_events`/`ahoi_inbound_events` to the `"tables"` map — the verified finding above (Global Constraints) is that this snapshot has never tracked every hand-authored table, `verify-migration-integrity.ts` never reads `"tables"` contents, and adding two hand-typed multi-column entries would be unverified busywork inconsistent with `stage_sends`/`send_attempts`/`texthub_inbound_events`/`provider_credentials` all being similarly absent.

- [ ] **Step 7: Author the concurrent-index apply script**

Create `scripts/apply-ahoi-stage-sends-index-concurrent.ts` (mirrors `scripts/apply-eligible-indexes-concurrent.ts` / `scripts/apply-trgm-concurrent.ts`):

```ts
// Builds migration 0109's stage_sends.texthub_message_id index WITHOUT a
// write lock, using CREATE INDEX CONCURRENTLY (which cannot run inside
// drizzle-kit's migration transaction). stage_sends is large + hot (820K+
// rows / ~490 MB in prod) — a plain CREATE INDEX would take ACCESS EXCLUSIVE
// and block sends during apply. Run this BEFORE `db:migrate` in prod; the
// migration's plain CREATE INDEX IF NOT EXISTS statement then no-ops, leaving
// the migration recorded in the chain. Idempotent + safe to re-run. Mirrors
// scripts/apply-eligible-indexes-concurrent.ts (migration 0096) and the 0101
// pattern the migration comment references.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const t0 = Date.now();
    process.stdout.write("Building stage_sends_texthub_message_id_idx CONCURRENTLY … ");
    await pg.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS stage_sends_texthub_message_id_idx ` +
        `ON public.stage_sends (texthub_message_id) WHERE texthub_message_id IS NOT NULL`,
    );
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // A failed CONCURRENTLY build leaves an INVALID index behind — report it.
    const invalid = await pg`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname = 'stage_sends_texthub_message_id_idx'`;
    console.log(
      invalid.length ? "⚠ INVALID index — drop + rebuild" : "Index valid ✅",
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 8: STOP — HARD USER GATE**

Do **NOT** run the concurrent-apply script or `npm run db:migrate`. Show the user:
- The migration SQL (Step 3) — two new EMPTY tables + RLS + one new partial index on the large/hot `stage_sends` table, no data migration, no backfill.
- That the `stage_sends` index is built **CONCURRENTLY out-of-band** (Step 7's script) BEFORE `db:migrate`, so the in-migration `IF NOT EXISTS` statement no-ops and the apply never takes a hot-table lock — the same pattern as migrations 0101/0096/0088.
- Confirmation that `scripts/test-ahoi-events-tables-columns.ts` is currently RED (Step 2's output).

Wait for explicit user go-ahead before proceeding to Step 9.

- [ ] **Step 9 (controller-run, after explicit go-ahead): Build the index CONCURRENTLY, THEN apply + verify**

Order matters — the concurrent build MUST complete before `db:migrate`, so the migration's `CREATE INDEX IF NOT EXISTS` finds the index already present and no-ops:

```bash
npx tsx scripts/apply-ahoi-stage-sends-index-concurrent.ts
npm run db:migrate
npx tsx scripts/verify-migration-integrity.ts
npx tsx scripts/test-ahoi-events-tables-columns.ts
```

Expected: concurrent build reports "Index valid ✅"; `db:migrate` applies only `0109` (the index statement no-ops); integrity chain all-green; the column test now PASSes (GREEN, including the `stage_sends_texthub_message_id_idx exists` check).

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Update `docs/03-data-model.md`**

Add two rows to the table list (near `texthub_inbound_events`):

```
| `ahoi_dlr_events` | `provider_id`, `provider_uuid`, `send_status`, `status`, `smpp_status`, `smpp_code`, `matched_stage_send_id`, `result` | append-only DLR capture + reconcile (migration 0109). NAMING DEBT: reconciles against `stage_sends.texthub_message_id`, which also holds Ahoi's send-time uuid (see `docs/07-conventions.md`) |
| `ahoi_inbound_events` | `provider_id`, `source` (channel: webhook/cdr), `source_number`, `destination_number`, `provider_uuid`, `matched_contact_id`, `matched_stage_send_id`, `result` | append-only inbound (STOP-carrying) capture from TWO channels (migration 0109); `matched_*`/`result`/`processed_at` are pre-created for Section 4 (opt-out intake), unused by Section 3 |
```

In the ERD (`erDiagram` block), add two edges near `provider_credentials ||--o{ texthub_inbound_events : "STOP intake"`:

```
  provider_credentials ||--o{ ahoi_dlr_events : "DLR capture"
  provider_credentials ||--o{ ahoi_inbound_events : "inbound capture"
```

- [ ] **Step 12: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — ahoi_dlr_events + ahoi_inbound_events (migration 0109) — docs/03-data-model.md
```

- [ ] **Step 13: Commit**

```bash
git add db/migrations/0109_ahoi_dlr_inbound_events.sql db/migrations/meta/ db/schema.ts scripts/apply-ahoi-stage-sends-index-concurrent.ts scripts/test-ahoi-events-tables-columns.ts docs/03-data-model.md docs/CHANGELOG.md
git commit -m "feat(ahoi): ahoi_dlr_events + ahoi_inbound_events tables (migration 0109)"
```

---

## Task 3: Mint the shared Ahoi webhook token (prod write, gated)

**Files:**
- Create: `scripts/seed-ahoi-webhook-token.ts`, `scripts/test-ahoi-webhook-token.ts`
- Modify: `docs/06-integrations.md`

**Interfaces:**
- Produces: `provider_credentials.inbound_webhook_token` set on the Ahoi provider-default credential row (the same column TextHub uses — Section 1's schema already has it; no migration needed here).

**Design note:** Unlike TextHub, Ahoi has no API to register a webhook URL (confirmed absent in Phase 0 recon — the only path found was `/cdrs/download/csv`; no `register-callback`-equivalent endpoint). Registration is a **manual portal step** the operator does outside CamMan. This task only mints the secret and prints the two URLs; pasting them into the Ahoi/api19 portal is a documented runbook step, not code. Both new Ahoi webhook paths (`dlr`, `inbound`) share this **one** token — the URL path (not the token) distinguishes which handler runs, avoiding a second schema column for a second token.

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-webhook-token.ts`

```ts
// Verifies the Ahoi provider-default credential has inbound_webhook_token
// set. Read-only. Run AFTER scripts/seed-ahoi-webhook-token.ts.
// Run: npx tsx scripts/test-ahoi-webhook-token.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const rows = await sql`
    SELECT pc.inbound_webhook_token AS token
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id
    WHERE p.sms_provider_id = 'ahoi' AND pc.brand_id IS NULL
  `;
  check("ahoi provider-default credential exists", rows.length === 1, JSON.stringify(rows));
  check(
    "inbound_webhook_token is set (>=32 hex chars)",
    typeof rows[0]?.token === "string" && rows[0].token.length >= 32,
    JSON.stringify(rows[0]),
  );
  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx scripts/test-ahoi-webhook-token.ts`
Expected: FAIL — `inbound_webhook_token is set` ✗ (currently NULL, per Section 1/2's carried note).

- [ ] **Step 3: Author `scripts/seed-ahoi-webhook-token.ts`**

```ts
// One-time script: mints provider_credentials.inbound_webhook_token for the
// Ahoi provider-default credential (idempotent — no-ops if already set), then
// prints the two webhook URLs the operator must manually paste into the
// Ahoi/api19 portal's DLR + inbound URL settings. No registration API exists
// for this platform (unlike TextHub's registerOptOutCallback / Phase 0
// recon confirmed only /cdrs/download/csv as a documented endpoint beyond
// send/lookup) — pasting these URLs into the portal is a manual runbook step.
//
// The SAME token authenticates BOTH Ahoi webhook paths — the URL PATH
// (/dlr/ vs /inbound/), not the token, distinguishes which handler runs.
//
// Run: npx tsx scripts/seed-ahoi-webhook-token.ts [https://your-prod-origin]
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

async function main() {
  const origin =
    process.argv[2] ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://<your-prod-origin>";

  const prov = await sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahoi'`;
  if (!prov[0]) {
    console.error("No ahoi provider row — run Section 1's seed (scripts/seed-ahoi-number-credential.ts) first.");
    await sql.end();
    process.exit(1);
  }

  const cred = await sql`
    SELECT id, inbound_webhook_token FROM provider_credentials
    WHERE provider_id = ${prov[0].id} AND brand_id IS NULL
  `;
  if (!cred[0]) {
    console.error("No provider-default ahoi credential — run Section 1's seed first.");
    await sql.end();
    process.exit(1);
  }

  let token = cred[0].inbound_webhook_token as string | null;
  if (!token) {
    token = randomBytes(32).toString("hex");
    await sql`
      UPDATE provider_credentials
      SET inbound_webhook_token = ${token}, updated_at = now()
      WHERE id = ${cred[0].id}
    `;
    console.log("Minted a new inbound_webhook_token.");
  } else {
    console.log("Token already set — reusing (idempotent, no-op).");
  }

  console.log(`\nPaste these into the Ahoi/api19 portal's webhook settings:`);
  console.log(`  DLR URL:      ${origin}/api/webhooks/ahoi/dlr/${token}`);
  console.log(`  Inbound URL:  ${origin}/api/webhooks/ahoi/inbound/${token}`);

  await sql.end();
}
main();
```

- [ ] **Step 4: STOP — HARD USER GATE**

Do **NOT** run `npx tsx scripts/seed-ahoi-webhook-token.ts` against prod. Show the user:
- The script (Step 3) — a single conditional `UPDATE` of one column on one already-seeded row, idempotent.
- Confirmation that `scripts/test-ahoi-webhook-token.ts` is currently RED.

Wait for explicit user go-ahead.

- [ ] **Step 5 (controller-run, after explicit go-ahead): Run + verify**

```bash
npx tsx scripts/seed-ahoi-webhook-token.ts https://<the real prod origin>
npx tsx scripts/test-ahoi-webhook-token.ts
```

Expected: token minted (or reused); test GREEN. **Save the two printed URLs** — Task 4/6's manual portal-registration step needs them, and they are not re-printable without re-running this script (the token itself IS re-readable via a plain `SELECT`, so nothing is lost if the printed output isn't saved — just re-run the script, it's idempotent).

- [ ] **Step 6: Update `docs/06-integrations.md`**

Amend the existing Ahoi gotchas paragraph (added in Section 2) to append:

```
Webhook registration is **manual, not API-driven** — Phase 0 recon found no Ahoi equivalent of TextHub's `registerOptOutCallback`. `scripts/seed-ahoi-webhook-token.ts` mints `provider_credentials.inbound_webhook_token` (idempotent) and prints both webhook URLs (`/api/webhooks/ahoi/dlr/<token>`, `/api/webhooks/ahoi/inbound/<token>`) — the SAME token authenticates both paths (the URL path, not the token, distinguishes DLR vs inbound) — for the operator to paste into the Ahoi/api19 portal by hand.
```

Update the "Last updated" date at the top to `2026-07-15`.

- [ ] **Step 7: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Ahoi webhook token seed script (Section 3 Task 3) — docs/06-integrations.md
```

- [ ] **Step 8: Commit**

```bash
git add scripts/seed-ahoi-webhook-token.ts scripts/test-ahoi-webhook-token.ts docs/06-integrations.md docs/CHANGELOG.md
git commit -m "feat(ahoi): seed script to mint the shared DLR/inbound webhook token"
```

---

## Task 4: DLR webhook endpoint + raw/parsed capture

**Files:**
- Create: `lib/sends/ahoi-webhook-shared.ts`, `lib/sends/ahoi-dlr.ts`
- Create: `app/api/webhooks/ahoi/dlr/[token]/route.ts`
- Modify: `docs/05-flows.md`, `docs/06-integrations.md`
- Test: `scripts/test-ahoi-dlr-webhook.ts`

**Interfaces:**
- Consumes: `ahoiAdapter.parseDlr`, `extractAhoiWebhookFields` (Task 1); `ahoi_dlr_events` (Task 2); `inbound_webhook_token` (Task 3).
- Produces: `captureAhoiDlrEvent(dbc, opts): Promise<{ id: string }>` (reconcile added in Task 5, called from the same route).

- [ ] **Step 1: Create `lib/sends/ahoi-webhook-shared.ts`**

```ts
// Small helpers shared by both Ahoi webhook routes (DLR + inbound) — kept
// tiny and dependency-free (no CIDR library) since the range is a single /24.
import type { NextRequest } from "next/server";

export function headersToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function queryToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// G1: this is DEFENSE-IN-DEPTH ONLY, never the auth gate (the path token is).
// Ahoi's documented callback source range is 207.181.190.0/24 (Phase 0
// recon: DLR from .156, inbound from .161, both in that /24). An
// out-of-range request is still PROCESSED — only logged — so an infra change
// on Ahoi's end (or a Vercel header quirk) can never silently brick the real
// webhook.
export function extractClientIp(forwardedFor: string | null): string | null {
  if (!forwardedFor) return null;
  return forwardedFor.split(",")[0]?.trim() || null;
}

export function isKnownAhoiIp(ip: string | null): boolean {
  if (!ip) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim());
  if (!m) return false;
  return m[1] === "207" && m[2] === "181" && m[3] === "190";
}
```

- [ ] **Step 2: Create `lib/sends/ahoi-dlr.ts` (capture only for now — `reconcileAhoiDlrEvent` added in Task 5)**

```ts
import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import type { DlrEvent } from "@/lib/sends/providers/types";

// Any drizzle executor — the top-level client or a transaction handle. Same
// shape as kickoff.ts's DbOrTx (not imported from there to avoid an odd
// cross-module dependency for a one-line type alias).
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CaptureAhoiDlrOpts {
  orgId: string;
  credentialId: number;
  providerId: number;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string | null;
  // Raw source/destination for archival — DlrEvent doesn't carry these (that
  // type only holds what reconcile needs), so the route extracts them
  // separately via extractAhoiWebhookFields and passes them here.
  fields: Record<string, string>;
  parsed: DlrEvent | null;
}

// Append-only raw+parsed capture. Never throws on a malformed/unparseable
// payload — parsed may be null (e.g. no uuid), in which case only the raw
// archival columns + fields.source/destination land; result/processed_at/
// matched_stage_send_id stay NULL until reconcileAhoiDlrEvent runs (Task 5).
export async function captureAhoiDlrEvent(
  dbc: DbOrTx,
  o: CaptureAhoiDlrOpts,
): Promise<{ id: string }> {
  const rows = (await dbc.execute(sql`
    INSERT INTO ahoi_dlr_events
      (org_id, credential_id, provider_id, method, query, headers, raw_body,
       provider_uuid, source, destination, send_status, status, smpp_status, smpp_code, error)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, ${o.method},
            ${JSON.stringify(o.query)}::jsonb, ${JSON.stringify(o.headers)}::jsonb, ${o.rawBody},
            ${o.parsed?.providerUuid ?? null}, ${o.fields.source ?? null}, ${o.fields.destination ?? null},
            ${o.parsed?.sendStatus ?? null}, ${o.parsed?.status ?? null},
            ${o.parsed?.smppStatus ?? null}, ${o.parsed?.smppCode ?? null}, ${o.parsed?.error ?? null})
    RETURNING id
  `)) as unknown as { id: string }[];
  return { id: rows[0].id };
}
```

- [ ] **Step 3: Write the failing test** — `scripts/test-ahoi-dlr-webhook.ts`

```ts
// DLR webhook route: path-token auth, raw+parsed capture. Invokes the
// exported POST handler directly with a synthetic NextRequest (no real Ahoi
// network, no dev server). Writes a real row into the new, empty, append-only
// ahoi_dlr_events table using the REAL seeded Ahoi credential's real token
// (scripts/seed-ahoi-webhook-token.ts must have run) — every row this test
// creates carries a "zzz-test-" prefixed provider_uuid marker and is deleted
// in a finally block. Never touches contacts/opt_outs/campaigns.
// Run: npx tsx scripts/test-ahoi-dlr-webhook.ts
import "./_env-preload";
import postgres from "postgres";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/webhooks/ahoi/dlr/[token]/route";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function postReq(url: string, body: string, ip = "207.181.190.156"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body,
  });
}

async function main() {
  const marker = `zzz-test-dlr-${Date.now()}`;
  try {
    const cred = await sql`
      SELECT pc.inbound_webhook_token AS token
      FROM provider_credentials pc JOIN sms_providers p ON p.id = pc.provider_id
      WHERE p.sms_provider_id = 'ahoi' AND pc.brand_id IS NULL
    `;
    const token = cred[0]?.token as string | undefined;
    if (!token) {
      console.log("SKIP: run scripts/seed-ahoi-webhook-token.ts first (no token set).");
      await sql.end();
      process.exit(0);
    }

    // Unknown token -> 401, nothing written.
    const badRes = await POST(postReq(`https://x/api/webhooks/ahoi/dlr/bogus-token`, `uuid=${marker}-bad`), {
      params: Promise.resolve({ token: "bogus-token" }),
    });
    check("unknown token -> 401", badRes.status === 401);

    // Real token, well-formed DLR body -> 200 + row captured with parsed fields.
    const body = `uuid=${marker}&source=3158359592&destination=5642155963&send_status=carrier_sent&status=sent&smpp_status=sent&error=000`;
    const res = await POST(postReq(`https://x/api/webhooks/ahoi/dlr/${token}`, body), {
      params: Promise.resolve({ token }),
    });
    check("valid token -> 200", res.status === 200);

    const row = await sql`SELECT * FROM ahoi_dlr_events WHERE provider_uuid = ${marker}`;
    check("row captured", row.length === 1, JSON.stringify(row));
    check("send_status parsed", row[0]?.send_status === "carrier_sent");
    check("smpp_status parsed", row[0]?.smpp_status === "sent");
    check("raw_body stored verbatim", row[0]?.raw_body === body);
    check("source archived (fields, not DlrEvent)", row[0]?.source === "3158359592");
    check("destination archived", row[0]?.destination === "5642155963");
  } finally {
    await sql`DELETE FROM ahoi_dlr_events WHERE provider_uuid LIKE ${marker + "%"}`;
    await sql.end();
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-dlr-webhook.ts`
Expected: FAIL — the route file doesn't exist yet (import error).

- [ ] **Step 5: Implement `app/api/webhooks/ahoi/dlr/[token]/route.ts`**

```ts
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials } from "@/db/schema";
import { captureAhoiDlrEvent } from "@/lib/sends/ahoi-dlr";
import {
  extractClientIp,
  headersToObject,
  isKnownAhoiIp,
  queryToObject,
} from "@/lib/sends/ahoi-webhook-shared";
import { ahoiAdapter, extractAhoiWebhookFields } from "@/lib/sends/providers/ahoi";

// Public inbound Ahoi DLR (delivery receipt) callback receiver.
//
// G1: auth is the path token ONLY, resolved to (org, provider, credential)
// via provider_credentials.inbound_webhook_token — the SAME column/token
// Ahoi's inbound (STOP) webhook uses (see ../inbound/[token]/route.ts); the
// URL PATH distinguishes which handler runs. The 207.181.190.0/24 IP check
// below is defense-in-depth ONLY (logged, never blocking).
//
// Capture + parse + reconcile all happen in this one request (unlike
// TextHub's historical Stage A/B split) — reconcile is a cheap single-row
// lookup, so there's no reason to defer it. Reconcile itself lands in Task 5.
//
// force-dynamic: every callback must run and be recorded, never cached.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  const cred = await db
    .select({
      id: provider_credentials.id,
      org_id: provider_credentials.org_id,
      provider_id: provider_credentials.provider_id,
    })
    .from(provider_credentials)
    .where(eq(provider_credentials.inbound_webhook_token, token))
    .limit(1);

  if (!cred[0]) return new NextResponse("Unauthorized", { status: 401 });
  if (cred[0].provider_id == null) return new NextResponse("Unauthorized", { status: 401 });

  const ip = extractClientIp(req.headers.get("x-forwarded-for"));
  if (!isKnownAhoiIp(ip)) {
    console.warn(
      `[ahoi-dlr-webhook] request from unexpected IP ${ip ?? "unknown"} (expected 207.181.190.0/24) — processing anyway (G1: token is the auth gate)`,
    );
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const query = queryToObject(req);
  const headers = headersToObject(req);
  const raw = { query, body: rawBody, headers };
  const fields = extractAhoiWebhookFields(raw);
  const parsed = ahoiAdapter.parseDlr(raw);

  await captureAhoiDlrEvent(db, {
    orgId: cred[0].org_id,
    credentialId: cred[0].id,
    providerId: cred[0].provider_id,
    method: req.method,
    query,
    headers,
    rawBody: rawBody || null,
    fields,
    parsed,
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-dlr-webhook.ts`
Expected: PASS — `ALL PASS`, exit 0 (or the SKIP path if Task 3 hasn't been gate-approved yet — re-run after it has).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Update `docs/06-integrations.md`**

Add a table row alongside the TextHub/Ahoi send rows:

```
| **Ahoi DLR webhook** | provider → app | delivery-receipt capture (Section 3) | path token (`provider_credentials.inbound_webhook_token`) | `POST /api/webhooks/ahoi/dlr/<token>` form body `uuid/source/destination/send_status/status/smpp_status/smpp_code/error`; 207.181.190.0/24 is logged-only, not the auth gate |
```

- [ ] **Step 9: Add a sequence diagram to `docs/05-flows.md`**

Add a new subsection after "E. Opt-out (STOP) intake":

```markdown
## E2. Ahoi DLR (delivery receipt) capture

\`\`\`mermaid
sequenceDiagram
  participant Ahoi
  participant App
  participant DB
  Ahoi->>App: POST /api/webhooks/ahoi/dlr/<token> (form-encoded)
  App->>DB: resolve token -> (org, provider, credential)
  Note over App: 207.181.190.0/24 IP check is LOGGED ONLY (G1: token is the gate)
  App->>App: parseDlr (uuid/source/destination/send_status/status/smpp_status/smpp_code/error)
  App->>DB: INSERT ahoi_dlr_events (raw + parsed)
  App->>DB: reconcile uuid -> stage_sends.texthub_message_id (Task 5)
  Note over App,DB: capture + reconcile only — no opt_outs write (Section 4's job)
\`\`\`
```

- [ ] **Step 10: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Ahoi DLR webhook + capture (Section 3 Task 4) — docs/05-flows.md, docs/06-integrations.md
```

- [ ] **Step 11: Commit**

```bash
git add lib/sends/ahoi-webhook-shared.ts lib/sends/ahoi-dlr.ts app/api/webhooks/ahoi/dlr scripts/test-ahoi-dlr-webhook.ts docs/05-flows.md docs/06-integrations.md docs/CHANGELOG.md
git commit -m "feat(ahoi): DLR webhook endpoint + raw/parsed capture"
```

---

## Task 5: DLR reconcile + reject-rate circuit breaker

**Files:**
- Modify: `lib/sends/ahoi-dlr.ts`, `lib/sends/circuit-breakers.ts`
- Modify: `app/api/webhooks/ahoi/dlr/[token]/route.ts`
- Modify: `.env.example`, `docs/04-features/sms-send-pipeline.md`, `docs/06-integrations.md`, `docs/07-conventions.md`
- Test: `scripts/test-ahoi-dlr-reconcile.ts`

**Interfaces:**
- Consumes: `ahoi_dlr_events`, `stage_sends.texthub_message_id` (Task 2/existing); `latchPause` (existing, `lib/sends/circuit-breakers.ts`).
- Produces: `reconcileAhoiDlrEvent(dbc, opts)`; `countAhoiDlrRejectsSince`, `ahoiDlrRejectSpikeThreshold()`, `ahoiDlrRejectWindowSeconds()` (env-backed, defaults 10 / 900).

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-dlr-reconcile.ts`

```ts
// DLR reconcile: match provider_uuid -> stage_sends (matched vs unmatched
// multi-segment-extra), and the reject-rate -> circuit-breaker signal.
// Rolled-back transaction — no data survives the run.
// Run: npx tsx scripts/test-ahoi-dlr-reconcile.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  captureAhoiDlrEvent,
  reconcileAhoiDlrEvent,
} from "@/lib/sends/ahoi-dlr";
import {
  ahoiDlrRejectSpikeThreshold,
  ahoiDlrRejectWindowSeconds,
  countAhoiDlrRejectsSince,
  latchPause,
} from "@/lib/sends/circuit-breakers";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"dlrrec-" + sfx}, ${orgId}, ${"dlrrec"}, true) RETURNING id`);
      const providerId = prov.id;

      const contact = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx}) RETURNING id`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"dlrrec-camp-" + sfx}, ${"dlrrec"}, 'active', 'manual') RETURNING id`);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
        VALUES (${orgId}, ${camp.id}, 1, 'STOP') RETURNING id`);
      const stageSend = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id)
        VALUES (${orgId}, ${camp.id}, ${stage.id}, ${contact.id}, ${"+1555" + sfx}, 'hi', ${"s-match-" + sfx})
        RETURNING id`);

      // Case 1: DLR uuid matches a real stage_sends.texthub_message_id.
      const ev1 = await captureAhoiDlrEvent(tx, {
        orgId, credentialId: 0, providerId, method: "POST",
        query: {}, headers: {}, rawBody: null,
        fields: { source: "3158359592", destination: "5642155963" },
        parsed: { providerUuid: "s-match-" + sfx, sendStatus: "delivered", status: "delivered", smppStatus: "DELIVRD", smppCode: null, error: "000" },
      });
      const r1 = await reconcileAhoiDlrEvent(tx, {
        eventId: ev1.id, orgId, providerId, providerUuid: "s-match-" + sfx, sendStatus: "delivered",
      });
      check("matched DLR -> result=matched", r1.result === "matched");
      check("matched DLR -> matchedStageSendId set", r1.matchedStageSendId === stageSend.id);

      // Case 2: numeric-uuid multi-segment extra -> no match, NOT an error.
      const ev2 = await captureAhoiDlrEvent(tx, {
        orgId, credentialId: 0, providerId, method: "POST",
        query: {}, headers: {}, rawBody: null,
        fields: {},
        parsed: { providerUuid: "4131784060328527222", sendStatus: "delivered", status: "delivered", smppStatus: "DELIVRD", smppCode: null, error: "000" },
      });
      const r2 = await reconcileAhoiDlrEvent(tx, {
        eventId: ev2.id, orgId, providerId, providerUuid: "4131784060328527222", sendStatus: "delivered",
      });
      check("numeric-uuid extra -> result=unmatched (not an error)", r2.result === "unmatched");
      check("unmatched -> matchedStageSendId null", r2.matchedStageSendId === null);

      // ---- Case 3: DLR reject-rate breaker (below/at threshold) ----
      const THRESHOLD = ahoiDlrRejectSpikeThreshold();
      const WINDOW = ahoiDlrRejectWindowSeconds();

      async function pushReject(tag: string) {
        const ev = await captureAhoiDlrEvent(tx, {
          orgId, credentialId: 0, providerId, method: "POST",
          query: {}, headers: {}, rawBody: null, fields: {},
          parsed: { providerUuid: `rej-${sfx}-${tag}`, sendStatus: "rejected", status: "rejected", smppStatus: null, smppCode: null, error: "600" },
        });
        return reconcileAhoiDlrEvent(tx, {
          eventId: ev.id, orgId, providerId, providerUuid: `rej-${sfx}-${tag}`, sendStatus: "rejected",
        });
      }

      // NO-DOUBLE-COUNT (disjointness): the DLR reject counter reads ONLY
      // ahoi_dlr_events rows with send_status='rejected'. 'delivered' DLRs — and,
      // critically, the send-time failure-spike breaker's rows (send_attempts /
      // stage_sends) — never inflate it. Insert 3 'delivered' DLRs -> reject
      // count stays 0. This is the structural proof the two breakers can't
      // double-count the same failure: they read entirely disjoint tables.
      for (let i = 0; i < 3; i++) {
        const ev = await captureAhoiDlrEvent(tx, {
          orgId, credentialId: 0, providerId, method: "POST",
          query: {}, headers: {}, rawBody: null, fields: {},
          parsed: { providerUuid: `del-${sfx}-${i}`, sendStatus: "delivered", status: "delivered", smppStatus: "DELIVRD", smppCode: null, error: "000" },
        });
        await reconcileAhoiDlrEvent(tx, { eventId: ev.id, orgId, providerId, providerUuid: `del-${sfx}-${i}`, sendStatus: "delivered" });
      }
      check(
        "delivered DLRs do NOT count toward the reject signal (disjoint from the send-time breaker)",
        (await countAhoiDlrRejectsSince(tx, providerId, WINDOW)) === 0,
      );

      // Below threshold -> no premature trip.
      let last: Awaited<ReturnType<typeof reconcileAhoiDlrEvent>> | undefined;
      for (let i = 0; i < THRESHOLD - 1; i++) last = await pushReject(`a${i}`);
      check(`${THRESHOLD - 1} rejects (below threshold) -> NOT paused`, last?.pausedNow === false);
      const notYet = await one<{ send_paused: boolean }>(sql`SELECT send_paused FROM sms_providers WHERE id = ${providerId}`);
      check("still not paused below threshold", notYet.send_paused === false);

      // The threshold-th reject -> latches the pause.
      const trip = await pushReject(`a${THRESHOLD - 1}`);
      check(`the ${THRESHOLD}th reject in-window -> latches the pause`, trip.pausedNow === true, JSON.stringify(trip));
      const paused = await one<{ send_paused: boolean; send_paused_reason: string }>(
        sql`SELECT send_paused, send_paused_reason FROM sms_providers WHERE id = ${providerId}`);
      check("sms_providers.send_paused = true", paused.send_paused === true);
      check("reason mentions dlr_reject_spike", (paused.send_paused_reason ?? "").includes("dlr_reject_spike"), paused.send_paused_reason);

      // SINGLE-COUNT: a further reject after the pause is already latched
      // returns pausedNow=false and does NOT append a second 'paused' event —
      // proving the pause is counted once even though both the send-time
      // breaker and this DLR breaker call the same latchPause.
      const again = await pushReject("after");
      check("further reject after pause -> pausedNow=false (idempotent latch)", again.pausedNow === false);
      const evCount1 = await one<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM send_circuit_events WHERE provider_id = ${providerId} AND event = 'paused'`);
      check("exactly ONE 'paused' event for this provider (single count)", evCount1.n === 1, JSON.stringify(evCount1));

      // ---- Case 4: ADDITIVE COMPOSITION across the two breakers ----
      // A SECOND provider is pre-paused by the send-time breaker (simulated via
      // latchPause with a failure_spike reason). The DLR breaker must COMPOSE,
      // not fight it: rejects on this provider find it already paused, return
      // pausedNow=false, and never overwrite the reason or add a 2nd pause
      // event. The two signals share one latch additively — neither cancels the
      // other, neither double-latches.
      const prov2 = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"dlrrec2-" + sfx}, ${orgId}, ${"dlrrec2"}, true) RETURNING id`);
      const preLatched = await latchPause(tx, { providerId: prov2.id, orgId, reason: "failure_spike: 10 consecutive send failures" });
      check("send-time breaker latches provider 2", preLatched === true);
      let r2: Awaited<ReturnType<typeof reconcileAhoiDlrEvent>> | undefined;
      for (let i = 0; i < THRESHOLD; i++) {
        const ev = await captureAhoiDlrEvent(tx, {
          orgId, credentialId: 0, providerId: prov2.id, method: "POST",
          query: {}, headers: {}, rawBody: null, fields: {},
          parsed: { providerUuid: `rej2-${sfx}-${i}`, sendStatus: "rejected", status: "rejected", smppStatus: null, smppCode: null, error: "600" },
        });
        r2 = await reconcileAhoiDlrEvent(tx, { eventId: ev.id, orgId, providerId: prov2.id, providerUuid: `rej2-${sfx}-${i}`, sendStatus: "rejected" });
      }
      check("DLR breaker composes with an already-latched pause (pausedNow=false)", r2!.pausedNow === false);
      const p2 = await one<{ send_paused_reason: string }>(sql`SELECT send_paused_reason FROM sms_providers WHERE id = ${prov2.id}`);
      check("send-time breaker's reason is NOT overwritten by the DLR breaker", (p2.send_paused_reason ?? "").includes("failure_spike"), p2.send_paused_reason);
      const evCount2 = await one<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM send_circuit_events WHERE provider_id = ${prov2.id} AND event = 'paused'`);
      check("still exactly ONE 'paused' event for provider 2 (no double-latch across breakers)", evCount2.n === 1, JSON.stringify(evCount2));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-dlr-reconcile.ts`
Expected: FAIL — `reconcileAhoiDlrEvent` doesn't exist; `ahoiDlrRejectSpikeThreshold` doesn't exist.

- [ ] **Step 3: Add the breaker signal to `lib/sends/circuit-breakers.ts`**

After the existing `latchPause` function, append:

```ts
// Ahoi DLR-driven reject-rate signal (Section 3, spec §5 derived signal (a)).
// Distinct from FAILURE_SPIKE_THRESHOLD above (consecutive SEND-time failures
// within one drain invocation): a DLR can report `rejected` for a send that
// looked fine at send time (Ahoi's always-200 body said {status:"ok"}), so
// this is a genuinely different, asynchronous, carrier-level signal that only
// arrives minutes later. Provider-scoped (not the org-wide proxy the
// send-time breaker uses) since ahoi_dlr_events already carries a real
// provider_id per row — no "until provider #2" caveat applies here.
//
// DEFENSIVE (G4/O1): `rejected` is doc-inferred, never observed live in Phase
// 0 recon (only carrier_sent/delivered with error=000 were seen). This
// threshold exists so that WHEN it does start appearing, a spike trips a
// pause instead of silently burning through a broken number/route.
//
// CONFIG, not hardcoded: threshold + window are env-tunable so ops can adjust
// sensitivity without a code change (the whole signal is provisional until a
// real reject rate is observed). Defaults are identical to the original
// constants (10 rejects / 900s). Read through helpers, not module-load
// constants, so a redeploy isn't needed to pick up a changed env value.
export function ahoiDlrRejectSpikeThreshold(): number {
  const v = Number(process.env.AHOI_DLR_REJECT_SPIKE_THRESHOLD);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 10;
}
export function ahoiDlrRejectWindowSeconds(): number {
  const v = Number(process.env.AHOI_DLR_REJECT_SPIKE_WINDOW_SEC);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 900;
}

export async function countAhoiDlrRejectsSince(
  dbc: DbOrTx,
  providerId: number,
  seconds: number,
): Promise<number> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM ahoi_dlr_events
    WHERE provider_id = ${providerId}
      AND send_status = 'rejected'
      AND received_at > now() - make_interval(secs => ${seconds})
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}
```

- [ ] **Step 4: Add `reconcileAhoiDlrEvent` to `lib/sends/ahoi-dlr.ts`**

Append:

```ts
import {
  ahoiDlrRejectSpikeThreshold,
  ahoiDlrRejectWindowSeconds,
  countAhoiDlrRejectsSince,
  latchPause,
} from "@/lib/sends/circuit-breakers";

export interface ReconcileAhoiDlrOpts {
  eventId: string;
  orgId: string;
  providerId: number;
  providerUuid: string;
  sendStatus: string;
}

export interface ReconcileAhoiDlrResult {
  result: "matched" | "unmatched";
  matchedStageSendId: string | null;
  pausedNow: boolean;
}

// Match a DLR's uuid to the send it belongs to, then feed the derived
// reject-rate breaker signal. NAMING DEBT (G2, carried from Section 2): the
// match is against stage_sends.texthub_message_id, which is named after
// TextHub but ALSO holds Ahoi's send-time uuid (Section 2's drain stores
// whatever messageId the adapter returns into that same column) — not
// renamed here; a cross-provider rename is a bigger migration than this
// section's scope. Multi-segment sends emit EXTRA DLRs under numeric-only
// uuids that never match a send-time `s-…` uuid (Phase 0 recon) — that is
// EXPECTED and lands as result='unmatched', not an error.
export async function reconcileAhoiDlrEvent(
  dbc: DbOrTx,
  o: ReconcileAhoiDlrOpts,
): Promise<ReconcileAhoiDlrResult> {
  const match = (await dbc.execute(sql`
    SELECT id FROM stage_sends WHERE texthub_message_id = ${o.providerUuid} AND org_id = ${o.orgId} LIMIT 1
  `)) as unknown as { id: string }[];
  const matchedStageSendId = match[0]?.id ?? null;
  const result: "matched" | "unmatched" = matchedStageSendId ? "matched" : "unmatched";

  await dbc.execute(sql`
    UPDATE ahoi_dlr_events
    SET matched_stage_send_id = ${matchedStageSendId}, result = ${result}, processed_at = now()
    WHERE id = ${o.eventId}
  `);

  let pausedNow = false;
  if (o.sendStatus === "rejected") {
    // Derived signal (a), spec §5: reject-rate -> circuit breaker. Counts ONLY
    // ahoi_dlr_events rows (not send_attempts / stage_sends) — structurally
    // disjoint from the drain's send-time failure-spike breaker, so the same
    // failure can never be counted by both (see the composition test).
    const windowSec = ahoiDlrRejectWindowSeconds();
    const n = await countAhoiDlrRejectsSince(dbc, o.providerId, windowSec);
    if (n >= ahoiDlrRejectSpikeThreshold()) {
      pausedNow = await latchPause(dbc, {
        providerId: o.providerId,
        orgId: o.orgId,
        reason: `dlr_reject_spike: ${n} rejected DLRs in ${windowSec}s`,
      });
    }
  } else if (o.sendStatus && o.sendStatus !== "carrier_sent" && o.sendStatus !== "delivered") {
    // G4: any send_status outside the three known values gets a DISTINCT log
    // line so a real opt-out-error signature (O1, unconfirmed) is spottable
    // in production the first time it appears — never auto-classified here.
    console.warn(
      `[ahoi-dlr] unmapped send_status="${o.sendStatus}" (uuid=${o.providerUuid}) — logged for triage, not auto-classified as opt-out (that's Section 4's job)`,
    );
  }

  return { result, matchedStageSendId, pausedNow };
}
```

- [ ] **Step 5: Wire the reconcile call into the DLR route**

In `app/api/webhooks/ahoi/dlr/[token]/route.ts`, replace the `import { captureAhoiDlrEvent } from "@/lib/sends/ahoi-dlr";` line with:

```ts
import { captureAhoiDlrEvent, reconcileAhoiDlrEvent } from "@/lib/sends/ahoi-dlr";
```

And after the `captureAhoiDlrEvent` call, before `return NextResponse.json({ ok: true });`, add:

```ts
  const captured = await captureAhoiDlrEvent(db, {
    orgId: cred[0].org_id,
    credentialId: cred[0].id,
    providerId: cred[0].provider_id,
    method: req.method,
    query,
    headers,
    rawBody: rawBody || null,
    fields,
    parsed,
  });

  if (parsed) {
    await reconcileAhoiDlrEvent(db, {
      eventId: captured.id,
      orgId: cred[0].org_id,
      providerId: cred[0].provider_id,
      providerUuid: parsed.providerUuid,
      sendStatus: parsed.sendStatus,
    });
  }
```

(This replaces the plain `await captureAhoiDlrEvent(db, {...})` statement from Task 4 — same call, with the reconcile call added directly after it, `captured` now used.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-dlr-reconcile.ts`
Expected: PASS — `ALL PASS (rolled back).`, exit 0.

- [ ] **Step 7: Run the full regression set + typecheck**

Run: `npx tsx scripts/test-ahoi-dlr-webhook.ts && npx tsc --noEmit`
Expected: all PASS (the route now also reconciles — confirms nothing broke).

- [ ] **Step 8: Update `docs/04-features/sms-send-pipeline.md`**

In the `### Circuit breakers (circuit-breakers.ts, migration 0058; ...)` section, add a paragraph:

```
**Ahoi DLR reject-rate (Section 3, migration 0109).** A second, independent signal: `send_status='rejected'` DLRs (asynchronous, minutes after a send that looked fine at send time) feed a provider-scoped rolling count (`countAhoiDlrRejectsSince`) — a threshold count (`AHOI_DLR_REJECT_SPIKE_THRESHOLD`, default 10) of rejects within a rolling window (`AHOI_DLR_REJECT_SPIKE_WINDOW_SEC`, default 900) latches the same `sms_providers.send_paused` kill-switch the send-time failure-spike breaker uses. The two signals compose additively (both latch the one pause; neither double-counts — they read disjoint tables). Doc-inferred/defensive (never observed live in Phase 0 recon) — see `docs/07-conventions.md`'s G4 note.
```

- [ ] **Step 9: Document the two new env vars (`.env.example` + `docs/06-integrations.md`)**

In `.env.example`, in the Ahoi section (near `AHOI_API_BASE_URL`), add:

```
# DLR reject-rate circuit-breaker tuning (Section 3). Defaults 10 / 900 —
# leave unset to use them. The DLR `rejected` signal is provisional (never
# observed live in recon); these let ops tune sensitivity without a redeploy.
# AHOI_DLR_REJECT_SPIKE_THRESHOLD=10
# AHOI_DLR_REJECT_SPIKE_WINDOW_SEC=900
```

In `docs/06-integrations.md`'s environment-variables table, add two rows after the `AHOI_API_TOKEN` row:

```
| `AHOI_DLR_REJECT_SPIKE_THRESHOLD` | server | rejected-DLR count that latches the Ahoi provider pause (default 10) |
| `AHOI_DLR_REJECT_SPIKE_WINDOW_SEC` | server | rolling window (seconds) for the DLR reject-rate breaker (default 900) |
```

Update the "Last updated" date at the top of `docs/06-integrations.md` to `2026-07-15`.

- [ ] **Step 10: Update `docs/07-conventions.md`**

Under `## Sending safety`, add:

```
- **Ahoi DLR reconcile naming debt (Section 3).** `stage_sends.texthub_message_id` is named after TextHub but also stores Ahoi's send-time uuid (Section 2) and is what `lib/sends/ahoi-dlr.ts`'s `reconcileAhoiDlrEvent` matches DLR `provider_uuid` against. Not renamed (G2 — a cross-provider rename is out of scope); every touch point carries a comment.
- **Ahoi DLR defensive classification (G4).** Only `carrier_sent`/`delivered` `send_status` values are confirmed live (Phase 0 recon). `rejected` is handled defensively (feeds the reject-rate breaker, thresholds env-tunable via `AHOI_DLR_REJECT_SPIKE_THRESHOLD` / `AHOI_DLR_REJECT_SPIKE_WINDOW_SEC`) but was never observed live; any other value logs a distinct `console.warn` in `reconcileAhoiDlrEvent` rather than being silently ignored or misclassified — this is how a real opt-out-error DLR code (O1, unconfirmed) gets spotted when it first appears in production.
- **Two send breakers, one latch (Section 3).** The drain's send-time failure-spike breaker (consecutive send failures, reads `send_attempts`/in-memory) and the DLR reject-rate breaker (reads `ahoi_dlr_events`) both latch the single `sms_providers.send_paused`. They read disjoint tables, so the same failure is never double-counted; `latchPause` is idempotent, so whichever trips first wins and the other composes without re-latching or overwriting the reason.
```

- [ ] **Step 11: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Ahoi DLR reconcile + reject-rate circuit breaker (Section 3 Task 5) — docs/04-features/sms-send-pipeline.md, docs/06-integrations.md, docs/07-conventions.md
```

- [ ] **Step 12: Commit**

```bash
git add lib/sends/ahoi-dlr.ts lib/sends/circuit-breakers.ts app/api/webhooks/ahoi/dlr scripts/test-ahoi-dlr-reconcile.ts .env.example docs/04-features/sms-send-pipeline.md docs/06-integrations.md docs/07-conventions.md docs/CHANGELOG.md
git commit -m "feat(ahoi): DLR reconcile against stage_sends + reject-rate circuit breaker"
```

---

## Task 6: Inbound (STOP-carrying) webhook endpoint + capture

**Files:**
- Create: `lib/sends/ahoi-inbound.ts`
- Create: `app/api/webhooks/ahoi/inbound/[token]/route.ts`
- Modify: `docs/05-flows.md`, `docs/06-integrations.md`
- Test: `scripts/test-ahoi-inbound-webhook.ts`

**Interfaces:**
- Consumes: `ahoiAdapter.parseInbound`, `extractAhoiWebhookFields` (Task 1); `ahoi_inbound_events` (Task 2); `ahoi-webhook-shared.ts` (Task 4).
- Produces: `captureAhoiInboundEvent(dbc, opts): Promise<{ id: string }>` — capture only, no reconcile, no `opt_outs` write (Section 4's job).

- [ ] **Step 1: Create `lib/sends/ahoi-inbound.ts`**

```ts
import { sql } from "drizzle-orm";

import type { InboundEvent } from "@/lib/sends/providers/types";
import type { DbOrTx } from "@/lib/sends/ahoi-dlr";

export interface CaptureAhoiInboundOpts {
  orgId: string;
  credentialId: number;
  providerId: number;
  method: string;
  rawBody: string | null;
  parsed: InboundEvent | null;
}

// Append-only raw+parsed capture, source='webhook'. NO reconcile, NO
// opt_outs write — Section 4 (spec §6) reads these rows and does the keyword
// match + contact upsert + suppression. Never throws on an unparseable
// payload (parsed may be null); the raw row still lands either way so the
// payload contract is always recoverable from real data.
export async function captureAhoiInboundEvent(
  dbc: DbOrTx,
  o: CaptureAhoiInboundOpts,
): Promise<{ id: string }> {
  const rows = (await dbc.execute(sql`
    INSERT INTO ahoi_inbound_events
      (org_id, credential_id, provider_id, source, source_number, destination_number,
       message, type, cost, method, raw_body)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, 'webhook',
            ${o.parsed?.source ?? null}, ${o.parsed?.destination ?? null},
            ${o.parsed?.message ?? null}, ${o.parsed?.type ?? null},
            ${o.parsed?.cost ? Number(o.parsed.cost) : null}, ${o.method}, ${o.rawBody})
    RETURNING id
  `)) as unknown as { id: string }[];
  return { id: rows[0].id };
}
```

- [ ] **Step 2: Write the failing test** — `scripts/test-ahoi-inbound-webhook.ts`

```ts
// Inbound (STOP-carrying) webhook route: path-token auth, capture only (no
// reconcile, no opt_outs write). Direct handler invocation, no real Ahoi
// network. Writes a real, marker-prefixed row into the new, empty
// ahoi_inbound_events table using the REAL seeded Ahoi credential's real
// token; cleans up in a finally block.
// Run: npx tsx scripts/test-ahoi-inbound-webhook.ts
import "./_env-preload";
import postgres from "postgres";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/webhooks/ahoi/inbound/[token]/route";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function postReq(url: string, body: string, ip = "207.181.190.161"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body,
  });
}

async function main() {
  const marker = `+1zzztest${Date.now().toString().slice(-9)}`;
  try {
    const cred = await sql`
      SELECT pc.inbound_webhook_token AS token
      FROM provider_credentials pc JOIN sms_providers p ON p.id = pc.provider_id
      WHERE p.sms_provider_id = 'ahoi' AND pc.brand_id IS NULL
    `;
    const token = cred[0]?.token as string | undefined;
    if (!token) {
      console.log("SKIP: run scripts/seed-ahoi-webhook-token.ts first (no token set).");
      await sql.end();
      process.exit(0);
    }

    const badRes = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/bogus-token`, `source=${marker}`), {
      params: Promise.resolve({ token: "bogus-token" }),
    });
    check("unknown token -> 401", badRes.status === 401);

    const body = `source=${marker}&destination=3158359592&message=Stop+please%0Athanks&type=sms&cost=0`;
    const res = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/${token}`, body), {
      params: Promise.resolve({ token }),
    });
    check("valid token -> 200", res.status === 200);

    const row = await sql`SELECT * FROM ahoi_inbound_events WHERE source_number = ${marker}`;
    check("row captured", row.length === 1, JSON.stringify(row));
    check("source='webhook' (channel discriminator)", row[0]?.source === "webhook");
    check("form-encoded message decoded", row[0]?.message === "Stop please\nthanks", JSON.stringify(row[0]?.message));
    check("no reconcile fields set (Section 4's job)", row[0]?.matched_contact_id === null && row[0]?.processed_at === null);
    check("provider_uuid is null (webhook payload has none)", row[0]?.provider_uuid === null);
  } finally {
    await sql`DELETE FROM ahoi_inbound_events WHERE source_number = ${marker}`;
    await sql.end();
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-inbound-webhook.ts`
Expected: FAIL — the route file doesn't exist yet.

- [ ] **Step 4: Implement `app/api/webhooks/ahoi/inbound/[token]/route.ts`**

```ts
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials } from "@/db/schema";
import { captureAhoiInboundEvent } from "@/lib/sends/ahoi-inbound";
import {
  extractClientIp,
  headersToObject,
  isKnownAhoiIp,
  queryToObject,
} from "@/lib/sends/ahoi-webhook-shared";
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";

// Public inbound Ahoi message (STOP / general reply) callback receiver.
//
// CAPTURE ONLY — this route does NOT match STOP keywords, does NOT upsert a
// contact, does NOT write opt_outs. That is Section 4 (spec §6), built
// against the rows this route captures. Auth (G1) mirrors the DLR route:
// path token only, resolved via the SAME provider_credentials row/token the
// DLR webhook uses (the URL path distinguishes the two).
//
// force-dynamic: every callback must run and be recorded, never cached.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  const cred = await db
    .select({
      id: provider_credentials.id,
      org_id: provider_credentials.org_id,
      provider_id: provider_credentials.provider_id,
    })
    .from(provider_credentials)
    .where(eq(provider_credentials.inbound_webhook_token, token))
    .limit(1);

  if (!cred[0]) return new NextResponse("Unauthorized", { status: 401 });
  if (cred[0].provider_id == null) return new NextResponse("Unauthorized", { status: 401 });

  const ip = extractClientIp(req.headers.get("x-forwarded-for"));
  if (!isKnownAhoiIp(ip)) {
    console.warn(
      `[ahoi-inbound-webhook] request from unexpected IP ${ip ?? "unknown"} (expected 207.181.190.0/24) — processing anyway (G1: token is the auth gate)`,
    );
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const raw = { query: queryToObject(req), body: rawBody, headers: headersToObject(req) };
  const parsed = ahoiAdapter.parseInbound(raw);

  await captureAhoiInboundEvent(db, {
    orgId: cred[0].org_id,
    credentialId: cred[0].id,
    providerId: cred[0].provider_id,
    method: req.method,
    rawBody: rawBody || null,
    parsed,
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-inbound-webhook.ts`
Expected: PASS — `ALL PASS`, exit 0 (or SKIP if Task 3's gate hasn't cleared yet).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Update `docs/06-integrations.md`**

Add a table row:

```
| **Ahoi inbound webhook** | provider → app | STOP/reply capture (Section 3; opt-out WRITE is Section 4) | path token (same column as the DLR webhook) | `POST /api/webhooks/ahoi/inbound/<token>` form body `source/destination/message/type/cost`; `message` is form/URL-encoded, decoded automatically by `URLSearchParams` |
```

- [ ] **Step 8: Add a sequence diagram to `docs/05-flows.md`**

Add after "E2. Ahoi DLR (delivery receipt) capture":

```markdown
## E3. Ahoi inbound (STOP-carrying) webhook capture

\`\`\`mermaid
sequenceDiagram
  participant Ahoi
  participant App
  participant DB
  Ahoi->>App: POST /api/webhooks/ahoi/inbound/<token> (form-encoded)
  App->>DB: resolve token -> (org, provider, credential) — same token as the DLR webhook
  App->>App: parseInbound (source/destination/message/type/cost)
  App->>DB: INSERT ahoi_inbound_events (source='webhook')
  Note over App,DB: CAPTURE ONLY — no keyword match, no opt_outs write (Section 4)
\`\`\`
```

- [ ] **Step 9: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Ahoi inbound webhook + capture (Section 3 Task 6) — docs/05-flows.md, docs/06-integrations.md
```

- [ ] **Step 10: Commit**

```bash
git add lib/sends/ahoi-inbound.ts app/api/webhooks/ahoi/inbound scripts/test-ahoi-inbound-webhook.ts docs/05-flows.md docs/06-integrations.md docs/CHANGELOG.md
git commit -m "feat(ahoi): inbound webhook endpoint + capture (no opt-out write — Section 4)"
```

---

## Task 7: CDR poll cron (inbound reconciliation backstop)

**Files:**
- Modify: `lib/sends/providers/ahoi.ts` (export `ahoiBaseUrl`, done in Task 1 — verify)
- Create: `lib/sends/ahoi-cdr-poll.ts`
- Create: `app/api/cron/ahoi-cdr-poll/route.ts`
- Modify: `vercel.json`, `docs/05-flows.md`, `docs/06-integrations.md`
- Test: `scripts/test-ahoi-cdr-poll.ts`

**Interfaces:**
- Consumes: `ahoiBaseUrl` (Task 1); `CAMPAIGN_TIMEZONE`, `campaignDayBoundsUtc` (existing, `lib/campaign-timezone.ts`); `ahoi_inbound_events` (Task 2).
- Produces: `computeCdrPollWindow(now)`, `pollAhoiCdr(database, opts)`.

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-cdr-poll.ts`

```ts
// CDR poll: (1) pure ET-window computation incl. the midnight-boundary case,
// (2) idempotent capture + direction filter via an injected fetcher, rolled
// back in a transaction (no real Ahoi network, no data survives).
// Run: npx tsx scripts/test-ahoi-cdr-poll.ts
import "./_env-preload";
import { sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";

import { db, sql as pgConn } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { computeCdrPollWindow, pollAhoiCdr, type AhoiCdrRow } from "@/lib/sends/ahoi-cdr-poll";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ---- Pure window computation ----
// Ordinary midday moment: startdate is literally "yesterday", enddate "today".
const midday = new Date("2026-07-15T18:00:00Z"); // ~2pm ET (no DST edge)
const w1 = computeCdrPollWindow(midday);
check("midday: enddate = today (ET)", w1.enddate === formatInTimeZone(midday, CAMPAIGN_TIMEZONE, "MM/dd/yyyy"), JSON.stringify(w1));
check(
  "midday: startdate = yesterday (ET)",
  w1.startdate === formatInTimeZone(new Date(midday.getTime() - 24 * 3600 * 1000), CAMPAIGN_TIMEZONE, "MM/dd/yyyy"),
  JSON.stringify(w1),
);

// ET-midnight boundary: a moment just after midnight ET must still treat
// "yesterday" as the PRIOR calendar date, not itself (this is the exact case
// campaignDayBoundsUtc's 1-hour-before-boundary trick is built for).
const justAfterMidnightEt = new Date("2026-07-15T04:05:00Z"); // 00:05 ET (summer, UTC-4)
const w2 = computeCdrPollWindow(justAfterMidnightEt);
check("just-after-ET-midnight: enddate is TODAY's ET date", w2.enddate === "07/15/2026", JSON.stringify(w2));
check("just-after-ET-midnight: startdate is YESTERDAY's ET date, not today's", w2.startdate === "07/14/2026", JSON.stringify(w2));

// A message uuid dated 23:59 ET the day before is inside BOTH a poll run at
// 00:05 ET (today) and one at 23:00 ET (yesterday) -> covered twice by
// design; idempotent INSERT (below) proves it lands exactly once.
const lateNightEt = new Date("2026-07-15T03:59:00Z"); // 23:59 ET the prior day
const w3 = computeCdrPollWindow(lateNightEt);
check(
  "23:59-ET-prior-day poll's window START <= that late-night date <= its END (straddles correctly)",
  w3.startdate <= "07/14/2026" && w3.enddate >= "07/14/2026",
  JSON.stringify(w3),
);

// ---- DB-backed: idempotent capture + direction filter (rolled-back tx) ----
async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      // pollAhoiCdr targets the credential of the provider whose
      // sms_provider_id = 'ahoi' (seeded in Section 1). Run against it directly
      // with an INJECTED fetcher (no network) and a rolled-back tx, so nothing
      // survives. Count assertions below assume the single seeded provider-
      // default ahoi credential this single-org install has (MEMORY: org count
      // = 1); `new`/`dupe` dedup by (provider_id, provider_uuid) so they're
      // robust even if extra ahoi credentials existed, and `inbound` is 1 per
      // credential.
      const realAhoi = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahoi'`);
      if (!realAhoi) { console.log("SKIP: no seeded ahoi provider row (run Section 1's seed)."); throw ROLLBACK; }

      const rows: AhoiCdrRow[] = [
        { date: "07/15/2026 10:00:00", your_cost: "0", submaster_id: "1", user_id: "1", submaster_cost: "0", user_cost: "0", surcharge: "0", src: "5642155963", dst: "3158359592", message: "Stop", direction: "in", alpha: "", msg_type: "sms", uuid: `cdrtest-${sfx}-1` },
        { date: "07/15/2026 10:01:00", your_cost: "0.0035", submaster_id: "1", user_id: "1", submaster_cost: "0", user_cost: "0", surcharge: "0", src: "3158359592", dst: "5642155963", message: "Hi", direction: "out", alpha: "", msg_type: "sms", uuid: `cdrtest-${sfx}-2` },
      ];
      const fetchCdr = async () => ({ ok: true as const, rows });

      const r1 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr });
      check("first poll: only direction=in counted", r1.inbound === 1, JSON.stringify(r1));
      check("first poll: 1 new row", r1.new === 1, JSON.stringify(r1));

      const cap1 = await tx.execute(sql`SELECT * FROM ahoi_inbound_events WHERE provider_uuid = ${`cdrtest-${sfx}-1`}`);
      check("inbound row captured with source='cdr'", (cap1 as unknown as { source: string }[])[0]?.source === "cdr");
      const outRow = await tx.execute(sql`SELECT 1 FROM ahoi_inbound_events WHERE provider_uuid = ${`cdrtest-${sfx}-2`}`);
      check("direction=out row NOT captured", (outRow as unknown[]).length === 0);

      // Idempotent re-run: same rows, zero new inserts.
      const r2 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr });
      check("second identical poll: 0 new (idempotent)", r2.new === 0, JSON.stringify(r2));
      check("second identical poll: 1 dupe", r2.dupe === 1, JSON.stringify(r2));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-cdr-poll.ts`
Expected: FAIL — module `@/lib/sends/ahoi-cdr-poll` not found.

- [ ] **Step 3: Create `lib/sends/ahoi-cdr-poll.ts`**

```ts
import { sql } from "drizzle-orm";
import Papa from "papaparse";
import { formatInTimeZone } from "date-fns-tz";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { CAMPAIGN_TIMEZONE, campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { ahoiBaseUrl } from "@/lib/sends/providers/ahoi";

// Rolling ET window (today + a midnight overlap — CDR timestamps are ET,
// Phase 0 recon). Reuses the project's single DST-safe day-boundary helper
// (campaignDayBoundsUtc) rather than a naive "now - 24h" subtraction: on a
// 25-hour fall-back day, subtracting a flat 24h from a moment just after
// ET-midnight can still land INSIDE today's ET date, not yesterday's. Going 1
// hour before today's ET-midnight boundary is always safely inside
// yesterday's calendar date instead (every ET day is at least 23h long).
export function computeCdrPollWindow(now: Date = new Date()): { startdate: string; enddate: string } {
  const enddate = formatInTimeZone(now, CAMPAIGN_TIMEZONE, "MM/dd/yyyy");
  const { start: todayStartUtc } = campaignDayBoundsUtc(now);
  const yesterdayInstant = new Date(todayStartUtc.getTime() - 60 * 60 * 1000);
  const startdate = formatInTimeZone(yesterdayInstant, CAMPAIGN_TIMEZONE, "MM/dd/yyyy");
  return { startdate, enddate };
}

export interface AhoiCdrRow {
  date: string;
  your_cost: string;
  submaster_id: string;
  user_id: string;
  submaster_cost: string;
  user_cost: string;
  surcharge: string;
  src: string;
  dst: string;
  message: string;
  direction: string;
  alpha: string;
  msg_type: string;
  uuid: string;
}

export type CdrFetchResult =
  | { ok: true; rows: AhoiCdrRow[] }
  | { ok: false; error: string };

export type CdrFetcher = (opts: {
  apiKey: string;
  startdate: string;
  enddate: string;
}) => Promise<CdrFetchResult>;

async function realFetchAhoiCdr(opts: {
  apiKey: string;
  startdate: string;
  enddate: string;
}): Promise<CdrFetchResult> {
  try {
    const url =
      `${ahoiBaseUrl()}/cdrs/download/csv?record_type=sms` +
      `&startdate=${encodeURIComponent(opts.startdate)}&enddate=${encodeURIComponent(opts.enddate)}` +
      `&key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed = Papa.parse<AhoiCdrRow>(text, { header: true, skipEmptyLines: "greedy" });
    const rows = (parsed.data ?? []).filter((r) => r && typeof r === "object" && r.uuid);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

function parseCdrCost(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface AhoiCdrPollResult {
  credentials_polled: number;
  fetched: number; // total rows returned (all directions)
  inbound: number; // direction=in rows
  new: number; // newly captured
  dupe: number; // already-ingested (idempotent skip)
  error: string | null;
}

// Polls the Ahoi CDR system-of-record for every Ahoi credential (optionally
// scoped to one org), filters direction=in, and idempotently captures into
// ahoi_inbound_events (source='cdr') — a reconciliation backstop for the
// webhook (Task 6), NOT because the webhook is known lossy (Phase 0 recon:
// 0% webhook-layer loss measured; upstream-carrier loss is unrecoverable by
// either channel). dbc-parameterized so a test can pass a rolled-back tx.
export async function pollAhoiCdr(
  database: typeof db,
  opts?: { orgId?: string; fetchCdr?: CdrFetcher; now?: Date },
): Promise<AhoiCdrPollResult> {
  const fetchCdr = opts?.fetchCdr ?? realFetchAhoiCdr;
  const window = computeCdrPollWindow(opts?.now ?? new Date());
  const orgFilter = opts?.orgId ? sql`AND pc.org_id = ${opts.orgId}` : sql``;

  const creds = (await database.execute(sql`
    SELECT pc.id AS credential_id, pc.org_id AS org_id, pc.provider_id AS provider_id, pc.api_key AS api_key
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.sms_provider_id = 'ahoi'
    ${orgFilter}
  `)) as unknown as { credential_id: number; org_id: string; provider_id: number; api_key: string }[];

  let fetched = 0;
  let inbound = 0;
  let neu = 0;
  let dupe = 0;
  let lastError: string | null = null;

  for (const cred of creds) {
    const res = await fetchCdr({ apiKey: cred.api_key, startdate: window.startdate, enddate: window.enddate });
    if (!res.ok) {
      lastError = res.error;
      await notifyTelegram(
        `⚠️ Ahoi CDR poll FAILED (inbound capture backstop down)\nerror: ${res.error}\ncredential: ${cred.credential_id}`,
      );
      continue;
    }
    fetched += res.rows.length;
    const inRows = res.rows.filter((r) => r.direction === "in");
    inbound += inRows.length;

    for (const r of inRows) {
      const inserted = (await database.execute(sql`
        INSERT INTO ahoi_inbound_events
          (org_id, credential_id, provider_id, source, source_number, destination_number,
           message, type, cost, provider_uuid, method, raw_body)
        VALUES (${cred.org_id}, ${cred.credential_id}, ${cred.provider_id}, 'cdr', ${r.src}, ${r.dst},
                ${r.message}, ${r.msg_type ?? null}, ${parseCdrCost(r.your_cost)}, ${r.uuid},
                'poll', ${JSON.stringify(r)})
        ON CONFLICT (provider_id, provider_uuid) WHERE provider_uuid IS NOT NULL DO NOTHING
        RETURNING id
      `)) as unknown as { id: string }[];
      if (inserted.length > 0) neu++;
      else dupe++;
    }
  }

  return { credentials_polled: creds.length, fetched, inbound, new: neu, dupe, error: lastError };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-cdr-poll.ts`
Expected: PASS — `ALL PASS (rolled back).`, exit 0.

- [ ] **Step 5: Implement `app/api/cron/ahoi-cdr-poll/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { pollAhoiCdr } from "@/lib/sends/ahoi-cdr-poll";

// Ahoi CDR poll — inbound capture reconciliation backstop (Section 3 Task 7).
// Lives under the existing /api/cron/ namespace alongside send-scheduled,
// telegram-report, lookup-worker, carrier-triage. Cron schedule is staggered
// (13,28,43,58) so it doesn't pile on the top-of-hour with the other pollers.
// Auth mirrors /api/opt-outs/poll and /api/keitaro/poll: CRON_SECRET Bearer
// (Vercel Cron, all orgs) or an authenticated operator+ session (manual
// trigger, scoped to the caller's org) — "triggering a capture sync" is
// import-shaped, same permission keitaro/poll uses.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  let orgId: string | undefined;
  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId;
  }

  if (bearerMatches) {
    const leased = await withCronLease("ahoi-cdr-poll", () => pollAhoiCdr(db, { orgId }));
    if (!leased.ran) {
      return NextResponse.json({ skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount });
    }
    return NextResponse.json(leased.result);
  }

  const result = await pollAhoiCdr(db, { orgId });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
```

- [ ] **Step 6: Add the cron entry to `vercel.json`**

Add to the `crons` array:

```json
    {
      "path": "/api/cron/ahoi-cdr-poll",
      "schedule": "13,28,43,58 * * * *"
    }
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Update `docs/06-integrations.md`**

Update the Ahoi service row's contract to mention CDR, and add an env/cron table note. Amend the Vercel Cron row's count (currently "the 9 cron endpoints") to "the 10 cron endpoints" and its schedule description to include the new `13,28,43,58` slot (`/api/cron/ahoi-cdr-poll`, staggered off the other pollers).

Add a table row:

```
| **Ahoi CDR poll** | app → provider | inbound capture backstop (Section 3) | `key` query param (DB, provider-default) | `GET {AHOI_API_BASE_URL}/cdrs/download/csv?record_type=sms&startdate=MM/DD/YYYY&enddate=MM/DD/YYYY&key=` → CSV; filtered to `direction=in`, deduped by `uuid` |
```

- [ ] **Step 9: Add a sequence diagram to `docs/05-flows.md`**

Add after "E3. Ahoi inbound webhook capture":

```markdown
## E4. Ahoi CDR poll (every 15 min, inbound backstop)

\`\`\`mermaid
sequenceDiagram
  participant Cron as ahoi-cdr-poll (13,28,43,58)
  participant App
  participant Ahoi as Ahoi CDR (system of record)
  participant DB
  Cron->>App: GET /api/cron/ahoi-cdr-poll (Bearer CRON_SECRET)
  App->>Ahoi: GET /cdrs/download/csv?startdate=<ET yesterday>&enddate=<ET today>&key=
  Ahoi-->>App: CSV (all directions)
  App->>App: filter direction=in
  App->>DB: INSERT ahoi_inbound_events (source='cdr') ON CONFLICT (provider_id, provider_uuid) DO NOTHING
  Note over App,DB: idempotent backstop, not because the webhook is lossy —<br/>upstream-carrier loss is unrecoverable by either channel (Phase 0 recon)
\`\`\`
```

- [ ] **Step 10: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Ahoi CDR poll cron (Section 3 Task 7) — vercel.json, docs/05-flows.md, docs/06-integrations.md
```

- [ ] **Step 11: Commit**

```bash
git add lib/sends/providers/ahoi.ts lib/sends/ahoi-cdr-poll.ts app/api/cron/ahoi-cdr-poll vercel.json scripts/test-ahoi-cdr-poll.ts docs/05-flows.md docs/06-integrations.md docs/CHANGELOG.md
git commit -m "feat(ahoi): CDR poll cron (inbound capture reconciliation backstop)"
```

---

## Task 8: No-sender-number kickoff guard (carried from Section 2's final review)

**Files:**
- Modify: `lib/sends/kickoff.ts`, `lib/sends/kickoff-refusals.ts`, `lib/sends/scheduled.ts`
- Modify: `docs/04-features/sms-send-pipeline.md`
- Test: `scripts/test-kickoff-no-sender.ts`

**Interfaces:**
- Consumes: `sms_providers.sms_provider_id` (existing, not previously selected by kickoff), `campaign_stages.provider_phone_id` (existing, not previously selected by kickoff).
- Produces: `KickoffRefusal` gains `no_sender_number`.

**Design note (why a plain key check, not a new adapter capability flag):** kickoff.ts does not currently import the provider registry (`lib/sends/providers/registry.ts`) at all — only the drain does. Adding a `getAdapter()` call here would introduce a new `UnknownProviderError` throw surface inside `kickoffStageSend` that nothing currently catches (kickoff has no G3-equivalent "unknown provider = clean refusal" handling — that's a drain-only guarantee today). A plain string comparison against the already-fetched `sms_providers.sms_provider_id` avoids that risk entirely and costs one extra selected column. If a third provider needs this same guard later, generalize to a `Set<string>` or an adapter capability flag then — not preemptively for a set of exactly one.

- [ ] **Step 1: Write the failing test** — `scripts/test-kickoff-no-sender.ts`

```ts
// G-carry (Section 2 final review): an Ahoi stage with no provider_phone_id
// is refused at KICKOFF, before any recipient materialization — not left to
// fail at drain (which wastes the attempt and risks tripping the failure-
// spike breaker on a purely-configuration problem). TextHub must be
// UNAFFECTED (it doesn't need provider_phone_id — its number is bound to the
// api_key account-side). Rolled-back transaction.
// Run: npx tsx scripts/test-kickoff-no-sender.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const brand = await one<{ id: number }>(sql`
        SELECT b.id FROM brands b
        JOIN short_domains sd ON sd.brand_id = b.id AND sd.status = 'active'
        WHERE b.org_id = ${orgId} LIMIT 1`);
      if (!brand) { console.log("SKIP: need a brand with an active short domain"); throw ROLLBACK; }

      const ahoiProv = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahoi'`);
      if (!ahoiProv) { console.log("SKIP: no seeded ahoi provider row (run Section 1's seed)."); throw ROLLBACK; }
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${ahoiProv.id}, NULL, 'k') ON CONFLICT DO NOTHING`);

      const texthubProv = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"nosend-th-" + sfx}, ${orgId}, ${"nosend-th"}, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${texthubProv.id}, NULL, ${"k"})`);

      async function mkStage(opts: { n: number; providerId: number; providerPhoneId: number | null }) {
        const cre = await one<{ id: number }>(sql`
          INSERT INTO creatives (slug, org_id, text, status) VALUES (${"nosend-cre-" + sfx + "-" + opts.n}, ${orgId}, ${"Hi"}, 'active') RETURNING id`);
        const trackingId = `9_99_nosend_${sfx}_s${opts.n}`;
        const camp = await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
          VALUES (${orgId}, ${"nosend-camp-" + sfx + "-" + opts.n}, ${"nosend"}, 'active', 'tracked', ${brand.id}, ${trackingId}) RETURNING id`);
        const fullUrl = `https://www.guidekn.com/lp/knd?sub_id3=${trackingId}`;
        const stage = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, sms_provider_id, provider_phone_id, send_approved,
             tracking_id, full_url, include_no_status, stop_text, scheduled_at)
          VALUES (${orgId}, ${camp.id}, ${opts.n}, ${cre.id}, ${opts.providerId}, ${opts.providerPhoneId}, true,
             ${trackingId}, ${fullUrl}, true, ${"STOP"}, now())
          RETURNING id`);
        const contact = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx + opts.n}) RETURNING id`);
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
          VALUES (${orgId}, ${camp.id}, ${contact.id}, true, false)`);
        return { stageId: stage.id, campaignId: camp.id };
      }

      // Case A: Ahoi stage, provider_phone_id NULL -> refused.
      const a = await mkStage({ n: 1, providerId: ahoiProv.id, providerPhoneId: null });
      const resA = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: a.campaignId, stageId: a.stageId });
      check("Ahoi stage with no provider_phone_id -> refused", !resA.ok && resA.reason === "no_sender_number", JSON.stringify(resA));

      // Case B: Ahoi stage, provider_phone_id set -> NOT refused by this guard
      // (may still fail later for unrelated reasons — assert it's not THIS reason).
      const phone = await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number) VALUES (${orgId}, ${ahoiProv.id}, ${"+13158359592"}) RETURNING id`);
      const b = await mkStage({ n: 2, providerId: ahoiProv.id, providerPhoneId: phone.id });
      const resB = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: b.campaignId, stageId: b.stageId });
      check("Ahoi stage WITH provider_phone_id -> not refused by no_sender_number", !(!resB.ok && resB.reason === "no_sender_number"), JSON.stringify(resB));

      // Case C: TextHub stage, provider_phone_id NULL -> NOT refused (TextHub
      // doesn't need a sender number — this is the "don't break TextHub" proof).
      const c = await mkStage({ n: 3, providerId: texthubProv.id, providerPhoneId: null });
      const resC = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: c.campaignId, stageId: c.stageId });
      check("TextHub stage with no provider_phone_id -> NOT refused (G2 proof)", !(!resC.ok && resC.reason === "no_sender_number"), JSON.stringify(resC));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-kickoff-no-sender.ts`
Expected: FAIL — `resA` currently succeeds past this point (no such refusal exists yet); `KickoffRefusal` has no `no_sender_number` member.

(If it prints `SKIP:` lines, run against an environment that has the stated preconditions — same as `test-kickoff-fullurl.ts`/`test-kickoff-segments.ts`.)

- [ ] **Step 3: Add `no_sender_number` to `KickoffRefusal`**

In `lib/sends/kickoff.ts`, extend the `KickoffRefusal` union (after `segment_ceiling_exceeded`):

```ts
  | "segment_ceiling_exceeded"
  // Ahoi's send() requires a `source` number (spec §5 carry, Section 2 final
  // review): a stage with no provider_phone_id previously passed kickoff,
  // materialized every recipient, then failed at DRAIN — wasteful and risks
  // tripping the failure-spike breaker on a pure config problem. Gated to
  // providers that actually need one (currently just Ahoi) — TextHub's
  // number is bound to the api_key account-side, not per-stage.
  | "no_sender_number";
```

- [ ] **Step 4: Add `provider_phone_id` to `MainRow` + the SELECT**

In `MainRow`, add after `sms_provider_id: number | null;`:

```ts
  provider_phone_id: number | null;
```

In the main SELECT, add after `s.sms_provider_id AS sms_provider_id,`:

```sql
      s.provider_phone_id        AS provider_phone_id,
```

- [ ] **Step 5: Add the guard in the tracked-mode block**

In the tracked-mode `else` branch, the existing provider query currently reads:

```ts
    const provider = (await dbc.execute(sql`
      SELECT supports_api_send FROM sms_providers
      WHERE id = ${row.sms_provider_id} AND org_id = ${orgId} LIMIT 1
    `)) as unknown as { supports_api_send: boolean }[];
    if (!provider[0]?.supports_api_send) {
      return { ok: false, reason: "provider_not_api_capable" };
    }
```

Replace with:

```ts
    const provider = (await dbc.execute(sql`
      SELECT supports_api_send, sms_provider_id AS provider_key FROM sms_providers
      WHERE id = ${row.sms_provider_id} AND org_id = ${orgId} LIMIT 1
    `)) as unknown as { supports_api_send: boolean; provider_key: string }[];
    if (!provider[0]?.supports_api_send) {
      return { ok: false, reason: "provider_not_api_capable" };
    }

    // No-sender-number guard (Section 3 Task 8; carried from Section 2's
    // final review). Only Ahoi needs a provider_phone_id — see the design
    // note in the Section 3 plan for why this is a plain key check rather
    // than a new adapter capability flag.
    if (provider[0].provider_key === "ahoi" && row.provider_phone_id == null) {
      return { ok: false, reason: "no_sender_number" };
    }
```

- [ ] **Step 6: Add the message to `KICKOFF_REFUSAL`**

In `lib/sends/kickoff-refusals.ts`, add after `segment_ceiling_exceeded`:

```ts
  no_sender_number: {
    status: 400,
    message: "This provider needs a sending number — assign a provider phone to this stage before sending",
  },
```

- [ ] **Step 7: Add to `scheduled.ts`'s `PERMANENT_REFUSALS`**

In `lib/sends/scheduled.ts`, add `"no_sender_number",` to the `PERMANENT_REFUSALS` set (after `"segment_ceiling_exceeded",`) — a stage refused this way won't self-resolve within the scheduled window (a human must assign a provider phone).

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx tsx scripts/test-kickoff-no-sender.ts`
Expected: PASS — `ALL PASS (rolled back).`, exit 0.

- [ ] **Step 9: Run the full regression set + typecheck**

Run: `npx tsx scripts/test-kickoff-fullurl.ts && npx tsx scripts/test-kickoff-segments.ts && npx tsx scripts/verify-drain.ts && npx tsc --noEmit`
Expected: all PASS, no type errors (confirms the exhaustive `KICKOFF_REFUSAL` record compiles with the new key and TextHub's path is unaffected).

- [ ] **Step 10: Update `docs/04-features/sms-send-pipeline.md`**

In the `### Step 1 — Kickoff / materialize` section, add a short paragraph:

```
**No-sender-number guard (`no_sender_number`, Section 3).** A provider whose adapter requires a per-stage sending number (currently only Ahoi — TextHub's number is bound to the api_key account-side) is refused at kickoff, before any recipient materialization, when the stage has no `provider_phone_id`. Closes a gap where such a stage previously materialized every recipient and only failed at drain.
```

- [ ] **Step 11: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — no_sender_number kickoff guard for Ahoi (Section 3 Task 8) — docs/04-features/sms-send-pipeline.md
```

- [ ] **Step 12: Commit**

```bash
git add lib/sends/kickoff.ts lib/sends/kickoff-refusals.ts lib/sends/scheduled.ts scripts/test-kickoff-no-sender.ts docs/04-features/sms-send-pipeline.md docs/CHANGELOG.md
git commit -m "feat(ahoi): refuse kickoff for an Ahoi stage with no provider_phone_id (no_sender_number)"
```

---

## Section 3 Checkpoint

Stop here and bring back for review before Section 4 (opt-out intake, spec §6). Deliverables:

- `ahoiAdapter.parseDlr`/`parseInbound` implement the real form-encoded field extraction (Task 1).
- `ahoi_dlr_events` + `ahoi_inbound_events` live (migration 0109, applied only after explicit user go-ahead) — G5 satisfied, no generalization of `texthub_inbound_events`.
- The shared Ahoi webhook token is minted (Task 3, gated) and both webhook URLs are documented for manual portal registration.
- `POST /api/webhooks/ahoi/dlr/[token]` captures + reconciles DLRs against `stage_sends.texthub_message_id` (naming debt flagged, not fixed — G2); multi-segment numeric-uuid extras land as `unmatched`, not an error.
- The DLR reject-rate signal (`send_status='rejected'`) feeds `sms_providers.send_paused` via a provider-scoped rolling window, additive to (not replacing) the existing send-time failure-spike breaker; any unrecognized `send_status` is logged distinctly (G4).
- `POST /api/webhooks/ahoi/inbound/[token]` captures inbound (STOP-carrying) messages — **capture only**, zero `opt_outs` writes.
- The CDR poll (`/api/cron/ahoi-cdr-poll`, `13,28,43,58 * * * *`) idempotently captures `direction=in` rows as a reconciliation backstop, correctly handling the ET-midnight boundary.
- An Ahoi stage with no `provider_phone_id` is refused at kickoff (`no_sender_number`) instead of failing at drain; TextHub is provably unaffected.
- `SEND_ENABLED` still off throughout. No opt-out suppression logic exists yet — that's Section 4.

---

## Self-Review

**Spec coverage (§5 + G1/G2/G4/G5):**
- DLR webhook, capture, reconcile against `stage_sends` → Tasks 4–5 ✓, with the multi-segment numeric-uuid case explicitly tested as a non-error.
- Two derived signals: (a) reject-rate → circuit breaker → Task 5 ✓ (provider-scoped; thresholds are env-tunable config, not hardcoded constants — `ahoiDlrRejectSpikeThreshold()`/`ahoiDlrRejectWindowSeconds()`, defaults 10/900; the additive composition with the existing send-time breaker is proven by a dedicated 2-provider test, see below); (b) opt-out-error → suppression is explicitly OUT of scope here (Section 4) — Section 3 only satisfies the "defensive classification + distinct unmapped-code log" half of G4, which is as far as spec §5 takes it before handing off to §6.
- CDR poll, rolling ET window with midnight overlap, `direction=in` filter, uuid idempotency → Task 7 ✓ (route lives under the existing `/api/cron/ahoi-cdr-poll` namespace, `13,28,43,58` schedule staggered off the other pollers), with the ET-midnight-boundary case spec §11 explicitly calls out as a verification criterion tested directly (not just asserted by inspection).
- Inbound webhook, capture only → Task 6 ✓.
- Table strategy: separate Ahoi tables, `ahoi_inbound_events` pre-built with Section 4's columns (mirroring `texthub_inbound_events`' own Stage-A/B precedent) → Task 2 ✓.
- No-sender-number kickoff guard (carried from Section 2's final review, not in the original spec text but explicitly flagged as a decision for this plan to resolve) → Task 8 ✓, gated to Ahoi only via a plain key check (deliberately not a new adapter capability flag — see Task 8's design note).

**Placeholder scan:** every task's code block is complete and copy-pasteable — no `TBD`, no `// ...`, no elided function bodies. Task 2's Steps 7–8 and Task 3's Steps 4–5 are explicit STOP/gates (not placeholders — all SQL/scripts are fully written; only the prod-write invocation itself is withheld pending user approval, mirroring Section 1 Task 4 / Section 2 Task 4's precedent).

**Type consistency:** `DlrEvent`/`InboundEvent` (Section 1) are consumed unchanged — no interface churn, confirmed against Section 2's final review note that these shapes already anticipate Section 3. The `source`/`destination` fields those types deliberately don't carry are sourced instead via `extractAhoiWebhookFields`, used identically by the parsers (Task 1) and the capture functions (Task 4/6), so raw-archival and typed-parse can never disagree about how a field was extracted. `DbOrTx` is defined once per new module (`ahoi-dlr.ts`), matching the codebase's existing convention of a local, non-shared type alias per module (`kickoff.ts`, `circuit-breakers.ts` each do the same) rather than introducing a new shared-type import.

**Reuse discipline:** the CDR poll's ET window reuses `lib/campaign-timezone.ts`'s `CAMPAIGN_TIMEZONE` + `campaignDayBoundsUtc` (already DST-tested for exactly this kind of boundary) instead of a fresh, naively-wrong `now - 24h` computation — a genuine bug avoided by checking for an existing helper before writing new date arithmetic. CSV parsing reuses the already-a-dependency `papaparse` (no new package). The webhook routes' `headersToObject`/`queryToObject` are factored into one shared file instead of being duplicated across two routes (TextHub's single route had no reason to factor this out; Ahoi's two routes do).

**Migration-snapshot finding (methodological, not just this migration):** verified directly against `0108_snapshot.json` that `stage_sends`, `send_attempts`, `send_circuit_events`, `provider_credentials`, and `texthub_inbound_events` are ALL absent from its `"tables"` map, and that `verify-migration-integrity.ts` never reads that map — only file existence, a SQL-content hash, and `prevId` chaining. Task 2 follows this established (if surprising) precedent rather than introducing new, unverified, hand-typed table definitions into the snapshot. Worth flagging to the user as a standing observation about this project's migration tooling, independent of Section 3.

**Concurrency safety (coordinator-verified prod fact):** `stage_sends` is 820K+ rows / ~490 MB in prod. The new `stage_sends.texthub_message_id` index is therefore built `CONCURRENTLY` out-of-band (`scripts/apply-ahoi-stage-sends-index-concurrent.ts`) BEFORE `db:migrate`, and the in-migration statement is `CREATE INDEX IF NOT EXISTS` so it no-ops — the exact pattern of migrations 0101/0096/0088 (`CONCURRENTLY` cannot run inside drizzle's migration transaction). This keeps the apply from taking an ACCESS EXCLUSIVE lock on a hot table. The two brand-new EMPTY tables carry no lock risk and stay as normal in-migration `CREATE TABLE`. Consistent everywhere: migration SQL comment (Task 2 Step 3), the apply script (Task 2 Step 7), the gate ordering (Steps 8–9), the File Structure map, and Global Constraints.

**Additive breaker composition (coordinator ask #4), proven by test:** the two breakers are SEPARATE signals over DISJOINT tables — the send-time failure-spike breaker reads `send_attempts` + an in-memory consecutive counter; the DLR reject-rate breaker reads `ahoi_dlr_events` (`send_status='rejected'`). `scripts/test-ahoi-dlr-reconcile.ts` asserts: (i) `delivered` DLRs never inflate the reject count (disjointness / no-double-count of the same failure); (ii) below-threshold does not trip, the threshold-th reject does; (iii) a further reject after the pause is latched returns `pausedNow=false` with exactly ONE `send_circuit_events` `paused` row (single-count via `latchPause`'s idempotency); (iv) a second provider PRE-paused by a simulated send-time `failure_spike` latch is not re-latched or reason-overwritten by subsequent DLR rejects (the two compose additively over one shared `sms_providers.send_paused`, neither cancels the other).

**The CARRIES from the brief, explicitly resolved:**
1. **No-sender-number kickoff guard** — built (Task 8), gated on `sms_provider_id === "ahoi"`. Its test has THREE cases: Ahoi/no-phone → refused (Case A), Ahoi/with-phone → not refused by this reason (Case B), and the required TextHub negative — TextHub/no-phone → NOT refused (Case C), which is the direct proof the guard is Ahoi-gated and TextHub (whose number is bound to the api_key account-side) is unaffected.
2. **`texthub_message_id` naming-debt** — NOT renamed (G2), commented at every touch point (`ahoi-dlr.ts`'s `reconcileAhoiDlrEvent`, the migration SQL, the schema.ts column).
3. **Section 3/4 boundary** — drawn at "capture + reconcile + derived signals, zero `opt_outs` writes," argued in the plan's opening section with the concrete precedent (`texthub_inbound_events`' own Stage A/B split) that justifies pre-building Section 4's columns now without pre-building its logic.
