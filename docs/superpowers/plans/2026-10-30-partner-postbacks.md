# Partner Passthrough Fields + Sales Postbacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partners send whitelisted extra fields with each lead, and receive a templated postback (echoing those fields) when a drip-journey-attributed purchase is approved.

**Architecture:** Per-key config columns on `partner_keys`; the whitelist is applied at intake into `lead_inbox.partner_data`, copied by enrichment to `lead_events.partner_data`. A ledger-driven enqueue pass (inside the drip-monitors cron, after the lifecycle sweep) inserts into `partner_postbacks` with a unique `(partner_key_id, conversion_event_id)`; a separate delivery cron sends with retries. Everything is inert until a key is configured and the env kill switch is on.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle (hand-authored migrations) · Postgres (Supabase) · Zod · shadcn/ui · `scripts/test-*.ts` (tsx, `check()` style).

**Spec:** [docs/superpowers/specs/2026-10-30-partner-postbacks-design.md](../specs/2026-10-30-partner-postbacks-design.md)

## Global Constraints

- Build order **PR1 → PR2 → PR3**; each PR: preview (camman-v2) first, then STOP for the owner's go before the prod migration and again before merge.
- Migrations are additive and hand-authored (edit `db/schema.ts`, write SQL, clone snapshot, journal entry). Never run `db:migrate` against prod without the owner's go in the same session; a DB-writing script imports `./_require-preview-db` second.
- Inert by default: `passthrough_fields = '[]'`, `postback_enabled = false`, `postback_include_payout = false`, `postback_first_purchase_only = false`, env `PARTNER_POSTBACKS_DELIVERY_ENABLED` unset ⇒ nothing leaves the system.
- Unknown extras stay **ignored** (stored in `raw` only, no warning). pml's 202 response for a key with no whitelist must stay byte-identical.
- Limits: ≤10 fields per key; field name `^[a-z][a-z0-9_]{0,39}$`; value scalar (string/number/boolean) stringified, ≤256 chars; ≤2048 bytes of `partner_data` per lead. A name may not equal a built-in field key/alias (`canonicalFieldKey(name) !== null`) nor a system placeholder.
- Fires only on `event_types.is_purchase AND conversion_events.status = 'approved'`, only for drip-journey-attributed sales, only for ledger rows with `created_at >= postback_active_since`, regardless of journey state. No reversal postbacks.
- Idempotency: `UNIQUE (partner_key_id, conversion_event_id) WHERE NOT is_test`; first-only mode additionally requires no non-test row for the same `drip_journey_id`.
- Delivery: GET, `https:` on port 443 only, private/reserved addresses refused via the probe's `safeLookup`, redirects not followed, 5 s timeout, retry delays `[1m, 5m, 30m, 2h, 6h, 24h]` (max 7 attempts), then `failed` + one latched Telegram alert per key. At-least-once.
- Never imported from the send path (`lib/sends/**`, `lib/drip/send-one.ts`, `lib/drip/scheduler.ts`, `lib/drip/followups.ts`).
- Every new API route goes into `lib/authz/route-map.ts` (`null` = hidden from operators) and `npm run check:authz` passes.
- Docs are part of done (CLAUDE.md "Documentation maintenance"); `docs/CHANGELOG.md` is CRLF.

## Review Focus

1. A partner sends a whitelisted name in another case or as a number (`"List_ID": 123`) — expected: matched case-insensitively, stored as `"123"`. Pinned in Task 2.
2. The same phone twice in one minute with a different `relay_lead_id` — expected: the first row's `partner_data` wins and the second is reported `duplicate`. Pinned in Task 3.
3. A postback URL that redirects, is `http:`, uses a non-443 port, or resolves to a private address — expected: refused at save (scheme/port) or recorded as a non-retried failure (redirect/blocked address), never a retry storm. Pinned in Tasks 5 and 6.
4. The owner switches a key's postbacks off while retries are pending — expected: those rows become `cancelled` on their next claim and nothing more is sent. Pinned in Task 8.
5. A template with an uppercase or misspelt placeholder (`{Relay_Lead_ID}`, `{relay_lead}`) or a literal brace — expected: save refused naming the placeholder; a `{payout}` with the payout toggle off is refused too. Pinned in Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `db/migrations/0228_partner_postbacks.sql` (+ snapshot, journal) | all schema for PR1+PR2 |
| `lib/intake/passthrough.ts` | limits, name validation, `extractPassthrough` (pure) |
| `lib/intake/{partner-key,capture}.ts`, `app/api/intake/leads/[token]/route.ts`, `lib/drip/enrichment.ts` | intake + enrichment wiring |
| `lib/partners/postbacks/template.ts` | placeholders, config validation, render, mask (pure) |
| `lib/partners/postbacks/http.ts` | `sendPostback`, `classifyResponse`, `nextAttemptDelayMs` |
| `lib/partners/postbacks/enqueue.ts` | ledger → queue |
| `lib/partners/postbacks/deliver.ts` | claim, send, record, alert |
| `app/api/cron/partner-postbacks/route.ts` | delivery cron |
| `app/api/partner-keys/[keyId]/postback-test/route.ts`, `…/postbacks/route.ts` | test-fire, log |
| `components/settings/partner-key-passthrough.tsx`, `partner-key-postback.tsx` | UI sections on the key card |

