# Message personalization tags + stage message formats — design

Status: RECON APPROVED by the owner 2026-10-19 (answers 1–5, approvals and blocking items below). Base: origin/main `cdf96d7f`. Cards: parent [869fk29z8](https://app.clickup.com/t/869fk29z8) · migration 0216 [869fk2a0f](https://app.clickup.com/t/869fk2a0f) · migration 0217 [869fk2a1e](https://app.clickup.com/t/869fk2a1e). Plan: [docs/superpowers/plans/2026-10-19-message-personalization-formats.md](../plans/2026-10-19-message-personalization-formats.md).

## Owner rulings (2026-10-19)

- **R1 Regular campaigns get tag support too.** The stage editor shows "N% would be skipped" from the audience preview. Activation shows a **warning, never a block**, when more than 50% of a stage's audience would be skipped.
- **R2 Missing tag at drip routing is PERMANENT.** The lead falls through to the next-priority campaign; if no campaign fits, it becomes `unroutable`.
- **R3 Regular skips are eligibility-layer counts only — no `stage_sends` rows.** Drip writes `stage_sends` rows with `status='skipped_ineligible'` and the reason in `last_error`.
- **R4 Format lock.** A stage's message format locks once the stage is committed to a send. **Regular stages: `materialized_at IS NOT NULL`** (the rendered bodies already exist, so changing the format would no longer change the messages — owner, 2026-10-20, applied in P4). **Drip stages: sent ≥ 1**, with the same rule and the same server guard as the drip creative lock (A9). Before that, both stay editable.
- **R5 Custom stage text is owner-only (`compliance.manage`)**, the same as `stop_text`. Operators pick from enabled templates only.
- **Approved:**
  - the opt-out check moves to per-recipient in kickoff; dry-run providers get **one aggregated Telegram alert per stage**
  - the segment rule applies on drip (`allow_multi_segment` honoured)
  - migrations 0216 and 0217, preview-first on camman-v2 with write tests
  - nothing paid
- **Gated on the owner's "Go", in the attended morning window:** prod `db:migrate`, the T1 stage backfill (inside 0216), and the zip backfill.
- **Blocking items:**
  - `preflight-breakdown.ts` never selects `offer_rules_enabled`. Fix it in its own small PR before P4, with before/after counts on 3 live stages.
  - The creative picker previews with the raw `stop_text`. Fix it inside P2 so the preview equals the rendered send.
- **Build order:** P1 → P2 → P3 → P4 → P5 → P6, one PR per phase, with the verify step reported per phase. P1's PR description carries the byte-for-byte T1 proof against live `rendered_text`.

## Points confirmed (owner, 2026-10-19)

All six confirmed; point 3 changed to a block. Further owner corrections, 2026-10-19:
- **Interim fail-closed reason `tags_not_supported_yet`** (P2 → P4/P5), for a message with a **contact** tag (`{first_name}` `{zip}` `{state}`). `{brand}` needs no contact data and renders from P2 on (implementation ruling 2026-10-19, spec A5):
  - regular kickoff refuses the stage + Telegram alert;
  - drip skips the lead with a `skipped_ineligible` row, `last_error='tags_not_supported_yet'`, and no journey close;
  - removed in P4 (regular) and P5 (drip).
- **Permission set:** `message_formats.manage` excludes the operator (B1).

1. **Where the >50% warning appears.** In two places: the campaign status dialog for draft → active (for every existing stage whose creative uses tags), and the stage Prepare dialog. Both are non-blocking.
2. **The format lock covers ALL stages, regular and drip** — regular from `materialized_at IS NOT NULL`, drip from sent ≥ 1 (R4; the regular trigger changed from sent ≥ 1 in P4). By Format revenue is attributed per stage (Keitaro rows), so a format changed after a regular stage has sent would relabel its history. The creative lock stays drip-only, per A9.
3. **A custom-text stage still requires a creative.** The exposure ledger, content dedup, By Creative and kickoff's `no_creative` gate all key on it. **CHANGED by the owner 2026-10-19: block, not warn.** Custom text must contain `{creative_text}` (see B4).
4. **The drip routing rule also covers the segment limit**, not only missing data. A lead whose first name is too long for any first-send stage of a campaign falls through at routing rather than being admitted and then skipped.
5. **A drip FIRST send skipped at send time** (the creative changed after routing) writes the skipped row and closes the journey: `state='exited'`, `close_reason` = the same reason string. Without the close, the scheduler would pick the journey up again on the next tick.
6. **Unknown brace tokens stay literal.** Tag keys match exactly (lowercase). Live creative 637 contains `{FirstName}` and keeps rendering exactly as today. The creative editor warns "unknown tag {FirstName} — will be sent literally" but does not refuse the save.

## P4 owner rules (2026-10-22)

- **UI behind the flag.** Every new P4 UI surface — tag picker, worst-case length, "N% would be skipped", the >50% warnings, the skip buckets in the Prepare/status dialogs — renders only when `NEXT_PUBLIC_MESSAGE_FORMATS_UI_ENABLED` is on. It stays OFF.
- **Backend not gated, but a proven no-op.** The eligibility layers, per-recipient render, per-recipient opt-out gate and kickoff validate-all run for every stage. No live creative uses a contact tag, so on every current stage they must change nothing. Proof required in the PR: pre/post byte-identity of prepared (`stage_sends.rendered_text`) rows, and identical preflight counts on 3 live stages.
- **No migration in P4. Nothing paid.**

## Recon facts this design rests on (origin/main cdf96d7f, prod 2026-10-19)

- **One composer today:** `buildStageSms` ([lib/sends/stage-sms.ts](../../../lib/sends/stage-sms.ts)). Every call site is listed in the plan (P2 / P4 / P5).
- **Kickoff assumes one text per stage.** The segment check and opt-out gate run once on a representative body ([kickoff.ts:543-616](../../../lib/sends/kickoff.ts)). Drip renders per lead and has no segment check.
- **Where the data lives:** `contacts` has no name, zip or state. All personal fields are in `contact_attributes` (1:1, 415,842 rows, all `source='drip_intake'`).
- **Fill rates:**

  | Field | Fill | Source |
  |---|---|---|
  | `first_name` | 4.2% | `bsd` 100%, `pml` 0% |
  | `state` | 99.7% | all 2-letter codes |
  | zip | 0% stored | 96% of the last 30 days' leads in `lead_inbox.raw` (`pml`), 99.99% 5-digit |
  | anything, regular contacts | 0% | — |

- **Measured cost:** 20K renders + segment count + opt-out check ≈ 145 ms. Joining attributes onto a 20,683-row stage ≈ +140 ms.
- **T1 matches `buildStageSms` on all 150 edge cases** (prototype grammar, §B2). No `unaccent` extension, so transliteration must be TypeScript-defined (the SQL twin is generated from the same map, §A4).
- **Rows and caps:**
  - The exposure trigger fires only on `status='sent'`, and cost only counts `'sent'`.
  - Drip caps count `sent`/`sending`/`pending` only, so skipped rows are free.
  - Drip follow-ups stop re-selecting a journey once ANY `stage_sends` row exists for (child stage, contact).
- **Drip routing:**
  - The hour fallback only picks candidates whose ONLY failing rule is `hour_capacity`, so a tag failure can never be overridden by it.
  - Routing's `active_creative_ids` includes follow-up children; the new rule must filter `parent_stage_id IS NULL`.
- **Live drip impact of the segment rule:** 23,295 sends in the last 2 days, 0 over one segment.

---

## A. Personalization tags

### A1. Registry — `lib/messages/tags.ts` (pure, client-safe)

One entry per tag. A new tag is one entry here, plus (if it is a contact field) its column in the SQL twin map.

| key | label | scope | source | maxLength | worstCase |
|---|---|---|---|---|---|
| `first_name` | First name | contact | `contact_attributes.first_name` | 15 | `"X".repeat(15)` |
| `zip` | ZIP code | contact | `contact_attributes.zip` (0219) | 5 | `"00000"` |
| `state` | State | contact | `contact_attributes.state` | 2 | `"XX"` |
| `brand` | Brand | campaign | `brands.name` via `campaigns.brand_id` (A5) | 20 | `"X".repeat(20)` (live max 9) |

**Tag syntax:** `{key}`, an exact lowercase match. Anything else in braces is literal (point 6). The only insertion UI is the tag picker (creative editor and custom stage text).

### A3. Missing

A contact tag is **missing** when its normalizer returns `null`. Junk values live in ONE constant, `JUNK_VALUES = ["n/a", "unknown", "none", "-"]`, compared case-insensitively on the trimmed raw value.

### A4. Normalizers (TypeScript is the definition; SQL twins are generated from the same constants)

- **first_name.** Return `null` (missing) if any of these hold:
  - the trimmed raw value is empty;
  - its lowercase form is in `JUNK_VALUES`;
  - it contains a digit;
  - after cleaning, its length is < 2 or > 15.

  Cleaning steps (tightened 2026-10-19 after the P1 review found mangled names: "Ștefan"→"Tefan", "O’Neil"→"Oneil", "--" accepted):
  1. Map characters through `TRANSLIT`, a generated table covering:
     - each character's NFKD base letters over U+00C0–U+024F (Latin-1, Latin Extended-A/B) and U+1E00–U+1EFF (Latin Extended Additional);
     - extra letters: ß→ss, æ/Æ→ae/Ae, œ/Œ→oe/Oe, ø/Ø→o/O, đ/Đ→d/D, ð/Ð→d/D, þ/Þ→th/Th, ł/Ł→l/L, ı→i, ħ/Ħ→h/H;
     - punctuation variants: curly apostrophes → `'`, Unicode hyphens/dashes → `-`.
  2. **Any letter that is still not A–Z makes the name missing.** It is never deleted, because deleting it ships a wrong name ("Ana李" → "Ana"). Non-letters such as `.` or emoji are dropped.
  3. Delete every remaining character outside `[A-Za-z' -]`, collapse runs of whitespace, and trim.
  4. **At least 2 letters**, and at most 15 characters, or the name is missing ("--" and "A-" are missing).
  5. Title-case: lowercase everything, then uppercase the first letter and any letter after a space, hyphen or apostrophe. Examples: `JOSÉ` → `Jose`, `mary-jane` → `Mary-Jane`, `O’Neil` → `O'Neil`, `Ștefan` → `Stefan`, `Nguyễn` → `Nguyen`.

  Accents never cause a skip: every Latin-script letter transliterates. Only a non-Latin letter or the length rules can.
- **zip.** The trimmed value must match `^(\d{5})(?:-?\d{4})?$`; the result is the first 5 digits. Anything else is missing. A zip that lost its leading zero (3 live rows) is missing; we don't guess.
- **state.** If the trimmed value is 2 letters and its uppercase form is in `US_STATES` (50 states + DC), the result is that code. Otherwise, lowercase it and collapse whitespace; if that matches a full state name, the result is its code. Anything else is missing.
- **brand.** The trimmed campaign brand name. Activation already requires a brand. An empty brand with a `{brand}` tag present:
  - regular: kickoff refuses the stage with `missing_brand`;
  - drip: the routing rule fails.

### A5. `{brand}`

`{brand}` reads the campaign's current brand name at render time: at materialization for regular campaigns, at send time for drip. Regular rows are frozen once materialized, as they are today.

### A6. Segment rule (per recipient)

`maxSegments = creative.allow_multi_segment ? MAX_SEGMENTS (4) : 1`.

`zip`, `state` and `brand` have fixed length for a given stage. After cleaning, `first_name` contains only GSM-7 base characters, so the rendered length grows exactly 1 per name character and the charset never flips. So:

- **`firstNameMaxLength(stageInput, maxSegments)`** returns the largest L in 0..15 for which the worst-case body (first_name = `"X".repeat(L)`, other tags at their worst case) fits in `maxSegments`. It returns `null` if even L = 0 doesn't fit. That `null` is the existing stage-level refusal (`segment_ceiling_exceeded` / `multi_segment_not_allowed`).
- **A contact is skipped for `segment_limit`** when `char_length(normalized first_name) > L`. This applies only when the message uses `{first_name}`.
- **Tracked links** use `buildRepresentativeTrackedLinkUrl`, which is the same length as the real link, so L is exact.
- **The creative editor** shows the worst-case length of the creative text alone (tags at worstCase) and flags it when that exceeds 1 segment. The stage form shows the worst-case full message.

### A7. Visibility

- **Regular campaigns:** two new eligibility layer keys, `missing_tag_data` and `segment_limit`, appended at the END of `EXCLUSION_PRIORITY`. Every existing bucket keeps its number.
- **Labels:** `excluded — missing data` and `excluded — segment limit`.
- **Missing data per tag:** preflight and the preflight breakdown also return `missing_by_tag: Partial<Record<TagKey, number>>`, one `FILTER` per tag predicate.
- **Stage editor:** "N% would be skipped" = (`x_missing_tag_data` + `x_segment_limit`) / the audience before those two layers.
- **Recording:**
  - No exposure or cost is recorded for a skip.
  - Regular skips write no rows.
  - Drip skips write `skipped_ineligible` rows, which the exposure trigger and cost both ignore.

### A8. Drip

- **Routing rule `creative_tags`** (per candidate, in `evaluateLeadRouting` before `eligible`):
  - **When it applies:** only when the candidate's first-send stages (`drip_active`, not archived, `parent_stage_id IS NULL`) use any tag. Otherwise the rule is ABSENT, so stored reasons for tag-less campaigns stay byte-identical.
  - **Fails as `missing` when either:**
    - a required contact tag normalizes to `null` — detail `missing data: first_name, zip`;
    - the normalized first_name is longer than the smallest L across those stages — detail `segment limit (first_name 14 > 12)`.
  - **PERMANENT:** the rule is not added to `TEMPORARY_CANDIDATE_RULES` (R2).
  - **Inputs** (stage texts, format/custom, allow_multi, brand, short domain) are loaded and L is computed once per candidate per routing run, not per lead.
- **First send (scheduler):** each lead is rendered. On a missing tag or segment limit:
  - insert a `stage_sends` row with `status='skipped_ineligible'` and `last_error` = `missing_tag:<key>` or `segment_limit`;
  - set the journey to `state='exited'` with the same string as `close_reason` (point 5);
  - mint no link.
- **Follow-up:** the same skipped row is written. The journey continues; `already_sent` stops re-selection.
- **Segment check on drip:** new (approved). It applies the same per-recipient rule, using `allow_multi_segment`.

### A9. Drip creative lock

`PATCH /api/campaigns/[campaignId]/stages/[stageId]` returns **409** with `details.reason = 'creative_locked_after_send'` when:
- the stage's campaign is `type='drip'`; and
- the payload's `creative_id` **differs** from the stored one (the form echoes every field, so the check compares values, like the scheduled-time lock); and
- `EXISTS (stage_sends WHERE stage_id = $1 AND status = 'sent')`.

UI: the picker is disabled and reads exactly "Create a new stage to use another creative". The shared helper is `stageHasSent(dbc, stageId)` in `lib/stages/send-locks.ts`.

### A10. Gates on the rendered text

- **Spam score:** creative text as typed (tags literal). Advisory only, never a send gate. Unchanged.
- **Dedup:** phone only. Unchanged.
- **Opt-out gate:** runs on EVERY recipient's final rendered body:
  - regular: in kickoff's validate-all pass (§C3);
  - drip: already per lead.
- **Dry-run providers:** one aggregated Telegram alert per stage: "N of M rendered bodies have no STOP".

## B. Message formats

### B1. Screen

`/settings/message-formats` lists every format with its name, template, enabled toggle and default marker. The org always has exactly one default. Permissions:
- `message_formats.view`: every role (viewer, operator, manager, admin, owner). Operators need it to pick a format in the stage form.
- `message_formats.manage` covers create, edit, enable/disable and make-default:

  | Role | `message_formats.manage` |
  |---|---|
  | viewer | ✗ |
  | operator | ✗ (picks from enabled formats only) |
  | manager | ✓ |
  | admin | ✓ |
  | owner | ✓ |

  `admin` holds it because `lib/permissions.ts` builds `adminPerms` from `managerPerms` — every manager permission reaches admin and owner. Confirmed by the owner 2026-10-19: keep admin included.

### B2. Grammar

- **Blocks:** `{brand}`, `{creative_text}`, `{url}`, `{stop_text}`.
- **Row break:** `<new_row>` (rendered as `\n`).
- Everything else is literal.
- **Template validator:**
  - only the four blocks are allowed as tokens;
  - `{creative_text}`, `{url}` and `{stop_text}` are required;
  - error codes: `unknown_token` and `missing_block`.
- **Rendering:**
  - **Single pass:** block values are substituted verbatim and never re-scanned.
  - **Trimming:** `url` and `stop_text` values are trimmed; `brand` and `creative_text` are not.
  - **Row drop:** a row whose template is exactly one block token, and whose value is empty, is dropped. Any other empty row, such as T2's deliberate blank line, is kept.
  - **Trailing blank rows are trimmed** (owner, 2026-10-19), for every format and for custom text: T2 with no link ends on its stop text. Rows are template rows, so a creative whose own text ends in a newline is untouched, and T1 stays byte-identical to legacy (grid and live proof re-run: 0 diffs).
  - **No creative:** an empty or absent creative text gives `""` (nothing to send), as today.
- **Seeds (per org):**

  | Name | Template | Default |
  |---|---|---|
  | `T1 — Brand prefix` | `{brand}: {creative_text}<new_row>{url}<new_row>{stop_text}` | ✓ |
  | `T2 — Brand inline` | `{creative_text} {brand} {stop_text}<new_row><new_row>{url}` | |
  | `T3 — Brand in creative` | `{creative_text}<new_row>{url}<new_row>{stop_text}` | |

- **T1 must equal today's `buildStageSms` byte-for-byte** on live inputs (P1 proof).

### B3. Stage choice

- **Format choice:**
  - Every stage carries `message_format_id` (an enabled format) or `custom_text` (exactly one of the two).
  - A new stage gets the org default, stamped at creation. A later default change never alters existing stages.
  - Derived stages copy their parent's choice: campaign duplicate, stage duplicate, split, behavioral split, and drip children.
- **Disabling or archiving a format** returns 409 `format_in_use` with `details.count` when "live" stages use it. A live stage is a non-archived stage on a campaign in `draft`/`active`/`paused` that is either drip, or regular with `materialized_at IS NULL`.
- **Defaults:** the default format can't be disabled, and a disabled format can't be made default.

### B4. Custom text

- **Who:** owner-only (R5).
- **What it is:** a stage-level template that may contain the blocks, the tags, literal text and `<new_row>`.
- **Validator at save:** it must contain `{creative_text}`, `{url}` AND `{stop_text}`; otherwise the save is refused with `custom_text_missing_required_block`. The form has "Insert {creative_text}", "Insert {url}" and "Insert {stop_text}" buttons.
- **Same path as everything else:** custom text goes through the same render, segment rule and opt-out gate.
- **Creative:** the creative is still required (point 3).

### B5. Warnings in the stage form (non-blocking)

- "Brand appears twice" when the creative contains `{brand}` and the chosen template places `{brand}`.
- "This format has no brand — the creative doesn't contain {brand}" when a template without `{brand}` (T3) is chosen for a creative with no `{brand}`.

### B6. `{stop_text}`

Resolved by `resolveOptOutFooter` exactly as today (number > provider > stage > default).

### B7. Reporting

- **Report:** a "By Format" dimension that groups on the STAGE's format (the format name, or "Custom"). This is exact because of the lock (R4, point 2).
- **Per-send stamp:** each send also records `stage_sends.message_format_id` and `format_custom`, for audit and exact sent counts.
- **Editing a template's text** affects future renders only:
  - regular rows are frozen at materialization;
  - drip renders at send;
  - a name edit relabels history (accepted).

## C. Code shape

### C1. Pure modules (P1)

- `lib/messages/tags.ts`: registry, `JUNK_VALUES`, `TRANSLIT`, `US_STATES`, normalizers, `findTags`, `findUnknownTokens`.
- `lib/messages/format.ts`: grammar, `T1_TEMPLATE`, `SEED_FORMATS`, `validateTemplate`, `validateCustomText`, `assembleMessage`.
- `lib/messages/render.ts`: `renderMessage`, `renderWorstCase`, `firstNameMaxLength`, `checkRecipientBody`.
- `buildStageSms` keeps its signature and becomes `assembleMessage(T1_TEMPLATE, …)`. Over P2/P4/P5 every caller moves to `renderMessage`.

### C2. SQL twins (P4)

`lib/messages/tag-sql.ts` generates, from the same constants:
- `tagMissingSql(key, alias)`;
- `firstNameCleanLengthSql(alias)`, built from `translate()` + `replace()` + `regexp_replace`.

A parity test runs both sides over a fixture corpus (accents, ligatures, Cyrillic, emoji, digits, junk, padding) on the preview DB.

### C3. Kickoff (P4)

1. Resolve the stage's shape, required tags and `L`. If `L` is `null`, refuse the stage as today.
2. Enumerate recipients with their attributes. This uses a LEFT JOIN on `contact_attributes`; `tagRules` is required on the input (§11b).
3. **Validate-all before any insert:** render every recipient. All must pass three checks: tags present, segments within the limit, opt-out language present (or a dry-run provider, which is aggregated).
   - A missing tag or segment breach that SQL didn't exclude is a parity bug. Refuse the stage with `per_recipient_render_failed` and send a Telegram alert. Fail closed.
   - txr without STOP: refuse with `missing_opt_out_language`.
4. Insert the rows with `message_format_id` / `format_custom` stamped. Manual mode renders per recipient too.

### C4. Locks and permissions

- `lib/stages/send-locks.ts` holds `stageHasSent`.
- Format lock: 409 `format_locked_after_send`, applied to all stages (point 2): regular when `materialized_at IS NOT NULL`, drip when sent ≥ 1 (`stageHasSent`). Creative lock: drip only. Custom text: `compliance.manage`.
- Every new route is classified in `lib/authz/route-map.ts`.

## D. Schema

**0216** (additive; `SET LOCAL lock_timeout = '5s'` leads the batch)

- **`message_formats`** (new table):
  - Columns: `id serial pk`, `org_id uuid not null fk cascade`, `name text not null`, `template text not null`, `is_enabled boolean not null default true`, `is_default boolean not null default false`, `status text not null default 'active'` (CHECK active/archived), `archived_at timestamptz`, `created_at`, `updated_at`.
  - Unique partial index on `(org_id) WHERE is_default`.
  - RLS: org SELECT; manager+ INSERT/UPDATE; no DELETE.
- **`ensure_message_formats(p_org uuid) RETURNS int`**: seeds T1–T3 when the org has none, then returns the default id.
- **`campaign_stages`**:
  - New columns: `message_format_id int NULL REFERENCES message_formats(id) ON DELETE RESTRICT`, `custom_text text NULL`.
  - **Backfill:** `UPDATE … SET message_format_id = ensure_message_formats(org_id)` (3,074 rows).
  - **CHECK** `campaign_stages_format_one_of`: `(message_format_id IS NULL) <> (custom_text IS NULL)`.
  - **BEFORE INSERT trigger:** when both columns are NULL, set `message_format_id := ensure_message_formats(NEW.org_id)`. This keeps the 96 test fixtures and new orgs working without touching `handle_new_user`.
- **`stage_sends`**: `message_format_id int NULL` (no FK) and `format_custom boolean NOT NULL DEFAULT false`. Both are metadata-only adds.

**0219** (planned as 0217; renumbered after main shipped 0218): `contact_attributes.zip text NULL`.

Skip reasons need no schema change: eligibility layer keys, `skipped_ineligible` + `last_error`, and the `drip_journeys.reason` JSON.

## E. Docs (part of done, per phase)

| Doc | What changes |
|---|---|
| `docs/04-features/` | new `message-formats.md`; `drip-campaigns-routing.md` (rule `creative_tags`); the creatives/sends feature docs |
| `docs/03-data-model.md` | schema + ERD (0216/0219) |
| `docs/05-flows.md` | render step in the send flows |
| `docs/07-conventions.md` | the tag registry as the single source; T1 byte-identity; the format lock |
| `docs/CHANGELOG.md` | every phase |
| CLAUDE.md | new §10h (message formats and tags), short, pointing at the feature doc |
