# Drip Campaigns — Phase 2 Recon: intake (zero sends)

_Card: `869endkmd` (Drip P2) · parent `869ency4b` · 2026-08-22 · **RECON ONLY — no code, no migrations, no branches beyond this doc**_

Scope: `partner_keys`, `POST /api/intake/leads/[token]`, `lead_inbox`, DB-backed rate limiting,
state-transition-gated alerts, generated partner instructions. Built as a **fifth instance of the
Q7 webhook pattern** (Tells inbound), not a new pattern.

---

## 0. Method — what these findings ran against

| | |
|---|---|
| Code base | `origin/main` @ `8e501c2` (Phase 1 merged and live) |
| Database | production Supabase `rtdarhkkjwcetlmruftl`, Postgres **17.6**, `max_connections = 90` |
| Live corpus | contacts **815,426** · contact_attributes **0** · tells_webhook_events **11,765** · provider_credentials **5** · contact_groups **16** |
| Phase 2 tables | `partner_keys`, `lead_inbox`, `partner_key_usage` — **none exist** |
| Writes performed | none. The one probe ran inside a transaction that rolled back (verified `rolledBack: true`), and its script was deleted |

**⚠️ Finding before the findings: all four Drip recon docs are UNTRACKED.**
`2026-08-21-drip-campaigns-phase-0-recon.md`, `2026-08-21-drip-phase-1-prework-recon.md`,
`2026-08-22-1b-landing-pages-recon.md` and `2026-08-22-contact-attributes-migration-proposal.md`
exist only as untracked files in the shared checkout `C:\AFF\camman`. They are not on `main` and not
in any branch — a `git clean` or a fresh clone loses every ruling recorded in them, including the
G1–G10 decisions. **Recommend committing them with this phase's PR.** (This doc is written into the
worktree so it lands in the PR by default.)

---

## 1. The three questions you asked

### 1.1 Which existing credential encryption/hash helper to reuse

**There is exactly one: [lib/crypto/secret-box.ts](../../../lib/crypto/secret-box.ts).** AES-256-GCM,
blob format `v1.<b64url(iv)>.<b64url(ct)>.<b64url(tag)>`, master key from `PROVIDER_CREDENTIALS_KEY`
(must decode to 32 bytes or it throws). Used through `resolveCredentialKeyById`
([lib/sends/provider-credential.ts](../../../lib/sends/provider-credential.ts)).

**There is NO hashing helper for secrets.** The only `createHash("sha256")` calls in `lib/` are
content hashes for cache/dedup keys — `mint-link.ts:55`, `tells-webhook-shared.ts:164`,
`spam/normalize.ts:22`. `crypto.timingSafeEqual` is **not used anywhere**; the codebase has its own
hand-rolled constant-time compare, `safeEqual` in
[lib/sends/tells-webhook-shared.ts:133](../../../lib/sends/tells-webhook-shared.ts).

**Recommendation — HASH the partner secret, do not encrypt it. This deviates from "per credential
conventions" deliberately, and needs your ruling (G11).**

Provider credentials are encrypted because CamMan must **replay** them to the provider. A partner
secret is only ever **verified** — CamMan never needs the plaintext again. That makes them different
problems, and the security properties differ sharply:

| | encrypt (secret-box) | hash (SHA-256) |
|---|---|---|
| DB dump leaks | ciphertext — plaintext recoverable **if the key also leaks** | nothing usable |
| `PROVIDER_CREDENTIALS_KEY` rotated/lost | **every partner key breaks** | unaffected |
| Cost per request | decrypt + compare | one hash + compare |
| Org member reading the row over PostgREST | sees ciphertext | sees a useless digest |

**⚠️ And do NOT reach for bcrypt/argon2/scrypt here.** Slow KDFs exist to protect *low-entropy human
passwords* from offline brute force. A 256-bit machine-generated secret has nothing to stretch. At
the 50 req/s burst you asked about, bcrypt at cost 10 is ~100 ms of CPU per verification = **5 CPU-
seconds per wall-clock second**, which is a self-inflicted DoS on a function billed by CPU time.
Plain SHA-256 over a high-entropy secret is the correct construction and is microseconds.

