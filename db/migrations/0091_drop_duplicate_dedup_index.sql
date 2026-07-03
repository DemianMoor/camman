-- Migration 0091: drop the duplicate dedup index added in 0090.
--
-- 0090 created `stage_sends_org_phone_sent_at_idx` = (org_id, phone, sent_at)
-- WHERE status='sent' for the drain's 1-hour send-dedup lookup — but an IDENTICAL
-- partial index already existed: `stage_sends_org_phone_sent_idx` (migration 0075,
-- inbound-STOP attribution). Two byte-identical indexes just double the write cost
-- on every 'sent' update for zero read benefit. Drop the 0090 duplicate; the 0075
-- index serves the dedup lookup unchanged.
DROP INDEX IF EXISTS public.stage_sends_org_phone_sent_at_idx;
