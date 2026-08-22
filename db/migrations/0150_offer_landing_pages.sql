-- Migration 0150: offer landing pages + brand landing host (Drip Phase 1, item 1b).
--
-- THE PROBLEM THIS SOLVES, observed in production on 2026-08-22: two campaigns
-- were re-branded (902 Guide Kin -> LumZen, 923 FitsYou -> LumZen) and every one
-- of their stages kept pointing at the OLD brand's landing pages. The stage
-- destination is stored today as a FROZEN ABSOLUTE URL, so a rebrand silently
-- orphans the link. Storing WHICH PAGE (landing_page_id) instead of WHICH URL,
-- and constructing the URL at MINT TIME from the campaign's brand at that
-- moment, makes a rebrand self-correcting.
--
-- Operators are already hand-encoding the brand in sales-page labels -- offer 58
-- carries 'gdkn-Reg', 'lmzn-Monks', 'fty-Monks'; offer 61 carries 'Gdkn',
-- 'LumZen', 'Fitsyou' -- duplicating the same slug once per brand. kind='slug'
-- removes exactly that duplication.
--
-- ADDITIVE AND REVERSIBLE. campaign_stages.landing_page_id is NULLABLE and
-- NULL means EXACTLY today's behaviour (build from offers.sales_pages /
-- the stored full_url). There is NO BACKFILL: all 1,198 existing stages stay
-- NULL, including the 11 currently flagged for manual review.

-- ── brands.landing_host ──────────────────────────────────────────────────────
--
-- ⚠️ WHY A NEW COLUMN INSTEAD OF DERIVING FROM brands.website.
-- `website` is not normalized and cannot be used as-is:
--     Guide Kin  https://www.guidekn.com   -> www.guidekn.com   (www, no slash)
--     LumZen     https://www.lumzen.co/    -> www.lumzen.co     (www, slash)
--     FitsYou    https://fitsyou.net/      -> fitsyou.net       (NO www)
-- Prefixing "www." literally yields www.www.guidekn.com for two of three brands;
-- using the value as-is gives FitsYou `fitsyou.net`, while every FitsYou
-- destination in production actually uses `www.fitsyou.net`. Getting this wrong
-- ships a 404 that silently kills attribution -- the exact failure 0094 exists
-- to prevent.
--
-- `brands.website` is ALSO consumed verbatim by lib/links/root-redirect.ts as
-- the bare-root redirect target, so normalizing it in place would change an
-- unrelated behaviour. This column states the landing host instead of inferring
-- it, and leaves `website` untouched.
--
-- NORMALIZED HOST ONLY: no scheme, no path, no port, no trailing dot.
ALTER TABLE public.brands
  ADD COLUMN landing_host text;
--> statement-breakpoint

COMMENT ON COLUMN public.brands.landing_host IS
  'Normalized bare host for this brand''s landing pages (e.g. www.guidekn.com). Used to build https://<landing_host>/lp/<slug> for offer_landing_pages of kind=slug. Distinct from `website` (the bare-root redirect target, not normalized) and from short_domains (the host of the link inside the SMS).';
--> statement-breakpoint

-- Bare host only: labels of [a-z0-9-] joined by dots with a 2+ char TLD. Mirrors
-- normalizeShortDomain() in lib/sends/short-domain.ts, so the two agree on what
-- a host is.
ALTER TABLE public.brands
  ADD CONSTRAINT brands_landing_host_shape_check CHECK (
    landing_host IS NULL
    OR landing_host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$'
  );
--> statement-breakpoint

-- Backfill the three active brands from what production ACTUALLY mints today
-- (verified against link_destinations and offers.sales_pages on 2026-08-22:
-- www.guidekn.com x1062, www.lumzen.co x7, www.fitsyou.net x3 -- zero other
-- hosts). Matched on the website host rather than the brand id so this is not
-- tied to one environment's serial values, and so it is a no-op anywhere the
-- brand does not exist.
UPDATE public.brands SET landing_host = 'www.guidekn.com'
  WHERE landing_host IS NULL AND website ILIKE '%guidekn.com%';
