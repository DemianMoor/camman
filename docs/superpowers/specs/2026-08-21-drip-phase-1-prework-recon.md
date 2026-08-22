# Drip Campaigns — Phase 1 pre-work: recon & findings

_Parent card: [869ency4b](https://app.clickup.com/t/869ency4b) · P1 card: [869endkj6](https://app.clickup.com/t/869endkj6) · Date: 2026-08-21 · Status: **recon complete, awaiting approval — nothing built**_

Phase 0 recon: [2026-08-21-drip-campaigns-phase-0-recon.md](2026-08-21-drip-campaigns-phase-0-recon.md)

**Read against** `origin/main` @ `c9ae3ea` (via `git show`), and the live production database
`rtdarhkkjwcetlmruftl`, 2026-08-21 ~20:15–20:40 UTC. No code changed, no branch created.

**Two of the four deliverables hit their stated stop condition.** 1a and 1b both have existing
production data that the new enforcement would reject, including **active campaigns with sends
scheduled tonight and tomorrow**. Details and the exact lists are below; both need a ruling before
any enforcement ships.

---

## 1.0 — Preview migration race

### What causes it

`package.json`:
```
"vercel-build": "if [ \"$VERCEL_ENV\" = \"preview\" ]; then npm run db:migrate; fi && next build"
```

**Two Vercel projects build every commit of every PR against this repo**, and both get
`VERCEL_ENV=preview`, so both run `db:migrate`:

| Vercel project | preview `DATABASE_URL` target | role |
|---|---|---|
| `camman` | `camman-v2` DB (`fdzxzxayhknywvmrhjcj`) — preview scope | the real app; its preview is what a branch is clicked through on |
| `camman-v2` | `camman-v2` DB — **one entry targeting `production,preview`** | the external demo (production branch `demo`) |

Confirmed from the Vercel API (env var names + targets only, no values read): `camman` has
`DATABASE_URL` as **two separate entries**, one scoped `preview` and one `production`; `camman-v2`
has a **single** entry scoped `production,preview`. So both projects' preview builds point at the
same database, and they race.

Observed on PR #108: `camman-v2`'s build failed ~0.9s into `db:migrate` while `camman`'s applied
0146 successfully a minute later. Redeploying the **identical commit** passed, which is what proves
contention rather than migration content. Before that PR, `camman-v2` had succeeded on 12
consecutive deployments — it only fails when a PR actually introduces a migration.

### Proposal — gate on a project-scoped env var

```diff
- "vercel-build": "if [ \"$VERCEL_ENV\" = \"preview\" ]; then npm run db:migrate; fi && next build"
+ "vercel-build": "if [ \"$VERCEL_ENV\" = \"preview\" ] && [ \"$RUN_PREVIEW_MIGRATIONS\" = \"1\" ]; then npm run db:migrate; fi && next build"
```

with `RUN_PREVIEW_MIGRATIONS=1` set **only** on Vercel project `camman` → **Preview** environment.

Result: exactly one project migrates. `camman-v2` (both its previews and its `demo` production
target) builds only.

**Why `camman` is the one that keeps migrating:** it is the project whose preview a developer
actually opens to check a branch, so it is the one that must have the schema its branch expects.
`camman-v2`'s production target already never migrated (`VERCEL_ENV=production` fails the existing
condition), so the demo database has *always* depended on `camman` previews for its schema. This
change does not alter that; it just stops a second racer.

**Fail-safe direction:** the gate is opt-**in**. An unset variable means "do not migrate". A new
Vercel project, a fork, or a preview built with the variable missing will not touch a database —
it will fail loudly at runtime on a missing column instead, which is the safe direction. The
alternative (opt-out, e.g. `SKIP_PREVIEW_MIGRATIONS`) would make every new environment a migrator
by default. Not chosen.

**Alternative considered and rejected:** turning off preview deployments for `camman-v2` at the
project level. It removes a working preview of the demo project, and it is a dashboard setting
with no trace in the repo — invisible to review and easy to undo by accident. The env-var gate is
one reviewable line.

**Docs:** `docs/preview-environment.md` gets the mechanism, the variable, and the explicit warning
that a preview build is enough to apply a migration to the shared demo database.

