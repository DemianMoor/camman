# Drip Campaigns — Phase 0 Recon (findings)

_Card: [869ency4b](https://app.clickup.com/t/869ency4b) · Date: 2026-08-21 · Status: **recon complete, awaiting approval**_

**Nothing was changed.** No code, no migrations, no branches, no extensions enabled. This
document plus a card comment is the entire output of Phase 0.

## 0. Method — what these findings were run against

| Thing | Value |
|---|---|
| Deployed code | `origin/main` @ `aec9b8c`, read via `git show origin/main:<path>` |
| Local checkout | `feat/segment-rule-sent-from-phone` @ `b4549dd` — **124 files behind `origin/main`**, so every code claim below is quoted from `origin/main`, not the working tree |
| Database | Supabase project `rtdarhkkjwcetlmruftl` ("camman", eu-central-1, PG 17.6). Confirmed as the live one: `.env.local` `NEXT_PUBLIC_SUPABASE_URL` and the pooler user `postgres.rtdarhkkjwcetlmruftl` both point here. A second project `camman-v2` (`fdzxzxayhknywvmrhjcj`, created 2026-08-14) exists and is **not** what the app talks to. |
| Live queries | Supabase MCP `execute_sql` against that project, 2026-08-21 ~18:20–18:40 UTC |

Every number below is dated. Re-measure before building on any of it.

---

## Q1 — pg_cron / pgmq availability, and the real 1-minute scheduler

### pg_cron and pgmq are AVAILABLE but NOT INSTALLED

```sql
select name, default_version, installed_version from pg_available_extensions
where name in ('pg_cron','pgmq','pg_net','http');
```

| extension | default_version | installed_version |
|---|---|---|
| `pg_cron` | 1.6.4 | **null** |
| `pgmq` | 1.5.1 | **null** |
| `pg_net` | 0.20.0 | **null** |
| `http` | 1.6 | **null** |

`to_regnamespace('cron')`, `to_regnamespace('pgmq')` and `to_regnamespace('net')` all return
NULL. The **entire** installed set is `plpgsql`, `pg_stat_statements`, `uuid-ossp`, `pgcrypto`,
`supabase_vault`, `pg_trgm`. So enabling pg_cron is a `CREATE EXTENSION` — a migration, therefore
a human-approval gate — not a plan upgrade.

### …but we should NOT use pg_cron, because a 1-minute Vercel cron is already in production

`origin/main:vercel.json` carries **20** cron entries, and one of them is:

```json
{ "path": "/api/cron/refresh-contact-stats", "schedule": "* * * * *" }
```

Proof it actually fires, not merely that it is declared:

```sql
select updated_at from contact_org_stats;   -- 2026-08-21T18:21:23.903+00
```

…read at ~18:23 UTC. `contact_org_stats` is written **only** by
`app/api/cron/refresh-contact-stats/route.ts` (`refreshContactOrgStats`, migration 0145), so a
~2-minute-old timestamp is direct evidence that minute-granularity cron is live on this project.

**Recommendation: use a Vercel cron at `* * * * *`, not pg_cron.** Reasons, in order:

1. It is *already proven on this project*, today, by a route that has been running.
2. pg_cron can only run SQL. To reach the Next.js send path it would need `pg_net` or `http` —
   **two more** un-installed extensions, an outbound HTTP call from inside the primary database,
   and a second secret-handling surface. Three new pieces of infrastructure to replace one line
   of JSON.
3. Every existing operational control — `cron_locks` leasing, `CRON_SECRET` auth, Telegram
   alerting, `maxDuration`, Vercel's own failure reporting — is already wired for the HTTP-route
   shape and would have to be re-created inside Postgres.
4. Cron count goes 20 → 21. Vercel Pro's limit is 40.

The spec's stated **1–2 minute reaction** target is met by a 1-minute cron alone; the "webhook
wake-up" is a latency optimisation, not a requirement, and can be deferred to Phase 5.

**pgmq is not needed.** The `lead_inbox` table the spec already describes *is* the queue, and the
codebase has a proven pattern for exactly this (see Q7). Adding pgmq would mean a second queue
technology alongside `lookup_queue`, `carrier_classify_queue` and `stage_sends` — all plain
tables drained with `FOR UPDATE SKIP LOCKED`.

### cron_locks — how the heartbeat is actually wired

Table (`db/migrations/0103_cron_locks.sql`), org-less infra, RLS on with **no** policies:

```sql
cron_locks(job_name text PK, lease_until timestamptz, skipped_count int,
           last_skipped_at timestamptz, watermark timestamptz)
```

Two distinct uses of the same row, and they must not be confused:

- **`lease_until` = the single-runner lease.** `withKeyedLease()` in
  [lib/cron/keyed-lease.ts](../../../lib/cron/keyed-lease.ts) claims it with one
  `INSERT … ON CONFLICT DO UPDATE … WHERE lease_until IS NULL OR lease_until < now() RETURNING`.
  One statement ⇒ concurrent claimants can never both win. Released in a `finally` with a CAS on
  the exact token, so a run that overran never clears its successor's lease. Expiry is absolute —
  a killed run self-clears with no heartbeat and no manual cleanup. Deliberately **not** a
  Postgres advisory lock: those are unsafe through the transaction pooler (`:6543`,
  `prepare=false`), where a backend reassignment between statements can lose or strand them.
  `withCronLease()` ([lib/cron/lease.ts](../../../lib/cron/lease.ts)) is the job-wide wrapper;
  `CRON_LEASE_MS = 4 min`.
- **`watermark` = the dead-man heartbeat.** `recordHeartbeat(dbc, jobName)` stamps `now()`;
  `checkHeartbeats()` reads it. The design rule in
  [lib/reporting/cron-heartbeat.ts](../../../lib/reporting/cron-heartbeat.ts) is explicit and
  load-bearing: **a job must never check its own heartbeat** — "a job that is dead cannot report
  itself dead" — so jobs are paired and each watches another. `HEARTBEAT_JOBS` currently pairs
  the weekly EPC monitors with the daily clickers rebuild, plus the offer-report refresh and the
  counted-clickers rebuild. A NULL watermark counts as **stale**, not healthy.

Live state (2026-08-21 18:23 UTC), 25 rows. Healthy watermarks: `propagate-clickers` 18:03,
`counted-clickers-incremental` 18:20, `tells-sweep` 18:17, `tells-monitors` 17:23.
`textrequest-poll` held a live lease (`lease_until` 18:23:44, `skipped_count` 2).
`report-rollup`'s watermark is 2026-07-30 — that cron is retired, table kept.

### Telegram — how alerts are wired

[lib/alerts/telegram.ts](../../../lib/alerts/telegram.ts), config `TELEGRAM_BOT_TOKEN` +
`TELEGRAM_CHAT_ID`; unset ⇒ silent no-op. Two functions with **opposite** contracts:

- `notifyTelegram(text)` — **best-effort, never throws, never rejects.** Missing token, network
  error, 4s timeout, non-200 — all swallowed and logged. Used by everything on the send path. The
  contract exists so an alert failure can never break the drain it is watching.
- `sendTelegramHtml(text, timeoutMs)` — **throws** on any failure, so the hourly report cron can
  return 500 and flap red. `parse_mode: "HTML"`; callers must `escapeHtml()` dynamic substrings.

Drip's alerts (backlog growth, lookup top-up, all-numbers-exhausted, daily cap ≥90%, dead-man
tick) should all use `notifyTelegram`. Note there is **no alert dedup/suppression layer** — every
call sends a message. A per-minute scheduler alerting on a standing condition will spam the
channel unless it gates on a state transition. See R10.

