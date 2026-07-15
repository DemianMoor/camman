-- Section 2 (send path + segment policy): per-creative override for the
-- default single-segment-only send policy (spec §4). Default false: a
-- creative that renders to >1 SMS segment is refused at kickoff preflight
-- (lib/sends/kickoff.ts) unless this is explicitly turned on. The
-- MAX_SEGMENTS hard ceiling (G8, lib/sends/segments.ts) still applies even
-- when this is true — the override enables 2-4 segments, never runaway
-- multipart.
ALTER TABLE public.creatives
  ADD COLUMN allow_multi_segment boolean NOT NULL DEFAULT false;