### Approval needed
- Confirm the approach and the variable name `RUN_PREVIEW_MIGRATIONS`.
- Confirm you will add it in the Vercel dashboard (`camman` → Preview → `RUN_PREVIEW_MIGRATIONS=1`)
  — **I cannot set env vars**, and merging the code change before the variable exists means preview
  migrations stop for everyone until it is added.

**Ordering matters:** set the variable **first**, then merge. The reverse leaves a window where no
project migrates previews.

### Incidental, unrelated to this task
`SEND_ENABLED` is present on `camman` **Preview**. A preview points at the `camman-v2` database,
which per `docs/preview-environment.md` holds **zero rows in `provider_credentials`**, so a drain
would refuse with `no_credentials` before sending. Not a live risk today, but it rests on that
table staying empty rather than on a switch. Flagging only; out of scope.

---

## 1a — Brand → numbers

### ⛔️ STOP CONDITION MET — 12 existing stages use a number of a different brand

All 12 are **the same number**: **phone 114, `+18449903688`, Text Request toll-free, `brand_id=142`
(LumZen)** — used on **Guide Kin (brand 8)** campaigns.

| stage | campaign | campaign status | stage status | send rows | sent |
|---|---|---|---|---|---|
| 2478 | 787 · S1 CALIBRATION — EMSense (txr) | archived | draft | 50 | 50 |
| 2962 | 896 · Harmonia - 15170 - 08/20/26 | completed | success | 2,501 | 2,501 |
| 2963 | 896 · Harmonia - 15170 - 08/20/26 | completed | success | 2,499 | 2,499 |
| 2964 | 897 · Wellaray - 15169 - 08/20/26 | **active** | success | 2,508 | 2,508 |
| 2965 | 897 · Wellaray - 15169 - 08/20/26 | **active** | success | 2,492 | 2,492 |
| 2990 | 902 · Wellaray - 15169 - 08/21/26 | **active** | success | 5,058 | 5,058 |
| 2991 | 902 · Wellaray - 15169 - 08/21/26 | **active** | success | 4,942 | 4,942 |
| **2995** | 897 · Wellaray - 15169 - 08/20/26 | **active** | **pending** | **4,852** | 0 |
| **3027** | 902 · Wellaray - 15169 - 08/21/26 | **active** | **pending** | **19,336** | 0 |
| **3029** | 924 · Wellaray - 15169 - 08/22/26 | **active** | **pending** | **9,390** | 0 |
| 3031 | 902 · Wellaray - 15169 - 08/21/26 | **active** | draft | 0 | 0 |
| 3032 | 902 · Wellaray - 15169 - 08/21/26 | **active** | draft | 0 | 0 |

**Four stages are live and unsent: 33,578 materialized `stage_sends` rows**, scheduled
2026-08-21 22:00 UTC (stages 2995, 3027) and 2026-08-22 14:00 UTC (stage 3029).

Enforcement as specified is **on stage save**, so those rows would still dispatch — but the
operator could not create tomorrow's equivalent campaign the same way, and re-saving any of those
stages would start failing.

### Reading of the evidence

This looks like a **mis-tagged phone**, not an intentional cross-brand pattern:

- Every other Guide Kin campaign uses a Guide Kin number. Top usage: phone 26 (`63109`, 630
  stages), 43 (`621637`, 388), 27 (101), 224 (12) — all `brand_id=8`. Phone 114 is the only
  outlier, at 12 stages.
- Phone 114 has `short_domain_id = NULL`, so it is not bound to a LumZen domain either.
- LumZen (brand 142) has only 5 campaigns total; the number is being used almost exclusively for
  Guide Kin work.

**Most likely fix: re-tag phone 114 to `brand_id = 8` (Guide Kin)** — a one-row production data
change, which is your approval gate. If instead the number is genuinely shared, then brand→number
is not a strict 1:many and the model needs a join table, which is a materially bigger change.

### Capacity check — enforcement does not strand anyone, but FitsYou is tight

