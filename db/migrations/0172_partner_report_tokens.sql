-- Migration 0172: signed report links for partners (Drip Phase 7).
--
-- ⚠️ NOT A USER ACCOUNT. Ruling: partners get a revocable signed link that
-- renders THEIR report and nothing else -- no login, no session, no org data
-- beyond their own aggregates. Full external accounts are a separate workstream.
--
-- ⚠️ OPAQUE TOKEN RESOLVED BY DB LOOKUP, NOT A SIGNED HMAC/JWT.
-- Revocation is the requirement that decides it: a signed token cannot be
-- revoked without a denylist, i.e. without the very lookup that signing was
-- supposed to avoid. An opaque token is revoked by flipping one column.
--
-- ⚠️ STORED HASHED, exactly as the intake secret is. The plaintext is shown once
-- at creation and is unrecoverable afterwards by construction, so a database
-- read -- a dump, a backup, a support query -- cannot yield working report
-- links. SHA-256 is right here for the same reason it is right for the intake
-- secret: this is a 256-bit random value, not a password, so there is nothing to
-- stretch and the lookup happens on every page load.
--
-- ⚠️ ON partner_keys RATHER THAN ITS OWN TABLE, because the ruling says rotation
-- and disable FOLLOW THE PARTNER KEY. One key, one link. A separate table would
-- allow several live tokens per key and make "disable the key" ambiguous.
--
-- ADDITIVE. All three columns are NULL on every existing row, which means "no
-- report link issued" -- the safe default.

ALTER TABLE public.partner_keys
  ADD COLUMN report_token_hash text;
--> statement-breakpoint

ALTER TABLE public.partner_keys
  ADD COLUMN report_token_issued_at timestamptz;
--> statement-breakpoint

-- NULL = no expiry. Checked on every request, so shortening it takes effect at
-- once rather than at the next issue.
ALTER TABLE public.partner_keys
  ADD COLUMN report_token_expires_at timestamptz;
--> statement-breakpoint

-- Revenue is OFF by default (ruling R2): it is our margin, not the partner's
-- number. A per-key opt-in rather than a global setting, because the decision is
-- per commercial relationship.
ALTER TABLE public.partner_keys
  ADD COLUMN report_show_revenue boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- The public route's ONLY lookup: hash -> key. Unique so a hash collision
-- cannot silently resolve to two partners, and partial so the many NULLs
-- (keys with no link issued) cost nothing.
CREATE UNIQUE INDEX partner_keys_report_token_hash_uniq
  ON public.partner_keys (report_token_hash)
  WHERE report_token_hash IS NOT NULL;