---

## Q2 — Can the send function be invoked for a single contact? **No.**

### There is no single-contact send path anywhere in the app

The send function is `runStageDrain(dbc, { stageId, … })` in
[lib/sends/drain.ts](../../../lib/sends/drain.ts) (759 lines). Its **unit of work is a
`stage_id`**, and it operates exclusively on `stage_sends` rows that already exist in status
`pending`:

```sql
UPDATE stage_sends SET status='sending'
WHERE id IN (SELECT id FROM stage_sends
             WHERE stage_id = $1 AND status='pending'
             ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $2)
RETURNING id, phone, rendered_text, lead_id, contact_id
```

It never enumerates an audience, never renders text and never accepts a contact. Rows are put
there by `kickoffStageSend()` ([lib/sends/kickoff.ts](../../../lib/sends/kickoff.ts)).

Searches for a test/one-off send surface turned up only
`components/providers/provider-credentials-section.tsx` → `/credentials/test` and
`/credentials/[id]/test-connection`, which are credential validators.
`/api/providers/[providerId]/api-send` is a **config toggle** for `supports_api_send`, not a send.

The only genuinely single-recipient thing is the adapter itself —
`getAdapter(key).send({ apiKey, text, recipientE164, senderNumber, leadId, statusCallbackUrl, metadata })`
([lib/sends/providers/types.ts](../../../lib/sends/providers/types.ts)). **Calling it directly
bypasses every gate listed below.** Drip must not do that.

### Where each compliance step lives

| Step | Lives in | Runs at | Keyed on |
|---|---|---|---|
| `send_approved` (per stage) | `runStageDrain` | drain, once | `campaign_stages.send_approved` |
| `SEND_ENABLED` env backstop | `runStageDrain` | drain, re-read per batch | env |
| `org_settings.sends_enabled` | `runStageDrain` | drain, **fresh read per batch** ⇒ true mid-run kill | org |
| `org_settings.sends_paused` | `runStageDrain` | drain, fresh read per batch | org |
| `sms_providers.send_paused` (breaker latch) | `runStageDrain` → `isProviderPaused` | drain, per batch | provider |
| `sms_providers.sends_enabled` (operator posture) | `runStageDrain` → `isProviderSendsEnabled` | drain, per batch | provider |
| `campaigns.send_paused` (per-campaign latch) | `runStageDrain` → `isCampaignPaused` | drain, per batch | campaign |
| **Opt-out suppression (send-time)** | **`runStageDrain`** | **drain, per claimed batch** | `opt_outs.contact_id`, **org-wide** |
| **1-hour dedup by phone** | **`runStageDrain`** | **drain, per claimed batch** | `stage_sends.phone`, **org-wide, cross-campaign** |
| Pacing caps: per-run / per-minute / per-24h | `runStageDrain` → `circuit-breakers.ts` | drain, per batch | **provider** |
| Per-second rate (carrier MPS) | `runStageDrain` | drain, paced parallel slices | **`provider_phones.max_sends_per_second`** |
| Failure-spike breaker (10 consecutive) | `runStageDrain` → `latchPause` | drain, folded in claimed order | provider |
| Carrier daily cap (Q5 work) | `runStageDrain` → `findCarrierCapBreaches` | drain, batch boundary, **soft** | (provider_phone, carrier_norm), ET calendar day |
| Credential resolution | `runStageDrain` → `resolveKeyForStage` | drain, once | (org, provider, brand, phone) |
| `send_attempts` evidence row | `runStageDrain` | drain, one per attempt | — |
| — | — | — | — |
| **Opt-out footer / stop_text** | **`kickoffStageSend`** | **materialisation** | `resolveOptOutFooter` chain |
| **Opt-out-language compliance gate** | **`kickoffStageSend`** | materialisation | validates the **winner**, fails closed |
| **Segment / audience gate** | **`stageRecipientsSql`** | materialisation | `campaign_audience_pool` ∩ live `opt_outs` ∩ toggles ∩ split |
| **Creative dedup (layers 1+2)** | **`buildStageEligibilityExclusions`** | materialisation | `creative_exposures`, in-flight `stage_sends` |
| **Offer dedup (layer 3)** | same | materialisation | `offer_exposures` |
| **Carrier allow-list** | **`carrierPolicyClause`** | **materialisation** | (provider_phone, carrier_norm), anti-join |
| Segment-count ceiling (`MAX_SEGMENTS`) | `kickoffStageSend` | materialisation | rendered text |
| Landline backstop | `enumerateStageRecipients` | materialisation | `contacts.messaging_status` |
| Link minting | `kickoffStageSend` → `mintLinksBatch` | materialisation | per recipient |
| **Quiet hours (8am–9pm ET)** | **`decideScheduledSend`** | **scheduler, NOT the drain** | `sms_providers.send_window_*` |

### What drip would have to re-implement — and the decisive conclusion

**If drip writes `stage_sends` rows against a real `campaign_stages` row, it re-implements almost
nothing. If it does not, it re-implements everything — and silently loses attribution too.** Four
independent pieces of evidence force this:

1. **Exposure ledgers are DB triggers on `stage_sends`.** Verified live:
   ```
   stage_sends_after_sent_insert  AFTER INSERT ... WHEN (new.status='sent')  → record_exposure_on_sent()
   stage_sends_after_sent_update  AFTER UPDATE OF status ... WHEN (new.status='sent'
                                   AND old.status IS DISTINCT FROM 'sent')   → record_exposure_on_sent()
   ```
   These populate `creative_exposures` and `offer_exposures`. "Already got this offer" and
   creative dedup — which the spec explicitly wants to keep — **only** exist as a side effect of a
   `stage_sends` row reaching `'sent'`. Migration 0086 names the blind spot outright: "pure
   external-CSV sends create no stage_sends rows and so leave no exposure trace."
2. **Keitaro attribution is keyed on `stage_sends.id`.** Both `lib/keitaro/poll-offer-reaches.ts`
   and `lib/keitaro/poll-conversions.ts` map `sub_id_1 → stage_sends.id`. No `stage_sends` row ⇒
   no offer-reach and no purchase ⇒ drip's Offer and Purchase behavioural triggers cannot fire and
   the journey can never end on purchase.
3. **Opt-out attribution and the opt-out-rate breaker join through `stage_sends`.**
   `opt_out_attributions` FKs to `stage_sends.id` and `campaign_stages.id`
   (`db/migrations/0075_optout_attribution.sql`); `poll-opt-outs.ts` finds the anchoring send with
   a window query over `stage_sends_org_phone_sent_idx (org_id, phone, sent_at)`.
4. **The behavioural tier model already exists and reads `stage_sends`.**
   [lib/campaign-tier.ts](../../../lib/campaign-tier.ts) `campaignTierExpr(campaignId, orgId)`
   returns `(contact_id, tier)` with **exactly** the four states the drip spec asks for:
   `0 ignored · 1 clicked · 2 reached_offer · 3 converted`. High-water, live-computed,
   campaign-scoped, absence = tier 0. Phase 6 is largely a consumer of this, not a new build.

