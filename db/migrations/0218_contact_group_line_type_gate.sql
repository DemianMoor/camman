-- 0218: per-contact-group line-type gate. Additive only.
--   contact_groups.allow_voip / allow_unknown   default true = today's behaviour.
-- false on an ACTIVE group drops its voip / unknown contacts from every campaign
-- audience (segment + group choke points) and from drip routing, org-wide —
-- strictest group wins. Read by lib/contact-groups/line-type-gate.ts.
-- ADD COLUMN ... NOT NULL DEFAULT is a catalog-only change at PG 11+ (no rewrite);
-- the lock_timeout keeps the brief ACCESS EXCLUSIVE lock from queueing readers.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "contact_groups" ADD COLUMN IF NOT EXISTS "allow_voip" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_groups" ADD COLUMN IF NOT EXISTS "allow_unknown" boolean DEFAULT true NOT NULL;
