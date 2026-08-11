-- Migration 0121: persist Text Request's per-send segment count.
--
-- Text Request returns `segments_count` on the POST /messages response (unlike
-- TextHub/Ahoi). The drain records it per attempt so segment/cost analysis has
-- the provider's own count. Additive/nullable — NULL for every existing row and
-- for providers that don't report it.
ALTER TABLE public.send_attempts
  ADD COLUMN IF NOT EXISTS segments_count integer;
