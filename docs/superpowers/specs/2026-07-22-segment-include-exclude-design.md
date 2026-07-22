# Campaign segments — per-segment include / exclude

Date: 2026-07-22
Status: approved, ready to implement

## Goal

On the campaign form, each selected segment can act as an **include** (narrow the
audience to it) or an **exclude** (subtract it). Per-segment toggle. Group is the
base for exclude.

## Audience math

```
INC = union of include-mode segments   (each = manual ∪ rules, §10e)
EXC = union of exclude-mode segments
GRP = union of selected contact groups

positive base P:
  INC and GRP → INC ∩ GRP        (current intersect)
  INC only    → INC
  GRP only    → GRP
  neither     → ∅  (only-exclude selection has no base)

final audience = P EXCEPT EXC     (no-op when EXC empty)
```

A segment is include XOR exclude (disjoint). Existing campaigns keep `EXC = ∅`,
so behavior is unchanged for them. Exclude subtracts from whatever positive base
exists; it is inert only when there is no base at all.

## Data model

Add `campaigns.audience_exclude_segment_ids int[] NOT NULL DEFAULT '{}'`
(migration 0114, hand-authored per project convention). `audience_segment_ids`
keeps its meaning = the **include** set. Additive + backward-compatible: the
currently-deployed code ignores the column, so it is safe to apply to the shared
Supabase DB before shipping the code.

## `lib/audience-snapshot.ts`

- `AudiencePreviewInput`: add `excludeSegmentIds?: number[]`.
- `buildAudienceSourceClause(includeBranches, groupClause, excludeUnion?)`: build P
  (existing include∩group / single-side), then `(P) EXCEPT (excludeUnion)` when
  exclude present. Returns null-equivalent (empty) when P is null.
- `buildAudienceSourceSql`: build EXC branches; evaluate EXC segments against the
  group universe when a group is present (final ⊆ GRP) to preserve the
  `restrictUniverse` perf lever.
- `previewAudience`: add `from_exclude_segment` marker branch;
  `membership_ok = positiveBase AND NOT from_exclude_segment`; add
  `excluded_by_segments` to `AudiencePreviewResult` (contacts in the positive base
  removed by an exclude segment). `from_segments/from_groups/overlap` stay defined
  over the positive dimensions.
- `computeStageAudienceCountForDraft`: `campaign.excludeSegmentIds`, same EXCEPT
  composition.
- `snapshotAudience`: consumes `excludeSegmentIds` via the shared source builder.

## API + validators

- `lib/validators/campaigns.ts`: `audience_exclude_segment_ids`
  (`z.array(int.positive()).optional()`) on the create/update base and
  (`.default([])`) on `audiencePreviewSchema`. superRefine: **disjoint** from
  `audience_segment_ids`.
- Routes: create (`route.ts`), PATCH (`[campaignId]/route.ts`), status
  (`status/route.ts`), audience-preview, stages/audience-preview, duplicate —
  thread the field. FK-ownership verified against org (same as segments). PATCH
  **audience-lock** guard (`audience_locked_after_draft`) gains
  `audience_exclude_segment_ids`. Detail GET returns the column.

## UI

`SegmentPicker` gains optional `segmentModes: Record<number,'include'|'exclude'>`
+ `onToggleMode(id)`. When provided, each selected chip shows a compact
Include/Exclude toggle (default **Include** on new selection). Campaign form state
holds two arrays; the picker value is their union. Toggling a chip moves a segment
between the arrays; deselecting drops it from both. Right-rail preview shows
"N excluded by segment". One-line hint under the picker.

## Verification

- `scripts/test-segment-exclude.ts`: assert `GRP EXCEPT EXC`, `INC ∩ GRP EXCEPT
  EXC`, include-only unchanged, exclude-only → empty.
- tsc, eslint (changed files), `next build`.
- Localhost `/campaigns/new`: toggle a segment to Exclude, watch the preview count
  drop + "N excluded by segment". Shown before any push.
- Docs: `docs/04-features/audience-snapshot.md`, `audience-segments.md`, CHANGELOG.

## Out of scope

- Changing group OR/segment OR semantics.
- Any per-stage segment override (stages inherit the campaign audience).
