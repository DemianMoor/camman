# Message formats (0216)

_Last updated: 2026-10-22 (P4: tags on regular stages; regular format lock at materialized_at)_

How the brand, the creative text, the link and the opt-out footer are assembled into one SMS. Spec: [docs/superpowers/specs/2026-10-19-message-personalization-formats-design.md](../superpowers/specs/2026-10-19-message-personalization-formats-design.md) (§B). Personalization tags (`{first_name}` …) are part A of the same spec. They render on regular stages since P4 and on drip since P5 (both below).

## The one renderer

[`lib/messages/`](../../lib/messages/) renders every body. Every send path and every preview calls it.
- `tags.ts`: the tag registry.
- `format.ts`: the grammar, the seeds, the validators and `assembleMessage`.
- `render.ts`: `renderMessage`, `renderWorstCase`, `shapeFromStage`, `formatStamp`.

| Caller | Where |
|---|---|
| regular materialization | [`lib/sends/kickoff.ts`](../../lib/sends/kickoff.ts) (manual text, the representative segment/opt-out body, each tracked row) |
| drip first send | [`lib/drip/scheduler.ts`](../../lib/drip/scheduler.ts) |
| drip follow-up | [`lib/drip/followups.ts`](../../lib/drip/followups.ts) → [`lib/drip/send-one.ts`](../../lib/drip/send-one.ts) |
| previews | the stage form and the creative picker (`renderWorstCase`) |

`lib/sends/stage-sms.ts` `buildStageSms` is **T1** of the grammar and is byte-identical to the pre-format composer. Two proofs:
- **Grid:** `scripts/test-message-render.ts`, 150 cases against a frozen copy.
- **Live:** `scripts/export-t1-corpus.ts` → `scripts/verify-t1-format-identity.ts`, the live sent corpus. It covered 149,292 rows with 0 diffs, and was re-run for P2.

## Grammar

- **Blocks:** `{brand}` `{creative_text}` `{url}` `{stop_text}`.
- **Line break:** `<new_row>`.
- **Everything else is literal**, including unknown brace tokens. Creative 637's `{FirstName}` ships verbatim.
- **Substitution is a single pass:** a value is never re-read as syntax.
- **Trimming:** `url` and `stop_text` values are trimmed; `brand` and `creative_text` are not.
- **Empty rows:**
  - A row that is exactly one block whose value is empty is dropped (no link ⇒ no link line).
  - Trailing blank rows are trimmed (T2 with no link ends on its stop text).
  - Other blank rows are kept.
- **No creative ⇒ empty message.**

**Seeds (per org, `ensure_message_formats`):**

| Name | Template | |
|---|---|---|
| T1 — Brand prefix | `{brand}: {creative_text}<new_row>{url}<new_row>{stop_text}` | default; every pre-0216 stage was backfilled to it |
| T2 — Brand inline | `{creative_text} {brand} {stop_text}<new_row><new_row>{url}` | |
| T3 — Brand in creative | `{creative_text}<new_row>{url}<new_row>{stop_text}` | |

A format must contain `{creative_text}`, `{url}` and `{stop_text}`, and only block tokens are allowed (`validateTemplate`).

## Settings → Message formats

[`/settings/message-formats`](../../app/(protected)/settings/message-formats/page.tsx) lists the formats with:
- the template, the enabled switch, the default marker and the count of live stages;
- create / edit in a dialog with block buttons and a sample preview.

The rules live in [`lib/messages/format-admin.ts`](../../lib/messages/format-admin.ts); the routes under `app/api/message-formats/` are thin wrappers.
- **Exactly one default.** It is always enabled; the DB CHECK and the partial unique index back this.
- **Disabling a format that live stages use is refused:** `409`, `details.reason = format_in_use`, `details.count`. A live stage is a non-archived stage on a draft/active/paused campaign that is either drip, or regular and not yet materialized.
- **Editing a template is allowed while it is in use.** It applies to messages rendered from then on: regular rows are frozen at materialization, and drip renders at send.
- **Permissions:**
  - `message_formats.view`: every role.
  - `message_formats.manage`: manager, admin, owner. Never operator; operators only pick from enabled formats.

## Stage choice

