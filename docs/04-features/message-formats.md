# Message formats (0216)

_Last updated: 2026-10-19 (P2: formats, stage choice, owner-only custom text, send stamp, locks)_

How the brand, the creative text, the link and the opt-out footer are assembled into one SMS. Spec: [docs/superpowers/specs/2026-10-19-message-personalization-formats-design.md](../superpowers/specs/2026-10-19-message-personalization-formats-design.md) (§B). Personalization tags (`{first_name}` …) are part A of the same spec. They render from P4 (regular) / P5 (drip); until then a tagged message is refused (see Interim below).

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
- **Locks after the first send** (a `status='sent'` row on the stage, `stageHasSent` in [`lib/stages/send-locks.ts`](../../lib/stages/send-locks.ts)):
  - **the message shape, on every stage:** `409 format_locked_after_send`. "By Format" attributes per stage, so a changed format would relabel history.
  - **the creative, on drip stages:** `409 creative_locked_after_send` (spec A9). The exposure ledger reads `campaign_stages.creative_id` at send time.
  - **UI:** the picker is disabled and reads "Create a new stage to use another format" / "…creative" (copy in `lib/stages/lock-copy.ts`).
- **Warnings in the stage form** (never blocking):
  - "Brand appears twice": the creative contains `{brand}` and so does the format.
  - "This format has no brand — the creative doesn't contain {brand}".
- **The creative picker previews with the stage's shape and the *resolved* opt-out footer**, the same as the stage preview and the send. It used the raw `stop_text` before P2.

## Send stamp

Every `stage_sends` row records the shape that rendered it in `message_format_id` (the format) or `format_custom = true`. A pre-0216 row is `NULL` / `false`. The stamp fields are **required** on `StageSendInsertRow` and `DripSendInput`.

## Interim: `tags_not_supported_yet` (P2 → P4/P5)

Until per-recipient rendering ships, a message whose creative or custom text uses a **contact** tag (`{first_name}` `{zip}` `{state}`; `requiredContactTags` > 0) is never sent with the literal tag. `{brand}` is campaign data and **renders now** (spec A5) — a creative such as "Hello from {brand}" sends with the campaign's brand name:

| Path | Outcome |
|---|---|
| regular | `kickoffStageSend` refuses the stage with `tags_not_supported_yet` (a permanent refusal for the scheduled path) and sends one Telegram alert |
| drip first send | `skipIfTagged` ([`lib/drip/skip-send.ts`](../../lib/drip/skip-send.ts)) writes one `skipped_ineligible` row per lead with `last_error = 'tags_not_supported_yet'`. The row is idempotent, so a re-selected lead writes nothing new. **The journey is not closed**: it stays `routed` and sends once the tag is removed. |
| drip follow-up | same row; `already_sent` then stops re-selection |

P4 removes the regular branch and P5 the drip branch.

**`missing_brand`.** A message that uses `{brand}` on a campaign with no brand is refused cleanly (regular: kickoff refusal `missing_brand`, permanent for the scheduled path; drip: one idempotent `skipped_ineligible` row per lead with `last_error = 'missing_brand'`), never thrown.

Drip skip rows are written in ONE statement per batch (`insertSkippedSends`): the stage's existing skip set is read once per tick, not once per lead.

**Drip alerting (owner ruling 3, 2026-10-19).** Each scheduler / follow-up run tallies only the rows it NEWLY wrote and sends ONE Telegram per stage at the end of the run (`tallySkip` → `notifyDripSkips`). A (stage, lead) is therefore alerted exactly once; a lead re-selected on later ticks writes no row and raises no alert.

## UI flag — OFF until the owner switches it on (hotfix 2026-10-20)

`NEXT_PUBLIC_MESSAGE_FORMATS_UI_ENABLED` (`lib/messages/ui-flag.ts`; env, no migration; anything but `"true"` = OFF). With it OFF the stage form, the creative picker and the drip creative lock behave **exactly as before P2**: no format select, no custom text, no format warnings, no creative lock, no format fields in the stage payload, and the picker previews with the stage's raw stop text as it did. Settings → Message formats stays reachable with a note that the controls are off. **Not gated:** the backend — every stage still carries T1 (trigger / derived copy), every send renders T1 byte-identically and stamps `message_format_id`, and the contact-tag / `missing_brand` refusals stay. P4–P6 UI additions go behind the same flag. Tests: `scripts/test-message-formats-ui-flag.ts`.
