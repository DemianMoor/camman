-- Backfill the one provider row created through the connection-type picker
-- during the window where POST /api/providers did not yet persist adapter_code.
--
-- The picker (869egmakh P3) merged BEFORE migration 0134 added the column, so
-- for that window every provider created through the UI landed with
-- adapter_code = NULL. The send path resolves
-- getAdapter(COALESCE(adapter_code, sms_provider_id)) — so `tls-t` resolved to
-- the literal string "tls-t", which is not a registered adapter, and the row
-- could never send. Neither PR was wrong alone; the gap is at their seam.
--
-- `tls-t` is a REAL second Tells account, deliberately created via the
-- separate-row path and kept. Its identity is `tls-t`; its connection TYPE is
-- `tls`. That distinction is the entire purpose of the separate-row path.
--
-- STRICTLY ADDITIVE: fills a NULL on one row. No column dropped, no row
-- deleted, nothing rewritten. Idempotent via the `adapter_code IS NULL` guard,
-- so re-running is a no-op and it cannot clobber a value set later by hand.
--
-- Targeted on sms_provider_id rather than the numeric id so the statement means
-- the same thing in any environment, and matches nothing where the row is absent.
--
-- The row stays INERT: supports_api_send is untouched (false). Taking this
-- account live is a separate, audited decision through
-- POST /api/providers/[id]/api-send.
UPDATE public.sms_providers
SET adapter_code = 'tls'
WHERE adapter_code IS NULL
  AND sms_provider_id = 'tls-t';
--> statement-breakpoint
-- snx and smpl are deliberately NOT backfilled. They are legitimately custom /
-- no-API providers (sent through manually, supports_api_send = false) with no
-- adapter in the registry. NULL is their correct, permanent value — it is a real
-- state, not missing data. Guard: fail loudly if a future edit to this file ever
-- leaves an api-send-capable row without a resolvable type.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM public.sms_providers
  WHERE supports_api_send = true AND adapter_code IS NULL;

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0135 guard: % provider row(s) have supports_api_send = true but adapter_code IS NULL — those providers cannot send.',
      bad_count;
  END IF;
END $$;