Concretely: `secret_hash = sha256(secret)` hex, compared with the existing `safeEqual` on the two
digests (equal-length hex strings, so its length pre-check never short-circuits). Store
`secret_last4` for the UI, and show the plaintext **once** at create/rotate — never again.

### 1.2 The exact atomic-upsert shape for the limiter

The Phase 0 recon pointed at `campaign_tracking_counters`
([lib/tracking-id.ts:70-77](../../../lib/tracking-id.ts)):

```sql
INSERT INTO campaign_tracking_counters (org_id, brand_id, offer_id, date_et, next_seq)
VALUES (..., 2)
ON CONFLICT (org_id, brand_id, offer_id, date_et)
DO UPDATE SET next_seq = campaign_tracking_counters.next_seq + 1
RETURNING (next_seq - 1) AS allocated_seq
```

That shape **allocates** but does not **refuse**. Used as-is for a limiter it has a real defect: a
client hammering while already over the limit keeps incrementing the counter, so **rejected requests
burn the daily quota** — a partner that misconfigures a retry loop can lock itself out for the rest
of the ET day without ever delivering a lead.

**The correct shape adds a `WHERE` guard to the `DO UPDATE`, so refusal is atomic and free:**

```sql
INSERT INTO partner_key_usage (org_id, partner_key_id, window_kind, window_start, count)
VALUES ($org, $key, 'sec', date_trunc('second', now()), $n)
ON CONFLICT (partner_key_id, window_kind, window_start)
DO UPDATE SET count = partner_key_usage.count + $n
  WHERE partner_key_usage.count + $n <= $limit      -- ← the guard
RETURNING count
```

When the guard is false the `DO UPDATE` touches nothing and **`RETURNING` yields no row**. Zero rows
returned ⇒ over limit ⇒ 429. One statement, no read-then-write race, no quota burned on refusal.

**Measured against production, in a rolled-back transaction:**

```
limiter upsert (allow path):  23.50 ms/op incl. round trip, 200/200 allowed
limiter upsert (refuse path): returned 0 row(s) — the WHERE guard refused atomically
  counter after a refused attempt: 999 (unchanged ⇒ a rejected request does NOT burn quota)
```

Both halves proven, not assumed — the refuse path is asserted by *absence of a row* **and** by the
counter being unchanged afterwards.

⚠️ One caveat to carry into the build: the first call for a window takes the `INSERT` branch, whose
`VALUES ($n)` is **not** guarded by the `WHERE`. A single call whose batch size exceeds the limit
would be admitted as the window's first write. Guard that in the validator (`n <= rate_per_day`)
before the statement runs, or the DB check is bypassable on a cold window.

### 1.3 Load expectations at a 50 req/s burst on the pooler

**Not a concern, and the reason is worth stating precisely: the limiter's DB work is ~0; the cost is
one network round trip.**

Measured: a bare `SELECT 1` round trip is **24.1 ms** from this machine, and the full limiter upsert
is **23.50 ms** — i.e. the upsert is *within noise of an empty query*. Server-side execution is
sub-millisecond; latency is entirely the WAN hop from Poland to `eu-central-1`.

Production does not pay that hop. The project runs in **fra1**, same region as the database, where a
round trip is **~2.1 ms** (measured during the earlier region migration — it took a DB round trip
from 187 ms to 2.1 ms).

| | |
|---|---|
| Round trips per intake request | **2** — (a) resolve key, (b) one CTE doing limit + insert |
| Connection time per request in fra1 | ~4–5 ms |
| At 50 req/s | ~0.25 connection-seconds per second ⇒ **<1 connection busy** |
| Postgres `max_connections` | **90** (the "~15" in older notes is the Supavisor *session*-pooler client cap, not this) |
| Backends in use at probe time | 12 total / 1 active / 9 idle |
| Pooler | transaction mode `:6543`, `prepare=false`, `max: 5` per instance, `idle_timeout` 20 s |

**The real risk at 50 req/s is not the pooler — it is Vercel function concurrency and cold starts.**
Transaction-mode pooling releases the connection per statement, so 50 req/s spread across N warm
instances each holding ≤5 clients is trivially inside 90. What actually bites: each cold start opens
a fresh pool, and a burst that fans out across many cold instances multiplies pools. With
`idle_timeout: 20`, those drain quickly. Mitigation is the same one the drain already relies on —
keep the handler tiny (2 round trips, no inline processing), which the Q7 pattern already mandates.

