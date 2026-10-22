-- 0219: contact_attributes.zip (P3 of docs/superpowers/specs/2026-10-19-message-personalization-formats-design.md §A2).
-- Additive. Zip arrives in partner payloads (pml: 96% of leads, 5-digit) but had
-- no column, so enrichment dropped it. Stored as received (trimmed); the
-- {zip} tag normalizes at render (lib/messages/tags.ts: 5 digits, ZIP+4 cut).
-- Existing contacts are filled from lead_inbox.raw by scripts/backfill-contact-zip.ts
-- (owner-gated; never part of this migration).
-- Re-runnable: ADD COLUMN IF NOT EXISTS. Nullable, no default: catalog-only.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.contact_attributes ADD COLUMN IF NOT EXISTS zip text;--> statement-breakpoint
COMMENT ON COLUMN public.contact_attributes.zip IS
  'ZIP / postal code as received (trimmed). Normalized at render by the {zip} tag (0219).';