---

# PR 1 — schema + passthrough capture

### Task 1: Migration 0228

**Files:**
- Create: `db/migrations/0228_partner_postbacks.sql`, `db/migrations/meta/0228_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts` (`partner_keys` ~L5265, `lead_inbox` ~L5353, `lead_events` ~L5478, new `partner_postbacks` after `lead_events`)
- Test: `scripts/test-partner-postbacks-schema.ts`

**Interfaces:**
- Produces: columns `partner_keys.{passthrough_fields jsonb NOT NULL DEFAULT '[]', postback_enabled boolean NOT NULL DEFAULT false, postback_url_template text, postback_include_payout boolean NOT NULL DEFAULT false, postback_first_purchase_only boolean NOT NULL DEFAULT false, postback_event_keys text[] NOT NULL DEFAULT '{purchase}', postback_active_since timestamptz}`; `lead_inbox.partner_data jsonb`, `lead_events.partner_data jsonb`; table `partner_postbacks`; Drizzle export `partner_postbacks`, type `PartnerPostback`.

`partner_postbacks` columns: `id bigserial PK`, `org_id uuid NOT NULL → organizations CASCADE`, `partner_key_id integer NOT NULL → partner_keys RESTRICT`, `conversion_event_id bigint → conversion_events RESTRICT` (NULL only for tests), `drip_journey_id uuid → drip_journeys SET NULL`, `lead_event_id uuid → lead_events SET NULL`, `is_test boolean NOT NULL DEFAULT false`, `payload jsonb NOT NULL`, `status text NOT NULL DEFAULT 'pending'`, `attempts integer NOT NULL DEFAULT 0`, `next_attempt_at timestamptz NOT NULL DEFAULT now()`, `last_attempt_at`, `delivered_at`, `last_response_code integer`, `last_error text`, `last_url_masked text`, `created_at timestamptz NOT NULL DEFAULT now()`.

- [ ] **Step 1: Write the failing schema test** (`requirePreviewDb()` second import, one rolled-back transaction, fixture via `createPartnerWithKey`). Checks:
  - `M1` the 7 key columns exist with the defaults above; a fresh key reads `passthrough_fields = []`, `postback_enabled = false`, `postback_event_keys = {purchase}`.
  - `M2` CHECK `partner_keys_passthrough_fields_check`: `jsonb_typeof = 'array' AND jsonb_array_length <= 10` — an 11-element array ⇒ `23514`.
  - `M3` CHECK `partner_keys_postback_event_keys_check`: `postback_event_keys <@ '{purchase}' AND cardinality >= 1` — `'{registration}'` ⇒ `23514`.
  - `M4` CHECK `partner_keys_postback_enabled_needs_template_check`: enabled with NULL template ⇒ `23514`; template longer than 2048 ⇒ `23514`.
  - `M5` duplicate non-test `(partner_key_id, conversion_event_id)` ⇒ `23505`; two `is_test` rows with NULL conversion ⇒ OK.
  - `M6` `status` CHECK accepts exactly `pending, delivered, failed, cancelled`.
  - `M7` RLS enabled on `partner_postbacks`.
