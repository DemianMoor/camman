-- Link shortener + click tracker — first piece of the TextHub SMS integration.
--
-- Four new tables (short_domains, link_destinations, links, clicks) plus a
-- campaigns.link_mode column that selects, per campaign, which link the send
-- path reads: the operator-pasted manual URL ('manual', default — unchanged
-- behavior) or a minted per-recipient tracked link ('tracked').
--
-- Design invariants (see the companion brief + CLAUDE.md):
--   * links is skinny + high-volume → bigserial PK.
--   * links.code is GLOBALLY unique — the public redirect resolves by code
--     alone, with no org context on the URL.
--   * idempotency is per "message": unique (stage_id, contact_id, send_token)
--     so a retry reuses the link and each new message mints a fresh code.
--   * link_destinations is deduped by a hash of the normalized URL.
--   * clicks is defined but UNWIRED here — no endpoint writes it yet (Phase 2);
--     bot/prefetch clicks get classified, never deleted.
--
-- RLS mirrors every other domain table (CLAUDE.md §3): org-scoped reads,
-- operator-or-higher writes. The server's privileged DB role bypasses RLS;
-- policies are defense-in-depth.

-- campaigns.link_mode — NOT NULL DEFAULT 'manual' so every existing campaign
-- keeps behaving identically with zero change.
ALTER TABLE public.campaigns
  ADD COLUMN link_mode text NOT NULL DEFAULT 'manual';
--> statement-breakpoint

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_link_mode_check
  CHECK (link_mode IN ('manual', 'tracked'));
--> statement-breakpoint

-- short_domains -------------------------------------------------------------
CREATE TABLE public.short_domains (
  id          serial PRIMARY KEY,
  org_id      uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  brand_id    integer NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  domain      text    NOT NULL,
  status      text    NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_domains_status_check CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX short_domains_org_id_domain_unique
  ON public.short_domains (org_id, domain);
--> statement-breakpoint
CREATE INDEX short_domains_org_id_idx ON public.short_domains (org_id);
--> statement-breakpoint
CREATE INDEX short_domains_brand_id_idx ON public.short_domains (brand_id);
--> statement-breakpoint

-- link_destinations ---------------------------------------------------------
CREATE TABLE public.link_destinations (
  id         serial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  url        text NOT NULL,
  url_hash   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX link_destinations_org_id_url_hash_unique
  ON public.link_destinations (org_id, url_hash);
--> statement-breakpoint
CREATE INDEX link_destinations_org_id_idx ON public.link_destinations (org_id);
--> statement-breakpoint

-- links ---------------------------------------------------------------------
CREATE TABLE public.links (
  id                   bigserial PRIMARY KEY,
  org_id               uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code                 text    NOT NULL,
  short_domain_id      integer NOT NULL REFERENCES public.short_domains(id) ON DELETE RESTRICT,
  destination_id       integer NOT NULL REFERENCES public.link_destinations(id) ON DELETE RESTRICT,
  campaign_id          integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  stage_id             integer NOT NULL REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  creative_id          integer REFERENCES public.creatives(id) ON DELETE SET NULL,
  contact_id           uuid    NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  send_token           text    NOT NULL,
  campaign_tracking_id text    NOT NULL,
  stage_tracking_id    text    NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- code is globally unique: the public redirect has only the code to resolve.
CREATE UNIQUE INDEX links_code_unique ON public.links (code);
--> statement-breakpoint
-- "one link per message": retries reuse, genuinely new sends mint fresh.
CREATE UNIQUE INDEX links_stage_contact_send_token_unique
  ON public.links (stage_id, contact_id, send_token);
--> statement-breakpoint
CREATE INDEX links_org_id_idx ON public.links (org_id);
--> statement-breakpoint
CREATE INDEX links_campaign_id_idx ON public.links (campaign_id);
--> statement-breakpoint
CREATE INDEX links_stage_id_idx ON public.links (stage_id);
--> statement-breakpoint
CREATE INDEX links_contact_id_idx ON public.links (contact_id);
--> statement-breakpoint
CREATE INDEX links_destination_id_idx ON public.links (destination_id);
--> statement-breakpoint

-- clicks (defined, UNWIRED this phase) --------------------------------------
CREATE TABLE public.clicks (
  id             bigserial PRIMARY KEY,
  org_id         uuid   NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  link_id        bigint NOT NULL REFERENCES public.links(id) ON DELETE CASCADE,
  clicked_at     timestamptz NOT NULL DEFAULT now(),
  ip             text,
  user_agent     text,
  referer        text,
  classification text   NOT NULL DEFAULT 'unknown',
  CONSTRAINT clicks_classification_check
    CHECK (classification IN ('human', 'bot', 'prefetch', 'unknown'))
);
--> statement-breakpoint

CREATE INDEX clicks_link_id_idx ON public.clicks (link_id);
--> statement-breakpoint
CREATE INDEX clicks_org_id_idx ON public.clicks (org_id);
--> statement-breakpoint
CREATE INDEX clicks_clicked_at_idx ON public.clicks (clicked_at);
--> statement-breakpoint

-- RLS: short_domains --------------------------------------------------------
ALTER TABLE public.short_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "short_domains_select_own_org"
  ON public.short_domains FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "short_domains_insert_operator_or_higher"
  ON public.short_domains FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = short_domains.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "short_domains_update_operator_or_higher"
  ON public.short_domains FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = short_domains.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = short_domains.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- RLS: link_destinations ----------------------------------------------------
ALTER TABLE public.link_destinations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "link_destinations_select_own_org"
  ON public.link_destinations FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "link_destinations_insert_operator_or_higher"
  ON public.link_destinations FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = link_destinations.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- RLS: links ----------------------------------------------------------------
ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "links_select_own_org"
  ON public.links FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "links_insert_operator_or_higher"
  ON public.links FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = links.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- RLS: clicks ---------------------------------------------------------------
-- SELECT is org-scoped. INSERT happens server-side via the privileged DB
-- role (the Phase-2 public redirect), which bypasses RLS — so no
-- authenticated INSERT policy is defined (there is no auth.uid() on a public
-- click). Org members can read their own org's clicks for reporting.
ALTER TABLE public.clicks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "clicks_select_own_org"
  ON public.clicks FOR SELECT
  USING (org_id = public.current_org_id());