---

## 2. The Q7 pattern, instantiated as the fifth instance

Reference: [app/api/webhooks/tells/inbound/[token]/route.ts](../../../app/api/webhooks/tells/inbound/[token]/route.ts).
Mapping every step, with what changes for intake:

| Q7 step (Tells inbound) | Intake equivalent | Change |
|---|---|---|
| 1. Opaque path token → credential; unresolved ⇒ 401, **alert only if payload is provider-shaped** so scanners don't page | `token` → `partner_keys` row by unique `token`; unresolved ⇒ 401, log only | **No alert on unresolved.** A public intake URL will be scanned. Alert only on *resolved token + bad secret* — that means a rotated or leaked secret, which is the alertable event |
| 2. Second factor via `safeEqual` against stored credential | `safeEqual(sha256(supplied), secret_hash)` | hash instead of decrypt (§1.1) |
| 3. **Redact before persist** | redact the secret field from `raw` before the INSERT | identical discipline; the secret must never enter `lead_inbox.raw`, backups, or exports |
| 4. One committed INSERT with a dedup key, `(xmax = 0) AS inserted` to detect duplicates | same, into `lead_inbox` | identical |
| 5. Best-effort inline processing, cannot fail the request; failure leaves `processed_at IS NULL` for a sweeper | **omitted entirely** | Phase 2 is zero-processing by definition. `status='received'` is the sweeper's queue; P3 supplies the sweeper |
| — | **new: Content-Length cap** | no equivalent exists anywhere today (§3) |
| — | **new: DB-backed rate limit** | no equivalent exists anywhere today (§3) |

`export const dynamic = "force-dynamic"` as on every webhook. No middleware exists in the repo
(`middleware.ts` is absent; the only hit is a `.next` build artifact), so auth is per-route and a
public endpoint needs no exemption — confirmed by the Tells route calling `requireApiMembership`
**zero** times.

---

## 3. Gaps confirmed — both Q7 gaps are still open, unchanged

- **Rate limiting does not work in serverless.** [lib/api/rate-limit.ts](../../../lib/api/rate-limit.ts)
  is an in-memory token bucket used by exactly one route (`/api/spam/score`); its own header says
  "this only enforces per-instance… real protection requires shared state." Unusable for a
  per-partner contract. → `partner_key_usage` (§1.2).
- **No payload-size limit anywhere.** A repo-wide grep for `content-length` / `bodySizeLimit` /
  `maxPayload` across `app/`, `lib/` and `next.config.*` returns **nothing**. App Router handlers
  have no default body cap; the only ceiling is Vercel's platform limit (~4.5 MB). Must be an
  explicit `Content-Length` check **before** `req.text()`.

**A third gap, new to this phase: there is no state-transition alert gating in the codebase.**
`notifyTelegram` fires on every call — it is best-effort and stateless by contract. No `alert_state`
table, no `last_alerted_at` column, nothing. Existing breakers avoid alert storms only as a *side
effect of latching* (`send_paused` flips true and stops further trips), which is not a reusable
mechanism. Your "state-transition gated" requirement therefore needs new state (§4, table 4).

---

## 4. Migration proposal — **STOPPING HERE FOR APPROVAL**

Next number is **0152** (0151 is the last applied). Proposed as **three migrations**, following the
1c/1b precedent of one concern per migration.

### 0152 — `partner_keys`