**Therefore: drip does NOT reuse `campaign_audience_pool` (correct — that is the frozen pool), but
it MUST reuse `campaign_stages` + `stage_sends`.** Those are different things and the spec
conflates them. See Spec Gap **G1**.

What drip must still build even on that basis:

- **Quiet hours.** `decideScheduledSend` / `nextWindowOpenAtOrAfter` are pure functions in
  [lib/quiet-hours.ts](../../../lib/quiet-hours.ts) and directly reusable — but their *caller* is
  the existing scheduler, so the drip scheduler must call them itself.
  `nextWindowOpenAtOrAfter` already implements "outside sending hours → next opening" including
  crossing midnight: exactly the spec's rule, already written. Note the documented v1 limitation —
  the window is **sender-zone (ET), not recipient-zone**.
- **Per-recipient text rendering.** `kickoffStageSend` renders **one** body for the whole stage and
  freezes it into every row ("rendered text is recipient-invariant WITHIN a stage"). Drip is
  one-lead-at-a-time by nature, so it needs a per-lead render + mint path. `buildStageSms` and
  `resolveOptOutFooter` are pure and reusable; the enumeration wrapper is not.
- **Number rotation by per-number daily limit.** No equivalent exists. The nearest thing is the
  per-carrier daily cap, which is a *stop*, not a *rotate*.

---

## Q3 — Data model, and whether a 1:1 `contact_attributes` fits

### `contacts` is remarkably narrow — the 1:1 table fits cleanly, with room to spare

Live columns of `public.contacts` — **the whole table**:

```
id uuid PK · org_id uuid · phone_number text · is_archived bool · archived_at
created_at · updated_at · line_type text ('unknown') · carrier_norm text ('Unidentified')
messaging_status text ('eligible')
```

There is **no name, no email, no address, no demographic field of any kind**. Nothing in the
spec's intake list (First/Last Name, Address, State, Country, Email, Gender, Income, Kids,
Married, DOB, Interest Tag, Partner Slug) collides with an existing column. A 1:1
`contact_attributes(contact_id PK → contacts.id)` is a clean additive fit with zero migration risk
to existing reads.

Two constraints that shape intake:

- `contacts_org_id_phone_number_unique UNIQUE (org_id, phone_number)` — makes the spec's
  "duplicate number with new data → update existing contact" a plain
  `INSERT … ON CONFLICT (org_id, phone_number) DO UPDATE`.
- Trigger `contacts_messaging_status_trg BEFORE INSERT OR UPDATE OF line_type, messaging_status`
  runs `contacts_derive_messaging_status()`:
  ```sql
  NEW.messaging_status := CASE WHEN NEW.line_type='landline' THEN 'not_applicable' ELSE 'eligible' END;
  ```
  So `messaging_status` is **derived, not settable** — a landline is automatically excluded from
  sends even if saved. That gives drip a safe alternative to the spec's "landline: NOT saved":
  saving it with `line_type='landline'` is already inert for sending *and* preserves the number so
  the same lead is not looked up again next time. See **G4**.

The rest of the model:

- **Contact groups** — `contact_groups` + `contact_contact_groups(contact_id, contact_group_id)`
  PK; many-to-many, org-scoped. 14 active groups live. The "drip contact group" is just another
  row; an idempotent bulk-apply endpoint (`POST /api/contacts/bulk-apply-groups`,
  `ON CONFLICT DO NOTHING`) already exists.
- **Segments** — UNION-with-manual-membership (Model C, CLAUDE.md §10e). Rules are evaluated as
  SQL **set arithmetic** (`UNION`/`INTERSECT`/`EXCEPT`), not boolean predicates, deliberately —
  `c.id IN (sub1) OR c.id IN (sub2)` seq-scans a 800K-row contacts table.
  `lib/validators/segment-rule-types.ts` is the single validation source. Adding
  `contact_attributes` as rule types means registering each **set-shaped** value in **four**
  places (`RULE_TYPES`, `validateValueByShape`, `isRuleComplete`, `verifyValueOwnership`) — the
  known trap that shipped `phone_type`/`carrier` uncreatable.
- **Phone numbers** — `provider_phones`: `brand_id` (nullable), `max_sends_per_second`,
  `cost_per_sms`, `credential_id`, `short_domain_id`, `opt_out_footer`, `allow_unknown_carrier`,
  `number_type`. **37 active numbers, and all 37 already have `brand_id` set** — so the
  brand→number pre-work is a query/UI change, not a data backfill. Confirmed that
  `/api/provider-phones/list` does **not** currently select or filter `brand_id` at all.
- **Brands** — `brands`: `brand_id` (business id), `name`, `short_link_base`, `website`.
  `short_domains` are brand-scoped, and `kickoffStageSend` already picks the short domain
  `WHERE brand_id = <campaign's brand> AND status='active'`.
