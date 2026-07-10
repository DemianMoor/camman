-- Telnyx Number Lookup — semantic split of the former "Unknown" carrier state into
-- two, BEFORE any contact-sync / campaign-filter wiring exists (small correction,
-- not rework). Does NOT edit the already-applied 0095–0098.
--
--   Unidentified — no phone_lookups row exists for this phone (never looked up, no
--                  user-provided data). The new default for contacts.carrier_norm.
--                  Invariant: carrier_norm='Unidentified' <=> no phone_lookups row.
--   Unknown      — a lookup occurred (any source) but the carrier is undetermined
--                  (Telnyx returned unknown/absent carrier). Groups with Unmapped.
--   Unmapped     — looked up, raw string awaiting an admin bucket mapping.
--
-- phone_lookups.carrier_norm must NEVER be 'Unidentified' — already enforced by
-- phone_lookups_carrier_norm_check (migration 0095, its allowed set excludes it),
-- so no change is needed there. Contact sync (Phase 4) always overwrites
-- Unidentified with a real value (Unknown at worst) whenever a lookup row is written.

-- New default for freshly-inserted contacts with no lookup.
ALTER TABLE public.contacts ALTER COLUMN carrier_norm SET DEFAULT 'Unidentified';
--> statement-breakpoint

-- Value domain for contacts.carrier_norm: the six buckets + Unmapped + Unidentified.
-- (contacts had no carrier_norm CHECK before; add it now.)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_carrier_norm_check') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_carrier_norm_check
      CHECK (carrier_norm IN ('AT&T', 'T-Mobile', 'Verizon', 'Other Mobile', 'VoIP', 'Unknown', 'Unmapped', 'Unidentified'));
  END IF;
END $$;
--> statement-breakpoint

-- One-time reclassification: every existing contact defaulted to 'Unknown' but none
-- has been looked up yet, so they are all really 'Unidentified'. GUARDED on
-- phone_lookups being empty — if any lookup has run, some 'Unknown' contacts are
-- legitimately looked-up-undetermined and must NOT be flipped, so we skip (prod runs
-- the batched flip in scripts/apply-0099.ts first, making this re-run a 0-row no-op).
DO $$ BEGIN
  IF (SELECT count(*) FROM public.phone_lookups) = 0 THEN
    UPDATE public.contacts SET carrier_norm = 'Unidentified' WHERE carrier_norm = 'Unknown';
  END IF;
END $$;