```
id                serial PK
org_id            uuid NOT NULL → organizations(id) ON DELETE CASCADE
partner_slug      text NOT NULL
name              text NOT NULL
token             text NOT NULL                    -- opaque path token, plaintext (mirrors provider_credentials.inbound_webhook_token)
secret_hash       text NOT NULL                    -- sha256 hex; NEVER the plaintext
secret_last4      text                             -- UI display only
interest_tag_mode text NOT NULL DEFAULT 'default'  -- CHECK IN ('force','default')
interest_tag      text
field_mapping     jsonb NOT NULL DEFAULT '{}'      -- partner field → contact_attributes field
sandbox           boolean NOT NULL DEFAULT true
rate_per_sec      integer NOT NULL DEFAULT 10      -- CHECK > 0
rate_per_day      integer NOT NULL DEFAULT 50000   -- CHECK > 0
max_payload_bytes integer NOT NULL DEFAULT 262144  -- 256 KB; CHECK BETWEEN 1024 AND 4194304
status            text NOT NULL DEFAULT 'active'   -- CHECK IN ('active','disabled')
created_at        timestamptz NOT NULL DEFAULT now()
created_by        uuid
rotated_at        timestamptz
last_seen_at      timestamptz

UNIQUE (org_id, partner_slug)
UNIQUE (token)                                     -- global: resolution needs no org
CHECK  (interest_tag_mode <> 'force' OR interest_tag IS NOT NULL)
INDEX  (org_id, status)
RLS: ENABLE + SELECT-only `org_id = public.current_org_id()`. No write policies.
```

Three choices I want to flag rather than bury:

- **`sandbox` defaults to `true`.** A key that can do real work the instant it is created is the
  wrong default for a credential handed to a third party. Promotion to live is then a deliberate act.
- **`token` is stored plaintext, `secret_hash` is not.** That is intentional and mirrors
  `inbound_webhook_token`: the token is an *addressing* value that must be looked up by equality on
  an index; the secret is the thing that authenticates. Hashing the token would make resolution a
  full scan.
- **`UNIQUE (token)` is global, not per-org.** Resolution happens before any org context exists.

### 0153 — `lead_inbox`

```
id            uuid PK DEFAULT gen_random_uuid()
org_id        uuid NOT NULL → organizations(id) ON DELETE CASCADE
partner_key_id integer NOT NULL → partner_keys(id)          -- ON DELETE RESTRICT (see below)
partner_slug  text NOT NULL                                  -- denormalized on purpose
received_at   timestamptz NOT NULL DEFAULT now()
raw           jsonb NOT NULL                                 -- secret already redacted
normalized    jsonb                                          -- NULL until Phase 3
phone_e164    text
interest_tag  text
sandbox       boolean NOT NULL DEFAULT false
status        text NOT NULL DEFAULT 'received'
              -- CHECK IN ('received','processed','rejected','landline','duplicate')
processed_at  timestamptz
error         text
dedup_key     text                                           -- NULLABLE — see below

UNIQUE INDEX lead_inbox_dedup_uniq ON (partner_key_id, dedup_key) WHERE dedup_key IS NOT NULL
INDEX (status, received_at)                                  -- the worker's queue scan
RLS: ENABLE + SELECT-only org policy.
```

**⚠️ `dedup_key` must be NULLABLE with a partial unique index — not `NOT NULL UNIQUE` as the brief
says.** The spec's key is `(partner_key_id, phone, received_minute)`, but phone is exactly the field
that can be missing or unparseable. Making the column `NOT NULL` means a malformed payload cannot be
inserted at all — the intake would **reject the leads most worth capturing**, which inverts the whole
"capture raw, decide later" design. Nullable + partial unique is the same shape
`tells_webhook_events` already uses (`ON CONFLICT (provider_id, dedup_key) WHERE dedup_key IS NOT NULL`).

`partner_slug` is denormalized deliberately: a lead's provenance must survive the key being renamed
or disabled. `ON DELETE RESTRICT` on the FK for the same reason — deleting a key with leads behind it
should fail loudly, and the UI offers *disable*, not delete (the same reasoning as no-DELETE on
landing pages in 1b).

### 0154 — `partner_key_usage` + `alert_state`

```
partner_key_usage
  org_id         uuid NOT NULL → organizations(id) ON DELETE CASCADE
  partner_key_id integer NOT NULL → partner_keys(id) ON DELETE CASCADE
  window_kind    text NOT NULL          -- CHECK IN ('sec','day','auth_fail')
  window_start   timestamptz NOT NULL
  count          integer NOT NULL DEFAULT 0
  PRIMARY KEY (partner_key_id, window_kind, window_start)
  INDEX (org_id, window_kind, window_start DESC)   -- the UI's "last 24h" panel
  RLS: ENABLE + SELECT-only org policy.

alert_state
  alert_key        text PRIMARY KEY     -- e.g. 'intake:auth_fail:<partner_key_id>'
  org_id           uuid                 -- nullable: some alerts are global
  state            text NOT NULL        -- 'ok' | 'firing'
  since            timestamptz NOT NULL DEFAULT now()
  last_notified_at timestamptz
  RLS: ENABLE, no policies (infra table, same posture as cron_locks).
```

