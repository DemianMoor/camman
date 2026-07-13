-- Carrier Normalization v2 — AI triage queue + cost breaker.
--
-- When the resolver chain (migration 0104) falls through to `Unmapped`, the
-- distinct normalized carrier string is enqueued here for async AI triage. The
-- background cron (/api/cron/carrier-triage) batches pending rows to a fast
-- Claude model, and on a confident answer writes the string into
-- `carrier_mappings` (so chain step 2 catches it forever after — ONE API call
-- per distinct string, ever). This table gives durable per-string status so an
-- AI-failed string is NOT re-billed every run.
--
-- No org_id: carrier identity is a global fact, matching phone_lookups /
-- carrier_mappings. `contact_count` is intentionally NOT stored — it is derived
-- on read (join to contacts via phone_lookups) so it can never go stale.

CREATE TABLE IF NOT EXISTS public.carrier_classify_queue (
  match_key   text PRIMARY KEY,          -- normalized key of carrier_name (lib/carrier/normalize-key.ts)
  raw_example text NOT NULL,             -- a sample original carrier_name, for the human queue + AI prompt
  status      text NOT NULL DEFAULT 'pending',
  confidence  numeric,                   -- null until AI attempts; 0..1 on ai_resolved / needs_human
  attempts    int  NOT NULL DEFAULT 0,   -- AI attempts (bounded retry/backoff)
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_classify_queue_status_check
    CHECK (status IN ('pending', 'ai_resolved', 'needs_human', 'human_resolved'))
);
--> statement-breakpoint

-- Drain index: the cron claims pending rows oldest-first.
CREATE INDEX IF NOT EXISTS carrier_classify_queue_pending_idx
  ON public.carrier_classify_queue (created_at) WHERE status = 'pending';
--> statement-breakpoint

-- Human review index: needs_human rows surface in the admin queue.
CREATE INDEX IF NOT EXISTS carrier_classify_queue_needs_human_idx
  ON public.carrier_classify_queue (updated_at) WHERE status = 'needs_human';
--> statement-breakpoint

ALTER TABLE public.carrier_classify_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Per-run Anthropic API-call cost breaker (brief §10). Mirrors the send/lookup
-- spend breakers: the triage cron stops + alerts once it has made this many API
-- calls in a single run. Editable via the lookup admin settings.
ALTER TABLE public.lookup_settings
  ADD COLUMN IF NOT EXISTS carrier_ai_run_cap int NOT NULL DEFAULT 200;
