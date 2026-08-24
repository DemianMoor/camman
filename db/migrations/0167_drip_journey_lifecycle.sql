-- Migration 0167: drip journey lifecycle — terminal states (Drip Phase 6, D3).
--
-- ⚠️ THE PHASE 5 PROOF FAILED ON EXACTLY THIS. A contact replied STOP, was
-- suppressed and attributed correctly, and its journey still read 'active',
-- because NOTHING in the codebase ever closes a journey. `completed` and
-- `exited` existed only in the CHECK below — the single UPDATE drip_journeys in
-- the whole repository is the scheduler's routed -> active.
--
-- ⚠️ THREE OF THE FIVE TERMINAL STATES WERE NOT IN THE VOCABULARY AT ALL.
-- The old CHECK allowed routed | active | completed | exited | unroutable, so
-- opted_out, converted and expired are ADDED here, not merely used.
--
-- ⚠️ WHY TERMINAL STATES ARE LOAD-BEARING, not bookkeeping. The partial unique
-- index drip_journeys_one_live_per_contact_uniq keys on
-- state IN ('routed','active'), so today every contact ever routed holds that
-- slot FOREVER — one drip campaign per contact for all time, and an opted-out
-- lead keeps its slot. Any new terminal value frees the slot BY CONSTRUCTION;
-- the index itself needs no change, which is why the vocabulary is widened
-- rather than the index rewritten.
--
-- ⚠️ `exited` IS AN ARCHIVE TRIGGER, NOT A DELETE ONE (ruling D3).
-- drip_journeys.campaign_id is ON DELETE CASCADE (0161), so a hard delete
-- removes the journey row rather than leaving one to mark. That is accepted:
-- archive is the project's soft-delete convention (CLAUDE.md §6) and is what
-- produces 'exited'. A hard-deleted campaign's journeys simply cease to exist.
--
-- ADDITIVE. Both columns are NULL on every existing row; the CHECK is widened
-- (strictly more permissive), so no existing row can fail it.

ALTER TABLE public.drip_journeys
  ADD COLUMN closed_at timestamptz;
--> statement-breakpoint

-- Free text rather than an enum: the reason is for a human reading the journey,
-- and the STATE is the machine-readable part. A second constrained vocabulary
-- would have to be widened in lockstep with the first.
ALTER TABLE public.drip_journeys
  ADD COLUMN close_reason text;
--> statement-breakpoint

ALTER TABLE public.drip_journeys
  DROP CONSTRAINT IF EXISTS drip_journeys_state_check;
--> statement-breakpoint

ALTER TABLE public.drip_journeys
  ADD CONSTRAINT drip_journeys_state_check CHECK (
    state IN (
      -- live: these two hold the one-live-per-contact slot
      'routed', 'active',
      -- terminal
      'opted_out',   -- STOP received (P6)
      'converted',   -- purchased, via purchasedClause() — never = 'sale'
      'completed',   -- every enabled stage done
      'expired',     -- campaign end_at passed and follow-ups finished
      'exited',      -- campaign archived
      'unroutable'   -- never matched a campaign (pre-existing)
    )
  );
--> statement-breakpoint

-- A terminal state must carry its timestamp, and a live one must not. Without
-- this, "closed" becomes two facts that can disagree, and every consumer has to
-- pick which one it trusts.
ALTER TABLE public.drip_journeys
  ADD CONSTRAINT drip_journeys_closed_at_check CHECK (
    (state IN ('routed', 'active') AND closed_at IS NULL)
    OR (state NOT IN ('routed', 'active') AND closed_at IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint

-- ⚠️ NOT VALID DELIBERATELY. Existing 'unroutable' rows predate closed_at and
-- would fail it. New and updated rows are enforced from now on; a VALIDATE
-- comes only after those rows are backfilled, which is not this phase's job.

-- The lifecycle sweeper's scan: live journeys of a campaign, oldest first.
CREATE INDEX drip_journeys_live_idx
  ON public.drip_journeys (org_id, campaign_id, first_send_at)
  WHERE state IN ('routed', 'active');
