-- Append-only cache for spam scores. Keyed by (org_id, text_hash, provider) so
-- re-scoring the same text against the same provider is a cache hit. Different
-- providers can score the same text independently (useful for A/B comparing
-- new classifiers without invalidating existing scores).

CREATE TABLE public.spam_scores (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  text_hash text NOT NULL,
  text_length integer NOT NULL,
  score integer NOT NULL,
  label text NOT NULL,
  confidence real,
  provider text NOT NULL,
  model_version text,
  raw_response jsonb,
  latency_ms integer,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT spam_scores_score_check CHECK (score >= 0 AND score <= 100),
  CONSTRAINT spam_scores_label_check CHECK (label IN ('ham', 'suspicious', 'spam')),
  CONSTRAINT spam_scores_org_hash_provider_unique UNIQUE (org_id, text_hash, provider)
);
--> statement-breakpoint
CREATE INDEX spam_scores_org_created_idx
  ON public.spam_scores (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX spam_scores_score_idx
  ON public.spam_scores (score);
