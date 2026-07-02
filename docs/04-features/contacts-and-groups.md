# Feature — Contacts, Contact Groups, Opt-outs/ins & Clickers

_Last updated: 2026-07-02_

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
- Opt-outs are **append-only** — multiple rows per contact over time (different sources/scopes) are expected.
- Contact-status import maps free text → `opt_out` / `suppressed` / `scrubbed` reasons ([`lib/imports/contact-status.ts`](../../lib/imports/contact-status.ts)).
- Permissions: upload = operator+; delete = manager+ (`contacts.delete`, `opt_outs.delete`, etc.).

## 7. Extension points / limitations
- No per-contact send history yet (`has_been_sent_*` deferred — CLAUDE.md §12). The segment-rules system is structured to absorb a `has_been_sent_to_by_campaign` rule type without schema churn.
- No contact-merge/dedup-across-numbers tooling beyond the upsert key.