| brand | active numbers | API-sendable | distinct numbers actually used |
|---|---|---|---|
| Guide Kin (8) | 31 | 6 | 9 |
| LumZen (142) | 5 | 3 | 3 |
| **FitsYou (143)** | **1** | **1** | 1 |

FitsYou has exactly one number (`+18444061736`). Enforcement is satisfiable, but that brand has no
rotation headroom — relevant later, since Drip requires multi-number rotation (Phase 5).

### Implementation shape (once approved)

1. `/api/provider-phones/list` — currently does **not select `brand_id` at all**. Add it to the
   `select`, plus an optional `brand_id` query filter. Additive; existing callers ignore the new field.
2. Pickers filtered by the campaign's brand — **two call sites**:
   `components/campaigns/campaign-form-state.ts:201` (campaign default send-from number, writes
   `campaigns.default_provider_phone_id`) and `components/campaigns/stage-inline-creator.tsx:158`
   (stage number).
3. Server-side re-check on stage save, rejecting a mismatch with a clear error code
   (e.g. `phone_brand_mismatch`) naming both brands. **The server check is the enforcement; the
   picker filter is only convenience.**

**Open question the spec does not cover:** what happens when a campaign's `brand_id` changes after
a number is chosen? Options: block the brand change while a mismatched number is set; clear the
number; or allow and let stage save fail later. Needs a ruling — I would block the change with a
clear message, since silently clearing a sending number is worse.

---

## 1b — Stage URL ↔ brand

### First: what actually produces a stage's URL

The destination is **not** a brand-owned URL today. `buildStageFullUrl` builds it from the
**offer's selected sales page**:

```
<sales page URL>?sub_id3=<stage tracking id>&<utm tag>=<value>…
```

The sales page comes from `offers.sales_pages` (JSONB `{label, url}[]`), picked by
`campaign_stages.sales_page_label` — see `lib/stage-url-context.ts`. **`offers` has no `brand_id`**
(confirmed: zero columns named `brand_id` on that table).

So "the stage URL must belong to the campaign's brand" is really a constraint that
**couples offers to brands**: an offer whose sales pages live on `guidekn.com` becomes usable only
by Guide Kin campaigns. That is a real product decision, not just a validation — please confirm it
is what you intend.

### Candidate definitions of "belongs to the brand"

| source | what it is | suitability |
|---|---|---|
| `brands.website` | brand's main site, full URL — `https://www.guidekn.com`, `https://www.lumzen.co/`, `https://fitsyou.net/` | good, but note the trailing-slash / `www.` inconsistency needs normalising |
| `short_domains.domain` (brand-scoped, `NOT NULL` brand_id) | the link-shortener domains — what mint reads | **required**, and it is what makes `gdkn.org` legitimate |
| `brands.short_link_base` | **LEGACY.** Schema comment: "no longer surfaced in the UI and read by nothing functional… safe to drop" | **do not use** |

**`gdkn.org` is the case that rules out the naive rule.** It is an `active`, `is_default=true`
short domain for Guide Kin, but a *different registrable domain* from `guidekn.com`. Any rule of
the form "same registrable domain as `brands.website`" would reject a legitimate, in-use Guide Kin
domain.

**Proposed rule:** allowed host set for a brand = `brands.website` host (matching that host or any
subdomain of it) **∪** that brand's `short_domains.domain` values. The stage's `full_url` host must
be in it; in manual mode the `short_url` host must be in the brand's `short_domains` specifically.

Current allowed sets:

| brand | allowed hosts |
|---|---|
| Guide Kin (8) | `guidekn.com` (+ subdomains), `g.guidekn.com`, `gdkn.org`, `go.guidekn.com` |
| LumZen (142) | `lumzen.co` (+ subdomains), `g.lumzen.co`, `sms.lumzen.co` |
| FitsYou (143) | `fitsyou.net` (+ subdomains), `g.fitsyou.net`, `sms.fitsyou.net` |

