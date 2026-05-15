-- Add optional Short URL and Full URL to each campaign stage.
--
-- short_url: pasted into the SMS preview on its own line, between the
-- creative text and the stop text. Renders verbatim — no length checks
-- here.
-- full_url: tracking metadata only, never rendered into the SMS. Used
-- externally to track the link with campaign IDs.

ALTER TABLE public.campaign_stages
  ADD COLUMN short_url text,
  ADD COLUMN full_url text;
