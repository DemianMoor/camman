# Feature — Campaigns, Stages & Creatives

_Last updated: 2026-07-10_

## 1. Purpose
The campaign core: a **campaign** is a long-running container with a frozen audience and a `manual`/`tracked` link mode; **stages** are the individual SMS-send events under it (one creative each); **creatives** are reusable SMS copy. All three carry auto-generated immutable **tracking IDs** for external analytics.

## 2. Key concepts / entities
- `campaigns` — status machine `draft → active → paused → completed → archived`; `link_mode` manual/tracked; audience recipe (see [audience-snapshot.md](audience-snapshot.md)).
- `campaign_stages` — `stage_number` (trigger-assigned), creative + provider + phone, URLs, schedule, result counters, A/B split fields.
- `creatives` — many-to-many with offers via `creative_offers`; cached spam columns.
- `campaign_tracking_counters` — atomic per-(org,brand,offer,day) sequence.

## 3. How it works

### Campaign lifecycle
- Drafts save with **zero required fields** (CLAUDE.md §10b). Status transitions go through `app/api/campaigns/[campaignId]/status/route.ts`, each gated by a transition-specific permission (`campaigns.activate`/`pause`/`complete`/`archive`/`restore`).
- `draft → active` snapshots the audience in-transaction (see [audience-snapshot.md](audience-snapshot.md)).
- FK to brand/offer is `ON DELETE RESTRICT` — can't delete a brand/offer used by a campaign.

### Upload contacts onto a draft campaign (`POST /api/campaigns/[campaignId]/upload-contacts`)
- Lets an operator drop a CSV / pasted phone list straight onto a campaign's audience. Contacts are upserted (new created, existing reused — `ON CONFLICT (org_id, phone_number)`), tagged into the selected **existing** contact group(s), and those group IDs are UNION'd into the campaign's `audience_contact_group_ids` so the upload lands in *this* campaign's audience.
- **Draft-only.** Rejects any non-draft campaign with `reason: "audience_locked_after_draft"` (the audience freezes at activation — same lock the PATCH route enforces on audience fields). The "Upload contacts" button only renders for drafts.
- Requires both `contacts.upload` (upserting contacts) and `campaigns.update` (mutating the audience). At least one contact group is required (`assign_to_group_ids`, validated by `contactBulkUploadSchema`); groups are verified org-owned before any write. There is no group-creation path here — pick from existing groups.
- Reuses `PhoneUploadForm` (CSV/paste tabs, phone validation, group multi-select) and returns the standard upload summary (`submitted/valid/invalid/duplicates_in_db/inserted/groups_applied/updated_contacts`).

### Stages
- `stage_number` auto-assigned by a BEFORE INSERT trigger (clients omit it); UNIQUE(campaign_id, stage_number) is a backstop against concurrent-insert races (one racer fails → retry).
- Activity filters: `include_clickers` / `exclude_clickers` (mutually exclusive — CHECK `campaign_stages_clickers_mutex`), `include_no_status`.
- **A/B split** (`split_index` / `split_total`): set only via `POST /api/campaigns/[campaignId]/stages/[stageId]/split`; audience filtered by `mod(hashtext(contact_id::text), split_total) = split_index - 1` so a contact always lands in the same bucket. Immutable via PATCH (like `tracking_id`). CHECK enforces `1 ≤ index ≤ total`, `2 ≤ total ≤ 1000`. The `/split` guard blocks re-splitting a stage only while **live** (non-archived) split partners still exist (`lib/stages/split-membership.ts`); archiving or deleting the other variants unblocks it. See "Deleting stages" below.
- **Scheduling:** `scheduled_at` drives the send-scheduled cron for tracked campaigns; `schedule_missed_at` marks a window that closed before firing (stays reschedulable); `send_approved` gates the real-send drain. See [sms-send-pipeline.md](sms-send-pipeline.md) & [crons.md](crons.md).
- **SMS preview composition** (`lib/sends/stage-sms.ts`, `buildStageSms`): `<Brand>: <creative text>` + (if present) the `short_url` on its own line + `stop_text` (default `"Stop to END"`). The same shape renders in the stage form's live preview and the frozen `rendered_text`.
- **Total Cost auto-derivation** (migration `0081`, [`lib/stages/total-cost.ts`](../../lib/stages/total-cost.ts)): a stage's `total_cost` defaults to `cost_per_sms × (sends + opt_out_count)` — the assigned provider phone's per-SMS rate times sends **plus** opt-out replies (STOPs are billed like sends). **`sends = GREATEST(sms_count, accepted stage_sends)`**: API/tracked stages dispatch one `stage_sends` row per recipient and leave `sms_count` at 0, so the count of provider-accepted rows (`status='sent'`, the same number the "Submitted / accepted by TextHub" badge shows) is used; manual/CSV stages have no `stage_sends` and carry the count in `sms_count`. **Gated on the send having happened:** the cost stays `$0` until `sent_at` is set (an API fire or a "Mark as sent" click) **or** results are hand-entered (`sms_count > 0`) — it does not appear at stage-creation time. It's recomputed on every write that moves those inputs: the manual-results save, the opt-out poller after a STOP bumps `opt_out_count`, and the stage PATCH when `provider_phone_id` changes. `total_cost_manual` is the override flag: the manual-results form's **Auto-calculate total cost** switch turns it on/off, and a CSV import that carries a real provider cost sets it (the imported figure is authoritative and replaces a previously auto-derived value). When the flag is true the auto formula never touches `total_cost`.
- **Full URL builder** (`lib/stage-url.ts`): selected `utm_tag_ids` append `&<label>=<value_source>` to `full_url` in order. The tracking-ID chip attaches a proper `sub_id3=<id>` param (`setUrlParam`), never a bare value. A hand-edited guidekn `full_url` that is malformed (id-in-path / empty / placeholder / mismatched `sub_id3`) blocks Save (specific defect named) and is rejected server-side — see [tracking-attribution.md §5b](tracking-attribution.md).
- **Split tracking IDs are previewed live** in the A/B and behavioral split dialogs (predicted stage numbers `max+1…` → `formatStageTrackingId`), parity with a regular stage's on-the-go preview. On save, both split paths rebuild each sibling/lane's `full_url` **canonically from its own tracking id** (guidekn/empty sources) rather than inheriting-and-patching the source URL, so a malformed source can't propagate.