- [ ] **Step 2:** Run `node scripts/with-preview-env.mjs npx tsx scripts/test-partner-postbacks-schema.ts` — expected FAIL on M1 (column missing).
- [ ] **Step 3: Write the migration.** First statement `SET LOCAL lock_timeout = '5s';` (it leads the batch; `lead_inbox` is written by live intake). Indexes: `partner_postbacks_key_conversion_uniq` (above, partial `WHERE NOT is_test`), `partner_postbacks_due_idx (next_attempt_at) WHERE status = 'pending'`, `partner_postbacks_key_created_idx (partner_key_id, created_at DESC)`, `partner_postbacks_journey_idx (drip_journey_id) WHERE NOT is_test`. RLS: copy the org-scoped SELECT policy shape from `0156_lead_events.sql`; no write policies (server-only writes). Snapshot cloned from 0227 with new id/prevId; journal `idx 224`, `when` = `1796342400000` or, if prod's newest applied is later at merge time, the next +86400000 above it (the skip preflight refuses otherwise). Mirror everything in `db/schema.ts`.
- [ ] **Step 4:** `npm run db:migrate` **against the preview DB only** (`node scripts/with-preview-env.mjs npm run db:migrate`), then `npx tsx scripts/verify-migration-integrity.ts` on preview, then rerun the test — expected `M1`–`M7` PASS.
- [ ] **Step 5:** `npx tsc --noEmit` clean; commit `feat(partner-postbacks): migration 0228 — passthrough + postback schema (inert)`.

### Task 2: Passthrough extraction (pure)

**Files:**
- Create: `lib/intake/passthrough.ts`
- Test: `scripts/test-intake-passthrough.ts`

**Interfaces:**
- Consumes: `canonicalFieldKey` (`lib/intake/fields.ts`), `SYSTEM_PLACEHOLDERS` (Task 5 — define it in `passthrough.ts` now and re-export from `template.ts`, so PR1 has no PR2 dependency).
- Produces:
  - `PASSTHROUGH_LIMITS = { maxFields: 10, maxNameLength: 40, maxValueLength: 256, maxTotalBytes: 2048 } as const`
  - `PASSTHROUGH_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/`
  - `SYSTEM_PLACEHOLDERS = ["status", "event", "conversion_id", "occurred_at", "currency", "payout"] as const`
  - `passthroughNamesError(names: string[]): string | null`
  - `extractPassthrough(raw: Record<string, unknown>, names: readonly string[]): { data: Record<string, string> | null; warnings: string[] }`

- [ ] **Step 1: Write the failing tests:**
  - `P1` `extractPassthrough({ List_ID: 123, relay_lead_id: "abc" }, ["list_id","relay_lead_id"])` ⇒ `data {list_id:"123", relay_lead_id:"abc"}`, `warnings []`.
  - `P2` unknown extras ignored: `{ reference_id: "x" }` with `[]` ⇒ `{ data: null, warnings: [] }`.
  - `P3` `null`/`""`/absent ⇒ field omitted, no warning; every field absent ⇒ `data null`.
  - `P4` object/array value ⇒ omitted, warning `"list_id: value must be a string, number or boolean"`.
  - `P5` 257-char value ⇒ omitted, warning `"list_id: value longer than 256 characters"`; 256 chars kept.
  - `P6` total bytes over 2048 ⇒ fields kept in whitelist order until the next would exceed; each dropped one warns `"<name>: dropped, partner data over 2048 bytes"`.
  - `P7` `true` ⇒ `"true"`; `0` ⇒ `"0"`.
  - `P8` `passthroughNamesError`: 11 names ⇒ `"At most 10 passthrough fields"`; `"List"` ⇒ invalid-name error; `"zip"` and `"zip_code"` ⇒ `"zip_code is already a built-in field"`; `"payout"` ⇒ `"payout is a reserved placeholder name"`; duplicate names ⇒ error; `["list_id","relay_lead_id"]` ⇒ `null`.