- **Carrier filters** — two layers that AND together and are deliberately different things:
  *campaign-level*, frozen into `campaign_audience_pool` at activation ("who the campaign is
  for"), and *per-number* `carrierPolicyClause`
  ([lib/sends/carrier-policy.ts](../../../lib/sends/carrier-policy.ts)), evaluated live at
  materialisation ("what this number may carry"). **Absent row = ALLOWED** — an anti-join over
  `phone_carrier_limits`, never a membership test. The carrier vocabulary is a closed set —
  `AT&T, T-Mobile, Verizon, Other Mobile, VoIP, Unknown` — with `Unknown`/`Unmapped`/`Unidentified`
  governed together by `provider_phones.allow_unknown_carrier`.
- **"Contacts in use"** — a contact present in `campaign_audience_pool` for a campaign with
  `status='active'`. Two flags: `segments.exclude_in_use_contacts` (default false) and
  `campaigns.exclude_in_use_contacts` (default **true**). **Drip has no `campaign_audience_pool`,
  so drip leads are invisible to this in both directions.** → **G2**.
- **"Already got this offer"** — `offer_exposures UNIQUE (org_id, contact_id, offer_id)`, written
  by the `stage_sends` trigger. Org-scoped and deliberately spans brands. Enforced twice: frozen
  into the pool at activation, then re-applied live at materialisation as a safety net.

---

## Q4 — Keitaro: how "reached offer" and "purchased" surface, and with what delay

Both are **per-`stage_sends`-row stamps**, discovered by polling, keyed on `sub_id_1`.

| Signal | Column(s) | Source | Poll route | Cron | Window |
|---|---|---|---|---|---|
| Reached offer | `offer_reached_at`, `offer_reach_event_id` | Keitaro `clicks/log`, campaign name ≠ `gk-lp-visits` | `/api/keitaro/poll-offer-reaches` | `12,27,42,57 * * * *` (**15 min**) | 7 days |
| Purchased | `sale_status`, `sale_revenue`, `converted_at`, `sale_event_id` | Keitaro `conversions/log` | `/api/keitaro/poll-conversions` | `9,24,39,54 * * * *` (**15 min**) | 7 days |
| Clicked | `clicks` ⋈ `links` | `/r/[code]` redirect (real time) | `/api/clicks/score-pending` | `3,18,33,48 * * * *` (**15 min**) | — |

**Purchase detection uses `purchasedClause()`, not `sale_status='sale'`.**
[lib/sale-attribution.ts](../../../lib/sale-attribution.ts) is the single source of truth:
`sale_status IN ('lead','sale')`. This account's network fires **`lead`**-status postbacks for
paid conversions and effectively never sends `sale` — a `='sale'` test found 2 buyers where the
truth was ~835. `rejected` is deliberately *not* a purchase (refund/chargeback/fraud screen).
**Drip's "journey ends on purchase" MUST call `purchasedClause()`**; anything else re-creates a
bug that was fixed two days ago.

Offer-reach is **monotonic** — once stamped, never changed or cleared. Sales are **latest-wins**
(a `lead → sale → rejected` progression always reflects the most recent event).

### Delay — two different delays; do not conflate them

`offer_reached_at` and `converted_at` are stamped from **Keitaro's own event `datetime`**, not
from poll time (`SET offer_reached_at = (v.dt || ' ' || 'America/New_York')::timestamptz`). So:

- **Recipient behaviour delay** (send → event), measured over the last 30 days:

  | signal | n | p50 | p90 | p99 |
  |---|---|---|---|---|
  | offer reach | 5,367 | **146 min** | 2,051 min (34h) | 17,687 min (12d) |
  | conversion | 477 | **219 min** | 3,310 min (55h) | 15,706 min (11d) |

- **Detection delay** (event → visible to us) = Keitaro ingestion lag + **up to 15 min** of poll
  cadence. `poll-conversions.ts` notes the network postback can trail "sometimes a day".

**Consequence for the spec:** the "Offer (reached sales page), default 30m" trigger will fire
*before* the median recipient has reached the offer at all — and even when someone has, we may not
know for another 15 minutes. The trigger is still coherent if read as "30m after we *detected* the
reach", but the Ignored lane must not treat a not-yet-polled reach as an absence. → **G5**.

### Existing behavioural events we can hook

`campaignTierExpr` (see Q2, point 4) already unions the three positive signals into a monotonic
high-water tier per contact per campaign, and defines "clean click" identically to the click
report (`classification NOT IN ('bot','prefetch','suspect')`). Opt-out is the fourth signal and
lives in `opt_outs` + `opt_out_attributions`. There is **no** generic per-contact event log —
`lead_events` in the spec would be new, and is worth building for partner reporting, but must not
become a *second* source of truth for the behavioural tiers.

---

## Q5 — Telnyx lookup: cache, cost, gate, current spend

Live `lookup_settings` (single row, read 2026-08-21):

| setting | value |
|---|---|
| `lookup_paused` | `false` |
| `lookup_daily_cap` | **150,000** |
| `lookup_rate_base` | **$0.0015** |
| `lookup_rate_mobile` | **$0** (no surcharge configured) |
| `lookup_concurrency_rps` | 30 |
| `carrier_resolver_v2` | **true** (earlier project notes say this flag is off — that is stale) |
| `carrier_ai_run_cap` | 200 |

Volume: `phone_lookups` holds **807,013** rows (742,311 mobile / 46,154 landline / 10,022 voip /
8,526 unknown). In the last 21 days there was exactly **one** active day — 2026-08-10, 39,568
lookups. Current run-rate is bursty and near zero.

**Cache: global, keyed on E.164 phone, and it never expires.** `enqueueNormalized`
([lib/telnyx/enqueue.ts](../../../lib/telnyx/enqueue.ts)) skips any phone with a `phone_lookups`
row where `lookup_status='complete'` — with **no recency predicate at all**. It also skips phones
already `pending` in any batch, so double-enqueue is impossible. The spec says "skip numbers
looked up recently"; the code says "skip numbers looked up *ever*". → **G4**.

**Cost accounting** ([lib/telnyx/cost.ts](../../../lib/telnyx/cost.ts)): estimate =
`count × base + count × mobileShare × mobile` (`DEFAULT_MOBILE_SHARE = 0.35`); actual =
`total × base + mobileCount × mobile`. The **ledger truth** is neither of those — it is the Telnyx
balance delta, `lookup_batches.balance_before_usd − balance_after_usd`, snapshotted per batch by
the worker. Partner reporting should quote the ledger, not the estimate.

**Projected drip cost at current rates** (base only, since the mobile surcharge is 0), worst case
of zero cache hits:

| leads/day | $/day | $/month (30d) |
|---|---|---|
| 10,000 | **$15.00** | $450 |
| 25,000 | $37.50 | $1,125 |
| 50,000 | **$75.00** | $2,250 |

Cache hits reduce this; repeat leads across partners could reduce it substantially.

**Guards that exist** ([lib/telnyx/worker.ts](../../../lib/telnyx/worker.ts)), in order:

1. Single-runner row lease (pooler-safe).
2. `lookup_paused` → stop.
3. Daily cap → `countAttemptsToday()` **sums `lookup_queue.attempts`** (so a number that 429s
   twice then succeeds consumes 3, not 1) since **Warsaw** local midnight
   (`LOOKUP_TIMEZONE = 'Europe/Warsaw'` — note: *not* ET, unlike everything else in the system).
4. Balance check → `notifyTelegram` + stop on error.

**The balance guard is far too weak for drip, and this is the most concrete gap in Q5:**

```ts
const nextChunk = Math.min(rps, remaining, pending);     // ≤ 30
const needed = nextChunk * (rates.base + rates.mobile);   // 30 × $0.0015 = $0.045
if (bal.availableCredit < needed) { …alert…; return finish("balance_low"); }
```

It only requires covering the **next 30 lookups — about 4.5 cents.** The "top up" Telegram
therefore fires only when the account is essentially at zero, by which point the drip pipeline has
already stalled. The spec asks for a warning based on "a formula from last week's lookup spend";
**that does not exist and must be built.** → **G6**.

Also: `lookup_daily_cap = 150,000` is **account-global and shared** with uploads, group/matched
targeted lookups and CSV updates. A 50K/day drip consumes a third of it silently. Drip needs its
own sub-budget, or at minimum an alert when drip's share crosses a threshold.

---

## Q6 — Breaker keying, and whether a low-volume continuous drip arms or false-trips them

### Per-provider breaker

Latch is `sms_providers.send_paused` (+ `send_paused_reason`, `send_paused_at`, and a
`send_circuit_events` audit row). Keyed **per provider**, ANDed with the per-campaign latch.
Trips on:

- **Failure spike** — `FAILURE_SPIKE_THRESHOLD = 10` *consecutive* failures within one invocation.
  HARD: latches, requires manual resume, fires Telegram.
- **Pacing tripwire** — structurally impossible under correct code; latches if it ever happens.

Soft stops (leave rows pending, no latch): `rate_minute` (default 100/min), `rate_24h` (default
10,000/24h), `carrier_daily_cap`, `outside_send_window`, `org_disabled`, `org_paused`,
`provider_sends_disabled`. All counted **per provider** via
`stage_sends ⋈ campaign_stages.sms_provider_id`.

**Verdict for drip: the soft ceilings are the real risk, not the latch.** A drip campaign sharing
a provider with a 100K-message blast contributes to the *same* `rate_24h` counter. At current
volumes (77,000 sends on 2026-08-20 alone) a provider's 24h ceiling is the binding constraint, and
drip rows sitting `pending` behind a blast is exactly the head-of-line problem PR #19 fixed for
stages. The failure-spike latch is **not** a false-trip risk for low volume — it needs 10
consecutive failures, and a drip trickling 1–5 messages a minute will rarely stack 10 in one
invocation.

### Opt-out-rate breaker

[lib/sends/optout-rate-breaker.ts](../../../lib/sends/optout-rate-breaker.ts). **The rate is
judged on the attributed STAGE; the latch is applied to the CAMPAIGN.** Cohort-aligned: numerator
and denominator both bucket by `stage_sends.sent_at`, never by the STOP's arrival time (bucketing
by receipt time caused the 2026-07-25 false trips). Only the attributed stage is evaluated — a
STOP credits exactly one stage, so no other stage's numerator moved.