### Deleting stages

A stage is deletable only if it was never sent or marked-as-sent (`sent_at` is
null) **and** has no rows in `stage_sends`, `stage_results_imports`,
`stage_manual_sales`, or `keitaro_stage_results` — i.e. no send or result data
of any kind, including a Prepared/materialized-but-unsent stage (which already
has `stage_sends` rows). Such stages can be hard-deleted (`DELETE
/api/campaigns/[campaignId]/stages/[stageId]`, `stages.delete`, manager+). The
delete removes the row and all its child records via DB cascade (`stage_sends`,
`links`, result rows/imports, keitaro results, manual sales, opt-out
attributions, behavioral lanes); `campaign_events` keep the history with
`stage_id` set NULL. Sent/result-bearing stages stay archive-only.

Deleting the extra variants of an A/B split reverts the lone remaining member to
a normal stage. Archiving OR deleting the extra variants of either split kind
(A/B or behavioral) unblocks re-splitting the original — only *live* (non-archived)
variants/lanes block a re-split.

Deleting a behavioral parent also removes its lanes (the self-FK
`parent_stage_id` cascades); this is allowed only when neither the parent nor
any of its lanes has send/result data — lanes are best archived or deleted as a
set.

### Creatives
- M:N with offers; `applies_to_all_offers=true` ⇒ valid for any offer (junction rows still allowed as a fallback list; toggling the flag does NOT auto-clear them).
- No provider/brand on the creative (those live at the stage level). No status state machine — `active`/`archived` only.
- `quality` (high/average/poor/unknown), `sequence_placement` (warmup/1st/2nd/3rd/4th/5th/6th/any/unknown — up to 6 messages per sequence), and `funnel_stage` (start/clicked/checkout/ignored/unknown — migration `0076`) are manual user metadata for filtering/organizing. All default to `unknown` and are not enforced anywhere else. The creatives list exposes a `funnel_stage` multi-select filter (a `MultiSelectPicker`) and a sortable "Funnel Stage" column. The list's free-text search ([`lib/creatives/list-filters.ts`](../../lib/creatives/list-filters.ts), shared by `/api/creatives/list` and `/api/creatives/ids`) matches `text` ∪ `creative_id` ∪ `slug` (case-insensitive `ILIKE`), so a creative can be found/filtered by its auto-generated slug.
- **Stage creative picker** ([`components/campaigns/creative-picker-dialog.tsx`](../../components/campaigns/creative-picker-dialog.tsx)): a button on the stage form opens a dialog (replacing the old `<Select>`) — text search, a sequence filter dropdown (WarmUp/1st–6th, multi-select via `MultiSelectPicker`), spam-dot + EPC + CTR columns (full creative text shown on row hover via `title`), and a live SMS preview (chars · segments · warnings for spam / multi-segment / Unicode). One creative per stage (`creative_id`). The dialog is mounted only while open so its filter/selection state resets fresh each time. Default sort `epc desc`.
  - **Fetch strategy (perf):** the picker fetches creatives from the server (with the EPC/CTR aggregates) only when the **offer set or the ALL toggle** changes; **search and sequence are filtered client-side** over the fetched rows — instant, no round-trip per keystroke/toggle. During an offer/ALL refetch the current rows stay visible (no flash-to-spinner; spinner shows only on the first load). Client search matches creative text + slug.
  - **Offer widening:** the campaign's offer is pre-checked and locked on; other active org offers are checkboxes that broaden the list. This drives the multi-offer `offer_ids` (CSV) param on `/api/creatives/list` ([`lib/creatives/list-filters.ts`](../../lib/creatives/list-filters.ts)): eligible = a junction row to ANY selected offer, plus (when `include_all_offers` ≠ `false`) any `applies_to_all_offers=true` creative.
  - **ALL toggle:** an "ALL" checkbox in the Offers panel, **off by default**, sends `include_all_offers=false` so `applies_to_all_offers` creatives are hidden until the operator opts in; checking it adds them. The single `offer_id` param still works (and is what `/creatives` uses; it always includes all-offers creatives). Spam dot/score + metrics come from the list endpoint's cache/aggregate joins (read-only — listing does NOT trigger scoring). See [spam-classifier.md](spam-classifier.md).