--> statement-breakpoint
UPDATE public.brands SET landing_host = 'www.lumzen.co'
  WHERE landing_host IS NULL AND website ILIKE '%lumzen.co%';
--> statement-breakpoint
UPDATE public.brands SET landing_host = 'www.fitsyou.net'
  WHERE landing_host IS NULL AND website ILIKE '%fitsyou.net%';
--> statement-breakpoint

-- ── offer_landing_pages ──────────────────────────────────────────────────────
CREATE TABLE public.offer_landing_pages (
  id            serial PRIMARY KEY,
  org_id        uuid NOT NULL,
  offer_id      integer NOT NULL,
  title         text NOT NULL,
  -- 'slug'         -> https://<brand.landing_host>/lp/<slug>, brand-resolved at mint
  -- 'external_url' -> the stored URL verbatim, any brand
  kind          text NOT NULL DEFAULT 'slug',
  slug          text,
  external_url  text,
  is_default    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT offer_landing_pages_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT offer_landing_pages_offer_id_offers_id_fk
    FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE CASCADE,

  CONSTRAINT offer_landing_pages_kind_check
    CHECK (kind IN ('slug', 'external_url')),
  CONSTRAINT offer_landing_pages_status_check
    CHECK (status IN ('active', 'disabled')),

  -- Exactly one side populated per kind. Without this a 'slug' row could also
  -- carry an external_url, and which one won at construction time would be an
  -- implementation detail rather than a stated rule.
  CONSTRAINT offer_landing_pages_shape_check CHECK (
    (kind = 'slug'         AND slug IS NOT NULL AND external_url IS NULL) OR
    (kind = 'external_url' AND external_url IS NOT NULL AND slug IS NULL)
  ),

  -- ⚠️ Lowercase alphanumerics ONLY, mirroring the canonical /lp/<slug> shape.
  -- An UNDERSCORE here is the exact signature of the tracking-id-glued-into-the-
  -- path defect that migration 0094 was written to stop (…/lp/knd8_62_…). Barring
  -- it at the source means that bug cannot be re-created through this table.
  CONSTRAINT offer_landing_pages_slug_shape_check
    CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+$')
);
--> statement-breakpoint

-- Ruled: unique (offer_id, slug) for kind='slug'. PARTIAL, so external_url rows
-- (slug NULL) never collide.
--
-- Deliberately NOT filtered on status: a DISABLED page keeps its slug. Freeing
-- the slug on disable would let a new page silently inherit the meaning of every
-- link already in the wild pointing at the old one.
CREATE UNIQUE INDEX offer_landing_pages_offer_slug_uniq
  ON public.offer_landing_pages (offer_id, slug) WHERE kind = 'slug';
--> statement-breakpoint

-- At most ONE default per offer (the short_domains 0140 pattern). Enforced by a
-- partial unique index rather than application code, which races.
CREATE UNIQUE INDEX offer_landing_pages_one_default_per_offer
  ON public.offer_landing_pages (offer_id) WHERE is_default;
--> statement-breakpoint

CREATE INDEX offer_landing_pages_org_offer_idx
  ON public.offer_landing_pages (org_id, offer_id);
--> statement-breakpoint

-- Tenant table: RLS on WITH an org-scoped SELECT policy and NO write policies --
-- the 0085 / 0146 / 0147 / 0149 shape.
ALTER TABLE public.offer_landing_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "offer_landing_pages_select_own_org"
  ON public.offer_landing_pages FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ── campaign_stages.landing_page_id ──────────────────────────────────────────
--
-- NULL ⇒ EXACTLY today's behaviour. No backfill.
--
-- ON DELETE SET NULL, never CASCADE: deleting a landing page must not delete a
-- stage. The stage falls back to its stored full_url, which is precisely the
-- legacy path -- so a deleted page degrades to today's behaviour instead of
-- destroying campaign history.
ALTER TABLE public.campaign_stages
  ADD COLUMN landing_page_id integer
  REFERENCES public.offer_landing_pages(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX campaign_stages_landing_page_idx
  ON public.campaign_stages (landing_page_id) WHERE landing_page_id IS NOT NULL;
