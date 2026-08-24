# Partner lead intake (Drip Phase 2)

_Last updated: 2026-08-24_

Real-time capture of partner-submitted leads. **Zero sends, zero processing.** The endpoint
authenticates, rate-limits, validates shape, writes one row, and returns. Everything downstream —
carrier lookup, contact creation, routing, messaging — is Phase 3 and later.

Card: `869endkmd` · migrations **0152–0154** · recon:
[2026-08-22-drip-phase-2-intake-recon.md](../superpowers/specs/2026-08-22-drip-phase-2-intake-recon.md)

## The endpoint

```
POST /api/intake/leads/[token]
Authorization: Bearer <secret>        (or X-Partner-Secret: <secret>)
```

[app/api/intake/leads/[token]/route.ts](../../app/api/intake/leads/[token]/route.ts). Public — there
is no `middleware.ts` in this repo, so auth is per-route and a public endpoint needs no exemption.

It is the **fifth instance of the provider-webhook pattern** (`ahoi`, `tells`, `texthub`,
`textrequest`), with [tells/inbound](../../app/api/webhooks/tells/inbound/[token]/route.ts) as the
reference. Same sequence, two deliberate differences:

| Step | Intake | vs. the Tells reference |
|---|---|---|
| 1. opaque path token → credential row | `partner_keys.token`; unresolved ⇒ 401 **log only** | Tells alerts on a provider-shaped payload. A public intake URL is scanned constantly, so alerting here would page forever — the alertable case is a *resolved* token with a bad secret |
| 2. second factor, constant-time | `safeEqual(sha256(supplied), secret_hash)` | Tells decrypts a stored key. Intake hashes — see below |
| 3. payload cap | `Content-Length` **and** actual byte length, before parse | no equivalent existed anywhere in the repo |
| 4. rate limit | DB-backed, per key | no equivalent existed anywhere in the repo |
| 5. one INSERT + dedup key, `(xmax = 0)` | identical | — |
| 6. inline processing | **omitted** | Phase 2 processes nothing; `status='received'` IS the queue |

Two round trips total (resolve key, then limit+insert), which is what makes the 50 req/s target a
non-issue: measured server-side cost of the limiter upsert is within noise of an empty query.

## Credentials

Two values, both secret, and they do different jobs:

- **token** — in the URL path. *Addressing.* Stored plaintext and uniquely indexed, because it is
  resolved by equality before any org context exists; hashing it would make resolution a seq scan.
- **secret** — in a header. *Authentication.* Stored only as SHA-256.

**⚠️ The secret is hashed, not encrypted — deliberately unlike `provider_credentials`.** That table
uses [lib/crypto/secret-box.ts](../../lib/crypto/secret-box.ts) (AES-256-GCM) because CamMan must
**replay** those secrets to a provider. A partner secret is only ever **verified**, so:

- a database dump yields nothing usable (ciphertext plus a leaked `PROVIDER_CREDENTIALS_KEY` would
  yield every live partner secret);
- rotating that master key does not break every partner;
- verification is microseconds.

**⚠️ And deliberately not bcrypt/argon2/scrypt.** Slow KDFs defend low-entropy *human passwords*
against offline brute force. The secret here is 256 bits from `crypto.randomBytes` — nothing to
stretch — and at 50 req/s a cost-10 bcrypt would burn ~5 CPU-seconds per wall-clock second on a
function billed by CPU time.

The secret travels in a **header, never the body** ([lib/intake/partner-key.ts](../../lib/intake/partner-key.ts)).
That is a genuine improvement on the Tells reference: the secret is then *structurally absent* from
what we persist, so redaction is not a string edit that can be got wrong.

**Rotation is immediate and breaking** — no dual-accept window. The partner's next request with the
old secret gets 401. That is correct for a credential you are rotating *because it may have leaked*;
a grace period keeps a compromised secret working exactly when it is most dangerous. Rotation also
clears any standing auth-failure alert, so the next real incident is not swallowed by a stuck
`firing` state. The token is **not** rotated — it is addressing, so changing it would force a URL
change for no security gain.

## Rate limiting

`partner_key_usage`, one guarded upsert per window. **Units differ and it matters:**

| Window | Counts | Resets |
|---|---|---|
| `sec` | **requests** — a 500-lead batch is one | every second |
| `day` | **leads** — a 500-lead batch costs 500 | ET calendar day |
| `auth_fail` | failed secret checks on a *resolved* token | ET calendar day |

Conflating them would make "50,000/day" mean 50,000 batches.

