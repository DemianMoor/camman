-- Mirror the spam-scoring result onto the creatives row so the list page
-- and edit dialog can render score + verdict without a join to the
-- spam_scores cache. The cache is still authoritative (cross-creative
-- deduping is keyed on text_hash); these columns are a denormalization
-- of the most recent score for THIS creative.
--
-- spam_label is binary here (ham/spam) even though the cache stores the
-- 3-bucket label (ham/suspicious/spam). We derive ham vs spam from the
-- verdict (score > 50 ⇒ spam) at write time.

ALTER TABLE public.creatives
  ADD COLUMN spam_score integer,
  ADD COLUMN spam_label text,
  ADD COLUMN spam_scored_at timestamp with time zone,
  ADD COLUMN spam_model_id text,
  ADD COLUMN spam_score_error text;
--> statement-breakpoint
ALTER TABLE public.creatives
  ADD CONSTRAINT creatives_spam_score_check
  CHECK (spam_score IS NULL OR (spam_score >= 0 AND spam_score <= 100));
--> statement-breakpoint
ALTER TABLE public.creatives
  ADD CONSTRAINT creatives_spam_label_check
  CHECK (spam_label IS NULL OR spam_label IN ('ham', 'spam'));