- Bulk-create: up to 50 rows/request, shared offer/quality/sequence/funnel stage, one transaction. Bulk-edit applies one set of `quality`/`sequence_placement`/`funnel_stage`/`status`/offer changes across many selected creatives.
- **30-day performance columns** (creatives list, [`app/api/creatives/list/route.ts`](../../app/api/creatives/list/route.ts)): the list endpoint joins two per-creative aggregates and returns a `metrics` object → four sortable, server-ranked columns. Clean clicks = manual-mode stage clicks (`click_count`) + tracked-mode clean clicks (clicks where `classification NOT IN ('bot','prefetch','suspect')`, same "clean" rule as the click report). Stage counters anchor on `campaign_stages.created_at`; tracked clicks anchor on `clicks.clicked_at`; both windowed to the last 30 days.
  - **CTR** = clean clicks ÷ delivered · **Checkout Rate** = checkouts ÷ clean clicks · **Sales CR** = sales ÷ clean clicks · **EPC** = payout ÷ clean clicks (payout = `Σ sales_count × sales_payout_each`).
  - Each ratio is NULL (renders "—") when its denominator is 0, so "no data" never shows as 0%. Sort uses the ratio expression with `NULLS LAST` + an `id` tiebreaker. (The former `Campaigns` and `Quality` table columns were removed; `quality` remains a field, form input, and list filter.)

### Tracking IDs ([`lib/tracking-id.ts`](../../lib/tracking-id.ts), [`lib/tracking-id-format.ts`](../../lib/tracking-id-format.ts))
Auto-generated, **immutable**, separate from `id` and `human_id`.

| | Format | Example |
|--|--------|---------|
| Campaign | `<brand_id>_<offer_id>_<MMDDYY>_<seq>` | `5_14296_051526_1` |
| Stage | `<campaign_tracking_id>_s<stage_number>_c<creative_id>` | `5_14296_051526_1_s2_c42` |

- Date = campaign `created_at` in **ET** (`CAMPAIGN_TIMEZONE`). Drafts that get brand+offer later still date back to first save.
- Campaign seq is allocated atomically: `INSERT … ON CONFLICT DO UPDATE SET next_seq = next_seq + 1 RETURNING (next_seq - 1)` on `campaign_tracking_counters` (no SELECT-then-INSERT race). Must run in the same transaction that creates/updates the campaign so rollback releases the number.
- **When generated:** campaign — POST tx if brand+offer both set, or PATCH when previously NULL and both become set. Stage — POST/duplicate tx if parent has a `tracking_id` AND stage has a `creative_id` (POST will generate the campaign's ID first if needed).
- **Immutability:** PATCH rejects `tracking_id` with `code:"tracking_id_immutable"`. Changing brand/offer/creative/stage_number after generation does NOT regenerate it.
- **Uniqueness:** partial unique indexes `campaigns_tracking_id_org_uniq` / `campaign_stages_tracking_id_org_uniq` (`WHERE tracking_id IS NOT NULL`).
- **Sortability gotcha:** MMDDYY is not lexically sortable across year boundaries — always `ORDER BY created_at` for chronology.
- **Backfill:** idempotent `scripts/backfill-tracking-ids.ts` (gate `tracking_id IS NULL`).

## 4. Data it reads/writes
- Writes `campaigns`, `campaign_stages`, `creatives`, `creative_offers`, `campaign_tracking_counters`, `campaign_audience_pool` (via snapshot).
- Reads registry (`brands`, `offers`, `sms_providers`, `provider_phones`, `routing_types`, `traffic_types`, `utm_tags`), spam cache.

## 5. UI surface (see [ui-system.md](ui-system.md))
- `app/(protected)/campaigns/[id]/page.tsx` — detail page with the inline stage table; draft-only "Upload contacts" button → `PhoneUploadForm` in a `FormDialog`.
- `app/(protected)/campaigns/[id]/edit/page.tsx` + `components/campaigns/campaign-editor-page.tsx` — setup/audience/notes editor with live audience preview.
- `components/campaigns/stage-inline-creator.tsx` + `stage-form.tsx` — inline stage create/edit (FormDialog) with live SMS preview.
- `<CopyableId>` surfaces tracking IDs; campaigns list hides the tracking-ID column behind a per-browser toggle.

## 6. Rules & edge cases
- Activation gate: name + brand + offer + ≥1 **contact group** (code-authoritative; segments optional).
- Audience locked after activation (`audience_locked_after_draft`).
- `creative_id` on a stage is `ON DELETE SET NULL` — deleting a creative nulls the stage link but keeps the stage (and any minted links keep working — link `creative_id` is also SET NULL).

## 7. Extension points / limitations
- No multi-variant creative testing beyond the per-stage A/B split.
- Checkout-click and sales counts on stages are **manual-only** (no CSV path yet).