- [ ] **Step 2:** `npx tsx scripts/test-intake-passthrough.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement.** Incoming keys match a name when `key.trim().toLowerCase() === name`; first match wins (same rule as `extractLeadFields`). Byte length via `Buffer.byteLength` of `JSON.stringify(data)`.
- [ ] **Step 4:** Rerun — all PASS.
- [ ] **Step 5:** Commit `feat(intake): passthrough field extraction`.

### Task 3: Intake + enrichment wiring

**Files:**
- Modify: `lib/intake/partner-key.ts` (`ResolvedPartnerKey` + SELECT gain `passthrough_fields: string[]`), `lib/intake/capture.ts` (`PreparedLead` gains `partner_data: Record<string,string> | null` and `warnings: string[]`; `prepareLead`'s key `Pick` gains `"passthrough_fields"` — required, per §11b; INSERT writes `partner_data`), `app/api/intake/leads/[token]/route.ts` (per-lead `warnings` only when non-empty), `lib/drip/enrichment.ts` (claim SELECT reads `li.partner_data`; `INSERT INTO lead_events` writes it), `lib/validators/partner-keys.ts` (`passthrough_fields: z.array(z.string()).superRefine(passthroughNamesError)` in `shared`, optional), `app/api/partner-keys/route.ts` + `[keyId]/route.ts` (return + persist the column)
- Test: `scripts/test-intake-passthrough-db.ts`

**Interfaces:**
- Consumes: `extractPassthrough`, `passthroughNamesError` (Task 2).
- Produces: `lead_events.partner_data` populated for every lead arriving on a key with a whitelist — Task 7 reads it.

- [ ] **Step 1: Write the failing DB test** (preview, rolled back, calls `prepareLead` → `captureLeads` → `runEnrichmentBatch`-equivalent path on fixture rows; follow `scripts/test-intake-schema.ts`):
  - `I1` key `["list_id","relay_lead_id"]`, lead `{phone, list_id:"L1", relay_lead_id:"R1", reference_id:"x"}` ⇒ `lead_inbox.partner_data = {list_id:"L1", relay_lead_id:"R1"}`, `raw` still has `reference_id`.
  - `I2` after enrichment, `lead_events.partner_data` equals the inbox value.
  - `I3` same phone, same minute, `relay_lead_id:"R2"` ⇒ `duplicate: true`, stored data still `R1` (Review Focus 2).
  - `I4` whitelisted value too long ⇒ lead `received`, response entry carries `warnings: ["list_id: value longer than 256 characters"]`.
  - `I5` key with `[]` ⇒ `partner_data` NULL, and every lead entry in the route's 202 JSON for a 2-lead batch has keys exactly `["id","status","duplicate"]` (plus `error` only on a rejected lead) — no `warnings` key.
  - `I6` PATCH body `passthrough_fields: ["zip"]` ⇒ 400 naming the built-in field (route-level, via the validator).
  - `I7` rejected lead (bad phone) still stores `partner_data`.
- [ ] **Step 2:** Run `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-intake-passthrough-db.ts` — expected FAIL.
- [ ] **Step 3: Implement** the modifications listed under Files.
- [ ] **Step 4:** Rerun — PASS. Also rerun `scripts/test-intake-schema.ts` (must stay green). `scripts/test-drip-enrichment-schema.ts` was red before this branch (card 869ff2atj): run it, confirm its failures are unchanged.
- [ ] **Step 5:** Commit `feat(intake): capture whitelisted passthrough fields onto the lead`.

### Task 4: Passthrough UI + PR1 docs

**Files:**
- Create: `components/settings/partner-key-passthrough.tsx`
- Modify: `components/settings/partner-key-card.tsx` (render the section), `docs/03-data-model.md` (+ ERD), `docs/04-features/partner-lead-intake.md`, `docs/04-features/drip-lead-enrichment.md`, `docs/CHANGELOG.md`

- [ ] **Step 1:** Section "Passthrough fields": chip input (Enter/comma adds, × removes), live validation via `passthroughNamesError`, counter `n / 10`, save via existing key PATCH; edit gated on `can(role, "partner_keys.manage")`. Under it a read-only **"Copy partner instructions"** block (with `<CopyableId>`-style copy button) listing: the field names, the limits in words, "unknown fields are ignored", and an example JSON lead built from `exampleLead()` plus `"<name>": "example"` for each field.
- [ ] **Step 2:** Visual check on the preview deployment (Playwright recipe in memory `reference_playwright_visual_check_recipe`), on a **fixture key**, never pml's.
- [ ] **Step 3:** Docs updated; "last updated" dates bumped.
- [ ] **Step 4:** `npx tsc --noEmit`, lint changed files, `npm run check:docs`, `npm run check:guards` — all green.
- [ ] **Step 5:** Commit; open **PR1**.

**🛑 PR1 GATE (owner):** report preview results, then on "go": apply 0228 on prod in a window (pending list must be exactly 0228), verify by query (columns/defaults/CHECKs/table/RLS), `verify-migration-integrity`, merge, deploy, then inert proof: `SELECT count(*) FROM partner_keys WHERE passthrough_fields <> '[]' OR postback_enabled` = 0, `SELECT count(*) FROM partner_postbacks` = 0, one fresh pml lead's 202 has no `warnings` and `partner_data IS NULL`.

---

# PR 2 — postbacks

### Task 5: Template (pure)

**Files:**
- Create: `lib/partners/postbacks/template.ts`
- Test: `scripts/test-postback-template.ts`

**Interfaces:**
- Produces:
  - `interface PostbackPayload { event: "purchase"; status: string; conversion_id: string; occurred_at: string; currency: string | null; payout: string | null; fields: Record<string, string> }`
  - `postbackConfigError(c: { template: string; passthroughFields: readonly string[]; includePayout: boolean }): string | null`
  - `renderPostbackUrl(template: string, p: PostbackPayload, includePayout: boolean): string`
  - `maskUrl(url: string): string`
  - `samplePayload(passthroughFields: readonly string[]): PostbackPayload` — `fields[name] = "test_" + name`, `status "approved"`, `conversion_id "test-" + randomUUID()`, `payout "0.00"`, `currency "USD"`, `occurred_at` now ISO.

- [ ] **Step 1: Write the failing tests:**
  - `T1` render `https://p.example/pb?rid={relay_lead_id}&s={status}&c={conversion_id}` ⇒ values URL-encoded (`"a b&c"` ⇒ `a%20b%26c`).
  - `T2` missing field value ⇒ empty string.
  - `T3` `{payout}` renders `""` when `includePayout` false, the value when true.
  - `T4` `postbackConfigError`: `http://…` ⇒ `"Postback URL must use https"`; `https://h:8443/…` ⇒ port 443 error; `{Relay_Lead_ID}` ⇒ `"Unknown placeholder {Relay_Lead_ID}"`; `{relay_lead}` ⇒ unknown; a lone `{` ⇒ `"Unbalanced { in template"`; `{payout}` with includePayout false ⇒ `"{payout} needs “Include payout” switched on"`; userinfo `https://u:p@h/` ⇒ refused; > 2048 chars ⇒ refused; valid template ⇒ `null`.
  - `T5` `maskUrl("https://h/pb?token=abc&rid=1&api_key=z&sig=q")` ⇒ `https://h/pb?token=***&rid=1&api_key=***&sig=***` (names matching `/token|key|secret|sig|auth|pass/i`).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (placeholder regex `/\{([^{}]*)\}/g`; valid names are the key's passthrough fields + `SYSTEM_PLACEHOLDERS`, case-sensitive). **Step 4:** PASS. **Step 5:** Commit.

### Task 6: HTTP primitives

**Files:**
- Create: `lib/partners/postbacks/http.ts`
- Modify: `lib/brand-landing-probe.ts` (export `safeLookup` and `BlockedAddressError`; no behaviour change)
- Test: `scripts/test-postback-http.ts`

**Interfaces:**
- Produces:
  - `RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000] as const`; `MAX_ATTEMPTS = 7`
  - `type SendResult = { status: number | null; error: string | null; blocked: boolean; durationMs: number }`
  - `sendPostback(url: string, timeoutMs = 5000): Promise<SendResult>` — `https.request` GET with `lookup: safeLookup`, header `user-agent: CampaignManager-Postback/1.0`, body discarded, redirects not followed.
  - `classifyResponse(r: SendResult): "delivered" | "retry" | "fail"` — 2xx delivered; null status (timeout/network) retry unless `blocked`; 408/429/5xx retry; 3xx and other 4xx fail; `blocked` fail.
  - `nextAttemptDelayMs(attemptsSoFar: number): number | null` — `RETRY_DELAYS_MS[attemptsSoFar - 1] ?? null`.
- [ ] **Step 1: Failing tests:** `H1` classify table (200, 204 delivered; 301, 302, 400, 404 fail; 408, 429, 500, 503 retry; `{status:null, blocked:false}` retry; `{status:null, blocked:true}` fail). `H2` `nextAttemptDelayMs(1) = 60000`, `(6) = 86400000`, `(7) = null`. `H3` `sendPostback("https://127.0.0.1.nip.io/")`-style host resolving to loopback ⇒ `blocked: true` (use a hostname that resolves to 127.0.0.1; if DNS is unavailable in CI, assert via `isBlockedAddress("127.0.0.1")` and mark the live probe SKIP).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit.

### Task 7: Enqueue from the ledger

**Files:**
- Create: `lib/partners/postbacks/enqueue.ts`
- Modify: `lib/drip/monitors.ts` (call after `sweepJourneyLifecycle()`, `.catch` logged and swallowed; add `postbacksQueued` to `DripMonitorResult`)
- Test: `scripts/test-postback-enqueue-db.ts`

**Interfaces:**
- Consumes: `lead_events.partner_data` (Task 3), `partner_postbacks` (Task 1).
- Produces: `enqueuePartnerPostbacks(dbc: Executor): Promise<{ queued: number }>`.

One `INSERT INTO partner_postbacks (…) SELECT … ON CONFLICT DO NOTHING RETURNING id`, across orgs, with every join org-matched:
`conversion_events ce JOIN event_types et ON et.id = ce.event_type_id AND et.is_purchase` — `ce.status = 'approved'`, `ce.created_at > now() - interval '30 days'`; journey `j` on `(org_id, campaign_id, contact_id)` with `ce.occurred_at >= j.routed_at` and the **same NOT EXISTS next-journey anchor as `reclassifyCompletedJourneysOnPurchase`** (copy it, with a comment pointing at that function); `lead_events le ON le.id = j.lead_event_id`; `partner_keys k ON k.id = le.partner_key_id AND k.postback_enabled AND 'purchase' = ANY(k.postback_event_keys) AND ce.created_at >= k.postback_active_since`; no journey-state predicate. First-only: `AND (NOT k.postback_first_purchase_only OR (NOT EXISTS (SELECT 1 FROM partner_postbacks p WHERE p.drip_journey_id = j.id AND NOT p.is_test) AND ce.id = (earliest approved purchase of j by occurred_at, id)))`. Payload: `jsonb_build_object('event','purchase','status',ce.status,'conversion_id',ce.id::text,'occurred_at',to_char(ce.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'currency',ce.currency,'payout',ce.revenue::text,'fields',coalesce(le.partner_data,'{}'::jsonb))` — cast every param explicitly (memory: untyped `jsonb_build_object` params 500'd uploads).

- [ ] **Step 1: Failing DB tests** (preview, rolled back; fixture org/partner/key/campaign/journeys/ledger rows built in the test; key enabled with `postback_active_since = now() - 1h`). Each case runs `sweepJourneyLifecycle`-equivalent close/reclassify calls where named, then `enqueuePartnerPostbacks` **twice**:
  - `E1` live journey closed `converted` ⇒ exactly 1 row, payload `fields` = the lead's partner_data.
  - `E2` journey `completed`, purchase lands later, `reclassifyCompletedJourneysOnPurchase` runs, enqueue twice ⇒ exactly 1 row.
  - `E3` journey `opted_out` with an approved purchase ⇒ 1 row.
  - `E4` ledger row `pending` ⇒ 0; updated in place to `approved` ⇒ 1; updated again (revenue change) ⇒ still 1.
  - `E5` two approved purchases on one journey ⇒ 2 rows (every-purchase); with `postback_first_purchase_only` ⇒ 1 row, the earlier `occurred_at`; a third purchase later ⇒ still 1.
  - `E6` re-entry: contact's journey 2 on the same campaign, sale after journey 2's `routed_at` ⇒ row carries journey 2's `lead_event_id` and its `relay_lead_id`.
  - `E7` not fired: ledger `created_at` before `postback_active_since`; registration event type; upsell type (`counts_revenue`, not `is_purchase`); sale on a non-drip campaign; key `postback_enabled = false`; journey in another org with the same contact id.
  - `E8` `drip_posture` OFF for the org ⇒ still enqueues (enqueue does not consult posture).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement + wire into `runDripMonitors`. **Step 4:** PASS. `EXPLAIN` the INSERT on preview; record the plan in the PR body. **Step 5:** Commit.

### Task 8: Delivery runner + cron

**Files:**
- Create: `lib/partners/postbacks/deliver.ts`, `app/api/cron/partner-postbacks/route.ts`
- Modify: `vercel.json` (`{"path": "/api/cron/partner-postbacks", "schedule": "*/5 * * * *"}`), `.env.example` (`PARTNER_POSTBACKS_DELIVERY_ENABLED=`), `lib/authz/route-map.ts` if cron routes are listed there (the coverage test decides)
- Test: `scripts/test-postback-deliver-db.ts`

**Interfaces:**
- Consumes: Tasks 5, 6.
- Produces: `runPostbackDelivery(o?: { limit?: number; send?: (url: string) => Promise<SendResult> }): Promise<{ claimed: number; delivered: number; retried: number; failed: number; cancelled: number; skipped_kill_switch: boolean }>`; `deliveryEnabled(): boolean` (`process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED === "true"`).

Claim without holding a transaction across HTTP: `UPDATE partner_postbacks SET next_attempt_at = now() + interval '2 minutes' WHERE id IN (SELECT id FROM partner_postbacks WHERE status = 'pending' AND NOT is_test AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING …` joined to the key's current `postback_enabled`, template, `postback_include_payout`. Disabled key ⇒ `status 'cancelled'`, `last_error 'postback_disabled'`, no send. Otherwise render from the **current** template, send (concurrency 5), record `attempts + 1`, `last_*`, `last_url_masked`; delivered ⇒ `delivered_at` + `clearAlert('partner-postback-failed:<keyId>')`; retry ⇒ `next_attempt_at = now() + nextAttemptDelayMs(attempts)`, or `failed` when null; fail ⇒ `failed`. Any `failed` ⇒ `notifyOnTransition({ alertKey: 'partner-postback-failed:<keyId>', orgId, text })` naming the key, count failed in the last 24 h, and the last masked URL + code. Cron route: `CRON_SECRET` bearer like `app/api/cron/carrier-rejections/route.ts`, `withCronLease("partner-postbacks", …)`, `maxDuration = 60`, kill switch off ⇒ returns `skipped_kill_switch: true` and touches nothing.

- [ ] **Step 1: Failing DB tests** (fake `send`):
  - `D1` 200 ⇒ `delivered`, attempts 1, `delivered_at` set.
  - `D2` 500 ⇒ pending, attempts 1, `next_attempt_at ≈ now()+60 s`; six more 500s ⇒ `failed` after attempt 7, alert row `firing`.
  - `D3` 404 ⇒ `failed` immediately; 302 ⇒ `failed`; `blocked` ⇒ `failed`.
  - `D4` key disabled while pending ⇒ `cancelled`, `send` never called (Review Focus 4).
  - `D5` kill switch off ⇒ `send` never called, rows unchanged.
  - `D6` two `runPostbackDelivery` calls in parallel over 20 due rows ⇒ `send` called exactly 20 times total.
  - `D7` template edited between attempts ⇒ attempt 2 uses the new URL.
  - `D8` `last_url_masked` never contains the raw value of a `token=` param.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit.

### Task 9: Key config API, test-fire, log

**Files:**
- Modify: `lib/validators/partner-keys.ts` (`shared` gains `postback_enabled: z.boolean()`, `postback_url_template: z.string().trim().max(2048).nullable()`, `postback_include_payout: z.boolean()`, `postback_first_purchase_only: z.boolean()`, `postback_event_keys: z.array(z.enum(["purchase"])).min(1)` — all `.optional()`), `app/api/partner-keys/[keyId]/route.ts` (PATCH validates the **merged** row with `postbackConfigError`; enabling needs a template; `false→true` sets `postback_active_since = now()`, `true→false` sets NULL; GET returns the new columns), `lib/authz/route-map.ts`
- Create: `app/api/partner-keys/[keyId]/postback-test/route.ts` (POST), `app/api/partner-keys/[keyId]/postbacks/route.ts` (GET `?failed=1`)
- Test: `scripts/test-partner-postbacks-api.ts` (preview API test pattern, `--conditions=react-server`)

- [ ] **Step 1: Failing tests:**
  - `A1` PATCH `{postback_enabled:true}` with no template ⇒ 400; with a valid template ⇒ 200, `postback_active_since` set; PATCH `false` ⇒ NULL; re-enable ⇒ a newer timestamp.
  - `A2` PATCH template containing `{payout}` while `postback_include_payout` false ⇒ 400 with the Task 5 message; then turning payout off on a key whose template has `{payout}` ⇒ 400.
  - `A3` PATCH template `{list_id}` where `list_id` not in passthrough_fields ⇒ 400; removing a passthrough field the template uses ⇒ 400.
  - `A4` POST postback-test route: kill switch off ⇒ 409 `{error:"Postback delivery is switched off"}`; a second call within 10 s of a test row ⇒ 429. The send itself is tested on the function the route calls — `sendTestPostback(dbc, { orgId, keyId }, send = sendPostback): Promise<{ ok: boolean; status_code: number | null; url_masked: string; error: string | null }>` in `deliver.ts` — with a fake `send`: writes exactly one `is_test` row with `samplePayload` values and returns the shape above.
  - `A5` GET postbacks ⇒ last 50 rows for that key only, newest first, `last_url_masked` only (no raw URL field in the JSON); `?failed=1` filters.
  - `A6` an `operator` and a `manager` get 403 on all three; another org's key id ⇒ 404.
- [ ] **Step 2–4:** fail → implement → pass. `npm run check:authz` green. **Step 5:** Commit.

### Task 10: Postback UI, source guard, PR2 docs

**Files:**
- Create: `components/settings/partner-key-postback.tsx`, `scripts/test-postback-send-path-guard.ts`
- Modify: `components/settings/partner-key-card.tsx`, `package.json` (`check:guards` += the new guard), `docs/04-features/partner-postbacks.md` (new), `docs/05-flows.md` (sequence: ledger → enqueue → delivery → partner), `docs/06-integrations.md` (outbound postbacks + env var), `docs/07-conventions.md` (idempotency rule, at-least-once, never from the send path), `docs/03-data-model.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: Guard test** — fails if any file under `lib/sends/`, `lib/drip/send-one.ts`, `lib/drip/scheduler.ts`, `lib/drip/followups.ts` imports `lib/partners/postbacks/*` (comments stripped before matching). Run it against a temp file that does import ⇒ red; remove ⇒ green.
- [ ] **Step 2: UI** "Sales postback" section: enable switch; "Fires on: Purchase (approved)" read-only; "Count" radio — "Every purchase" / "First purchase per journey only"; template `<Textarea>` with clickable placeholder chips (system + this key's fields) and inline `postbackConfigError`; "Include payout" switch with helper "Sends our revenue for the sale — same sensitivity as the report revenue toggle."; **Send test** button showing code + masked URL inline. "Postback log" table: time (`formatCampaignDateTime`), test/live, conversion id, masked URL, code, attempts, status, "Failed only" toggle. Read via `useApiCall` (depend on `.execute`, not the hook object).
- [ ] **Step 3:** Visual check on the preview deployment with a fixture key; test-fire to a request-bin URL **only with the owner's OK** (it is outbound to a third party).
- [ ] **Step 4:** tsc, lint changed files, `check:docs`, `check:guards`, `check:authz` green. **Step 5:** Commit; open **PR2**.

**🛑 PR2 GATE (owner):** no migration (0228 shipped in PR1). On "go": merge, deploy, confirm the cron returns `skipped_kill_switch: true`, `partner_postbacks` count 0. **Go-live is a separate owner step:** set `PARTNER_POSTBACKS_DELIVERY_ENABLED=true` in Vercel + redeploy → configure the partner's key → Send test to their URL → enable → watch the log through the first real sale.

---

# PR 3 — public docs

### Task 11: Generic mechanism on `/docs/partner-api`

**Files:**
- Modify: `lib/intake/api-contract.ts` (new exports `PASSTHROUGH_DOC` and `POSTBACK_DOC`, built from `PASSTHROUGH_LIMITS`, `SYSTEM_PLACEHOLDERS`, `RETRY_DELAYS_MS`; `API_CHANGELOG` entry dated the merge day; response codes unchanged; the 202 example gains a `warnings` note), `app/docs/partner-api/page.tsx` (two sections, elements carry `data-placeholder="…"`), `docs/partners/lead-intake.md` (regenerated by `scripts/generate-partner-docs.ts`), `scripts/test-partner-docs-drift.ts`

- [ ] **Step 1: Drift assertions:** placeholders on the page (`data-placeholder`) == `SYSTEM_PLACEHOLDERS` sorted; the page text contains `10`, `256`, `2048`; the retry schedule rendered from `RETRY_DELAYS_MS`; the strings "unknown fields are ignored", "at least once", "conversion_id"; and the page contains **no** per-key value (no `list_id` / `relay_lead_id` literal). Run ⇒ FAIL.
- [ ] **Step 2:** Implement; regenerate the markdown. **Step 3:** `npm run check:docs` green. **Step 4:** Commit; open **PR3**.

**🛑 PR3 GATE (owner):** merge on "go"; smoke `/docs/partner-api` on prod.

---

## Follow-up (not in this plan)

Regular-campaign sales to partner-sourced contacts (including drip leads who later buy through a regular campaign) — tied to the partner-group-attribution workstream (`partner_send_attributions`).