`window_start` for `'day'` is the **ET** calendar day start as a timestamptz, via the existing
`campaignDayBoundsUtc()` in [lib/campaign-timezone.ts](../../../lib/campaign-timezone.ts) — never a
functional predicate on a timestamp, per the sargability convention. Per-second rows are at most
86,400/key/day (one per second, not per request) and get pruned at 2 days by whichever cron the
alert monitor lands in.

`alert_state` is generic on purpose: two alerts need it now and the drip scheduler's dead-man alert
will need it in P5. Only a **transition** into `firing` notifies; staying `firing` is silent.

---

## 5. Decisions needed before I build (G11–G18)

| # | Decision | My recommendation |
|---|---|---|
| **G11** | Secret **hashed** (SHA-256) vs **encrypted** (secret-box), given the brief said "hashed/encrypted per credential conventions" | **Hash.** CamMan never replays it; hashing survives key rotation and a DB leak yields nothing. Explicitly *not* bcrypt/argon2 — CPU DoS at 50 req/s |
| **G12** | Where the secret travels: body field, or `Authorization`/`X-Partner-Secret` header | **Header.** Keeps it out of `raw` entirely, so redaction is structural rather than a string edit. Tells puts it in the body only because Tells chose that |
| **G13** | Max leads per call, `N` | **500.** ~200 KB at a typical 400-byte lead, one multi-row INSERT, one round trip |
| **G14** | Does the per-second limit count **requests** and the daily limit count **leads**? | **Yes — different units.** "50K/day" is a lead contract; "10/s" is a request contract. Must be explicit or a 500-lead batch silently costs 1 |
| **G15** | Batch that would cross the daily cap: reject whole call, or partial accept? | **Reject whole call, 429 + `Retry-After`.** Partial acceptance makes the partner's retry semantics ambiguous |
| **G16** | ⚠️ **Backlog alert in P2 or P3?** | **P3.** In Phase 2 nothing consumes `lead_inbox` by design, so "backlog > X unprocessed for > 10 min" is **guaranteed to fire and stay firing** from the first lead. Shipping it now means shipping an alert that is red by construction — the same trap as a guard that asserts today's empty state. Auth-failure alerting ships in P2; backlog ships with its consumer |
| **G17** | `dedup_key` nullable + partial unique (my proposal) vs `NOT NULL UNIQUE` (the brief) | **Nullable + partial.** `NOT NULL` drops exactly the malformed leads that most need capturing |
| **G18** | Unresolved-token requests: alert, or log only? | **Log only.** A public intake URL will be scanned continuously; alerting on it pages someone forever. Alert on *resolved token + bad secret* — that is a rotated or leaked credential |

---

## 6. Risk register additions (continuing R1–R15)

| # | Risk | Mitigation |
|---|---|---|
| **R16** | Intake writes to the same Postgres the live send path uses. A burst or a runaway partner could contend with the drain | 2 round trips per request, no inline processing, DB work measured at ~0 ms. Rate limit is enforced *before* the insert |
| **R17** | `lead_inbox` grows unboundedly in P2 because nothing consumes it | Accepted and intended for this phase. Quantified: at the spec's 10–50K leads/day, one month unprocessed is ~0.3–1.5M rows — fine. G16 keeps the alert honest about it |
| **R18** | A leaked partner secret lets anyone inject leads under that partner's slug, polluting attribution and P7 reporting | Rotation in the UI; hash-at-rest (G11); auth-failure alerting; `sandbox` default true |
| **R19** | The generated partner doc drifts from the actual validator | Generate `docs/partners/*.md` **from the same field definition object** the Zod schema is built from, exactly as the segment-rules `RULE_TYPES` map is the single source for server + client |

---

## 7. What I have NOT done

No code, no migration files, no branch beyond this document, no writes to production (the single
probe rolled back and its script is deleted). Awaiting rulings on **G11–G18** and approval of
**0152 / 0153 / 0154** before anything is written.
