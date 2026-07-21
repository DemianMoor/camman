# Feature — CSV Result Imports & Phone Uploads

_Last updated: 2026-07-21_

## 1. Purpose
After a manual send, the provider exports a results CSV. This module imports it, derives a per-row **outcome**, propagates opt-outs and clickers into the suppression/engagement tables, and updates the stage's result counters — all transactionally and **revertibly**. A separate, simpler path handles bulk phone uploads.

## 2. Key concepts / entities
- `result_import_mappings` — per-provider column-mapping templates (`mapping` jsonb + `status_value_map` jsonb, `is_default`).
- `stage_results_imports` — one row per import event (permanent audit; `reverted_at`).
- `stage_result_rows` — per-row record; **UNIQUE(stage_id, phone_number)** is the dedup key; `created_opt_out_id`/`created_clicker_id` enable cross-import preservation on revert.
- Code: [`lib/imports/`](../../lib/imports/) (`parse-csv.ts`, `outcome.ts`, `canonical-fields.ts`, `contact-status.ts`), [`lib/upload/audience-upload.ts`](../../lib/upload/audience-upload.ts).

## 3. How it works

### Result import flow
```mermaid
sequenceDiagram
  participant U as Operator
  participant Form as ResultsImportForm
  participant Pre as import-preview
  participant Imp as import (tx)
  participant DB as Postgres
  U->>Form: pick CSV (FileDropZone) + mapping
  Form->>Pre: POST import-preview → sample rows by outcome
  U->>Imp: POST import
  Imp->>DB: BEGIN
  Imp->>DB: upsert contacts (chunks of 1000)
  Imp->>DB: plan + insert opt_outs (+brands), clickers
  Imp->>DB: insert stage_result_rows (ON CONFLICT(stage_id,phone) DO NOTHING)
  Imp->>DB: update campaign_stages counters + import row
  Imp->>DB: COMMIT
  Imp-->>U: summary {processed, delivered, optouts, clickers, ...}
```

### Outcome derivation ([`lib/imports/outcome.ts`](../../lib/imports/outcome.ts))
Per row, highest-priority match wins (driven by `status_value_map` word lists, falling back to heuristics):

| priority | outcome | trigger |
|----------|---------|---------|
| 7 | `opt_out` | `is_optout` truthy or STOP/unsub/removed/blocked |
| 6 | `scrubbed` | invalid/not_mobile/landline |
| 5 | `bounced` | bounce/bounced |
| 4 | `clicker` | `is_clicker` truthy or click/engaged |
| 3 | `delivered` | delivered/success/ok/sent/yes |
| 2 | `failed` | failed/error/rejected/filtered |
| 1 | `noop` | unrecognized |

Within one CSV, per-phone duplicates collapse to the highest-priority outcome. Parsing via PapaParse (header rows), phone validation via libphonenumber-js, **max 25 MB**.