Defaults (env-overridable; **no `OPTOUT_RATE_*` overrides are set in `.env.local`**, so these are
the live values):

| window | threshold | min_sends |
|---|---|---|
| long `24h` | **10%** | **200** |
| short `2h` | **8%** | **200** |

Calibrated 2026-07-26 against 318 stages with ≥200 sends: 24h cohort p95 7.19% / p99 8.03% / max
8.41%; 2h cohort p95 5.23% / p99 5.92% / max 6.12%. Each threshold sits above the observed maximum,
so a healthy stage cannot trip.

**Would a low-volume continuous drip arm or false-trip it? Two answers, both important:**

1. **It will very often not arm at all.** `decideOptOutRateBreaker` returns `evaluated: false`
   unless a window clears its own `min_sends = 200` floor. A drip stage sending ~300/day spread
   over a 13-hour window puts ~46 messages in any 2h window and 300 in 24h — so the 2h window
   **never** evaluates and the 24h window only just does. A genuinely toxic drip creative could
   run for a long time under the radar. **This is the argument for the spec's own per-campaign
   daily monitor:** it is not redundant with the existing breaker, it covers exactly the regime
   the existing breaker deliberately refuses to judge.
2. **When it does arm, it will not false-trip *because of* low volume — but it can trip violently
   on a small denominator.** At exactly 200 sends, 20 STOPs trips the 24h window. Because drip
   stages are long-lived and accumulate sends slowly, the rolling denominator moves slowly while
   STOPs from that cohort keep arriving. The aligned-cohort design protects against the worst
   version of this, but a drip stage is a much less homogeneous cohort than a blast — it mixes
   leads from many partners, tags and days. **Recommendation: give drip stages their own
   `min_sends` floor, and judge the drip monitor per campaign-day as the spec proposes rather than
   per stage.**

**Threshold conflict:** the spec sets drip's monitor at **≥7% warn / ≥10% auto-stop**, while the
existing breaker is **10% (24h) / 8% (2h)**. Two systems, two numbers, both able to pause the same
campaign, and the spec's 10% auto-stop coincides exactly with the existing 24h threshold. → **G7**.

---

## Q7 — Existing webhook/API endpoints: patterns to reuse for partner intake

### The auth + capture pattern is already proven and should be copied wholesale

Seven provider webhooks exist, all shaped the same way
(`app/api/webhooks/{ahoi,tells,texthub,textrequest}/…/[token]/route.ts`). The Tells inbound route
is the most complete reference. Its sequence:

1. **Opaque path token** → resolve a credential row. Unresolved ⇒ 401. Crucially, the alert on an
   unresolved token fires **only when the payload is provider-shaped** (`looksLikeTellsPayload`),
   so scanners do not page anyone.
2. **Second factor** — a payload key compared with `safeEqual` (constant time) against the stored
   credential. Failure is an *auth* failure: nothing is persisted, nothing processed.
3. **Redact before persist.** `redactTellsKeyFromBody` replaces the key's value before the row is
   written, so a live credential is never replicated into backups/exports. Validate → redact →
   persist, in that order, and the raw value never leaves the function.
4. **One committed INSERT** carrying a **dedup key**, then return.
5. **Best-effort inline processing** in a try/catch that cannot fail the request; on failure the
   row stays with `processed_at IS NULL` and a **sweeper retries it**. As the comment puts it:
   "the STOP is already durably ours, so we never needed their ack."

Steps 4–5 are *exactly* the spec's `lead_inbox` + enrichment-worker architecture. Build intake as
a fifth instance of this pattern rather than inventing a new one.

**Cron auth pattern** (for the drip scheduler): `CRON_SECRET` as
`Authorization: Bearer <secret>`, returning 503 when the secret is unset (never fail-open);
`refresh-contact-stats` also accepts `x-cron-secret`. The manual drain route uses a **dual-auth
pure decision function** — `decideDrainAuth({ bearerMatches, sessionRole })` — kept pure
specifically so "no gap between the two paths" is testable (401 with neither, 403 when
under-privileged, never fall through to allow). Reuse it.

### Two gaps that block the spec's stated intake requirements