- **Columns:** `campaign_stages.message_format_id` **or** `custom_text`. Exactly one is set (CHECK `campaign_stages_format_one_of`).
- **New stages:** a new stage with neither set gets the org default from a BEFORE INSERT trigger. The default is stamped, so a later default change never moves existing stages.
- **Derived stages copy their parent's shape** via `inheritedStageFormat` ([`lib/messages/stage-format.ts`](../../lib/messages/stage-format.ts)):
  - covers campaign duplicate, stage duplicate, A/B split, behavioural lanes and drip children;
  - a disabled parent format is not copied, so the copy gets the default;
  - guard: `scripts/test-stage-format-copy-guard.ts` (in `check:guards`).
- **Rules** (`decideStageFormatChange`). The form echoes every field, so only a different value counts as a change.
  - **Custom text is owner-only** (`compliance.manage`), like `stop_text`. Setting it, editing it and leaving it all require it (`403 compliance_field_locked`).
  - **Custom text must contain** `{creative_text}`, `{url}` and `{stop_text}` (`400 custom_text_missing_required_block`). It may also contain `{brand}` and `<new_row>`. A stage with custom text still needs a creative.
  - **A format must be enabled** and the org's own (`400 format_unavailable`).
- **Locks** (`stageFormatLocked` in [`lib/stages/format-lock.ts`](../../lib/stages/format-lock.ts); `stageHasSent` in [`lib/stages/send-locks.ts`](../../lib/stages/send-locks.ts)):
  - **the message shape, on every stage:** `409 format_locked_after_send`, for a REGULAR stage once `materialized_at IS NOT NULL` (its bodies are already rendered; P4) and for a DRIP stage at its first `status='sent'` row. "By Format" attributes per stage, so a changed format would relabel history.
  - **the creative, on drip stages:** `409 creative_locked_after_send` (spec A9). The exposure ledger reads `campaign_stages.creative_id` at send time.
  - **UI:** the picker is disabled and reads "Create a new stage to use another format" / "…creative" (copy in `lib/stages/lock-copy.ts`).
- **Warnings in the stage form** (never blocking):
  - "Brand appears twice": the creative contains `{brand}` and so does the format.
  - "This format has no brand — the creative doesn't contain {brand}".
- **The creative picker previews with the stage's shape and the *resolved* opt-out footer**, the same as the stage preview and the send. It used the raw `stop_text` before P2.

## Send stamp

Every `stage_sends` row records the shape that rendered it in `message_format_id` (the format) or `format_custom = true`. A pre-0216 row is `NULL` / `false`. The stamp fields are **required** on `StageSendInsertRow` and `DripSendInput`.

## Interim: `tags_not_supported_yet` (REMOVED — history)

Until per-recipient rendering ships, a message whose creative or custom text uses a **contact** tag (`{first_name}` `{zip}` `{state}`; `requiredContactTags` > 0) is never sent with the literal tag. `{brand}` is campaign data and **renders now** (spec A5) — a creative such as "Hello from {brand}" sends with the campaign's brand name:

| Path | Outcome |
|---|---|
| regular | **removed in P4**: rendered per recipient (section below) |
| drip first send | `skipIfTagged` ([`lib/drip/skip-send.ts`](../../lib/drip/skip-send.ts)) writes one `skipped_ineligible` row per lead with `last_error = 'tags_not_supported_yet'`. The row is idempotent, so a re-selected lead writes nothing new. **The journey is not closed**: it stays `routed` and sends once the tag is removed. |
| drip follow-up | same row; `already_sent` then stops re-selection |

P4 removed the regular branch and P5 the drip branch; `tags_not_supported_yet` no longer exists in `lib/sends/` or `lib/drip/`. `missing_brand` remains (below).

**`missing_brand`.** A message that uses `{brand}` on a campaign with no brand is refused cleanly (regular: kickoff refusal `missing_brand`, permanent for the scheduled path; drip: one idempotent `skipped_ineligible` row per lead with `last_error = 'missing_brand'`), never thrown.

Drip skip rows are written in ONE statement per batch (`insertSkippedSends`): the stage's existing skip set is read once per tick, not once per lead.

**Drip alerting (owner ruling 3, 2026-10-19).** Each scheduler / follow-up run tallies only the rows it NEWLY wrote and sends ONE Telegram per stage at the end of the run (`tallySkip` → `notifyDripSkips`). A (stage, lead) is therefore alerted exactly once; a lead re-selected on later ticks writes no row and raises no alert.

## UI flag — OFF until the owner switches it on (hotfix 2026-10-20)

