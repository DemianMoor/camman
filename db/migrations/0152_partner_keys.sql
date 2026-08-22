-- Migration 0152: partner_keys — per-partner intake credentials (Drip Phase 2).
--
-- One row per partner that may POST leads to /api/intake/leads/[token]. This is
-- the FIFTH instance of the webhook auth pattern already proven by the four
-- provider webhooks (ahoi, tells, texthub, textrequest); see Q7 of the Phase 0
-- recon. Nothing here touches the send path.
--
-- ⚠️ THE SECRET IS HASHED, NOT ENCRYPTED — a deliberate departure from
-- provider_credentials, ruled G11.
--
-- provider_credentials encrypts (lib/crypto/secret-box.ts, AES-256-GCM keyed by
-- PROVIDER_CREDENTIALS_KEY) because CamMan must REPLAY those secrets to the
-- provider. A partner secret is only ever VERIFIED — the plaintext is never
-- needed again — so hashing is strictly better here:
--
--   * a database dump yields nothing usable, whereas ciphertext plus a leaked
--     PROVIDER_CREDENTIALS_KEY yields every live partner secret;
--   * rotating or losing PROVIDER_CREDENTIALS_KEY does not break every partner;
--   * verification costs microseconds instead of a decrypt.
--
-- ⚠️ And deliberately NOT bcrypt/argon2/scrypt. Slow KDFs exist to protect
-- LOW-ENTROPY HUMAN PASSWORDS from offline brute force. `secret` here is 256
-- bits of crypto.randomBytes — there is nothing to stretch. At the 50 req/s
-- burst this endpoint is specced for, bcrypt cost-10 would burn ~5 CPU-seconds
-- per wall-clock second: a self-inflicted DoS on a function billed by CPU time.
-- Plain SHA-256 over a high-entropy secret is the correct construction.
--
-- ⚠️ token is PLAINTEXT and indexed; secret_hash is one-way. That asymmetry is
-- intentional and mirrors provider_credentials.inbound_webhook_token: the token
-- is an ADDRESSING value resolved by equality on an index (hashing it would make
-- resolution a full scan), while the secret is the thing that AUTHENTICATES.
-- Possession of the token alone must never be sufficient.
--
-- ADDITIVE. New table only. Nothing reads it until the Phase 2 endpoint ships.

CREATE TABLE public.partner_keys (
  id                serial PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  partner_slug      text NOT NULL,
  name              text NOT NULL,

  -- Opaque path token. Resolved by equality; globally unique because resolution
  -- happens BEFORE any org context exists.
  token             text NOT NULL,
  -- SHA-256 hex of the secret. The plaintext is shown to the operator exactly
  -- once, at create/rotate, and is never recoverable from this row.
  secret_hash       text NOT NULL,
  -- Display-only tail so the UI can identify which secret is live.
  secret_last4      text,

  -- 'force'   — always stamp interest_tag, ignoring whatever the partner sends
  -- 'default' — use interest_tag only when the payload omits one
  interest_tag_mode text NOT NULL DEFAULT 'default',
  interest_tag      text,

  -- partner field name -> contact_attributes field. Also the source the partner
  -- instructions doc is generated from, so the doc cannot drift from validation.
  field_mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ⚠️ DEFAULTS TRUE. A credential handed to a third party must not be able to
  -- do real work the instant it exists; promotion to live is a deliberate act.
  sandbox           boolean NOT NULL DEFAULT true,

  rate_per_sec      integer NOT NULL DEFAULT 10,
  rate_per_day      integer NOT NULL DEFAULT 50000,
  -- 256 KB. Enforced from Content-Length BEFORE the body is read — App Router
  -- handlers have no default body cap, and nothing in this repo checked one
  -- before now (verified by repo-wide grep).
  max_payload_bytes integer NOT NULL DEFAULT 262144,

  status            text NOT NULL DEFAULT 'active',

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  rotated_at        timestamptz,
  last_seen_at      timestamptz,

  CONSTRAINT partner_keys_interest_tag_mode_check
    CHECK (interest_tag_mode IN ('force', 'default')),
  -- 'force' without a tag would silently stamp NULL onto every lead.
  CONSTRAINT partner_keys_force_needs_tag_check
    CHECK (interest_tag_mode <> 'force' OR interest_tag IS NOT NULL),
  CONSTRAINT partner_keys_status_check
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT partner_keys_rate_per_sec_check
    CHECK (rate_per_sec > 0),
  CONSTRAINT partner_keys_rate_per_day_check
    CHECK (rate_per_day > 0),
  -- Upper bound is Vercel's platform body limit (~4.5 MB); a larger value would
  -- be unenforceable and read as a promise we cannot keep.
  CONSTRAINT partner_keys_max_payload_bytes_check
    CHECK (max_payload_bytes BETWEEN 1024 AND 4194304)
);
--> statement-breakpoint

-- Global, not per-org: the token is resolved before we know the org.
CREATE UNIQUE INDEX partner_keys_token_uniq ON public.partner_keys (token);
--> statement-breakpoint

CREATE UNIQUE INDEX partner_keys_org_slug_uniq
  ON public.partner_keys (org_id, partner_slug);
--> statement-breakpoint

CREATE INDEX partner_keys_org_status_idx ON public.partner_keys (org_id, status);
--> statement-breakpoint

-- Tenant table (carries org_id) => RLS enabled WITH an org-scoped SELECT policy,
-- never policy-less. Mirrors 0085/0146/0149. NO write policies: an absent policy
-- is a denial, so anon/authenticated lose INSERT/UPDATE/DELETE/TRUNCATE. Every
-- writer is the server's privileged DATABASE_URL connection, which bypasses RLS.
ALTER TABLE public.partner_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partner_keys_select_own_org"
  ON public.partner_keys FOR SELECT
  USING (org_id = public.current_org_id());