**⚠️ Why the guard is on the `DO UPDATE` and not in application code.** The obvious shape — the one
`campaign_tracking_counters` uses — increments unconditionally and lets the caller compare
afterwards. As a limiter that means **rejected requests burn the quota**: a partner with a bad retry
loop locks itself out for the rest of the day without ever delivering a lead. With
`WHERE count + n <= limit` on the `DO UPDATE`, a refusal touches nothing and `RETURNING` yields no
row. Proven in [scripts/test-intake-schema.ts](../../scripts/test-intake-schema.ts) both ways: the
4th request over a limit of 3 returns zero rows **and** the counter is still 3.

**⚠️ The `INSERT` branch is not covered by that `WHERE`.** The first call of a window inserts `n`
unguarded, so an oversized batch would be admitted once per window. The route therefore pre-checks
batch size against `rate_per_day` and returns 413. That hole is asserted in the test so the
pre-check cannot be deleted later as redundant.

A 429 stores nothing and consumes no daily budget. An over-cap batch is refused **whole** — partial
acceptance would leave the partner unable to tell which leads landed.

## What gets stored

Everything. A lead that fails validation is stored with `status='rejected'` and an `error`, not
dropped: a partner sending the wrong field name is invisible if bad payloads vanish at the edge, and
one query away from diagnosis if they do not.

Duplicates collapse on `(partner_key_id, phone_e164, received_minute)` and return the existing id
with `duplicate: true`, so a retry after a timeout is idempotent.

**⚠️ Intra-batch dedup is mandatory, not an optimization.** Postgres raises `21000` if one statement
conflict-updates the same row twice, so a batch containing the same phone twice would fail the
*whole* call. [lib/intake/capture.ts](../../lib/intake/capture.ts) collapses repeats before the
INSERT and re-expands the results to the caller's original order and length.

## Fields and the partner document

[lib/intake/fields.ts](../../lib/intake/fields.ts) is the single source for what the endpoint
accepts, what a key's `field_mapping` may target, and what the partner document says.
[docs/partners/lead-intake.md](../partners/lead-intake.md) is **generated** from it by
[scripts/generate-partner-docs.ts](../../scripts/generate-partner-docs.ts); `--check` fails if they
drift (risk R19). Only `phone` is required; unknown fields are kept in `raw`, never discarded.

## Alerts

`alert_state` is the first state-transition gate in the codebase. `notifyTelegram` is stateless by
contract and fires on every call; the existing circuit breakers avoid alert storms only as a *side
effect of latching*. The latch is claimed on confirmed **delivery**, not on detection: a transition
into `firing` notifies, and so does an already-`firing` row whose last send never delivered (`state
= 'firing' AND last_notified_at IS NULL`, the pending state) — that row re-claims and re-sends on
every subsequent call until a send succeeds
([lib/alerts/alert-state.ts](../../lib/alerts/alert-state.ts)).

Shipped in Phase 2: **auth-failure spike** per key (≥5 failed secret checks in a day on a resolved
token). Because this route calls the alert per-request rather than on a cron cadence, and
`recordAuthFailure` is uncapped, the naive `failures >= 5` gate would call `notifyOnTransition` on
every bad-secret request for the rest of the day — and each one sends while the row is pending. The
route instead fires at the 5th failure and then only every hundredth
([app/api/intake/leads/[token]/route.ts](../../app/api/intake/leads/[token]/route.ts)), so
attempts scale with failure count, not request rate.

**Deferred to Phase 3: the backlog alert.** In Phase 2 nothing consumes `lead_inbox` by design, so
"backlog > X unprocessed for > 10 min" would fire on the first lead and stay firing forever. It
ships with its consumer.

## UI

`/settings/partners` ([components/settings/partner-keys.tsx](../../components/settings/partner-keys.tsx)).
Create, rotate, enable/disable, sandbox toggle, per-key 24h counts and last-seen. `partner_keys.view`
(manager+) to look, `partner_keys.manage` (admin+) to mint or rotate — the same split
`provider_credentials` uses.

**No delete.** `lead_inbox.partner_key_id` is `ON DELETE RESTRICT`, and the leads carry the key's
slug as provenance. Disable instead; the endpoint answers a disabled key with 403 so the partner
learns their key was turned off rather than mistyped.

The endpoint URL is shown only on an explicit "Show endpoint URL" click, not in the list response —
it is half the credential and should not render on every settings visit.

## Sandbox

`sandbox` defaults **true** on a new key: a credential handed to a third party must not do real work
the instant it exists. Sandbox leads are stored and flagged, and are excluded from sending and
reporting. Promotion to live is one toggle and changes nothing about the partner's request.
