# Partner attribution via contact groups — recon

_Recon only. No code, no migrations, no prod writes. Written 2026-10-08._
_Read at `origin/main` `434c1566` (PR #327). Prod ledger confirmed at migration **0199**
(200 rows in `drizzle.__drizzle_migrations`), so the first migration here is **0200**._
_Every production number below was measured 2026-10-08 18:45–19:15 UTC, read-only; §9.4
lists my own heavy queries so the measurement traffic is not read as platform load._

Feature: attribute regular-campaign results and carrier-lookup costs to partners through a
contact group → partner link, shown in `/reports/partners` and the signed partner view.
Rulings R1–R8 are taken as decided; each is tested against live data below, and the
places where one is unworkable as literally written are called out (§9.1).

---

## Approval (2026-10-08) — changes to the plan and answers

Approved by the owner with four changes and answers to every question in §9.2.
Where this section and the body disagree, this section wins. ClickUp card
`869fem8bq`. Standing rules: every prod migration and data write stops at the
proposal and waits for an explicit go, preview (camman-v2) first, morning window
(05:00–06:00 UTC) only; stop and report after each phase.

**Changes**
- **C1 — lookup-rate fix ships first, as its own PR, before Phase 1**: calibrate
  only from `upload` / `backfill` batches; no qualifying batch in the window ⇒
  flat $0.0015 reported as `source: "flat"`, never `"ledger"`; show the before/after
  rate on the live pml report. *Shipped on branch `fix/lookup-rate-bulk-batches-only`
  (this doc's first commit rides with it): live pml/aca 2026-10-06..09 moved from
  $0.001563 (248 batches) to $0.001592 (18 bulk batches), lookup cost $24.74 → $25.21.*
- **C2 — 0200 does not `SET NOT NULL` on `partner_keys.partner_id`**: add column +
  backfill in 0200, deploy code that always writes it, verify, then `SET NOT NULL`
  in a follow-up migration (additive leads code).
- **C3 — the attribution cron has no watermark**: a stateless trailing lookback
  (e.g. 6 h, `ON CONFLICT DO NOTHING`) plus a daily repair pass, the
  `counted_clickers` pattern; registered in the cron heartbeat. (§5.2 described a
  watermark; superseded.)
- **C4 — the system drip groups ("Drip intake", "Drip sandbox") are exempt from R3
  via an explicit marker on the group**, not hard-coded ids.

**Answers to §9.2**
1. R4 scope: **all** of the contact's partner groups (as adopted).
2. **Rewrite `created_at` to `received_at`** for drip partner groups; enrichment
   stamps delivery time going forward; repair the 8,171 rows. No `appeared_at`
   column. Exit check: R3 count on pml-aca = 63.
3. Yes: strict `<` for R3; lowest group id for R4 ties.
4. Yes: segment-rule groups are never a partner entry.
5. Accepted; documented.
6. Yes: auto-link drip `<slug>-<tag>` groups at creation; link pml-aca → pml.
7. Yes: archiving a partner disables intake on its keys and kills its report link;
   the confirm dialog says both; restore re-enables. A sandbox-only partner gets no
   link; a file-only partner can have one.
8. See C1.
9. Yes: ids stay `partner_keys.*`; changing a group's partner requires
   `partner_keys.manage`.
10. Yes: the link moves to the partner, pml's hash copied. Phase 1 exit check:
    pml's existing link resolves and shows identical numbers before and after.
11. Yes: a Partner column on the internal table.
12. Yes: large-group recalcs run batched in the 05:00–06:00 UTC window; the link
    dialog warns when a group is large enough to be deferred.

**Build order:** C1 → Phase 1 → 2 → 3 → 4 → 5 as in §9.5, each phase gated on the
owner's go.

---

## 0. One screen

- **The partner entity does not exist.** Everything partner-shaped keys on `partner_keys`
  (4 rows: `internal-test`, `pml`, `docs-curl-verify`, `bsd` — `bsd` was created today,
  sandbox). The signed report link, the revenue toggle, the intake counters, the lead
  ledger and the report rows all hang off `partner_key_id`. R7 means a new `partners`
  table with `partner_keys.partner_id` under it; the token and revenue toggle move to the
  partner so a file-only partner can have a link (§1).
- **The link lives on `contact_groups.partner_id` (new, nullable).** The group screen
  (`/contact-groups/[id]`, edit dialog → `PATCH /api/contact-groups/[id]`) is the natural
  home; one plain `<Select>` (4 partners) (§2).
- **Membership has a reliable added-at.** `contact_contact_groups.created_at` is
  `NOT NULL DEFAULT now()`, 0 NULLs across 1,158,148 rows, and the group Contacts tab
  already shows it as "joined". Two defects for R3/R4: the partner-tag backfill (#311)
  stamped **8,171 of 14,180** pml-aca memberships up to 1 h 24 m *after* the lead arrived
  and *after* the system "Drip intake" membership, so a literal R3 strips credit from
  8,171 live leads; and 5,980 contacts have their earliest two memberships at one instant
  (ties need a rule) (§3).
- **Send attribution is a join, not a lookup.** `campaign_audience_pool` and `stage_sends`
  carry no source group. The 0132 pattern (`stage_sends ⋈ contact_contact_groups` on the
  recipient ∩ `campaigns.audience_contact_group_ids`) is reusable as-is, plus
  `created_at <= sent_at`. On ET day 2026-10-07: 55,246 regular sends, **0** reached a
  contact through no targeted group, **6,281 (11.4%)** through 2+ targeted groups — the
  R3/R4 resolver is exercised on every tenth send. Drip campaigns target no groups
  (6/6 have `audience_contact_group_ids = '{}'`), so drip and regular attribution are
  disjoint by construction — no double count possible (§4).
- **Storage: a side table at send grain, credited rows only, written by a cron tick.**
  `kickoff.ts` / `drain.ts` statements are untouched (so their plans are). Prototype:
  one ET day of regular sends resolves in **306 ms** warm; a 57K-member group's whole
  history (72 campaigns, 350,813 sends) scans in **1.19 s** + the insert of ~272K rows.
  The largest groups (Memory: 187K members, 234 campaigns) need a batched background
  recalc, not a request (§5).
- **Paid lookups are already a ledger.** `lookup_queue` keeps every row (787,583 `done`,
  one per phone, 0 orphans, batch → org + trigger); a `done` row is one billed call,
  cache hits never get a row. Date = `updated_at`. Tie to a group through the contact's
  membership as of that moment (verified: 10,031/10,031 rows of the latest upload batch
  had their membership 25 s *before* enqueue). Drip lookups stay on
  `lead_intake_daily.lookups_spent` (the contact does not exist yet at lookup time) (§6).
- **⚠️ R6's "existing calibrated rate" is about to decay 14×.** The 90-day window's
  `$0.001566` rests on 18 upload batches (2026-07-14 → 09-24). They age out between
  2026-10-12 and 2026-12-23; what remains is 200 `drip_intake` batches whose ledger reads
  `$1.52` over 14,237 lookups (`$0.000108`; 190 of 200 read ≤ 0). The rate stays
  `source: "ledger"` because the delta is positive. Needs a floor before R6 ships (§6.4).
- **R8 rename is small; the row grain change is not.** "Tag" → "Contact Group" touches
  one component, one type, two proof scripts and the docs. The real change is the row key
  moving from `(partner_key_id, interest_tag)` to `(partner_id, contact_group_id)` with
  drip rows mapped tag → `<slug>-<tag>` group by the existing naming rule (§7).
- **Partners screen: route and permissions can stay.** `/settings/partners` survives
  (the proxy exclusion is root-anchored; nothing matches it); only labels change. New
  `/api/partners/*` routes must be classified in `lib/authz/route-map.ts` or
  `scripts/test-route-map-coverage.ts` goes red (§8).
- **Five additive migrations, five phases** (§9.3, §9.5). Nothing destructive.

---

## 1. Partner data model today, and the path to a partner entity

### 1.1 What `partner_keys` is

[db/schema.ts](../../db/schema.ts) `partner_keys` (migrations 0152 / 0172): one row = one
intake credential **and** the only partner identity. Columns that are really *partner*
attributes: `partner_slug` (UNIQUE per org, immutable — "stamped onto every lead"),
`name`, `report_token_hash` / `_issued_at` / `_expires_at`, `report_show_revenue`.
Columns that are really *key* attributes: `token`, `secret_hash`, `secret_last4`,
`interest_tag(_mode)`, `field_mapping`, `sandbox`, rate limits, `status`, `rotated_at`,
`last_seen_at`.

Live rows (prod, 2026-10-08):

| id | slug | sandbox | status | tag | link | revenue |
|---|---|---|---|---|---|---|
| 15 | internal-test | no | active | medicare (forced) | no | off |
| 77 | pml (ProMarketing Leads) | no | active | — | **yes** | **on** |
| 78 | docs-curl-verify | yes | disabled | — | no | off |
| 81 | bsd (Big Sky Data) | yes | active | — | no | off |

### 1.2 Everything that keys on it

| table / surface | column | FK rule | what breaks if the key row changes |
|---|---|---|---|
| `lead_inbox` | `partner_key_id`, `partner_slug` (denormalized) | RESTRICT | provenance; a key with leads cannot be deleted (and there is no DELETE route) |
| `lead_events` | `partner_key_id`, `partner_slug` | RESTRICT | the arrival ledger the report's `viaLead` reaches |
| `lead_intake_daily` / `lead_intake_hourly` | `partner_key_id` (in PK) | CASCADE | intake counters; the hourly digest's day-sum invariant |
| `partner_key_usage` | `partner_key_id` (PK) | CASCADE | rate limiting |
| `drip_campaign_configs` | `partner_key_id` | SET NULL | optional per-campaign partner filter in routing |
| `contact_attributes` | `partner_slug` (text) | — | attribute import / drip enrichment |
| report | `getPartnerReport(orgId, from, to, partnerKeyId?)` rows keyed `(partner_key_id, interest_tag)`; joins `partner_keys k` for slug/name and `k.sandbox = false` | | [lib/reporting/partner-report.ts](../../lib/reporting/partner-report.ts) |
| signed link | `resolveReportToken` → `partner_keys.report_token_hash` WHERE `status='active' AND sandbox=false`; returns `partnerKeyId` which scopes every query | | [lib/reporting/partner-report-token.ts](../../lib/reporting/partner-report-token.ts) |
| intake | `resolvePartnerKey(token)` by `partner_keys.token` equality | | [lib/intake/partner-key.ts](../../lib/intake/partner-key.ts) |
| digest | joins `partner_keys` for the slug in the hourly message | | [lib/drip/intake-digest.ts](../../lib/drip/intake-digest.ts) |
| settings | `GET/POST /api/partner-keys`, `GET/PATCH /api/partner-keys/[keyId]`, `/rotate`, `/report-link` (POST issue/rotate, DELETE revoke) | | [components/settings/partner-keys.tsx](../../components/settings/partner-keys.tsx) |

15 app/lib/component files and 17 scripts reference `partner_keys` (list in §8.3).

### 1.3 Migration path (keeps every existing key, token and counter working)

**0200 — `partners`** (additive):

```
partners (id serial PK, org_id, slug text NOT NULL, name text NOT NULL,
          status text 'active'|'archived', archived_at, created_at, created_by,
          report_token_hash, report_token_issued_at, report_token_expires_at,
          report_show_revenue boolean NOT NULL DEFAULT false)
UNIQUE (org_id, slug); partial UNIQUE (report_token_hash) WHERE NOT NULL
RLS enabled + SELECT-only org policy (mirror 0152's partner_keys_select_own_org)

partner_keys ADD COLUMN partner_id integer REFERENCES partners(id) ON DELETE RESTRICT
```

Backfill **inside the same migration** (4 rows, instant): one partner per existing key,
`slug = partner_slug`, `name = name`, token columns + `report_show_revenue` **copied**
from the key (key 77's hash copied verbatim ⇒ pml's live link keeps resolving — the
plaintext is unrecoverable, so a move is the only way to keep it alive), then
`SET NOT NULL` on `partner_keys.partner_id`.

Then: drop `partner_keys_org_slug_uniq` (two keys of one partner share a slug) and keep
`partner_keys.partner_slug` as a denormalized copy of `partners.slug` (the intake route
and `lead_inbox.partner_slug` provenance keep working unchanged; new keys copy it from
the partner at creation). The four token columns on `partner_keys` stay in place until
the readers are cut over (0172's columns become dead, dropped in a later destructive
migration per the additive-leads-destructive rule).

**Reader cut-over, all mechanical:**
- `resolveReportToken` reads `partners` (status `active`); the sandbox gate moves from
  "the key is not sandbox" to "the partner has ≥ 1 live key **or** is file-only" — a
  sandbox-only partner (bsd today) must still resolve to no link. Open question Q7.
- `getPartnerReport(…, partnerId?)`: `k` becomes `partners p` joined through
  `partner_keys` for the intake / drip half; `le.sandbox = false` filtering stays.
- intake-digest, enrichment, routing-eval: unchanged (they key on the key).
- Settings: keys nested under their partner (§8).

`lead_intake_daily`, `lead_intake_hourly`, `lead_inbox`, `lead_events`,
`partner_key_usage`, `drip_campaign_configs` are **not touched** — they keep
`partner_key_id`; the partner is one join away.

---

## 2. Contact groups — where the link lives, which screen edits a group

- Table `contact_groups` ([db/schema.ts](../../db/schema.ts) ~L1037): `id`,
  `contact_group_id` (text, globally unique, immutable in the UI), `org_id`, `name`,
  `description`, `color`, `status` (active/archived), four lifecycle override columns
  (0187), `archived_at`, `created_at`. 26 rows in prod. **Proposed:** `partner_id integer
  NULL REFERENCES partners(id) ON DELETE RESTRICT` + partial index
  `(org_id, partner_id) WHERE partner_id IS NOT NULL` (migration 0201).
- Edit surface: [app/(protected)/contact-groups/[id]/page.tsx](../../app/(protected)/contact-groups/[id]/page.tsx)
  — header (name, id, status, archive/restore), tabs **Contacts / Add contacts / Remove
  contacts**, and an **Edit** `FormDialog` rendering
  [components/contact-groups/contact-group-form.tsx](../../components/contact-groups/contact-group-form.tsx)
  (name, Contact Group ID read-only in edit, description, color, lifecycle overrides
  gated by `lifecycle.configure`). Submits `PATCH /api/contact-groups/[id]`
  ([route](../../app/api/contact-groups/[id]/route.ts)) validated by
  `contactGroupUpdateSchema` ([lib/validators/contact-groups.ts](../../lib/validators/contact-groups.ts)).
- Where the partner select goes: the edit form, as a plain `<Select>` with "No partner"
  (4 partners today; swap for `<SearchableSelect>` past 10 per §9 UI conventions).
  Validator: `partner_id: z.number().int().positive().nullable().optional()`. The PATCH
  route verifies the partner belongs to the org (same shape as the lifecycle gate) and,
  when `partner_id` changes, enqueues the recalc (§5.3). Permission: recommend
  `partner_keys.manage` for changing the link, not `contact_groups.update` — the link
  moves money between partner reports (Q9).
- List page `/contact-groups` columns today: Group, Description, Segments, Status,
  Created → add **Partner**. Detail header: partner badge + "recalculating…" state.
- Linking an **archived** group should be allowed (history is the point).
- **Drip's own groups.** `ensurePartnerTagGroup` ([lib/drip/groups.ts](../../lib/drip/groups.ts))
  creates `<slug>-<tag>` (key `drip:<org>:<name>`) per real partner × tag. It knows the
  partner, so it can set `partner_id` at creation and the existing `pml-aca` (id 311) can
  be linked by backfill. R1 says the link is set from the group screen; auto-linking the
  system-made partner groups is a reasonable default the owner should confirm (Q6).

---

## 3. Membership timestamps

### 3.1 Coverage (prod, full junction)

| fact | value |
|---|---|
| rows | 1,158,148 (est. heap 85 MB, indexes 122 MB) |
| `created_at` NULL | **0** (column is `NOT NULL DEFAULT now()`, migration 0031) |
| distinct contacts | 987,111 |
| contacts in 2+ groups | 160,746 |
| rows stamped 2026-05-18 | 795,515 (68.7%) — eight separate bulk loads of groups 1–8 between 10:50 and 11:48 UTC, one transaction each (1–2 distinct stamps per group). Not the 0031 fan-out (0031 ran 2026-05-15). ⚠️ If any of those eight legacy groups is ever linked, "appeared first" between them is the upload order of that morning, minutes apart — an artifact, not acquisition order |
| earliest-two-memberships tied (same instant) | 5,980 contacts (3.7% of multi-group contacts); 6,009 of those are pml-aca ∥ Drip intake pairs written in one transaction |

Every writer uses the default (8 insert sites: `lib/drip/groups.ts`,
`lib/upload/audience-upload.ts`, `lib/sends/import-optout-attribution.ts`,
`contact-groups/[id]/contacts/add`, `contacts/bulk-apply-groups`, `contacts/upload`,
`campaigns/[campaignId]/upload-contacts`, `scripts/backfill-partner-tag-groups.ts`), all
`ON CONFLICT DO NOTHING`, so the stamp is the **first** add and a re-add never moves it.
The only reader is the group Contacts tab (`joined_at`), so the column already means
"joined". Removal (`contacts/remove` route, contact-delete cascade) deletes the row and
its stamp — R5's "later membership changes never rewrite past numbers" is satisfied
only because the attribution is **stored** (§5); a recalc after a removal cannot
recover the row (documented limitation, §9.1).

### 3.2 The live partner group fails R3 as written — because of the backfill

pml-aca (id 311), 14,180 members, vs each lead's `lead_events.received_at`:

| measure | value |
|---|---|
| membership stamped > 10 min after arrival | **8,171** (the #311 backfill, run 2026-10-06/07) |
| stamped > 1 day after | 0 |
| lag p50 / max | 54 min / 1 h 24 m |
| same stamp as the contact's "Drip intake" (113) row | 6,009 (one transaction, `now()` is frozen) |
| "Drip intake" stamped **strictly earlier** | **8,171** |
| already in a **non-drip** group strictly before | 63 (0.4%) — these lose credit under R3, correctly |

"Drip intake" (113) and "Drip sandbox" (114) are non-partner groups. Under a literal R3
("already in a non-partner group BEFORE it joined the partner group"), the 8,171
backfilled leads get **no** credit. Two fixes, both recommended together:

1. **Appearance = delivery for drip groups.** Enrichment inserts the partner×tag
   membership with `created_at = lead.received_at` (ON CONFLICT DO NOTHING keeps the
   first delivery), and a one-off repair sets the 8,171 backfilled rows to
   `min(lead_events.received_at)`. That is R4's own wording ("a drip/live-feed delivery
   from a partner counts as an appearance"), and `received_at` always precedes the
   processing-time "Drip intake" stamp. Alternative: a nullable `appeared_at` column
   with `COALESCE(appeared_at, created_at)` in the resolver — avoids touching
   `created_at`, costs a column (Q2).
2. **Exempt the two system drip groups from R3** regardless — they are pipeline
   artifacts, not an acquisition source, and a future re-backfill must not re-break 8K
   leads.

### 3.3 First drip intake per contact and partner

`SELECT contact_id, partner_key_id, min(received_at) FROM lead_events WHERE sandbox =
false GROUP BY 1, 2` — served by `lead_events_org_contact_received_idx`; 13,898 rows
total, one per contact so far for pml (14,180 events = 14,180 contacts). With fix 1 above
this is also what the partner×tag membership stamp carries, so the resolver needs only
the junction.

### 3.4 Ties

5,980 contacts tie on their earliest two memberships; none are sub-second near-misses.
Rule to adopt: R3 uses **strict** `<` (a same-instant non-partner membership does not
block); R4 among tied partner groups picks the lowest `contact_group_id` (deterministic,
stated in the doc). (Q3)

---

## 4. Send attribution — tying a `stage_send` to the group that put the contact in

### 4.1 What exists

- `stage_sends` (6.26M rows, 2,392 MB heap / 2,752 MB indexes; 1.6–2.0M `sent` rows per
  month Jul–Sep): `contact_id`, `campaign_id`, `stage_id`, `sent_at`, `status`,
  `link_id`, `provider_phone_id`, `cost_per_sms`. **No source-group column, no
  `contact_id` index** (the probe "sends to these contacts" seq-scans 2.4 GB — my attempt
  on pml-aca's 14,180 members timed out; always go campaign → sends).
- `campaign_audience_pool` (3.12M rows): `(campaign_id, contact_id, org_id, three
  snapshot booleans)`. No source group either. The group dimension is OR-of-groups
  (`buildGroupMembershipClause`: `ccg.contact_group_id = ANY(gids)`) ∩ segments when both.
- `campaigns.audience_contact_group_ids int[]` is **frozen after draft**: the PATCH route
  rejects it (`audience_locked_after_draft`) and `campaigns/[campaignId]/upload-contacts`
  (which merges groups into it) is draft-only. So "the groups this campaign targeted" at
  send time = the column today. 834 regular campaigns, 832 with ≥ 1 group; the 2 without
  are archived.
- The 0132 pattern ([db/migrations/0132](../../db/migrations/0132_offer_report_per_recipient_attribution.sql)):
  `stage_sends ss JOIN campaign_stages cs JOIN campaigns camp JOIN contact_contact_groups
  ccg ON ccg.contact_id = ss.contact_id AND ccg.contact_group_id = ANY(camp.gids) AND
  ccg.org_id = camp.org_id WHERE ss.status = 'sent'`. Reusable verbatim with two
  changes: add `ccg.created_at <= ss.sent_at` (membership as of the send) and **drop the
  `link_mode = 'tracked'` restriction** — 0132 needed it to make the footer foot; a
  partner report has no campaign-grain footer, and every send with a `stage_sends` row
  counts (0 manual-mode sends since 2026-10-01 anyway).

### 4.2 Measured on ET day 2026-10-07 (regular campaigns, status `sent`)

| | count |
|---|---|
| sends | 55,246 |
| reached via **0** targeted groups | **0** |
| via exactly 1 targeted group | 48,965 |
| via **2+** targeted groups | **6,281 (11.4%)** |
| opt-out attributions on those sends | 780 |
| clean clicks on their links | 2,870 |
| conversion events on them | 14 |

So the join reaches every regular send, and one send in nine needs R3/R4 to pick one
partner. All three outcome joins already exist in the drip path
(`opt_out_attributions.stage_send_id`, `clicks → links → stage_sends.link_id`,
`conversion_events.stage_send_id` via `purchasesBySendSelect`) and plug onto a per-send
partner the same way.

### 4.3 Resolver — one partner per send (the reading of R2–R4 this recon adopts)

```
inputs: send s (contact c, campaign gids G, sent_at t)
M        = memberships of c with created_at <= t            (ALL groups, not only G)
entered  = { m ∈ M : m.group ∈ G AND m.group.partner_id IS NOT NULL }
if entered = ∅                                   → no credit            (R2)
firstP   = min over { m ∈ M : partner-linked } by (created_at, group_id)   (R4)
if ∃ m ∈ M, non-partner, non-system, m.created_at < firstP.created_at → no credit (R3)
else credit firstP.partner, record firstP.group
```

Two readings were possible for "contact in 2+ partner groups": first appearance among
the **targeted** partner groups, or among **all** the contact's partner groups. This
adopts **all** — the contact belongs to whoever delivered it first, and R2 only decides
whether a credit exists at all. Confirm (Q1). R3's "before it joined the partner group"
is read as "before its first partner-group appearance".

Edges: a contact reached through a **segment** whose rule is `is_in_contact_group`
(11 active such rules on 11 segments) with no group in `audience_contact_group_ids`
is "via no group" under this rule — recommend keeping it that way (rules are opaque;
a segment can AND it with anything) (Q4). A `stage_manual_recipients` contact (0197)
who also belongs to a targeted linked group is credited like anyone else.

### 4.4 Drip and regular do not overlap

The drip path (`viaLead`: send → the one journey → `lead_events`) requires
`c.type = 'drip'`; the group path requires `c.type = 'regular'` and a group in
`audience_contact_group_ids`. All 6 drip campaigns have `'{}'` there, and no campaign
targets 311/113/114. A proof script must assert both facts rather than rely on them.

---

## 5. Storage for R5, cost, and the link/unlink recalculation

### 5.1 Options

| option | shape | verdict |
|---|---|---|
| **A. side table at send grain, credited rows only** | `partner_send_attributions (stage_send_id PK → stage_sends CASCADE, org_id, partner_id, contact_group_id, contact_id, campaign_id, sent_at, computed_at)`; index `(org_id, partner_id, sent_at)`, `(contact_group_id)` | **recommended** — ~50 B/row; sized by partner-group sends, not by all sends |
| B. columns on `stage_sends` | `partner_id`, `attributed_group_id` stamped later by UPDATE | rejected — UPDATEs on a 2.4 GB hot table (bloat), and stamping inside `bulkInsertStageSends` changes the kickoff statement the brief protects |
| C. day-grain aggregates per (partner, group, day) | counters | insufficient — clicks / opt-outs / sales are dated by their own event and must join to a per-send partner |

### 5.2 How the rows get written without touching the send path

A cron tick (`*/5`, `withCronLease`, reuse the existing cron conventions) with a
watermark on `sent_at` (minus a lag) selects `status = 'sent'` regular sends of campaigns
whose `audience_contact_group_ids` intersect the linked groups, runs the resolver, and
inserts credited rows (`ON CONFLICT DO NOTHING`). The materialize and claim statements in
`kickoff.ts` / `drain.ts` are not edited, so their plans cannot change. "Stored at send
time" holds to within the tick: the resolver evaluates membership **as of `sent_at`**
using `created_at`, so a late tick gives the same answer — except for a membership row
deleted between the send and the tick (rare operator action; the cadence bounds it).

Scan shape today (prototype, warm): one ET day = 55,246 sends → **306 ms**, 279,628
buffer hits (logical; the per-send index probe of the junction), 0 physical reads —
`stage_sends_sent_at_contact_idx` drives it. A 5-minute tick is a few hundred sends.

### 5.3 Link / unlink recalculation

Scope for group G: (a) every `sent` row of regular campaigns with `G = ANY(gids)`, and
(b) rows of campaigns targeting any **other** linked group whose recipient is in G
(R3/R4 ordering can move credit between partners). Unlink is a recompute, never a
delete — R4 may hand the credit to the next partner. Delete+reinsert the affected
`stage_send_id`s per campaign in one transaction; a `partner_attribution_recalcs` job
row (`group_id, requested_at, status, campaigns_done/total`) drives it from the same
cron, resumable, surfaced on the group header.

Cost, measured with the campaign-index shape (never by contact):

| group | members | campaigns | `sent` rows | credited (membership ≤ send) | scan |
|---|---|---|---|---|---|
| 102 WL Signal Test | 19,713 | 23 | 188,244 | — | (count only) |
| **135 WL_Sep_2026** | 57,144 | 72 | 350,813 | 271,989 | **1.19 s**, 41,243 hits + 8,878 reads (≈ 69 MB) |
| 1 Memory (largest) | 187,361 | 234 | est. 1.5–2 M | — | est. 10–20 s scan; the insert of ~1–2 M rows dominates (minutes) |

A partner-sized group (≤ 60K) recalculates in seconds and can run on the next tick. The
eight legacy groups (Memory, Weight Loss, Manifestation, AstroEnergy… 100–234
campaigns each) must run batched per campaign inside the 300 s cron budget, and their
first full run belongs in the 05:00–06:00 UTC window.

### 5.4 Volumes to size against

- `stage_sends`: 6.26 M rows all-time; `sent` per month 324K (Jun), 1.60 M (Jul),
  2.01 M (Aug), 1.69 M (Sep), 348K (Oct to date). Attribution rows ≈ sends to
  linked-group members only — today 0 linked groups, so the table starts empty and
  grows with the partner program, not with the platform.
- Regular `cost_per_sms` snapshot: **0 NULL of 333,521** regular `sent` rows since
  2026-10-01 (0112 is complete on the regular path); older history is ~32.7% NULL
  org-wide (0132's measurement) → `COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)`, the
  same rule the drip rows already use.

---

## 6. Lookup cost for R6

### 6.1 Paid vs cache hit — the ledger already exists

| source | rows | what it is |
|---|---|---|
| `lookup_queue` status `done` | **787,583** (one per distinct phone, 0 orphan batches; 40 retried) | one row = one billed Telnyx call. Cache-complete phones are skipped at enqueue (`enqueueNormalized` / `enqueueGroup` `NOT EXISTS phone_lookups … complete`) and counted only in `lookup_batches.cache_hits` — **they never get a row** |
| `phone_lookups` source `telnyx` | 787,582 complete | the cache; `looked_up_at` is **overwritten** by a re-lookup, the queue row is not |
| `phone_lookups` source `csv_import` | 193,023 | free, no queue row |
| `lookup_batches` | 220 (`upload` 18 / `drip_intake` 200 / `backfill` 2) | `org_id`, `trigger`, `cache_hits`, `processed`, ledger balances |

Ledger sanity: `$1,230.66 + $1.52` over `772,846 + 14,236` processed = `$0.001565` per
done row ≈ the flat `$0.0015` — so "one done row = one paid lookup" holds.

### 6.2 Tying a paid lookup to a contact group and a date

`lookup_queue.updated_at` is the completion stamp ("the date the lookup ran"); the batch
gives `org_id`; `phone` → `contacts (org_id, phone_number)` (index from 0101) → the
contact's memberships **as of `updated_at`**, through the same resolver as sends (R6:
"same priority rules"). Verified on the most recent `upload` batch
(`cf89baac…`, 2026-09-24, 10,031 rows): 10,031 matched a contact, 10,031 had a
membership, and **all 10,031 memberships were stamped before the enqueue** (max 25 s
earlier) — the upload writes contacts + groups, then enqueues. Targeted per-group runs
(`enqueueGroup`, `trigger='upload'`) are sourced from the membership itself, so
precedence holds by construction. There is no need to record the group on the batch
(`lookup_batches` has no `contact_group_id`); adding one is optional provenance.

**Drip lookups are different and stay as they are.** The lead's lookup runs *before* the
contact exists (enrichment creates the contact after the verdict; landlines never become
contacts), so no membership exists at lookup time. `lead_intake_daily.lookups_spent`
(per `partner_key × tag × day_et`, calls not leads) is already R6-shaped and feeds the
hourly digest's invariant — keep it as the drip lookup source. The 63 pml leads that
pre-existed in another group were almost certainly cache hits ($0), so the R3 deviation
is immaterial; state it in the doc rather than build a per-lead exception.

Storage: `partner_lookup_attributions (lookup_queue_id bigint PK → lookup_queue CASCADE,
org_id, partner_id, contact_group_id, contact_id, looked_up_at, computed_at)`, written
by the same cron with a watermark on `lookup_queue.id` (monotonic) over `done` rows;
backdating on link = recompute the group's members' queue rows (phone-keyed, bounded by
the group's size). "Linking a group after its lookup backdates the cost to the lookup
date" falls out of `looked_up_at`.

### 6.3 Reusing the calibrated rate

`getCalibratedLookupRate()` ([lib/reporting/lookup-rate.ts](../../lib/reporting/lookup-rate.ts))
and `lookupCostUsd()` are reusable unchanged: cost = rows per ET day × `rate.rate`, dated
by `looked_up_at`, same as the drip column.

### 6.4 ⚠️ The calibration window decays as the upload batches age out

| | value |
|---|---|
| rate now (trailing 90 d) | `$0.001566`, window 2026-07-14 → today |
| oldest upload batch in the window | 2026-07-14 — **leaves the window 2026-10-12** |
| last upload batch | 2026-09-24 — leaves 2026-12-23 |
| `drip_intake` ledger | `$1.52` over 14,237 processed = `$0.000108`; **190 of 200** batches read ≤ 0 |

After 2026-12-23 (and drifting from 10-12) the window holds only drip batches; the sum is
positive, so the function keeps returning `source: "ledger"` at ~1/14 of the true cost —
the exact "invoice everyone nothing" failure P7 guarded against, one step removed.
Before R6 ships: exclude batches below a `processed` floor (e.g. 100) from calibration,
or pin the rate per reported period; either is a one-function change. (Q8)

---

## 7. Partner report for R8

### 7.1 How rows are built today

[lib/reporting/partner-report.ts](../../lib/reporting/partner-report.ts): five CTEs
(`intake` from `lead_intake_daily`; `sends`, `clicks`, `optout_rows`, `sales` each
"events in the ET-day range → `stage_sends` → `viaLead` (drip campaign, LATERAL latest
journey, `lead_events`, `sandbox = false`)"), `keys` = UNION of the five, LEFT JOIN each
onto `keys`, joined to `partner_keys` for slug/name with `k.sandbox = false`. Rate from
`getCalibratedLookupRate()`; `profitAndRoi` per row and for totals. Grain
`(partner_key_id, interest_tag)`; the view renders `interest_tag` as **Tag**
(`''` → "(untagged)").

### 7.2 Joining regular-campaign numbers per partner per ET day

New grain `(partner_id, contact_group_id)`; `keys` gains the regular sources:

| column | drip source (unchanged, mapped) | regular source (new) | dated by |
|---|---|---|---|
| Leads, line types, lookups | `lead_intake_daily` by key → partner, tag → group | — (0 for a regular-only row) | `day_et` |
| Sent, send cost | `viaLead` | `partner_send_attributions` ⋈ `stage_sends` (`COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)`) | `sent_at` |
| Clicks | `viaLead` | `clicks → links → stage_sends → partner_send_attributions` | `clicked_at` |
| Opt-outs (+ cost) | `viaLead` | `opt_out_attributions.stage_send_id → partner_send_attributions` | `opt_outs.created_at` |
| Sales, Revenue | `viaLead` | `purchasesBySendSelect(…)` ⋈ `partner_send_attributions` | `conversion_events.created_at` |
| Lookup cost | `lookups_spent × rate` | `count(partner_lookup_attributions) × rate` | `day_et` / `looked_up_at` |

Drip rows map `(partner_key, tag)` → group by the deterministic key
`contact_groups.contact_group_id = 'drip:<org>:' || partnerTagGroupName(slug, tag)` —
no migration; a tag with no group yet (internal-test / medicare — the backfill ran
`--partner=pml` only) renders the would-be name with no id. A `(partner, group)` that
has both drip and regular activity merges into one row and the totals, as R8 asks. No
double count: §4.4.

The signed link scopes by `partner_id` (token on `partners`), so a file-only partner
and a two-key partner each get one link; the revenue toggle (and send cost / NET / ROI
with it, per the 2026-10-07 ruling) moves to the partner and `stripRevenueForPartner`
is unchanged.

### 7.3 Tag → Contact Group: what the rename touches

| file | change |
|---|---|
| [components/reports/partner-report-view.tsx](../../components/reports/partner-report-view.tsx) | `<th>Tag</th>` → Contact Group; `tagLabel()`; CSV header `interest_tag` → `contact_group`; row key `${partner_key_id}-${interest_tag}` → `${partner_id}-${contact_group_id}` |
| [lib/reporting/partner-report.ts](../../lib/reporting/partner-report.ts) | `PartnerReportRow.interest_tag` → `contact_group_id` + `contact_group_name` (+ `partner_id`, `partner_slug` kept) |
| `scripts/partner-report-activity-proof.ts`, `scripts/partner-report-cost-proof.ts` | 10 `interest_tag` references; both must grow a regular-send hand query per column |
| [app/partner-report/[token]/page.tsx](../../app/partner-report/[token]/page.tsx), [components/reports/internal-partner-report.tsx](../../components/reports/internal-partner-report.tsx) | resolve by partner; otherwise unchanged |
| docs | `drip-partner-reporting.md` §1–2, `07-conventions.md` (the two UNION-of-keys bullets), `03-data-model.md` + ERD, `CHANGELOG.md` |

Internal view: "All partners" still shows only the group column (card 869ency4b noted two
partners on one tag are indistinguishable); with groups being partner-specific this
mostly resolves itself, but a Partner column on the internal table is a one-line add
(Q11). The hourly intake digest keeps its tag grain — it is intake-only.

---

## 8. Partners screen for R7

### 8.1 Today

`/settings/partners` ([page](../../app/(protected)/settings/partners/page.tsx), title
"Partner Intake Keys") renders `<PartnerKeys />` (568 lines): one card per key with
usage, limits, tag, secret last4; actions Show endpoint URL / Rotate secret /
Disable–Enable / Generate–Rotate report link / Revoke / Show revenue / Sandbox; dialogs
for create key, the one-time secret, the one-time report URL, rotate and revoke
confirmations. Nav label "Partner Keys" under Settings (`partner_keys.view`); the whole
Settings tree is denied to the operator by the layout (`providers.view` as the
discriminator).

### 8.2 What changes

- Nav label → **Partners**; page title / heading; the key card becomes a child of a
  partner card (name, slug, status, linked groups, link state, revenue toggle, "Partner
  report" button); **New partner**; **New key** inside a partner (POST gains
  `partner_id`; slug comes from the partner, no longer typed); **Remove** = archive
  (`status='archived'`, `archived_at`; keys retained). Recommend: archiving a partner
  disables intake on its keys (the intake route already answers 403 for a disabled key)
  and kills its report link (`resolveReportToken` checks partner status) — confirm (Q7).
- APIs: `GET/POST /api/partners`, `GET/PATCH /api/partners/[partnerId]`,
  `POST …/archive`, `POST …/restore`, `POST/DELETE …/report-link` (moved from the key).
  `/api/partner-keys/*` stays for key CRUD/rotate.
- Permissions: keep the ids `partner_keys.view` / `partner_keys.manage` (10 call sites +
  5 references in `scripts/test-operator-permission-matrix.ts`) and relabel; a rename to
  `partners.*` is pure churn for this cut (Q9).

### 8.3 What breaks on rename

- **Routes: nothing.** `/settings/partners` keeps its path; the proxy exclusion list
  (`partner-report/`, `docs/partner-api`) is root-anchored and cannot touch it
  (`scripts/test-public-route-scope.ts` guards exactly that).
- **Route map:** every new `app/api/partners/**/route.ts` needs a line in
  [lib/authz/route-map.ts](../../lib/authz/route-map.ts) (`null`, hidden from the
  operator like the key routes) or `scripts/test-route-map-coverage.ts` fails.
- **Docs text:** `06-integrations.md` ("Settings → Partner intake keys", two rows),
  `partner-lead-intake.md` §UI, `drip-partner-reporting.md` §10. The generated partner
  document (`docs/partners/lead-intake.md`) does not mention the screen — unaffected.
- **Scripts that read `partner_keys`** (build fixtures by inserting a key): `drip-p5-proof-setup`,
  `drip-p7-proof`, `partner-report-cost-proof`, `test-drip-*` (6), `test-intake-*` (2),
  `test-partner-docs-drift`, `test-registered-lane-consumers`, `verify-*-production` (3).
  With `partner_keys.partner_id NOT NULL` each fixture must create a partner first — one
  shared helper, but it is ~17 files.

---

## 9. Risks, open questions, migrations, build order

### 9.1 Rulings tested — where a literal reading is unworkable

| ruling | finding |
|---|---|
| R3 | As written it removes credit from **8,171 of 14,180** live pml leads, because the #311 backfill stamped their partner membership after the system "Drip intake" membership. Fix: appearance = delivery for drip groups + exempt the two system groups (§3.2). |
| R4 | "Appeared" needs a tie-break (5,980 same-instant pairs) and a decision on **targeted vs all** partner groups (§4.3). |
| R5 | "Stored at send time" without touching `kickoff.ts` / `drain.ts` means a cron tick minutes later, evaluating membership as of `sent_at`. A membership deleted inside that window is the one case the stored row cannot reproduce. |
| R6 | "Existing calibrated rate" decays ~14× between 2026-10-12 and 12-23 as upload batches leave the 90-day window (§6.4). Needs a floor or a pinned window. Drip lookups cannot take the send priority rules (no contact exists yet) — keep the counters. |
| R8 | Drip rows need a (partner, tag) → group mapping; by naming rule, no migration; one tag has no group today. |

### 9.2 Open questions (decide before Phase 2)

1. **R2 vs R4 scope** — first appearance among *all* the contact's partner groups
   (adopted) or only the campaign's targeted ones?
2. **Drip appearance** — rewrite `created_at` to `received_at` for drip partner groups
   (+ repair 8,171 rows), or add `appeared_at`?
3. **Ties** — strict `<` for R3, lowest group id for R4?
4. **Segment-rule groups** (`is_in_contact_group`, 11 active segments) — never a
   partner entry (adopted)?
5. **Membership removal after a send** — accept that a recalc cannot see it (documented)?
6. **Auto-link** drip `<slug>-<tag>` groups to their partner at creation (and link
   `pml-aca` → pml by backfill)?
7. **Archived partner** — disable intake on its keys and its report link?
8. **Calibration floor** — exclude batches under N processed, or pin the window?
9. **Permission ids** stay `partner_keys.*`; changing a group's partner requires
   `partner_keys.manage`?
10. **Signed link moves to the partner** (one per partner; pml's survives by copying the
    hash) — confirm.
11. Internal table gains a Partner column?
12. First recalc of a legacy 100K+ group: schedule in the 05:00–06:00 UTC window?

### 9.3 Proposed migrations (numbered, additive; prod is at 0199)

| # | content |
|---|---|
| **0200** | `partners` table + RLS; `partner_keys.partner_id` FK, backfilled 1:1 and `SET NOT NULL`; token/revenue columns copied to `partners`; drop `partner_keys_org_slug_uniq` |
| **0201** | `contact_groups.partner_id` FK (RESTRICT) + partial index; `partner_attribution_recalcs` job table |
| **0202** | drip appearance: repair the 8,171 pml-aca stamps from `lead_events.received_at` (data, idempotent, `WHERE created_at > received_at`) — or `contact_contact_groups.appeared_at` if Q2 goes the other way |
| **0203** | `partner_send_attributions` + indexes + RLS (SELECT-only org) |
| **0204** | `partner_lookup_attributions` + indexes + RLS; optional `lookup_batches.contact_group_id` |

Dead columns on `partner_keys` (the four token columns, `name`) are dropped in a later
destructive migration after the readers are cut over — additive leads, destructive
follows.

### 9.4 My own heavy queries (so they are not read as platform load)

All 2026-10-08 18:45–19:15 UTC, read-only, through the Supabase MCP (its statement
timeout aborted one): three full passes over `contact_contact_groups` (85 MB) for the
member counts, the per-day histogram and the multi-group count; one window-function pass
for ties; `lookup_queue ⋈ lookup_batches` (81 MB); an index-only month histogram over
`stage_sends_org_sent_at_idx`; sends since 2026-10-01 ⋈ campaigns (~350K rows); the
one-day prototype twice (306 ms, 279,628 logical hits, 0 reads); the group-135 recalc
proxy twice (1.19 s, 41,243 hits + 8,878 reads); the group-102/135 count join; one
**aborted** `stage_sends` seq scan (sends by `contact_id` for pml-aca — no such index).
Nothing exceeded ~100 MB of physical reads.

### 9.5 Phased build order (each phase ships alone and is additive)

1. **Partner entity** — 0200, Partners screen rework, `/api/partners/*`, route-map,
   token resolution by partner, report joins through key → partner (rows still by tag),
   fixture helper for the 17 scripts, docs. *Verifies:* pml's existing link still
   resolves; intake unchanged; hourly digest unchanged.
2. **Group link + appearance** — 0201, 0202, group form/list/header, drip auto-link
   (if Q6), enrichment stamps delivery time, recalc job table (no consumer yet).
   *Verifies:* 8,171 repaired rows; R3 count on pml-aca = 63.
3. **Send attribution** — 0203, the cron tick + recalc worker, proof script with hand
   queries (assert drip/regular disjointness and the 11.4% multi-group resolution).
   *Verifies:* link pml-aca → rows appear for its 0 regular sends (empty today), link a
   test group → counts match the hand query.
4. **Lookup attribution** — 0204, the watermark over `lookup_queue`, the calibration
   floor (Q8). *Verifies:* the 10,031-row batch resolves 10,031/10,031.
5. **Report R8** — new grain, regular columns, Tag → Contact Group, signed link by
   partner, CSV, both proof scripts extended, docs (`drip-partner-reporting.md`,
   `07-conventions.md`, `03-data-model.md` + ERD, `CHANGELOG.md`).

Stop here for approval before any build.
