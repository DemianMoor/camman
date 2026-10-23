# Feature — Contacts, Contact Groups, Opt-outs/ins & Clickers

_Last updated: 2026-10-23 (contact_group_id not validated on edit; create limit 100)_

## 1. Purpose
The central phone registry and the suppression/engagement records attached to it. Contacts are the atomic audience unit (scaling to millions); contact groups are tags; opt-outs/ins and clickers are the status signals that audience filters and segment rules read.

## 2. Key concepts / entities
- `contacts` — `id uuid`, `phone_number`, `is_archived`. UNIQUE(org_id, phone_number).
- `contact_groups` + `contact_contact_groups` — categorical tags (M:N). Renamed from `segment_groups` in migration `0031` (the old "folder for segments" concept is gone).
- `opt_outs` (+ `opt_out_brands`, `opt_out_providers`) — append-only suppressions with a `reason`.
- `opt_ins` — single brand/provider per row.
- `clickers` — engagement records, `brand_id` required.

## 3. How it works
- Standard CRUD + bulk phone-upload endpoints. Phone parsing/validation via libphonenumber-js ([`lib/phone-validation.ts`](../../lib/phone-validation.ts)).
- **Phone upload (shared pipeline):** four entry points — contacts, opt-outs, opt-ins, clickers — all flow through [`lib/upload/audience-upload.ts`](../../lib/upload/audience-upload.ts) (`processAudienceUpload()`): split on `[\n,;]`, dedupe by E.164, validate, upsert `contacts` `ON CONFLICT DO UPDATE`, insert entity rows, then apply `assign_to_group_ids` (idempotent `ON CONFLICT DO NOTHING`). Returns a summary (submitted/valid/invalid/duplicates/inserted/groups_applied).
- **Bulk-apply groups:** `POST /api/contacts/bulk-apply-groups` `{ contact_ids[], group_ids[] }` → `{ applied }`, idempotent.
- **Opt-out reasons** (`opt_outs.reason`, CHECK):
  | reason | scope | origin | snapshot effect |
  |--------|-------|--------|-----------------|
  | `opt_out` | brand-scoped (via `opt_out_brands`) | recipient STOP | excluded |
  | `scrubbed` | universal | provider non-mobile reject (stage results) | excluded |
  | `bounced` | universal | carrier reject (stage results) | excluded |
  | `suppressed` | universal | contact-level status import (Global Suppression) | excluded |

  **All four** exclude the contact from future audience snapshots — the audience query checks for *any* `opt_outs` row regardless of reason.

## 4. Data it reads/writes
- Writes `contacts`, `contact_contact_groups`, `opt_outs`(+junctions), `opt_ins`, `clickers`.
- Read by: segment rules (`is_clicker_*`, `is_optin_*`, `is_optout_for_brand`, `is_in_contact_group`), audience snapshot (status flags + opt-out exclusion), result-import propagation (writes opt-outs/clickers).

## 5. UI surface
- `app/(protected)/contacts/` — list, search, sort, groups column, multi-select group filter, bulk "Apply to groups", status import. The list count is **capped at 10,000** for performance (an exact count over a 752K-row org is ~670 ms); above the cap the footer shows "10,000+" and paging is driven by a `hasMore` flag, not the total. Any active filter (search/segment/group/view) narrows below the cap → exact count. See [conventions](../07-conventions.md).
- `app/(protected)/contact-groups/[id]/` — three tabs: Contacts (list/search/sort/bulk-remove), Add contacts (`PhoneUploadForm`), Remove contacts.
- `opt-outs/`, `opt-ins/`, `clickers/` — list + phone-upload entry points (each exposes a `MultiSelectPicker` for contact groups).

## 6. Rules & edge cases
- A contact may belong to many groups; tags are direct (not via segments).
- **`contact_group_id` is immutable.** Create validates it (letters/digits/`-`/`_`, max **100** — `CONTACT_GROUP_ID_MAX` in [`lib/validators/contact-groups.ts`](../../lib/validators/contact-groups.ts); the column itself is unbounded `text`). Edit does NOT validate it: the edit form uses `contactGroupEditFormSchema` (create minus the id) and `PATCH` strips it from the body. Drip intake mints `drip:<org uuid>:<partner-tag>` (always > 40 chars and containing `:`), which the create rules can never produce — the `drip:` namespace is pipeline-only. Until 2026-10-23 the edit form validated with the create schema (max 40), so no drip group could be saved.
- Opt-outs are **append-only** — multiple rows per contact over time (different sources/scopes) are expected.
- Contact-status import maps free text → `opt_out` / `suppressed` / `scrubbed` reasons ([`lib/imports/contact-status.ts`](../../lib/imports/contact-status.ts)).
- Permissions: upload = operator+; delete = manager+ (`contacts.delete`, `opt_outs.delete`, etc.).
- `GET /api/contact-groups/list` accepts `contact_groups.view` **or** `campaigns.create`, so the operator can pick groups in the campaign form and segment rules without access to the Contact Groups screen. Callers without `contact_groups.view` get `description: null` and cannot search descriptions. See [multi-tenancy-auth.md](multi-tenancy-auth.md).

