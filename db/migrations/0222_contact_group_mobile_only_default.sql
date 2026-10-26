-- 0222: contact groups are mobile-only by default + a toll-free box on the line-type gate.
-- Owner-approved 2026-10-23 (proposed as "0220"; 0220/0221 are reserved by the
-- unmerged feat/engagement-batch-index branch, so this is 0222).
--
-- 1. allow_toll_free joins allow_voip / allow_unknown (lib/contact-groups/line-type-gate.ts,
--    lib/drip/routing-eval.ts). Added DEFAULT true so every EXISTING group keeps
--    allowing toll-free, as it does today.
-- 2. Backfill: toll-free is blocked in the mobile-only groups — selected by
--    allow_unknown = false, which on 2026-10-23 is exactly the six: pml-aca,
--    pml-aca3, pml-medicare, pml-autoinsur, bsd-autoinsur, bsd-untagged. Not
--    "both boxes off": pml-aca / pml-aca3 were switched to allow_voip = true the
--    same day and stay toll-free-blocked by ruling.
-- 3. Column defaults flip to false: a group created without explicit values is
--    mobile-only. Every app create path passes explicit values anyway
--    (lib/drip/groups.ts, app/api/contact-groups/route.ts) — the default is the
--    backstop for anything that does not.
--
-- ADD COLUMN with a constant default is catalog-only (no rewrite); the UPDATE
-- touches a handful of rows. Re-runnable: IF NOT EXISTS, and the UPDATE and the
-- SET DEFAULTs are idempotent.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.contact_groups ADD COLUMN IF NOT EXISTS allow_toll_free boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE public.contact_groups SET allow_toll_free = false WHERE allow_unknown = false AND allow_toll_free;--> statement-breakpoint
ALTER TABLE public.contact_groups
  ALTER COLUMN allow_voip SET DEFAULT false,
  ALTER COLUMN allow_unknown SET DEFAULT false,
  ALTER COLUMN allow_toll_free SET DEFAULT false;