`NEXT_PUBLIC_MESSAGE_FORMATS_UI_ENABLED` (`lib/messages/ui-flag.ts`; env, no migration; anything but `"true"` = OFF). With it OFF the stage form behaves **as before P2**: no format select, no custom text, no format warnings, no greyed-out creative picker, no format fields in the stage payload. **Not behind the flag** (owner adjustment 2026-10-20): the creative picker's preview uses the **resolved** opt-out footer (a correctness fix), and the **server-side drip creative lock** stays on (`409 creative_locked_after_send`) — with the flag off the picker is not greyed out, but a save that changes a sent drip stage's creative is refused. Settings → Message formats stays reachable with a note that the controls are off. **Not gated:** the backend — every stage still carries T1 (trigger / derived copy), every send renders T1 byte-identically and stamps `message_format_id`, and the contact-tag / `missing_brand` refusals stay. P4–P6 UI additions go behind the same flag. Tests: `scripts/test-message-formats-ui-flag.ts`.

## Personalization on regular stages (P4, 2026-10-22)

Regular stages render contact tags per recipient. **No live creative uses a contact tag**, and a message without one resolves to `NO_TAG_RULES` before any lookup, so every current stage is unchanged (byte-identical bodies and recipient SQL, proven on production in the P4 PR).

- **Rules.** `loadStageTagRules` ([`lib/sends/tag-rules.ts`](../../lib/sends/tag-rules.ts)) loads kickoff's own inputs (shape, creative, brand, resolved footer, stored short URL or a length-exact representative tracked link) and calls the pure `stageTagRules` ([`lib/messages/render.ts`](../../lib/messages/render.ts)): `{ required, firstNameMaxLength }` (the longest first name whose worst-case body still fits the segment allowance), or a stage-level refusal (`segment_ceiling_exceeded` / `multi_segment_not_allowed` / `missing_brand`).
- **Skips are eligibility layers** (last in `EXCLUSION_PRIORITY`): `missing_tag_data` (no `contact_attributes` row, or a required tag missing) and `segment_limit` (a valid name longer than L). Built from the SQL twins in [`lib/messages/tag-sql.ts`](../../lib/messages/tag-sql.ts), generated from the same registry as the renderer and parity-tested (`scripts/test-tag-sql-parity.ts`). `StageEligibilityParams.tagRules` is **required** (CLAUDE.md §11b). Preflight, the breakdown, reconcile, the CSV export and the stage audience preview all apply them; preflight/breakdown also report `missing_by_tag` (not exclusive). Campaign-level audiences never drop anyone for tag data (`Omit<…, StageOnlyExclusionKey>`): tags belong to a stage.
- **Kickoff** (tagged stages only): enumerate with the rules, then load the recipients' attributes (a separate read, so `stageRecipientsSql` is untouched), then **validate-all** renders every body first. A missing tag or a segment breach is a parity bug ⇒ `per_recipient_render_failed` (permanent refusal) + Telegram, 0 rows. The opt-out gate runs per body: txr refuses, dry-run providers get ONE aggregated alert ("N of M rendered bodies have no STOP"). Regular skips are counts only, no rows.
- **CSV export is blocked for a tagged stage** (owner, 2026-10-22): `GET …/export-phones` returns `409` with `reason: personalization_tags_not_exportable` and "This stage uses personalization tags — export not supported". The CSV carries phones only, so a manual send would ship the literal tag. Follow-up: the export gains a per-recipient rendered `message` column (tagged stages only).
- **UI** (behind the flag): creative editor tag picker + "Worst case: N characters · S segments" + unknown-tag warning; stage form "N% would be skipped (missing data X · segment limit Y)"; Prepare dialog missing-by-tag; activation dialog lists stages over 50% (a warning, never a block; `lib/messages/skip-share.ts`). With the flag OFF the Prepare dialog filters the two new buckets out.

## Personalization on drip (P5, 2026-10-22)

Drip renders contact tags per lead: routing rule `creative_tags` (permanent; absent for tag-less campaigns), per-lead render in the scheduler and follow-ups, skip rows `missing_tag:<tag>` / `segment_limit`, first-send skip closes the journey `exited`. Details and the no-op proof: [drip-campaigns-routing.md](drip-campaigns-routing.md#personalization-tags-on-drip-p5-2026-10-22).

## By Format report (P6, 2026-10-22)

`/reports/format` (behind the UI flag) groups performance by the stage's format name, or "Custom". The per-send stamp stays audit only. See [reports-rollup.md](reports-rollup.md#by-format-p6-2026-10-22--tab-behind-the-message-formats-ui-flag).