- **Rate limiting does not work in serverless.** The only limiter is
  [lib/api/rate-limit.ts](../../../lib/api/rate-limit.ts) — an **in-memory** token bucket, used by
  exactly one route (`/api/spam/score`), and its own header says so:
  > "In a serverless deployment this only enforces per-instance — Vercel spreads requests across
  > cold/warm instances so the effective rate is instance_count * limit… real protection requires
  > shared state."

  The spec's per-partner **10 req/s + 50K/day** cannot be enforced with this. It needs a DB-backed
  counter (a `partner_key_usage(partner_key_id, window_start)` row with an atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` — the same shape `campaign_tracking_counters`
  already uses to allocate sequence numbers race-free) or an external store. → **G8**.
- **No payload-size limit anywhere.** Grep found no `content-length`, `bodySizeLimit` or
  `MAX_BODY` check in any route. Next.js App Router route handlers have no default body cap (that
  was the Pages Router's `bodyParser`); the only ceiling is Vercel's platform limit (~4.5 MB). The
  spec's "max payload size" must be an explicit `Content-Length` check before `req.text()`.

---

## Q8 — Risk register: every place the spec touches the live send path

Live-send blast radius today: **~50K–105K messages/day** (`stage_sends` sent 2026-08-12→08-21:
104,079 / 106,174 / 94,133 / 58,773 / 49,338 / 55,220 / 71,672 / 47,481; 292,256 in the last 7
days; 3,471,367 rows lifetime). Drip at 10–50K leads/day is a **20–100% increase in send volume.**
This is not a small feature bolted onto a quiet system.

| # | Risk | Where it touches live | Isolation |
|---|---|---|---|
| R1 | **Editing `runStageDrain` to serve drip** breaks every regular campaign at once | `lib/sends/drain.ts` — the single choke point for all sending | **Do not modify it.** Drip creates `stage_sends` rows and lets the *existing* drain send them. If drip needs different pacing, add a *new caller*, never a new branch inside the drain. |
| R2 | **Shared provider ceilings** — drip volume consumes `rate_minute` / `rate_24h` / `max_sends_per_run`, starving or being starved by blasts | `countSentSince(org, provider, …)` is per-provider and counts *all* sends | Give drip its **own provider phones**, not merely its own campaign, for the initial partner. Volume then accrues to a provider account whose ceilings only drip uses. |
| R3 | **A drip failure-spike latches the shared provider** and stops regular campaigns | `latchPause(providerId)` is provider-wide, HARD, manual resume | Same mitigation as R2. The campaign-level latch (`campaigns.send_paused`) is the right lever for drip-specific stops — it is already per-campaign. |
| R4 | **Two opt-out monitors racing on one campaign** (existing breaker 10%/8% vs drip monitor 7%/10%) | both write `campaigns.send_paused` | One writer. Make the drip monitor *warn only* above the existing breaker's floor and let the existing breaker own the latch. See G7. |
| R5 | **Per-minute scheduler = 60 invocations/hour of DB load** on a pooler with a ~15-connection ceiling | `db/client.ts` globalThis singleton, transaction pooler `:6543` | Lease-gate the drip tick with `withCronLease('drip-scheduler')` **as the first statement**, before any query. Keep the tick's work bounded, `maxDuration = 60`. Precedent: `textrequest-poll` already holds a lease ~3 min and self-heals. |
| R6 | **Bypassing the adapter's gates** by calling `getAdapter().send()` directly for speed | `lib/sends/providers/*` | Forbidden. Anything that sends must go through `runStageDrain`. Add a source-level guard asserting no caller outside `drain.ts` invokes an adapter `.send(`. |
| R7 | **New `stage_sends` write volume degrades the 1-hour dedup and send-time opt-out checks**, which run `IN (…)` over the claimed batch, per batch | `drain.ts`; indexes `stage_sends_org_phone_sent_idx`, `stage_sends_active_contact_uniq` | Measure before Phase 5. `stage_sends` is already 3.47M rows; drip adds ~15M/year at 50K/day. Partitioning or retention becomes a real question — flag it now rather than discover it. |
| R8 | **Telnyx daily-cap exhaustion by drip** stops carrier enrichment for regular uploads too | `lookup_settings.lookup_daily_cap` is account-global | Per-source sub-budget + alert. See G6. |
| R9 | **Enabling `pg_cron`** puts a scheduler inside the primary DB with no rollback story | `CREATE EXTENSION` on prod | Avoid entirely — use the Vercel 1-min cron that is already proven. |
| R10 | **Alert flooding.** `notifyTelegram` has no dedup; a per-minute scheduler alerting on a standing condition sends 1,440 messages/day | `lib/alerts/telegram.ts` | Every drip alert must gate on a state *transition* or a `cron_locks.watermark`-style last-alerted timestamp. |
| R11 | **Feature flags are compile-time.** `ENTITY_AVAILABILITY` in `lib/feature-flags.ts` is a `const` — flipping it needs a redeploy, so it cannot "ship dark and enable later" | `lib/feature-flags.ts` | Drip needs a **runtime** flag. `org_settings` is the established place (it already holds `sends_enabled` / `sends_paused` with actor + timestamp columns). Keep capability / posture / latch as three separate flags, per the provider-connections precedent. |
| R12 | ~~**Pre-existing red guards.** The Supabase security advisor is **already** reporting 2 ERRORs on clean `main`: `contact_org_stats` and `campaign_circuit_events` have RLS disabled in `public`~~ | `get_advisors type=security` | ✅ **CLOSED 2026-08-21** — migration 0146 (PR #108, merged `c9ae3ea`), applied to production. Advisor ERRORs now **0**. "Advisor is clean" is a usable gate again. |
| **R13** | **G7 changes a LIVE compliance path.** Skipping the stage-level opt-out breaker for drip means `checkOptOutRateBreaker` must become campaign-type-aware — and it is called from **every** opt-out ingester (`poll-opt-outs.ts` + each provider webhook), all live and compliance-critical. A mistake here silently removes opt-out protection from real campaigns. | `lib/sends/optout-rate-breaker.ts` and all its callers | **The guard must fail toward the EXISTING behaviour: a campaign whose `type` is NULL, unknown, or unreadable is treated as `'regular'` and keeps the existing breaker. Never the reverse.** A drip-typed campaign is the only thing that may skip it, and only on a positive, successful read. Entry gate on **Phase 5**; assert both directions with a test that proves a regular campaign still trips. |
| **R14** | **G2 changes the LIVE campaign activation path.** Extending "in use" to UNION active drip journeys means editing `lib/audience-snapshot.ts`, which every regular campaign activation runs through. That file has documented planner sensitivity and has regressed twice: the `ON COMMIT DROP` temp table + `ANALYZE` is load-bearing (>180s → ~8.5s), and the prior-offer exclusion had to be split out of the qualifier to avoid a nested loop (67.5s → 4.2s). A new UNION branch on the in-use set is exactly that shape. | `lib/audience-snapshot.ts` | Additive **by construction**: with zero drip journeys the UNION'd set is empty and both the emitted plan and the resulting pool must be byte-identical to today — verify it, do not assume it. **Activation-time `EXPLAIN` before-vs-after on a real regular campaign is the Phase 4 EXIT gate.** |
| **R15** | **G7 adds a fourth time semantics to the send path.** The system already carries rolling-seconds windows (`rate_minute`/`rate_24h`), `sent_at`-cohort windows (the stage-level opt-out breaker), ET calendar days (carrier caps), and Warsaw calendar days (the Telnyx lookup cap). The drip monitor adds a fifth usage (ET day, per campaign). All correct, all different; reporting one as another sends an operator to the wrong control. | drip opt-out monitor (Phase 5) | Use the **ET-day-as-timestamptz-RANGE** form the carrier cap uses (`date_trunc('day', now() AT TIME ZONE …) AT TIME ZONE …`), **never** a functional predicate on `sent_at` — the latter cannot use the partial indexes and turns a per-batch check into a seq scan of a 3.47M-row table. Name the window explicitly in every alert and audit string. |

Every new drip table must ship with RLS enabled — tenant tables with an
`org_id = current_org_id()` SELECT policy, server-only infra tables with **no** policies
(deny-by-default; the privileged `DATABASE_URL` connection and `service_role` bypass RLS).

---

## Spec gaps — decisions needed before Phase 1 starts

**G1 — "Drip gets its own audience tables — does NOT reuse `campaign_audience_pool`" is right
about the pool and wrong if read as "not `stage_sends`."** Four subsystems (exposure ledgers,
Keitaro offer/sale attribution, opt-out attribution, behavioural tiers) exist *only* as
consequences of a `stage_sends` row. **Proposed resolution:** drip owns `lead_inbox`,
`lead_events`, `drip_journey` and its routing tables; drip *sends* by creating one
`campaign_stages` row per drip stage and inserting `stage_sends` rows against it.
`campaign_audience_pool` stays empty for drip campaigns. **This is the single biggest
architectural decision in Phase 0 and needs your confirmation.**

**G2 — "Contacts in use" is invisible across the drip/regular boundary.** In-use is defined as
membership in an *active* campaign's `campaign_audience_pool`; drip has no pool. So a drip lead
never blocks a regular campaign and a contact in a regular campaign never blocks drip — yet the
spec says "keep existing filters: contacts in use". Options: (a) extend the in-use definition to
`UNION` drip's active journeys; (b) accept the asymmetry and document it; (c) write drip leads
into `campaign_audience_pool` after all. **Recommend (a).**

**G3 — Behavioural triggers vs. the existing tier model.** `campaignTierExpr` already implements
ignored / clicked / reached / converted, and the existing behavioural lane stages consume it. The
spec describes the same four states as if new. Confirm drip reuses `campaignTierExpr` rather than
defining a parallel model — two definitions of "clicked" is precisely how the click report and the
lanes would drift apart.

**G4 — "Skip numbers looked up recently" has no TTL in the code.** The cache is permanent
(`lookup_status='complete'`, no recency predicate). Decide: (a) keep it permanent — cheapest, and
carrier/line-type rarely changes; or (b) add a TTL, which is new behaviour and new cost. Related:
the spec says landlines are "counted for reporting, NOT saved", but *not saving* them means the
same landline is re-looked-up every time a partner resends it. Since the `contacts` trigger already
forces `messaging_status='not_applicable'` for landlines (inert for sending), saving them is both
safe and cheaper. **Recommend saving.**

**G5 — The Offer trigger's 30m default is shorter than the detection delay.** Median recipient
takes 146 min to reach the offer, and detection adds up to 15 min of poll cadence. "30m since last
activity" must mean 30m since *detection*, and the Ignored lane must not count a not-yet-polled
reach as an absence. Confirm the semantics; consider defaulting Offer to 1h.

**G6 — The Telnyx "top up" warning does not exist in any usable form.** The current gate fires at
~$0.045 of remaining balance. The spec's formula ("based on last week's lookup spend") is new work.
It also needs a drip-specific sub-budget under the shared 150,000/day account cap.

**G7 — Two opt-out thresholds on one campaign.** Spec: 7% warn / 10% auto-stop, per campaign per
day. Existing: 10% over 24h / 8% over 2h, per stage, latching the campaign. Both would write
`campaigns.send_paused`. Decide which owns the latch. **Recommend: the existing breaker owns the
latch; the drip monitor warns — and below the existing breaker's `min_sends=200` floor it is the
*only* protection, which is its real justification.**

**G8 — Per-partner rate limiting has no working implementation.** `lib/api/rate-limit.ts` is
in-memory and per-instance by its own admission. Decide: DB-backed counter (**recommended** — no
new dependency, and `campaign_tracking_counters` already proves the atomic-upsert pattern here) vs.
an external store. Also: no payload-size check exists anywhere; add an explicit `Content-Length`
guard.

**G9 — "Flag-gated" needs a runtime flag.** `ENTITY_AVAILABILITY` is compile-time. Use
`org_settings`-style columns and keep the three-flag discipline separate: *capability* (is drip
built), *posture* (is drip switched on), *latch* (did something trip). Merging posture into the
latch makes a breaker trip and a human decision indistinguishable.

**G10 — Volume.** 10–50K leads/day is a 20–100% increase over current send volume and adds ~15M
`stage_sends` rows/year at the top of that range, on a table already at 3.47M. Retention or
partitioning is a Phase 5 prerequisite, not a later optimisation.

---

## Confirmed build order

Unchanged from the card's 1–6 in **sequence**, with the following made explicit. Each phase:
recon → findings → approval → build → verify → ship, and regular campaigns re-verified after each.

**Phase 0 — Recon.** ✅ Complete (this document).

**Phase 0.5 — Clear the ground (small; do it first).** Resolve G1 and G2 (architecture decisions,
no code). Fix or explicitly accept the two pre-existing advisor ERRORs (R12) so "advisor clean" is
a usable gate. Decide the runtime-flag shape (G9). No migrations.

**Phase 1 — Pre-work (ships separately; two independent cards).**
- **1a. Brand → numbers.** Add `brand_id` to `/api/provider-phones/list` (currently not even
  selected), filter the campaign/stage pickers by the campaign's brand, and **re-check
  server-side** at stage save. Data is ready — all 37 active numbers already carry `brand_id`.
- **1b. Stage-URL ↔ brand validation.**
- **1c. `contact_attributes`** (1:1, additive — no collision with `contacts`), the CSV
  column→field mapping UI, and the segment rule types. **Register every set-shaped rule value in
  all four places** (`RULE_TYPES`, `validateValueByShape`, `isRuleComplete`,
  `verifyValueOwnership`).

**Phase 2 — Intake (zero sends).** `POST /api/intake/leads` + partner keys, modelled directly on
the Tells inbound webhook: opaque token → second factor with `safeEqual` → **redact → persist** →
single committed INSERT with a dedup key → return. Plus the DB-backed rate limiter (G8) and an
explicit `Content-Length` cap. Writes `lead_inbox` only; no lookups, no contacts, no sends.

**Phase 3 — Enrichment (zero sends).** Sweeper over `lead_inbox WHERE processed_at IS NULL` under
`withCronLease`. Normalise → Telnyx lookup via the **existing** `enqueueNormalized` +
`lookup-worker` (do not build a second lookup path) → upsert `contacts` on
`(org_id, phone_number)` → `contact_attributes` → `lead_events` → drip contact group. Ship the
top-up formula and the drip lookup sub-budget (G6) **in this phase**, not later — it is the phase
that spends the money.

**Phase 4 — Drip campaigns + routing (zero sends, assignments visible).** `campaigns.type`
(additive, default `'regular'`), drip config, priority resolution, `drip_journey` rows with
due-at. Nothing sends; the deliverable is that assignments and due-times are visible and
inspectable.

**Phase 5 — Stages + scheduler + sends (the only phase that touches live sending).** One Vercel
cron at `* * * * *` (**not** pg_cron), leased via `withCronLease('drip-scheduler')`, heartbeat into
`cron_locks.watermark`, paired dead-man check with an existing job (never self-checking). Per-lead
render + mint, then **insert `stage_sends` and let the existing `runStageDrain` send them** —
`drain.ts` is not modified. Quiet hours via the existing pure `nextWindowOpenAtOrAfter`. Number
rotation by per-number daily limit is genuinely new work. Gate behind the runtime flag, use
dedicated provider phones (R2/R3), start with one small partner.

**Phase 6 — Behavioural.** Consume `campaignTierExpr`; purchase detection **must** use
`purchasedClause()` (`sale_status IN ('lead','sale')`), never `='sale'`. Trigger timings read as
time-since-*detection* (G5).

**Phase 7 — Reporting.** Per-partner and per-partner×tag, with the lookup-cost column sourced from
the `lookup_batches` balance-delta ledger (the truth), not the rate estimate.

---

_Human approval retained for: migrations, opt-out/compliance logic, carrier pacing, provider
credentials, production data writes._

---

# Decisions (Phase 0.5) — owner rulings, 2026-08-21

Recorded verbatim from the owner's ruling. **These are final.** Where a ruling differs from this
document's earlier recommendation, the ruling wins and the recommendation above is superseded —
noted inline below rather than edited out, so the reasoning that was weighed stays visible.

| Gap | Ruling |
|---|---|
| **G1** | Drip owns `lead_inbox`, `lead_events`, `drip_journey` + routing tables. **Every drip send is a `stage_sends` row against a real `campaign_stages` row.** `campaign_audience_pool` stays empty for drip. **`drain.ts` is never modified.** |
| **G2** | Option (a) — "in use" = active `campaign_audience_pool` **UNION** active drip journeys, **both directions**. |
| **G3** | Reuse `campaignTierExpr`. **No parallel behavioural model.** |
| **G4** | Lookup cache stays **permanent** (no TTL). **Landlines are NOT saved** — counted for partner reporting at intake, then discarded. _Owner decision; the cost of re-lookup on resend is accepted._ (Supersedes this document's "recommend saving".) |
| **G5** | **All behavioural timers = time since detection.** Offer default **30m → 60m**; option list unchanged. The Ignored lane must not treat a not-yet-polled reach as absence. |
| **G6** | Build the top-up warning: alert when Telnyx balance **< 7 × average daily lookup spend over the last 7 days**, where spend is the **ledger** (`lookup_batches` balance delta), not the rate estimate. Drip gets its **own daily lookup sub-cap** under the 150K account cap. **Ships in Phase 3.** |
| **G7** | For `campaigns.type='drip'` the **drip monitor owns the latch**: per campaign per **ET day** over all sends that day, **≥7% warn, ≥10% pause + Telegram**, with an "accept risk and proceed" override that clears **only the drip latch**. The existing stage-level opt-out-rate breaker is **skipped for drip campaigns**. The per-provider breaker stays above both. **One writer of `campaigns.send_paused` per campaign type.** (Supersedes this document's "existing breaker owns the latch".) |
| **G8** | **DB-backed per-partner rate limiter** (atomic upsert counter, `campaign_tracking_counters` pattern) + explicit **`Content-Length` cap before `req.text()`**. |
| **G9** | Runtime flags in `org_settings`: **capability / posture / latch as three separate columns.** |
| **G10** | `stage_sends` retention/partitioning review is a **Phase 5 entry gate**. |

**Also ruled:**

- Drip uses **dedicated provider phones at launch** (mitigates R2/R3).
- **Webhook wake-up deferred to Phase 5.**
- **Every drip alert gates on a state transition** (mitigates R10).
- **Every new table ships with RLS** — tenant tables get an `org_id = public.current_org_id()`
  policy; infra tables (no `org_id`) get RLS enabled with **no** policies.

## Consequences of these rulings that were not in the original risk register

Three of the rulings create work on files that are **live for regular campaigns today**. The
"nothing existing breaks" rule still holds — but it holds by *design discipline*, not by
avoidance, so these are named here rather than discovered later.

**Accepted by the owner 2026-08-21 and promoted into the risk register as R13 (C1), R14 (C2) and
R15 (C3)**, with R13's fail-safe direction stated normatively. They are also carried on the
relevant phase cards as entry/exit gates: R13 + R15 on Phase 5, R14 on Phase 4.

**C1 — G7 requires a change to the live opt-out ingest path.** `drain.ts` is untouched, as ruled,
but skipping the stage-level breaker for drip means `checkOptOutRateBreaker`
([lib/sends/optout-rate-breaker.ts](../../../lib/sends/optout-rate-breaker.ts)) must become
campaign-type-aware. It is called from every opt-out ingester (`poll-opt-outs.ts` and each
provider webhook), all of which are live and compliance-critical.
**The guard must fail toward the existing behaviour:** a campaign whose `type` is NULL, unknown,
or unreadable is treated as `'regular'` and keeps the existing breaker. Never the reverse — an
unreadable type must not silently disable a campaign's opt-out protection.

**C2 — G2 requires a change to the campaign activation path.** Extending "in use" to UNION active
drip journeys means editing [lib/audience-snapshot.ts](../../../lib/audience-snapshot.ts), which
is what every regular campaign activation runs through. Two constraints:
1. **Additive by construction** — with zero drip journeys the UNION'd set is empty, so the
   emitted plan and the resulting pool must be byte-identical to today. Verify that, don't assume it.
2. **Perf must be re-measured, not reasoned about.** That file has documented planner
   sensitivity: the `ON COMMIT DROP` temp table + `ANALYZE` before the flag joins is load-bearing
   (>180s → ~8.5s), and the prior-offer exclusion had to be split out of the qualifier to avoid a
   nested loop (67.5s → 4.2s). A new UNION branch on the in-use set is exactly the shape that has
   regressed this before. Treat an activation-time `EXPLAIN` as a Phase 4 exit gate.

**C3 — G7's ET-calendar-day window is a third time semantics in the send path.** The system now
carries: rolling seconds windows (`rate_minute`/`rate_24h`), rolling seconds windows bucketed by
`sent_at` cohort (the stage-level opt-out breaker), ET calendar days (carrier caps, and now the
drip monitor), and Warsaw calendar days (the Telnyx lookup cap). These are all correct and all
different. The drip monitor must use the same ET-day-as-timestamptz-range form the carrier cap
uses (`date_trunc('day', now() AT TIME ZONE …) AT TIME ZONE …`), never a functional predicate on
`sent_at` — the latter cannot use the partial indexes and turns a per-batch check into a seq scan
of a 3.47M-row table.

## Phase 0.5 outcome — R12 closed, advisor clean (2026-08-21)

Migration **0146** (`0146_contact_org_stats_campaign_circuit_events_rls.sql`) — PR
[#108](https://github.com/DemianMoor/camman/pull/108), merged as `c9ae3ea`, applied to the
production database. Enables RLS + a SELECT-only `org_id = public.current_org_id()` policy on
`contact_org_stats` and `campaign_circuit_events`, mirroring 0085. No write policies.

Verified after applying:

| Check | Result |
|---|---|
| Advisor `rls_disabled_in_public` ERRORs | **2 → 0** (no ERROR-level lints remain at all) |
| Neither table in `rls_enabled_no_policy` INFO | ✓ — each has exactly 1 policy |
| `drizzle.__drizzle_migrations` count | 146 → **147**; newest hash `c4480fb9…` matches the locally computed hash |
| `verify-migration-integrity` | **"Migration integrity OK"** — 0146 SQL ✓ snapshot ✓ hash ✓ prevId-chain ✓ |
| RLS state | both tables `relrowsecurity = true`, 1 SELECT policy each, `qual = (org_id = current_org_id())` |
| Audit trail preserved | `campaign_circuit_events` still **8 rows**, latest `2026-07-27 12:36:20` — unchanged |
| 1-min cron still refreshing | `contact_org_stats.updated_at` advanced 19:56:23 → **19:57:23** (exactly 60s), age 27s |
| Server readers on production | `/api/contacts/base-stats` and `/api/contacts/carrier-stats` → **HTTP 200** with correct data, authenticated; **401** unauthenticated (404 on a nonexistent control, so the 401 is a real rejection) |
| Vercel production | deployment `6028310024` @ `c9ae3ea` — **success** |

**Incidental finding worth carrying forward:** `package.json` defines
`vercel-build = if [ "$VERCEL_ENV" = "preview" ]; then npm run db:migrate; fi && next build`, so
**preview deployments apply migrations automatically** — against the shared `camman-v2` preview/demo
database (`fdzxzxayhknywvmrhjcj`), per [docs/preview-environment.md](../../preview-environment.md).
Two Vercel projects (`camman` preview and `camman-v2` preview) both build every PR commit, so both
race to run `db:migrate` on that one database. On this PR the `camman-v2` build failed ~0.9s into
`db:migrate` while the `camman` build applied 0146 successfully a minute later; a redeploy of the
**identical commit** then passed, confirming contention rather than migration content. Expect this
red on any future PR that introduces a migration — and note the flip side: **a preview build is
enough to apply a migration to the shared demo database**, which the preview-environment doc already
warns can break the demo.