### Partner link (migration 0201, partner attribution Phase 2)

A contact group can be linked to a **partner** (`contact_groups.partner_id`): its contacts are then
credited to that partner by the attribution resolver (Phase 3). Where it is set and who may set it:

| group | set by | the form |
|---|---|---|
| a drip partner×tag group (`contact_group_id LIKE 'drip:%'`) | the pipeline only — `ensurePartnerTagGroup` at creation, 0201's backfill | read-only: "Set by the drip pipeline from the partner key — cannot be changed here." `PATCH … partner_id` → 409 `drip_group` even when unchanged (owner fix F3) |
| a system group (`system_role` set: `Drip intake` / `Drip sandbox`) | nobody | "System group — cannot be linked"; `PATCH` → 409 `system_group` (ruling C4) |
| any other group, incl. an archived one | an operator with **`partner_keys.manage`** (ruling Q9) via the Edit dialog's **Partner** select (plain `<Select>`, active partners from `GET /api/partners`, fetched only with `partner_keys.view`) | helper text: "Links this group's contacts to the partner for attribution. Reports update after a recalculation." Without the permission the select is disabled with the reason |

`PATCH /api/contact-groups/[id]` with `partner_id` in the payload: `partner_keys.manage` or 403; the
partner must be in the org (404) and active (409 `partner_archived`); when the stored value changes,
ONE `partner_attribution_recalcs` row is queued in the same transaction (`reason` = `link` /
`unlink` / `relink`; ruling Q12 — Phase 3's cron consumes it). The two edit dialogs (list page and
detail page) send `partner_id` only when the viewer may change it, the group is not locked and the
value actually changed, so a plain rename never 403s or 409s. The list shows a **Partner** column
(name, `drip` chip on pipeline groups, `system` badge on system groups); the detail header shows a
`Partner: <name>` badge. `GET /api/contact-groups/list` and `GET /api/contact-groups/[id]` carry
`partner_id`, `partner_name`, `system_role`.

### Allowed number types (migration 0218)

Two checkboxes on the group's Create/Edit dialog, both **checked by default**:
**Allow VoIP numbers** (`contact_groups.allow_voip`) and **Allow unknown numbers (type not
identified)** (`allow_unknown`). Landlines are never sent to regardless (`messaging_status`);
toll-free is not gated.

Unchecking one blocks that group's contacts of that `contacts.line_type`:

- **Everywhere, strictest group wins.** A contact in ANY *active* group with the box unchecked is
  out of every campaign — including campaigns that select a different group, or only segments.
  An archived group blocks nothing.
- **Selection time only** (owner ruling 2026-10-20, "only block new sends"). Applied where the
  landline stop is applied: `gateEligible()` in [lib/segment-rules-eval.ts](../../lib/segment-rules-eval.ts)
  (segment side) and `buildGroupMembershipClause()` in [lib/audience-snapshot.ts](../../lib/audience-snapshot.ts)
  (group side) — so preview, draft stage counts, lanes, the activation snapshot, the segment page
  and its CSV export all drop them — and as the drip routing global rule `line_type` (permanent ⇒
  the lead is marked unroutable, like an opt-out). **Not** in `lib/sends/eligibility.ts`: queued
  sends, frozen audience pools and drip follow-ups already in flight still go out.
- The blocked set is one helper, [lib/contact-groups/line-type-gate.ts](../../lib/contact-groups/line-type-gate.ts).
  It costs one index probe while no group in the org has a box unchecked.
- `unknown` includes numbers never looked up (`carrier_norm = 'Unidentified'`). It reads
  `contacts.line_type`, the copy of `phone_lookups` — see [phone-lookup-carrier.md](phone-lookup-carrier.md)
  for why that copy was stale on drip contacts until 2026-10-20.

Permission: `contact_groups.update` (manager+). Both list and detail API responses carry the two
fields so either edit dialog starts from the stored value (a rename from the list must not re-check
a box). Test: `scripts/test-group-line-type-gate.ts` (preview DB).

**`contact_contact_groups.created_at` means "appeared"** (ruling Q2). For drip partner×tag groups
it is the lead's first delivery (`lead_inbox.received_at`), stamped by enrichment going forward and
repaired for existing rows by `scripts/repair-drip-membership-appearance.ts`. The group's Contacts
tab shows it as "joined" and is its only reader outside the resolver (guarded by
`scripts/test-membership-timestamp-readers.ts`).

## 7. Extension points / limitations
- No per-contact send history yet (`has_been_sent_*` deferred — CLAUDE.md §12). The segment-rules system is structured to absorb a `has_been_sent_to_by_campaign` rule type without schema churn.
- No contact-merge/dedup-across-numbers tooling beyond the upsert key.