Sub-question: should `short_domains` with `status='pending'` or `'archived'` count as belonging?
I would say **yes for validation** (the domain *is* the brand's) even though only `active` is
mintable — otherwise archiving a domain retroactively invalidates historical stages.

### ⛔️ STOP CONDITION MET — 6 existing stages would fail this rule

| stage | campaign | campaign status | stage status | brand | destination host |
|---|---|---|---|---|---|
| 516 | 120 · Kinzeno - 14508 - 13/06/26 (Ear Relief) | completed | success | Guide Kin | `clicks2scale.com` |
| 2881 | 869 · Novubrainplus - 14524 - 08/18/26 | completed | success | LumZen | `www.guidekn.com` |
| 2997 | 905 · Lunavelle - 14443 - 08/21/26 - BS | completed | failed | FitsYou | `www.guidekn.com` |
| 2998 | 905 · Lunavelle - 14443 - 08/21/26 - BS | completed | failed | FitsYou | `www.guidekn.com` |
| **3019** | 923 · Lulutox - 13759 - 08/21/26 AstroEnergy_v2 | **active** | **pending** | FitsYou | `www.lumzen.co` |
| **3029** | 924 · Wellaray - 15169 - 08/22/26 - WL_TR | **active** | **pending** | Guide Kin | `www.lumzen.co` |

Two are **active and pending**. **Stage 3029 fails BOTH 1a and 1b** — wrong-brand number *and*
wrong-brand destination — and carries 9,390 materialized rows scheduled for 2026-08-22 14:00 UTC.

Stage 516 is the deliberately-abandoned stage from the guidekn URL-shape work (the `NOT VALID`
CHECK constraint was left unvalidated for exactly this row); `clicks2scale.com` is a network URL,
which the existing `validateDestination` explicitly allows as out of scope.

That last point matters: the existing guard **deliberately permits non-guidekn destinations**
("network URLs, other domains"). A brand-ownership rule would reverse that policy. If network
destinations must stay legal, the rule needs an explicit allow-list of non-brand hosts, or it
should apply only to hosts we recognise as brand-owned by *some* brand.

### Approval needed for 1b
1. Confirm coupling offers to brands via their sales-page hosts is intended.
2. Confirm the allowed-set definition (`brands.website` + `short_domains`, `short_link_base`
   excluded, pending/archived domains counted).
3. Rule on the 6 stages — especially 3019 and 3029, which are live.
4. Rule on non-brand destinations (e.g. `clicks2scale.com`): still legal, or now rejected?

---

## 1c — `contact_attributes`

No stop condition. Two scope discoveries that change the size of the work.

### ⚠️ Discovery 1 — there is no contact detail page

`app/(protected)/contacts/` contains **only** `layout.tsx` and `page.tsx` (the list). There is no
`/contacts/[id]` route, no contact-detail component, and nothing anywhere links to one. (There is
an API route `app/api/contacts/[id]/route.ts`, but no page.)

So deliverable **(ii) "attributes shown on contact detail" requires building a surface that does
not exist.** Two options:

- **(A) New `/contacts/[id]` page.** Follows the `contact-groups/[id]` precedent (layout + page +
  tabs). More work, but it is the natural home for attributes, group membership, send history and
  opt-out state later — and Drip will want it.
- **(B) Detail drawer/sheet on the list row.** Much smaller; no new route; keeps `/contacts` as the
  single surface. Weaker as a foundation.

I would pick **(A)** — Phases 4–7 repeatedly need a per-contact view — but it is your call and it
is the difference between roughly a day and roughly an hour.

### ⚠️ Discovery 2 — CSV mapping has a pattern to copy, and it is not in the phone upload form

- `components/phone-upload-form.tsx` (the shared uploader behind all four audience entry points)
  already uses **papaparse** and already does *header detection* for one specific column
  (`findReplyTimeColumn`, for TextHub STOP exports). It has **no** generic column→field mapping step.
- **`components/campaigns/results-import-form.tsx` is the existing column→field mapping UI**, backed
  by `result-import-mappings` (API + validators + saved per-provider templates). That is the pattern
  to reuse for (iii) rather than inventing one.

Decision needed: does the attribute mapping get **saved templates** (like result-import-mappings) or
is it per-upload only? Per-upload is simpler; templates matter if partners send recurring CSVs —
which Phase 3's pull connectors imply they will.

### Table design (proposed)

```sql
CREATE TABLE public.contact_attributes (
  contact_id   uuid PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  first_name   text,
  last_name    text,
  address      text,
  state        text,
  country      text,
  email        text,
  gender       text,
  income_band  text,
  kids         boolean,
  married      boolean,
  dob          date,
  interest_tag text,
  partner_slug text,
  source       text,
  extra        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

- **1:1 via `contact_id` as PK** — as specified.
- **`org_id` carried** even though it is derivable through `contacts`, because every RLS policy and
  every app query filters on it directly. RLS: enabled, SELECT-only `org_id = public.current_org_id()`,
  no write policies — the 0085/0146 shape.
- **Zero collision risk**: `contacts` has only `id, org_id, phone_number, is_archived, archived_at,
  created_at, updated_at, line_type, carrier_norm, messaging_status`. No contacts column changes.
- **`dob date`, age never stored** — age band derived at query time. Under 18 is **never eligible**;
  that must be enforced in the rule SQL itself, not left to the operator's band choice, so a NULL
  `dob` is *not* silently treated as adult.
- **`extra jsonb`** for undefined fields. Recommend a GIN index only when a query needs it — not up front.
- **CHECK constraints** on `gender`, `income_band`, `interest_tag` — or leave them free text?
  Constraining `income_band` to the six bands is worth it (it is a closed set and drives a rule);
  `interest_tag` starts as ACA / Medicare / Home_Services but is explicitly extensible, so I would
  leave it unconstrained and validate in Zod. Your call.

Bands, as specified:
- age `18–24 / 25–34 / 35–44 / 45–54 / 55–64 / 65+` (under 18 never eligible)
- income `<25k / 25–50k / 50–75k / 75–100k / 100–150k / 150k+`

### Segment rule types (iv)

Nine new types: `gender`, `age_band`, `state`, `country`, `income_band`, `kids`, `married`,
`interest_tag`, `partner_slug`.

All **set-shaped** (a chosen set of codes), so each needs registering in all four places —
confirmed present on `origin/main`:

1. `RULE_TYPES` — `lib/validators/segment-rule-types.ts`
2. `validateValueByShape` — `lib/validators/segment-rules.ts`
3. `isRuleComplete` — `lib/segment-rules-eval.ts`
4. `verifyValueOwnership` — `lib/api/segment-rule-value-ownership.ts` (shared by both rule routes)

Plus a **fifth** place the card does not list but which is mandatory: **the SQL emitter in
`lib/segment-rules-eval.ts`** must gain a branch per rule type, or the rule validates and saves but
matches nobody.

`phone_type_set` / `carrier_set` (migration 0098) are the closest precedent — new `ValueShape`
entries with a `isStringSubsetOf` guard. `kids` and `married` are booleans; modelling them as a
set of `["yes","no"]` keeps every new type on one shape and lets "either" be expressed.

⚠️ **Preserve the `is_not` guard.** `isRuleComplete` must stay identical-or-stronger than the eval's
fallback: under `EXCEPT`, an incomplete `is_not` rule flips "nobody" into "everybody".

**Test**: one that creates each of the nine rule types through the real API and asserts it saves,
reloads, previews, and evaluates — the check that would have caught `phone_type`/`carrier` shipping
uncreatable.

### Approval needed for 1c
- The migration (your standing gate).
- Contact detail: **(A) new page** or **(B) drawer**.
- CSV mapping: saved templates or per-upload only.
- CHECK constraints on `gender` / `income_band` / `interest_tag`: yes or Zod-only.

---

## Summary of what is blocked

| # | Status | Blocking question |
|---|---|---|
| 1.0 | ready to build | approve approach + variable name; **you set the Vercel variable before I merge** |
| 1a | **⛔️ stopped** | 12 stages, 4 live with 33,578 scheduled rows — re-tag phone 114 to Guide Kin, or model shared numbers? Plus: what happens when a campaign's brand changes? |
| 1b | **⛔️ stopped** | 6 stages, 2 live — confirm offer↔brand coupling, the allowed-host definition, the fate of those stages, and whether non-brand destinations stay legal |
| 1c | ready to build | migration approval; contact detail page vs drawer; mapping templates; CHECK constraints |

Nothing has been built. No branch, no migration, no code change.
