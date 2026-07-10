-- Telnyx Number Lookup — phase 1c: batch tracking + the worker queue.
--
-- lookup_batches has org_id (the tenant that triggered it, for reporting only —
-- the cache it fills is global). RLS: org-scoped SELECT policy, no write policies
-- (written only by the privileged Drizzle role, which bypasses RLS) — mirrors the
-- stage_manual_sales precedent (0085) + current_org_id() from 0001.
--
-- lookup_queue is operational worker state with no org_id (it references a batch).
-- RLS: enabled POLICY-LESS (geoip_cache/0066 pattern) — worker-only access via the
-- Drizzle role; the admin batch UI reads progress through server API routes, not
-- PostgREST. Default-deny closes the anon/authenticated door.

CREATE TABLE IF NOT EXISTS public.lookup_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  trigger         text NOT NULL,
  total_numbers   int NOT NULL,
  cache_hits      int NOT NULL DEFAULT 0,
  processed       int NOT NULL DEFAULT 0,
  failed          int NOT NULL DEFAULT 0,
  est_cost_usd    numeric(10, 4),
  actual_cost_usd numeric(10, 4),
  status          text NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lookup_batches_trigger_check
    CHECK (trigger IN ('upload', 'backfill', 'csv_update')),
  CONSTRAINT lookup_batches_status_check
    CHECK (status IN ('pending', 'running', 'paused', 'complete', 'aborted'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS lookup_batches_org_id_idx ON public.lookup_batches (org_id);
--> statement-breakpoint

-- Worker sweep: find batches with outstanding work.
CREATE INDEX IF NOT EXISTS lookup_batches_active_idx
  ON public.lookup_batches (status) WHERE status IN ('pending', 'running');
--> statement-breakpoint

ALTER TABLE public.lookup_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "lookup_batches_select_own_org" ON public.lookup_batches;
--> statement-breakpoint

CREATE POLICY "lookup_batches_select_own_org"
  ON public.lookup_batches FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.lookup_queue (
  id         bigserial PRIMARY KEY,
  batch_id   uuid NOT NULL REFERENCES public.lookup_batches(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  attempts   int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lookup_queue_status_check
    CHECK (status IN ('pending', 'done', 'failed'))
);
--> statement-breakpoint

-- Atomic claim by the worker: pending rows, oldest first (FOR UPDATE SKIP LOCKED).
CREATE INDEX IF NOT EXISTS lookup_queue_pending_idx
  ON public.lookup_queue (batch_id, id) WHERE status = 'pending';
--> statement-breakpoint

-- Dedup at enqueue: don't double-enqueue a number already pending in another batch.
CREATE INDEX IF NOT EXISTS lookup_queue_phone_pending_idx
  ON public.lookup_queue (phone) WHERE status = 'pending';
--> statement-breakpoint

ALTER TABLE public.lookup_queue ENABLE ROW LEVEL SECURITY;
