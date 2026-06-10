# Docs Changelog

A running log of documentation-affecting changes. Add a dated entry whenever a doc is materially updated, and note the code commit/migration that prompted it.

## 2026-06-10 — Campaign audience preview: ~24× faster
- Audience preview/snapshot/draft-stage-count sped up from ~9s to ~0.4s on a 750K-contact org. Two changes in [lib/audience-snapshot.ts](../lib/audience-snapshot.ts) + [lib/segment-rules-eval.ts](../lib/segment-rules-eval.ts): (1) `buildSegmentAudienceClause` accepts an optional `restrictUniverse`, and the three audience functions pass the contact-group set when both dimensions are selected so a near-universal `is_not` rule no longer scans all contacts before the intersection narrows it; (2) opt-out/opt-in/clicker/in-use flags are LEFT-JOINed via deduped CTEs (`flagSetCtes`/`flagJoins`) instead of correlated `EXISTS` per row. Verified result-identical against a brute-force ground truth. Note: with both dimensions selected, the preview's `from_segments` now reflects the segment evaluated within the group (= the intersection). — Docs updated: [04-features/audience-snapshot.md](04-features/audience-snapshot.md).

## 2026-06-10 — Campaign audience: segment ∩ group (was union)
- Campaign audience composition now **intersects** the segment dimension with the contact-group dimension when both are selected (a contact must be in a selected segment AND a selected group); a single populated dimension is used alone. Previously the two were UNION'd. Affects `buildQualifyingContactsSql` (snapshot), `previewAudience` (editor preview), and `computeStageAudienceCountForDraft` (draft stage count) in [lib/audience-snapshot.ts](../lib/audience-snapshot.ts) via the new `buildAudienceSourceClause` helper. Preview `from_segments`/`from_groups` now report each side's pre-intersection pool; `total_matching`/`overlap` are the intersected audience. — Docs updated: [04-features/audience-snapshot.md](04-features/audience-snapshot.md), CLAUDE.md §10b.

## 2026-06-10 — Segment rule: in use in another campaign in last period
- New `in_use_in_campaign_last_period` segment rule type (migration `0059`): include (`is`) / exclude (`is_not`) contacts that were in use in another campaign within a fixed lookback window (`1d`/`3d`/`1w`/`2w`/`1m`/`3m`/`6m`/`1y`). "In use" = in a `campaign_audience_pool` for a campaign with `status` active/paused/completed and ≥1 live stage (draft/pending/sent/success), windowed on `campaigns.created_at`. New `campaign_use_period` value shape. — Docs updated: [04-features/audience-segments.md](04-features/audience-segments.md), [03-data-model.md](03-data-model.md).

## 2026-06-08 — Upload contacts onto a draft campaign
- New `POST /api/campaigns/[campaignId]/upload-contacts` + draft-only "Upload contacts" button on the campaign detail page: CSV/paste phone upload that upserts contacts, tags them into selected existing contact group(s), and UNIONs those groups into the campaign's `audience_contact_group_ids`. Draft-only (audience freezes at activation); requires `contacts.upload` + `campaigns.update`. — Docs updated: [04-features/campaigns-stages-creatives.md](04-features/campaigns-stages-creatives.md).

## 2026-06-05 — Initial documentation set
- Created the full `docs/` set: `README`, `01-overview`, `02-architecture`, `03-data-model` (with ER diagram), `04-features/*` (12 module files), `05-flows`, `06-integrations`, `07-conventions`, `08-local-setup`.
- Documented reality against the codebase at branch `main` (recent commits through `bf7010a` "Active stages block"; schema through migration `0058_send_circuit_breakers`).
- Recorded 5 doc↔code discrepancies and a set of `[VERIFY]` items in [07-conventions.md](07-conventions.md):
  1. Activation gate requires ≥1 **contact group** (not segment) — code vs CLAUDE.md §10b.
  2. `is_in_contact_group` rule type present in eval/migration `0031` but missing from the inline CHECK list in `db/schema.ts`.
  3. `.env.example` shows pooler port `5432`; CLAUDE.md §6 mandates `6543` (transaction pooler).
  4. No command palette / cmdk exists (was on the wishlist).
  5. `proxy.ts` protected-prefix list is narrower than the full protected route set.
- Pre-existing `docs/security-notes.md` left untouched; linked from the index.

> When you change behavior that a doc describes, update the doc **and** add an entry here in the same PR (Part B rule).
