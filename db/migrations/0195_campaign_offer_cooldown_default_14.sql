-- 0195 — campaigns.offer_cooldown_days column default 7 → 14 (card 869fb5j0e).
--
-- "Not within [N] days" for a NEW campaign is 14 since PR #281
-- (OFFER_COOLDOWN_DAYS_DEFAULT, lib/validators/campaigns.ts). The create route
-- always writes the value explicitly; this default matters only for inserts
-- that omit the column. Catalog-only: no existing row is read or rewritten —
-- stored campaigns keep their values. offer_limit_times keeps DEFAULT 5.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.campaigns
  ALTER COLUMN offer_cooldown_days SET DEFAULT 14;
