# Feature — Campaigns, Stages & Creatives

_Last updated: 2026-06-10_

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
- **A/B split** (`split_index` / `split_total`): set only via `POST /api/campaigns/[campaignId]/stages/[stageId]/split`; audience filtered by `mod(hashtext(contact_id::text), split_total) = split_index - 1` so a contact always lands in the same bucket. Immutable via PATCH (like `tracking_id`). CHECK enforces `1 ≤ index ≤ total`, `2 ≤ total ≤ 1000`.
- **Scheduling:** `scheduled_at` drives the send-scheduled cron for tracked campaigns; `schedule_missed_at` marks a window that closed before firing (stays reschedulable); `send_approved` gates the real-send drain. See [sms-send-pipeline.md](sms-send-pipeline.md) & [crons.md](crons.md).
- **SMS preview composition** (`lib/sends/stage-sms.ts`, `buildStageSms`): `<Brand>: <creative text>` + (if present) the `short_url` on its own line + `stop_text` (default `"Stop to END"`). The same shape renders in the stage form's live preview and the frozen `rendered_text`.
- **Full URL builder** (`lib/stage-url.ts`): selected `utm_tag_ids` append `&<label>=<value_source>` to `full_url` in order.

### Creatives
- M:N with offers; `applies_to_all_offers=true` ⇒ valid for any offer (junction rows still allowed as a fallback list; toggling the flag does NOT auto-clear them).
- No provider/brand on the creative (those live at the stage level). No status state machine — `active`/`archived` only.
- `quality` (high/average/poor/unknown) and `sequence_placement` (warmup/1st/2nd/3rd/any/unknown) are user metadata for filtering.
- Stage creative picker queries `/api/creatives/list?offer_id=X&status=active` → creatives with a junction row to X **or** `applies_to_all_offers=true`. The picker shows a spam color-dot + score from the list endpoint's cache join (read-only — listing does NOT trigger scoring). See [spam-classifier.md](spam-classifier.md).
- Bulk-create: up to 50 rows/request, shared offer/quality/sequence, one transaction.
- **30-day performance columns** (creatives list, [`app/api/creatives/list/route.ts`](../../app/api/creatives/list/route.ts)): the list endpoint joins two per-creative aggregates and returns a `metrics` object → four sortable, server-ranked columns. Clean clicks = manual-mode stage clicks (`click_count + late_click_count`) + tracked-mode clean clicks (clicks where `classification NOT IN ('bot','prefetch','suspect')`, same "clean" rule as the click report). Stage counters anchor on `campaign_stages.created_at`; tracked clicks anchor on `clicks.clicked_at`; both windowed to the last 30 days.
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
