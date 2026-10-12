# 1b — Stage URL ↔ brand via `offer_landing_pages`: recon & migration proposal

_Parent: [869ency4b](https://app.clickup.com/t/869ency4b) · P1: [869endkj6](https://app.clickup.com/t/869endkj6) · Date: 2026-08-22 · Status: **recon complete — awaiting approval, nothing built**_

Read against `origin/main` @ `7485f76` and the live production DB, 2026-08-22.
**No migration written, no branch, no code.**

---

## ⚠️ 0. The data moved since yesterday. Two campaigns were re-branded today.

My 1b recon on 2026-08-21 reported **6** stages whose destination host didn't match the campaign's
brand. Re-run today it is **11**, and the difference is not drift in my query — it is production
changing underneath it.

| campaign | was (2026-08-21) | now (2026-08-22) | changed at |
|---|---|---|---|
| **902** Wellaray 08/21 | brand **8 Guide Kin** | brand **142 LumZen** | 11:16 UTC |
| **923** Lulutox (renamed AstroEnergy_v2 → Manifestation) | brand **143 FitsYou** | brand **142 LumZen** | 11:40 UTC |

Consequences, all verified:

- **Campaign 902's five stages** (2990, 2991, 3027, 3031, 3032) all point at `www.guidekn.com` and
  are now under a LumZen campaign. Three already sent — **19,659 messages** — but they sent on
  08-21 *before* the rebrand, when the campaign was Guide Kin, so they were consistent at the time.
  Two (3031, 3032) are still `pending` with a Guide Kin destination on a LumZen campaign.
- **Campaign 923's stages 3018/3019** are still on **phone 234 (+18444061736, FitsYou)** under a now-LumZen
  campaign. Its two newer stages (3044, 3045) use phone 114 (LumZen) and `www.lumzen.co` — consistent.
- **No flagged stage has sent today.** Nothing shipped a wrong-brand destination since the rebrand.

**This is the single strongest argument for the ruled design.** Today the destination is a frozen
absolute URL, so re-branding a campaign silently orphans every stage's link. Storing
`landing_page_id` and constructing the URL from the campaign's brand at read time makes a rebrand
self-correcting instead of silently wrong.

### It also exposes a real gap in 1a that has now been realised twice

`phone_brand_mismatched_stages` is **9 today, not the 12 I reported yesterday** — and the mix changed:

| phone | phone brand | campaign brand | stages |
|---|---|---|---|
| 114 `+18449903688` | LumZen | Guide Kin | 7 |
| **234** `+18444061736` | **FitsYou** | **LumZen** | **2** ← new |

Phone 234 was not a mismatch yesterday. It became one when campaign 923's brand changed.

My 1a guard grandfathers by "the (brand, number) pair is not changing", so a campaign PATCH that
sets brand **and** default number together passes — and the campaign's **existing stages keep the
old brand's number**, untouched by design. That is exactly the "what happens when a campaign's
brand changes?" question I raised during 1a recon and which was never ruled on. It is no longer
hypothetical. **It needs a ruling** (options at the end).

---

## 1. How the stage destination is stored and read today

### Stored in TWO places, and only one of them is constrained

| | what | rows |
|---|---|---|
| `campaign_stages.full_url` | the operator-facing destination; hand-typed or auto-derived | **1,185 of 1,198 stages** |
| `campaign_stages.short_url` | manual-mode pasted short link | sparse |
| `link_destinations.url` | the **minted** destination behind a tracked short link | **1,072** |

`full_url_auto` is **not a column** — it is a request-only flag telling the write route to rebuild
`full_url` rather than take the posted text.

### Every reader and writer of `campaign_stages.full_url`

**Writers**
- `app/api/campaigns/[campaignId]/stages/route.ts` — POST. Rebuilds when `full_url_auto`, else takes
  the posted text; runs `validateDestination(...)` on the hand-edited path.
- `app/api/campaigns/[campaignId]/stages/[stageId]/route.ts` — PATCH. Same shape; `full_url` is in
  its updatable set.
- `.../stages/[stageId]/duplicate/route.ts` — copies `source.full_url`, then rewrites `sub_id3` to
  the new stage's tracking id via `setUrlParam`.
- `app/api/campaigns/[campaignId]/duplicate/route.ts` — same, per stage, for a whole-campaign copy.
- `.../stages/[stageId]/split/route.ts` — `attachStageTracking` per sibling; also refreshes the
  source's own `full_url`.
- `scripts/backfill-guidekn-destinations.ts` — one-off repair; `--skip=516,517` for rows under
  manual review.

**Readers**
- `lib/sends/kickoff.ts` — **the send path**. Trusts the stored `full_url` only when it carries this
  stage's `tracking_id` **and** (for a guidekn `/lp/` URL) passes `validateDestination`; otherwise it
  discards it and rebuilds from `loadStageUrlContext` + `buildStageFullUrl`. Then mints it into
  `link_destinations`.
- `components/campaigns/stage-form.tsx` — the editor; auto-derives, and blocks Save on a
  `validateDestination` error.
- `app/(protected)/campaigns/[id]/page.tsx` — display.
- Test harnesses: `test-kickoff-fullurl.ts` asserts *the minted destination equals `full_url`
  exactly, not a rebuild*; `test-stage-copy-invariants.ts` asserts each copy's `sub_id3` equals its
  **own** tracking id and that `sub_id1` / `subid5` survive the rewrite.

⚠️ **`test-kickoff-fullurl.ts` is the guard 1b must not break.** If `landing_page_id` construction
happens at mint time, "minted == stored `full_url`" stops being the invariant. Either that test is
updated deliberately, or construction must write `full_url` at save time and mint from it unchanged.
I would keep minting from a stored `full_url` and construct at **save** time — it preserves the
existing invariant, keeps one code path for the send, and still lets a rebrand re-derive (by
re-saving the stage or via a targeted rebuild).

### Where the destination host is parsed

Only four places touch a destination host at all:

| place | what it does |
|---|---|
| `lib/stage-url.ts` | `GUIDEKN_LP_RE` / `GUIDEKN_DEST_RE` — regex, hardcoded `www.guidekn.com`; `new URL(u).searchParams.get("sub_id3")` (parses the URL, not the host) |
| `app/r/[code]/route.ts` | `new URL(url)` for an http/https protocol check before redirecting |
| `lib/links/root-redirect.ts` | `appHostname()` + `lookupBrandWebsiteByHost()` — maps a **short-domain** host to `brands.website` for the bare-root redirect. **The other consumer of `brands.website`.** |
| `lib/sends/short-domain.ts` | `normalizeShortDomain()` — strips scheme/path/port, lowercases, validates a bare hostname. **Reusable for deriving a landing host.** |

No reporting, attribution or analytics path parses the destination host — Keitaro keys off
`sub_id3`, not the URL.

---

## 2. The `NOT VALID` CHECK is on `link_destinations`, NOT `campaign_stages`

The ruling says to widen "the NOT VALID DB CHECK". Locating it precisely:

```sql
-- on public.link_destinations, convalidated = false
CHECK (url NOT LIKE '%guidekn.com/lp/%'
       OR url ~ '^https://www\.guidekn\.com/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$') NOT VALID
```

**`campaign_stages` has no destination CHECK at all** — its four CHECKs are behavioral-lane,
clickers-mutex, split-pair and status, all validated. So the DB guard protects the *minted* link,
not the stage. `campaign_stages.full_url` is guarded only in application code.

**The CHECK is conditional**, and that structure is load-bearing: a URL that is not a `/lp/` URL is
exempt entirely. 17 of the 1,072 destinations are non-`/lp/` paths (`/mind`, `/body`) and pass today
by exemption.

**Widening it is nearly free.** Keeping the conditional shape and allowing any brand's landing host:

| | rows |
|---|---|
| `/lp/` destinations total | **1,055** |
| would FAIL the widened check | **1** |
| non-`/lp/` rows (exempt, unchanged) | 17 |

The single failure is the known historic placeholder bug:
`https://www.guidekn.com/lp/knd?sub_id3=8_62_061226_3_s6_c124&subid3=sub_id3` — stage 516's lineage,
the row deliberately abandoned when 0094 shipped. Because the constraint stays `NOT VALID`, that row
is untouched; only future inserts of the same shape would be refused, which is the point.

⚠️ Note this is a **tightening as well as a widening**: today a `lumzen.co/lp/x` destination is
exempt (it isn't guidekn), and afterwards it must match the canonical shape. Of the 7 LumZen and 3
FitsYou destinations, **9 of 10 already conform**; the one that doesn't is the same `subid3` row.

---

## 3. Which host field is canonical — and `brands.website` is NOT normalized

The ruled construction is `https://www.<brands.website>/lp/<slug>`. The data does not support taking
that literally:

| brand | `brands.website` | bare host | trailing `/` | has `www.` |
|---|---|---|---|---|
| Guide Kin (8) | `https://www.guidekn.com` | `www.guidekn.com` | no | **yes** |
| LumZen (142) | `https://www.lumzen.co/` | `www.lumzen.co` | **yes** | **yes** |
| FitsYou (143) | `https://fitsyou.net/` | `fitsyou.net` | **yes** | **NO** |

- Prefixing `www.` literally would produce `www.www.guidekn.com` for two of the three brands.
- Using the value as-is would give FitsYou `fitsyou.net`, but **every FitsYou destination in
  production uses `www.fitsyou.net`** — 3 sales pages and 3 minted `link_destinations` rows.

So `brands.website` and the actual landing host **disagree for FitsYou today**, and `brands.website`
is additionally consumed verbatim by `root-redirect.ts` as a redirect target — so normalizing that
column in place would change an unrelated behaviour.

### The `gdkn.org` question — resolved

`gdkn.org` is a **short domain** (`short_domains`, brand-scoped, `is_default=true` for Guide Kin).
Short domains are the host of the *link in the SMS* (`gdkn.org/r/<code>`). The **destination** is the
landing page the short link redirects to (`www.guidekn.com/lp/<slug>`). They are different layers and
`gdkn.org` is **not** a candidate destination host. It mattered for the *1b validation rule I
proposed yesterday* (allowed-host set), but it is irrelevant to constructing a landing URL.

**Proposed: a dedicated `brands.landing_host` column** rather than deriving from `website`.
Deriving requires a guess (add `www.`? strip it?) that is wrong for at least one brand today, and
mutating `website` would change the bare-root redirect. A separate, explicitly-set field states the
answer instead of inferring it. Seed values — from what production actually uses — would be
`www.guidekn.com`, `www.lumzen.co`, `www.fitsyou.net`. **Seeding is a production data write and is
therefore your gate**; I would rather set three rows deliberately than have a migration guess.

---

## 4. `offers.sales_pages` already encodes brand — in the label

This is strong independent validation of the ruled design. All 33 offers have sales pages (55 total),
and operators are already hand-encoding the brand:

| offer | labels |
|---|---|
| 58 Lulutox | `gdkn-Reg`, `gdkn-Monks`, **`lmzn-Monks`**, **`fty-Monks`**, `lmzn-Reg`, `fty-Reg` |
| 61 Lunavelle | `Gdkn`, **`LumZen`**, **`Fitsyou`** |
| 62 Kinzeno | `Gdkn-KND`, `Gdkn-KNN`, `Gdkn-KCWV`, `Gdkn-14418-kdtc` |

Every sales-page host is one of the three brand sites (`www.guidekn.com` ×48, `www.lumzen.co` ×4,
`www.fitsyou.net` ×3) — **zero external hosts**. The same slug is duplicated per brand
(`Monks` exists three times, once per host), which is precisely the duplication `kind=slug` removes.

**Shape check for `kind=slug`:** **46 of 55** sales pages are the canonical `/lp/<slug>` shape.
The other 9 are not (`/`, `/body`, `/mind`, …) — those are the `kind=external_url` cases. So the
two-kind design covers the real data with nothing left over.

---

## 5. ⚠️ A latent contradiction the ruling inherits: UTM tags vs the single-param rule

`GUIDEKN_DEST_RE` allows **exactly one** query param (`sub_id3`). But `buildStageFullUrl` appends
every selected UTM tag after it. Those two cannot both hold.

Today it does not bite, and the numbers say why:

- **271 stages** carry `utm_tag_ids` that resolve to real tags; **261** of those are on a `/lp/`
  destination.
- Yet **0** `/lp/` stage `full_url`s contain a second param. The only multi-param `full_url` in the
  entire table is stage 516's `clicks2scale.com` URL, which is not `/lp/` at all.

So those stages' URLs were hand-set or predate the tags. **Re-saving any of them in auto mode today
would append a tag and `validateDestination` would reject it** — the stage form would block Save.

And the tag that would be appended is instructive: of the three defined UTM tags, one is
`tag_id: "subid3"`, `value_source: "sub_id3"` — i.e. it appends the literal `subid3=sub_id3`, which
is **exactly the "unsubstituted template placeholder" defect** `validateDestination` names, and
exactly the one row that would fail the widened CHECK.

**Keeping the single-param rule is therefore fine for the data, but it means UTM tags and canonical
`/lp/` destinations remain mutually exclusive.** Worth an explicit decision rather than inheriting it
silently. My recommendation: keep the single-param rule, and have the landing-page picker **disable
UTM tag selection when `kind=slug`**, so the incompatibility is visible in the UI instead of
appearing as a Save error.

---

## Migration proposal

Two migrations, as ruled.

### `0150_offer_landing_pages.sql`

```sql
CREATE TABLE public.offer_landing_pages (
  id            serial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  offer_id      integer NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'slug',
  slug          text,
  external_url  text,
  is_default    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT offer_landing_pages_kind_check CHECK (kind IN ('slug','external_url')),
  CONSTRAINT offer_landing_pages_status_check CHECK (status IN ('active','disabled')),
  -- Exactly one side populated, per kind. Without this a 'slug' row could carry
  -- an external_url that silently wins (or loses) at construction time.
  CONSTRAINT offer_landing_pages_shape_check CHECK (
    (kind = 'slug'         AND slug IS NOT NULL AND external_url IS NULL) OR
    (kind = 'external_url' AND external_url IS NOT NULL AND slug IS NULL)
  ),
  -- Mirrors the canonical /lp/<slug> shape: lowercase alphanumerics only. An
  -- underscore here is the exact signature of the tracking-id-in-the-path bug
  -- 0094 was written to stop, so it is rejected at the source.
  CONSTRAINT offer_landing_pages_slug_shape_check CHECK (
    slug IS NULL OR slug ~ '^[a-z0-9]+$'
  )
);

-- Ruled: unique (offer_id, slug) for kind='slug'. Partial, so external_url rows
-- (slug NULL) do not collide, and a DISABLED page still holds its slug — freeing
-- it on disable would let a new page silently inherit old links' meaning.
CREATE UNIQUE INDEX offer_landing_pages_offer_slug_uniq
  ON public.offer_landing_pages (offer_id, slug) WHERE kind = 'slug';

-- At most one default per offer (the short_domains 0140 pattern).
CREATE UNIQUE INDEX offer_landing_pages_one_default_per_offer
  ON public.offer_landing_pages (offer_id) WHERE is_default;

CREATE INDEX offer_landing_pages_org_offer_idx
  ON public.offer_landing_pages (org_id, offer_id);

ALTER TABLE public.offer_landing_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "offer_landing_pages_select_own_org"
  ON public.offer_landing_pages FOR SELECT
  USING (org_id = public.current_org_id());

-- NULL ⇒ exactly today's behaviour. No backfill; all 1,198 existing stages stay NULL.
ALTER TABLE public.campaign_stages
  ADD COLUMN landing_page_id integer
  REFERENCES public.offer_landing_pages(id) ON DELETE SET NULL;

CREATE INDEX campaign_stages_landing_page_idx
  ON public.campaign_stages (landing_page_id) WHERE landing_page_id IS NOT NULL;
```

`ON DELETE SET NULL` on the stage FK, not CASCADE: deleting a landing page must never delete a
stage — the stage falls back to its stored `full_url`, which is exactly the legacy path.

### `0151_link_destinations_brand_host_shape.sql` (separate, as ruled)

```sql
ALTER TABLE public.link_destinations
  DROP CONSTRAINT IF EXISTS link_destinations_guidekn_url_shape;

ALTER TABLE public.link_destinations
  ADD CONSTRAINT link_destinations_landing_url_shape CHECK (
    url NOT LIKE '%/lp/%'
    OR url ~ '^https://(www\.guidekn\.com|www\.lumzen\.co|www\.fitsyou\.net)/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$'
  ) NOT VALID;
```

Conditional shape preserved, single-param rule preserved, `NOT VALID` preserved. Impact measured
above: of 1,055 `/lp/` rows, **1** would fail (the known `&subid3=sub_id3` row), and it is
grandfathered by `NOT VALID`.

⚠️ **The host list is hardcoded, exactly as today.** A DB CHECK cannot subquery `brands`. That means
**adding a fourth brand requires a migration** — a real cost, and the honest alternative is dropping
the DB check entirely and relying on application validation. I propose keeping it (defense in depth
is why 0094 exists) with a guard asserting the CHECK's host list matches the brands table, the same
shape as the rule-type registration guard.

---

## Open questions before I write anything

1. **`brands.landing_host`** — add the column (recommended) or derive from `brands.website`? If
   added, seeding the three values is a production data write and needs your approval.
2. **Campaign rebrand** — now realised twice in production. When a campaign's brand changes, its
   existing stages keep the old brand's phone and destination. Options: (a) block the brand change
   while stages exist; (b) allow it and re-derive `full_url` for stages with a `landing_page_id`,
   leaving legacy NULL stages alone; (c) allow and warn. I recommend **(b)** — it is the reason to
   build 1b at all — plus a warning listing the legacy stages it cannot fix.
3. **Construction at save time or mint time?** I recommend **save time**, preserving the existing
   `test-kickoff-fullurl.ts` invariant (minted == stored `full_url`).
4. **UTM tags with `kind=slug`** — disable tag selection in the picker (recommended), or drop the
   single-param rule?
5. **Fourth-brand cost** — accept that a new brand needs a migration to widen the CHECK, or drop the
   DB check and rely on application validation?
6. The 11 currently-flagged stages stay legacy (NULL) per the ruling — confirm, given the list is now
   11 not 6, and that 2 of them (3031, 3032) are **pending on an active campaign**.

Nothing will be written until these are answered.
