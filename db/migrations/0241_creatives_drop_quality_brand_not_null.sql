-- 0241 — Creatives brand P4 (ClickUp 1amdve2d47v). DESTRUCTIVE; runs attended,
-- in the morning window, on the owner's "go now" (CLAUDE.md §14).
--
-- 1. creatives.brand_id becomes NOT NULL. Preconditions checked on prod
--    2026-11-17: 0 of 1121 creatives have a NULL brand_id (P1 backfill + P3
--    mapping), and every create path requires a brand since P2 (#457). If a NULL
--    appears before this runs, SET NOT NULL fails and the whole migration rolls
--    back (drizzle runs it in one transaction), so quality is not dropped either.
-- 2. creatives.quality and its CHECK are dropped. Nothing on origin/main reads or
--    writes the column (P2 removed it from the UI, API and validators). No view,
--    function, index or trigger depends on it. The 45 non-default values are
--    kept in docs/snapshots/creatives_quality_2026-11-16.csv, which matched prod
--    45/45 on 2026-11-17.
--
-- Locks: ACCESS EXCLUSIVE on creatives for the duration. SET NOT NULL scans the
-- ~1.1K rows; the column drop is catalog-only. lock_timeout makes it give up
-- (and roll back) instead of queueing behind a long reader.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.creatives ALTER COLUMN brand_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.creatives DROP CONSTRAINT creatives_quality_check;
--> statement-breakpoint
ALTER TABLE public.creatives DROP COLUMN quality;