### Propagation
- `opt_out` → `opt_outs` (reason `opt_out`) + `opt_out_brands` (brand-scoped to the campaign's brand).
- `scrubbed` / `bounced` → `opt_outs` (reason `scrubbed`/`bounced`, **universal**, no brand junction).
- `clicker` → `clickers` (per contact+brand; requires `campaign.brand_id`).
- `delivered`/`failed`/`noop` → `stage_result_rows` only, no propagation.
- Each created opt-out/clicker id is recorded on its `stage_result_rows` row.

### Auto-owned counters (Keitaro / TextHub)
- `click_count` ("Clickers"), `checkout_click_count`, and `sales_count` are **auto-overwritten** for tracked stages by the Keitaro `*/5` poll (from `keitaro_stage_results`: landing-page visits → Clickers, checkouts, sales); `opt_out_count` is auto-mirrored from `inbound_opt_out_count` by the opt-out poller. A CSV import still writes these, but for a stage with upstream data the next poll wins — CSV/manual entry is the fallback for **untracked** stages only. See [keitaro-poll.md](keitaro-poll.md).
- The former clicker-only "late" import phase (`clicker_phase`, `late_click_count`) was removed in migration `0077`; imports are now always a single full pass.

### Revert (`POST …/imports/[importId]/revert`)
- Marks `reverted_at` + `reverted_by_user_id`, deletes this import's `stage_result_rows`, subtracts its `*_added` counters from the stage.
- **Cross-import preservation:** for each opt-out/clicker the deleted rows created, it is deleted **only if** no other non-reverted `stage_result_rows` still references it; otherwise kept.

### Phone uploads (separate path)
Four entry points — contacts / opt-outs / opt-ins / clickers — share `processAudienceUpload()`: dedupe by E.164, upsert `contacts`, insert entity rows, apply `assign_to_group_ids` (idempotent). See [contacts-and-groups.md](contacts-and-groups.md).

#### Opt-out import with campaign/stage attribution (timestamped)
The **Add Opt-Outs** dialog accepts a CSV that pairs each number with the time it
replied STOP (a `received` / `received_at` / `time` column auto-detected next to
the phone column). When such a column is present the upload takes an attribution
path (`importOptOutsWithAttribution` in [lib/sends/import-optout-attribution.ts](../../lib/sends/import-optout-attribution.ts))
instead of the plain phone-list path: each opt-out is stored with `created_at =`
the reply time and reverse-matched to the campaign/stage that sent to the number,
using the **same rule as the live poller** (`latestSendForAttribution` — the single
most-recent `status='sent'` send within `OPT_OUT_ATTRIBUTION_WINDOW_HOURS` (72h),
one STOP ⇒ one stage). A match inserts an `opt_out_attributions` row and bumps the
stage's `inbound_opt_out_count`/`opt_out_count` + recomputes stage cost; no match ⇒
the opt-out is created for suppression only (`unattributed`).

- **Timezone:** naive timestamps (no offset) are interpreted in the operator-chosen
  zone (ET default; **Mountain** for TextHub exports; UTC). ISO-8601 values with an
  offset are honored as-is.
- **Dedup rule 1 — skip already-opted-out:** a number that already has *any*
  `opt_outs` row in the org is skipped entirely — no new opt-out, no re-attribution
  to a different campaign/stage (numbers stay credited to the stage that first
  suppressed them).
- **Dedup rule 2 — earliest wins:** when the file lists a number more than once,
  only the earliest reply time is kept.
- Opt-outs stay **brand-scoped** (the dialog's required brand(s) + optional
  providers/groups apply); attribution is layered on top. The whole import commits
  or rolls back in one transaction; re-running is idempotent (rule 1 skips everything
  already present). Verified by `scripts/test-optout-import-attribution.ts`.
- The plain phone-list path (Paste tab, or a CSV with no time column) is unchanged —
  append-only suppression with no attribution.

## 4. Data it reads/writes
- Writes `stage_results_imports`, `stage_result_rows`, `opt_outs`(+`opt_out_brands`), `clickers`, `contacts`, `campaign_stages` counters.
- Reads `result_import_mappings`, the stage/campaign, existing opt-outs/clickers (for dedup).

## 5. UI surface
- `components/campaigns/results-import-form.tsx` (CSV upload via `<FileDropZone>`), `manual-results-form.tsx` (manual counters), `import-history-dialog.tsx` (list + revert).
- Per-provider mapping config under `app/(protected)/` / `app/api/result-import-mappings/`.

## 6. Rules & edge cases
- Re-importing the same CSV is a no-op for already-seen `(stage_id, phone)` rows (`ON CONFLICT DO NOTHING`).
- `stage_results_imports` rows are never hard-deleted (audit survives revert).
- Permissions: `result_imports.create` (operator+), `result_imports.revert` (manager+), `import_mappings.*`.

## 7. Extension points / limitations
- Checkout clicks / sales have no CSV path (manual only). Saving the manual-results
  form also records the signed **change** in `sales_count` to the dated
  `stage_manual_sales` ledger (migration 0079, same transaction) so the date-ranged
  `/reports` tab can attribute manual sales to when they were entered. See
  [keitaro-poll.md](keitaro-poll.md) §2a.
- Outcome heuristics are tuned for known providers; new providers should ship a `status_value_map` rather than relying on heuristics.
