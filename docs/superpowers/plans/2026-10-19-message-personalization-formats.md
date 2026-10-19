# Message Personalization Tags + Stage Message Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a message per recipient: personalization tags in the creative, wrapped in a per-stage format template or owner-only custom text. Contacts missing data, or over the segment rule, are skipped visibly: as layer counts for regular campaigns, and through routing or `skipped_ineligible` rows for drip. "By Format" is added to reports.

**Architecture:** Three pure modules form the one renderer: `lib/messages/tags.ts`, `format.ts` and `render.ts`. Every send path and preview calls them; `buildStageSms` becomes T1. Formats live in `message_formats` (0216) and are chosen per stage. Regular campaigns exclude skips with two new eligibility layers, whose SQL is generated from the TypeScript registry. Drip excludes at routing (`creative_tags`) and writes skip rows at send.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle (hand-authored migrations) · Postgres · tsx test scripts (pure, or on the preview DB).

**Spec:** [docs/superpowers/specs/2026-10-19-message-personalization-formats-design.md](../specs/2026-10-19-message-personalization-formats-design.md). Read it first. Section refs below (A6, B2, …) point into it.

## Global Constraints

- One PR per phase, in order: P1 → P2 → P3 → **P4-pre** → P4 → P5 → P6. Re-read origin/main before each phase and rebase. Report each phase's verify step in the PR.
- **T1 stays byte-identical** to origin/main `buildStageSms` on every input. Any T1 stage's body is unchanged by every phase.
- **Tags:**
  - Keys are exact lowercase `{first_name}` `{zip}` `{state}` `{brand}`.
  - Unknown brace tokens are literal (creative 637's `{FirstName}` must render as today).
  - `JUNK_VALUES = ["n/a","unknown","none","-"]`. first_name length 2..15. MAX_SEGMENTS = 4.
- **Template grammar:**
  - Blocks: `{brand}` `{creative_text}` `{url}` `{stop_text}`. Row break: `<new_row>` → `\n`.
  - Substitution is a single pass; values are never re-scanned.
  - `url` and `stop_text` are trimmed.
  - A row whose template is exactly one block, rendering empty, is dropped.
  - An empty creative gives `""`.
- **Copy (exact):**
  - layer labels `missing data`, `segment limit`;
  - lock text "Create a new stage to use another creative" / "Create a new stage to use another format";
  - warnings "Brand appears twice", "This format has no brand — the creative doesn't contain {brand}".
- **Error codes:**
  - 409 `creative_locked_after_send`, 409 `format_locked_after_send`, 409 `format_in_use` (`details.count`);
  - 403 `compliance_field_locked` (field `custom_text`);
  - 400 `custom_text_missing_required_block`, 400 `unknown_token`, 400 `missing_block`;
  - kickoff reasons `per_recipient_render_failed`, `missing_brand`.
- **§11b:**
  - `tagRules` is REQUIRED on `StageEligibilityParams`, on the recipients input and on the audience-preview inputs. Run `tsc` and treat each error as a decision.
  - Callers that never read it get `Omit<…>`.
- **Regular skips write NO `stage_sends` rows.**
  - Drip skips: `status='skipped_ineligible'`, `last_error` ∈ `missing_tag:<key>` | `segment_limit`.
  - Drip first-send skips also close the journey: `state='exited'`, `close_reason` = the same string.
- **Migrations:**
  - Hand-authored (see memory "Migrations are hand-authored"). 0216 then 0217. Each leads its batch with `SET LOCAL lock_timeout = '5s'`.
  - Snapshot = clone of the previous one (`0215a000-0215-4215-8215-000000000215`), with id `0216a000-0216-4216-8216-000000000216` / `0217a000-0217-4217-8217-000000000217`.
  - Journal `when` = previous + 86400000 (0215 is 1795219200000).
  - Renumber if main moves.
- **`.env.local` is PRODUCTION.**
  - DB tests import `./_env-preload` then `./_require-preview-db`, and run via `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/<name>.ts`.
  - Pure tests run via `npx tsx scripts/<name>.ts`.
  - `npm run check:guards` must stay green.
- **Prod writes** (`db:migrate`, the backfills) happen only after the owner's "Go", in the attended morning window. Nothing paid.
- `npx tsc --noEmit -p .` must be clean. Lint only the changed files: `npx eslint <files>`.
- **Docs are part of each phase's done:** spec §E, plus `docs/CHANGELOG.md` and "last updated" on every doc touched.

## Review Focus

1. **A name that cleans to a different length.** `Ægir`→`Aegir` (+1), `李` → empty ⇒ missing. TS and SQL must agree on missing / length. Pinned by P4 Task 2 parity rows (`"Ægir"`, `"李雷"`, `"Zoë"`, `" José "`).
2. **A creative that already contains a brace token.** `{FirstName}` and `{ first_name }` must stay literal and must not count as missing. Pinned by P1 Task 1 (`findTags` returns `[]`) and Task 2 (renders literally).
3. **A manual-mode stage with no `short_url`** under T2/T3/custom: the `{url}` row drops only when the row is exactly `{url}`. In T2, `{url}` sits alone on the last row ⇒ dropped, and the preceding blank row stays. Pinned by P1 Task 2 `T2 no-link`.
4. **Every recipient skipped.** Regular: the layers leave 0 recipients ⇒ the existing `no_recipients` refusal. Must not report an inconsistent state. Pinned by P4 Task 4 `all-missing stage refuses no_recipients`.
5. **A format disabled while a drip stage is mid-run.** The disable is refused with a count. A drip stage's format can't change after its first send. Pinned by P2 Task 3 `in-use disable refused` and P5 Task 4.

## File structure

| File | Phase | Responsibility |
|---|---|---|
| `lib/messages/tags.ts` (new) | P1 | registry, junk list, TRANSLIT, US_STATES, normalizers, `findTags`, `findUnknownTokens` |
| `lib/messages/format.ts` (new) | P1 | grammar, `T1_TEMPLATE`, `SEED_FORMATS`, validators, `assembleMessage` |
| `lib/messages/render.ts` (new) | P1 | `renderMessage`, `renderWorstCase`, `firstNameMaxLength`, `checkRecipientBody` |
| `lib/sends/stage-sms.ts` | P1 | `buildStageSms` → `assembleMessage(T1_TEMPLATE, …)` |
| `scripts/test-message-render.ts` (new) | P1+ | pure suite |
| `scripts/export-t1-corpus.ts`, `scripts/verify-t1-format-identity.ts` (new) | P1 | live T1 proof |
| `db/migrations/0216_message_formats.sql` + meta, `db/schema.ts` | P2 | 0216 |
| `app/api/message-formats/**`, `lib/validators/message-formats.ts` | P2 | formats API |
| `app/(protected)/settings/message-formats/page.tsx`, `components/settings/message-formats-panel.tsx` | P2 | screen |
| `lib/stages/send-locks.ts` (new) | P2 | `stageHasSent` |
| `components/campaigns/stage-form.tsx`, `creative-picker-dialog.tsx` | P2/P4 | format picker, custom text, warnings, footer fix |
| `db/migrations/0217_contact_zip.sql` + meta, `lib/intake/fields.ts`, `lib/drip/enrichment.ts`, `lib/contact-attributes.ts`, `scripts/backfill-contact-zip.ts` | P3 | zip |
| `lib/sends/preflight-breakdown.ts` | P4-pre | offer-rule bug |
| `lib/messages/tag-sql.ts` (new), `lib/sends/tag-rules.ts` (new), `lib/sends/eligibility.ts`, `lib/sends/exclusion-labels.ts`, `lib/sends/recipients.ts`, `lib/sends/kickoff.ts`, `lib/sends/preflight*.ts`, `lib/audience-snapshot.ts` | P4 | regular path |
| `components/creatives/creative-form.tsx`, `bulk-creative-form.tsx`, `components/messages/tag-picker.tsx` (new) | P4 | editor |
| `components/campaigns/status-change-dialog.tsx`, `stage-prepare-dialog.tsx` | P4 | >50% warnings |
| `lib/drip/routing-eval.ts`, `routing.ts`, `scheduler.ts`, `send-one.ts`, `followups.ts` | P5 | drip path |
| `lib/reporting/report-dimensions.ts`, `stage-funnel.ts`, `performance-report.ts`, `counted-clickers.ts` | P6 | By Format |

---

## P1 — Renderer + registry (no migration, no behaviour change)

### Task 1: Tag registry + normalizers

**Files:** Create `lib/messages/tags.ts`, `scripts/test-message-render.ts`.

**Interfaces — Produces:**
```ts
export type TagKey = "first_name" | "zip" | "state" | "brand";
export interface TagDef { key: TagKey; label: string; scope: "contact" | "campaign"; maxLength: number; worstCase: string;
  normalize(raw: string | null | undefined): string | null }
export const TAGS: Record<TagKey, TagDef>;            // values per spec A1
export const TAG_KEYS: readonly TagKey[];
export const JUNK_VALUES: readonly string[];          // ["n/a","unknown","none","-"]
export const TRANSLIT: ReadonlyMap<string, string>;   // generated U+00C0–U+017F via NFKD base + multi-letter table (spec A4)
export const US_STATES: ReadonlyMap<string, string>;  // code -> name, 50 + DC
export function findTags(text: string): TagKey[];     // distinct, first-seen order
export function findUnknownTokens(text: string): string[]; // brace tokens that are neither a TagKey nor a block key
export interface RecipientData { first_name: string | null; zip: string | null; state: string | null }
```

- [ ] **Step 1: Write failing tests** (`R1.*`) asserting:
  - `TAGS.first_name.normalize`:
    - `" JOSÉ "`→`"Jose"`, `"mary-jane"`→`"Mary-Jane"`, `"o'neil"`→`"O'Neil"`, `"Ægir"`→`"Aegir"`, `"Zoë"`→`"Zoe"`
    - `"李雷"`→`null`, `"N/A"`→`null`, `"-"`→`null`, `"Jo3"`→`null`, `"J"`→`null`, `"Maximilianuslong"` (16)→`null`, `""`/`null`→`null`
  - `TAGS.zip.normalize`: `"02134"`→`"02134"`, `"02134-1234"`→`"02134"`, `"021341234"`→`"02134"`, `"2134"`→`null`
  - `TAGS.state.normalize`: `"tx"`→`"TX"`, `"Texas"`→`"TX"`, `"new  york"`→`"NY"`, `"ZZ"`→`null`, `"Unknown"`→`null`
  - `findTags("Hi {first_name}, {FirstName} {zip} {first_name}")` = `["first_name","zip"]`
  - `findUnknownTokens(...)` = `["{FirstName}"]`
- [ ] **Step 2:** Run `npx tsx scripts/test-message-render.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `lib/messages/tags.ts` (pure, no imports from db/server). Normalization order per spec A4: junk/digit checks run on the trimmed raw value, before cleaning.
- [ ] **Step 4:** Run. Expected: all `R1.*` ✓.
- [ ] **Step 5:** Commit `feat(messages): tag registry + normalizers (P1)`.

### Task 2: Format grammar + renderer; `buildStageSms` = T1

**Files:** Create `lib/messages/format.ts`, `lib/messages/render.ts`. Modify `lib/sends/stage-sms.ts`, `scripts/test-message-render.ts`.

**Interfaces — Produces:**
```ts
// format.ts
export type BlockKey = "brand" | "creative_text" | "url" | "stop_text";
export const NEW_ROW = "<new_row>";
export const T1_TEMPLATE = "{brand}: {creative_text}<new_row>{url}<new_row>{stop_text}";
export const SEED_FORMATS: readonly { name: string; template: string; isDefault: boolean }[]; // spec B2 table
export type TemplateError = { code: "unknown_token" | "missing_block"; detail: string };
export function validateTemplate(t: string): TemplateError | null;      // blocks only; requires creative_text,url,stop_text
export function validateCustomText(t: string): { code: "custom_text_missing_required_block" | "unknown_token"; detail: string } | null; // blocks+tags; requires url,stop_text
export function assembleMessage(template: string, v: Record<BlockKey, string>): string;
// render.ts
export type MessageShape = { kind: "template"; formatId: number | null; template: string } | { kind: "custom"; text: string };
export interface RenderInput { shape: MessageShape; brandName: string; creativeText: string | null | undefined;
  linkUrl: string | null | undefined; stopText: string; recipient: RecipientData }
export type RenderResult = { ok: true; body: string } | { ok: false; reason: "missing_tag"; tag: TagKey };
export function renderMessage(i: RenderInput): RenderResult;
export function renderWorstCase(i: Omit<RenderInput, "recipient">, firstNameLength?: number): string;
export function firstNameMaxLength(i: Omit<RenderInput, "recipient">, maxSegments: number): number | null; // spec A6
export function checkRecipientBody(body: string, maxSegments: number): { ok: true } | { ok: false; reason: "segment_limit" };
export function requiredTags(i: { shape: MessageShape; creativeText: string | null | undefined }): TagKey[];
```

**Render order:** tags are expanded in the creative text (and in custom text) with the normalized recipient values, and `{brand}` with the brand name. Then `assembleMessage` runs on the template (or the expanded custom text) with the blocks. Empty creative ⇒ `{ok:true, body:""}`. Signature of `buildStageSms` is unchanged. Body: `assembleMessage(T1_TEMPLATE, {brand: brandName, creative_text: creativeText ?? "", url: linkUrl ?? "", stop_text: stopText})`, returning `""` when there is no creative.

- [ ] **Step 1: Write failing tests** (`R2.*`):
  - **T1 vs the frozen original:** the 150-case grid (brand × creative × link × stop; spec recon) compared against a frozen copy of origin/main's `buildStageSms` pasted into the test file as `legacyBuildStageSms`. 0 diffs.
  - **T2 no-link:** `"{creative_text} {brand} {stop_text}<new_row><new_row>{url}"` with url `""` ⇒ `"Hi G Stop to END\n"`. The blank row is kept; the url row is dropped.
  - **T3:** renders without the brand.
  - **Tags:** `{FirstName}` stays literal. `{first_name}` with recipient first_name `null` ⇒ `{ok:false, reason:"missing_tag", tag:"first_name"}`. With `"josé"` ⇒ body contains `"Jose"`.
  - **No re-scan:** a creative `"{url}"` renders the literal `{url}`.
  - **`firstNameMaxLength`:** for a GSM creative whose worst-case body without a name is 150 characters and `maxSegments` 1 ⇒ 10. When even L=0 exceeds ⇒ `null`.
  - **Validators:** `validateTemplate("{creative_text}{url}")` ⇒ `missing_block`; `validateTemplate("{first_name} {creative_text}{url}{stop_text}")` ⇒ `unknown_token`; `validateCustomText("Hi {first_name}")` ⇒ `custom_text_missing_required_block`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `format.ts`, `render.ts`, and rewrite the `stage-sms.ts` body. Keep its header comment and add one line: "T1 of lib/messages/format.ts".
- [ ] **Step 4:** Run the pure suite, plus the existing `npx tsx scripts/verify-sms-preview.ts`. Expected: all ✓.
- [ ] **Step 5:** Commit `feat(messages): format grammar + renderer; buildStageSms is T1 (P1)`.

### Task 3: Live T1 proof + PR

**Files:** Create `scripts/export-t1-corpus.ts`, `scripts/verify-t1-format-identity.ts`. Modify `docs/07-conventions.md`, `docs/CHANGELOG.md`.

**Export script:**
- Read-only: `BEGIN READ ONLY`, SELECTs only, own `postgres` client from `DATABASE_URL`, no `@/db/client`. Add it to the guard's EXCLUSIONS with the reason "read-only corpus export" if the guard flags it.
- **Rows:** `stage_sends` with `status='sent'` and `sent_at` in the last 3 days, plus the inputs for each row:
  - `brands.name`;
  - `creatives.text` via `campaign_stages.creative_id`;
  - link URL = `short_domains.domain` + `short_links.code` via `link_id`, or `campaign_stages.short_url` for manual mode;
  - footer inputs: phone, provider and stage footers, plus the adapter code.
- Writes JSON to the path given in `argv[2]`, in the scratchpad.

**Verify script:** pure, reads the JSON. For every row, compute `footer = resolveOptOutFooter(...)` and both `legacy = legacyBuildStageSms(...)` (the frozen copy) and `t1 = buildStageSms(...)`.

**Bars:**
- **(a)** `t1 === legacy` on 100% of rows. A hard stop otherwise.
- **(b)** The set of rows where `t1 !== rendered_text` equals the set where `legacy !== rendered_text`. Each such row is classified (creative edited after send / footer changed since send / drip) and the classes are printed.
- **(c)** Fault injection: `legacy` with stop `"Stop to ENDX"` must make (a) red.

- [ ] **Step 1:** Write both scripts.
- [ ] **Step 2:** Run the export against prod (read-only), then `npx tsx scripts/verify-t1-format-identity.ts <json>`. Expected: (a) 0 diffs, (b) equal sets, (c) red as designed.
- [ ] **Step 3:** Docs: conventions entry "One renderer: lib/messages; T1 = legacy body"; CHANGELOG.
- [ ] **Step 4:** `npx tsc --noEmit -p .`, lint the changed files, `npm run check:guards`.
- [ ] **Step 5:** Commit and open the PR. The description includes the window, row count, bars (a)/(b)/(c) output and the mismatch classes.

---

## P2 — Message formats (migration 0216, card 869fk2a0f)

### Task 1: Migration 0216 + schema

**Files:** Create `db/migrations/0216_message_formats.sql`, `db/migrations/meta/0216_snapshot.json`. Modify `db/migrations/meta/_journal.json`, `db/schema.ts`. Create `scripts/test-message-formats-db.ts`.

The SQL is exactly spec §D (0216). `ensure_message_formats` inserts `SEED_FORMATS` values. Copy them literally and pin them with a test against `format.ts`.

- [ ] **Step 1: Write failing preview-DB tests** (`M1.*`):
  - Every org has 3 formats and exactly 1 default (T1 template, byte-equal to `T1_TEMPLATE`).
  - A raw `INSERT INTO campaign_stages` without format columns gets the org default.
  - An insert with both columns set violates `campaign_stages_format_one_of`.
  - `DELETE FROM message_formats WHERE id = <in use>` fails (RESTRICT).
  - A second `is_default` for the org violates the unique index.
  - A new org with no formats is seeded by the trigger on its first stage insert.
  - The `stage_sends` columns exist, with `format_custom` default false.
- [ ] **Step 2:** Run on preview (the migration is not yet applied). Expected: FAIL.
- [ ] **Step 3:** Write the migration, snapshot, journal and `schema.ts` (tables, columns, check, index), then `node scripts/with-preview-env.mjs npm run db:migrate` (preview only).
- [ ] **Step 4:** Run `M1.*` plus `npx tsx scripts/verify-migration-integrity.ts` on preview. Expected: ✓, "Migration integrity OK."
- [ ] **Step 5:** Commit `feat(db): 0216 message_formats + stage format columns + send stamp`.

### Task 2: Derived stage inserts copy the parent's format

**Files:** Modify:
- `app/api/campaigns/[campaignId]/duplicate/route.ts:255`
- `.../stages/[stageId]/duplicate/route.ts:161`
- `.../stages/[stageId]/split/route.ts:299`
- `lib/stages/behavioral-split.ts:340`
- `lib/drip/children.ts:81`

Create `scripts/test-stage-format-copy-guard.ts`, and add it to `check:guards`.

- [ ] **Step 1:** Source guard test. Each of the 5 files mentions both `message_format_id` and `custom_text` in its insert values. It also asserts the set of `campaign_stages` insert sites under `app/`+`lib/` equals these 5 plus `stages/route.ts` (base create, which relies on the trigger). Expected: FAIL.
- [ ] **Step 2:** Copy the parent's `message_format_id` / `custom_text` at each site. Children copy from the drip first-send parent.
- [ ] **Step 3:** Guard ✓, plus a preview test: duplicating a custom-text stage keeps the custom text. Commit.

### Task 3: Formats API + settings screen

**Files:**
- Create: `lib/validators/message-formats.ts`; `app/api/message-formats/list/route.ts`, `route.ts` (POST), `[id]/route.ts` (PATCH), `[id]/make-default/route.ts`; `app/(protected)/settings/message-formats/page.tsx`; `components/settings/message-formats-panel.tsx`.
- Modify: `lib/permissions.ts` (`message_formats.view` all roles, `message_formats.manage` manager+), `lib/authz/route-map.ts`, `components/protected/nav-config.ts`.
- Test: `scripts/test-message-formats-api.ts`.

**Live-stage count for `format_in_use`:** spec B3 definition. One SQL helper, `countLiveStagesUsingFormat(dbc, orgId, formatId)`, in `lib/messages/format-usage.ts`.

- [ ] **Step 1: Failing API tests** (`M2.*`):
  - an invalid template ⇒ 400 `unknown_token` / `missing_block`;
  - **in-use disable refused:** disabling a format used by a live stage ⇒ 409 `format_in_use`, `details.count = 1`;
  - disabling the default ⇒ 409;
  - making a disabled format default ⇒ 409;
  - make-default moves the single default;
  - an operator PATCH ⇒ 403;
  - list is org-scoped.
- [ ] **Step 2:** Implement, following the UTM-tags pattern (Zod, `apiError`, `can()`), and the panel. Use a plain table, `Switch` for enabled, a radio/"Make default" action, and `<FormDialog>` for create/edit with a live T1-style preview via `renderWorstCase`.
- [ ] **Step 3:** Run `M2.*` and `npx tsx scripts/test-route-map-coverage.ts`. Commit.

### Task 4: Stage format choice, custom text, locks, warnings, picker footer fix

**Files:**
- Modify: `lib/validators/campaign-stages.ts`; `app/api/campaigns/[campaignId]/stages/route.ts` (POST resolves the default via the trigger; returns the format); `.../stages/[stageId]/route.ts` (PATCH); `components/campaigns/stage-form.tsx`; `creative-picker-dialog.tsx`.
- Create: `lib/stages/send-locks.ts`.
- Test: `scripts/test-stage-format-api.ts`.

**Interfaces — Produces:** `export async function stageHasSent(dbc: typeof db, stageId: number): Promise<boolean>` (EXISTS `status='sent'`; a transaction handle is also accepted).

**Server behaviour on PATCH:**
- `message_format_id` must reference an enabled, active format in the org.
- `custom_text` requires `compliance.manage`, otherwise 403 `compliance_field_locked`. It is validated with `validateCustomText`. Setting one of the two columns nulls the other.
- When the stored value differs from the payload and `stageHasSent` ⇒ 409 `format_locked_after_send` (all stages).
- The drip creative lock (spec A9) is also added here, 409 `creative_locked_after_send`, because it shares the helper.

**UI:**
- A format `<Select>` lists the enabled formats; the "Custom" option is shown only with `compliance.manage`.
- The custom textarea has "Insert {url}" / "Insert {stop_text}" buttons (insert at the cursor via `setRangeText`).
- Both pickers are disabled with the lock copy once the stage has sent. The stage GET returns `has_sent`.
- B5 warnings.
- The SMS preview card uses `renderWorstCase` with the stage's shape.
- `creative-picker-dialog` receives `stopText={resolvedFooter.text}` (blocking-item fix) and the stage's shape.

**Steps:**
- [ ] **Step 1: Failing tests** (`M3.*`):
  - an operator setting `custom_text` ⇒ 403;
  - owner custom text without `{stop_text}` ⇒ 400;
  - switching format after a sent row ⇒ 409;
  - echoing the same format after send ⇒ 200;
  - drip creative change after send ⇒ 409, before send ⇒ 200;
  - a regular stage's creative change after send ⇒ 200 (the creative lock is drip-only).
- [ ] **Step 2:** Implement the server side. Run `M3.*` ✓.
- [ ] **Step 3: Switch the render call sites to the stage's shape.** `kickoff.ts` (3 sites), `scheduler.ts:330`, `send-one.ts:110`, `stage-form.tsx`, `creative-picker-dialog.tsx` call `renderMessage`, with `recipient` = all-null for now. Tags arrive in P4/P5; until then a creative containing a real tag key fails closed with `missing_tag`, and none exist live. Each send path stamps `message_format_id` / `format_custom` on its inserted rows. Load the shape in the existing main-row queries (`LEFT JOIN message_formats mf ON mf.id = s.message_format_id`).
- [ ] **Step 4: Preview test.** A T2 stage materializes rows whose `rendered_text` matches the T2 layout and carries the stamp. A T1 stage is unchanged.
- [ ] **Step 5: Playwright visual check of the stage form** (memory recipe: preview stack, creds via scratchpad). Format select, custom option hidden for operator, warnings, picker preview footer equals stage preview footer.
- [ ] **Step 6: Docs.**
  - New `docs/04-features/message-formats.md`.
  - `03-data-model.md` + ERD.
  - `05-flows.md` render step.
  - CLAUDE.md §10h.
  - CHANGELOG.
- [ ] **Step 7:** Open the PR.
  - **Gate:** the owner's "Go" ⇒ prod `db:migrate` (0216, including the backfill) in the morning window ⇒ `verify-migration-integrity` ⇒ re-run P1 Task 3 bars on a fresh export ⇒ merge.
  - **Smoke:** a T1 stage body is unchanged on prod.

---

## P3 — Zip (migration 0217, card 869fk2a1e)

### Task 1: Column, intake field, enrichment, CSV mapping

**Files:**
- Create `db/migrations/0217_contact_zip.sql` + meta.
- Modify `db/schema.ts`; `lib/intake/fields.ts` (add `{ key: "zip", label: "ZIP Code", type: "string", aliases: ["zip_code","zipcode","postal_code","postal"], example: "02134" }`); `lib/drip/enrichment.ts` (`zip: str(f.zip)`); `lib/contact-attributes.ts` (`ATTRIBUTE_FIELDS`); the import-attributes route's column list.
- Test: `scripts/test-contact-zip.ts`.

- [ ] **Step 1: Failing tests.**
  - `normalizeLead({zip:" 02134 "}, {})` ⇒ `zip: "02134"` (stored trimmed, not normalized; spec A4 normalizes at render).
  - On preview: an intake → enrichment fixture lands `contact_attributes.zip`.
  - `npm run check:docs` still green (partner docs regenerated: `npx tsx scripts/generate-partner-docs.ts`).
- [ ] **Step 2:** Implement and apply on preview. Tests ✓, integrity OK.
- [ ] **Step 3:** Commit.

### Task 2: Backfill script

**Files:** Create `scripts/backfill-contact-zip.ts`. Add it to the guard EXCLUSIONS with the reason "owner-gated prod backfill".

- Flags: `--dry-run` (default) prints the candidate count, the 5-digit share, and the rows that would change. `--apply` updates in batches of 5,000.
- The update writes `contact_attributes.zip = btrim(li.raw->>'zip')` from each contact's latest `lead_inbox` row, `WHERE ca.zip IS NULL AND li.raw ? 'zip'` (also checks the aliases in the `LEAD_FIELDS` entry). Idempotent.

- [ ] **Step 1:** Preview test: fixtures with raw zip ⇒ apply fills them, a second apply changes 0.
- [ ] **Step 2:** Docs (`03-data-model`, `drip` intake doc, CHANGELOG). PR.
  - **Gate:** "Go" ⇒ prod `db:migrate` 0217 ⇒ backfill `--dry-run` (report numbers) ⇒ `--apply` off-hours ⇒ re-count fill. Expected ≈ 96% of `pml` leads.

---

## P4-pre — preflight-breakdown offer-rule fix (own small PR, before P4)

**Files:** Modify `lib/sends/preflight-breakdown.ts:112-123,173`. Test: `scripts/test-preflight-breakdown-offer-rules.ts`.

- [ ] **Step 1:** Failing preview test: a campaign with `offer_rules_enabled=true` and a contact inside the cooldown. The breakdown's dedup/carrier figures must exclude it, which they currently don't.
- [ ] **Step 2:** Select `offer_rules_enabled`, `offer_cooldown_days` and `offer_limit_times` in the config query and pass them through.
- [ ] **Step 3:** Before/after on 3 live stages via a read-only run of `computePreflightBreakdown` (choose stages with `offer_rules_enabled`). The PR description gets a table of stage id, before and after per bucket. CHANGELOG. PR, merge on green.

---

## P4 — Tags on regular campaigns

### Task 1: Creative editor: tag picker, worst case, unknown tokens

**Files:** Create `components/messages/tag-picker.tsx`. Modify `components/creatives/creative-form.tsx`, `bulk-creative-form.tsx`.

- `<TagPicker onInsert={(token: string) => void} />` is a small popover listing `TAG_KEYS` with labels. The form inserts at the cursor with `setRangeText`.
- The counter adds "Worst case: N characters · S segments" from `renderWorstCase`-style expansion of the creative text alone (tags → `worstCase`). It is flagged red when S > 1 and `allow_multi_segment` is off.
- Unknown-token warning: "unknown tag {X} — will be sent literally".

- [ ] **Step 1:** Pure test: worst-case length of `"Hi {first_name}"` = 18. Implement, then a Playwright check: picker inserts at the cursor, worst-case flag. Commit.

### Task 2: SQL twins + parity

**Files:** Create `lib/messages/tag-sql.ts`, `scripts/test-tag-sql-parity.ts`.

**Interfaces — Produces:**
```ts
export function tagMissingSql(key: Exclude<TagKey, "brand">, caAlias: string): SQL;   // TRUE when missing
export function firstNameCleanLengthSql(caAlias: string): SQL;                       // char_length of cleaned value
```
Both are generated from `JUNK_VALUES`, `TRANSLIT` and `US_STATES` (no hand-typed lists).

- [ ] **Step 1:** Failing parity test on preview. Corpus: ≥ 60 values, including `"Ægir"`, `"李雷"`, `"Zoë"`, `" José "`, `"N/A"`, `"-"`, `"Jo3"`, `"J"`, 16-character names, emoji, `"Texas"`, `"new  york"`, `"ZZ"`, zip variants.

  Assert, for every value:
  - `(TAGS[k].normalize(v) === null) === sqlMissing(v)`;
  - `normalize(v).length === sqlCleanLength(v)` for valid first names.

  Use a `VALUES` list with a fake alias (`SELECT … FROM (VALUES …) ca(first_name, zip, state)`).
- [ ] **Step 2:** Implement. ✓. Commit.

### Task 3: Eligibility layers + preview/preflight counts

**Files:** Modify:
- `lib/sends/eligibility.ts`: `EXCLUSION_PRIORITY` appends `missing_tag_data`, `segment_limit`; new sub-builder `tagExclusionLayers(p)`; `StageEligibilityParams.tagRules`.
- `lib/sends/exclusion-labels.ts`: labels `missing data`, `segment limit`.
- `lib/sends/recipients.ts`, `preflight.ts`, `preflight-breakdown.ts`, `reconcile.ts`.
- `lib/audience-snapshot.ts`: every path that calls the lifecycle sub-builders also calls `tagExclusionLayers`.

**Interfaces — Produces:**
```ts
// lib/messages/render.ts (pure):
export interface TagRules { required: TagKey[]; firstNameMaxLength: number | null } // null ⇒ name length unconstrained (no {first_name})
export type TagRulesRefusal = { refused: "segment_ceiling_exceeded" | "multi_segment_not_allowed" | "missing_brand" };
export function stageTagRules(i: Omit<RenderInput, "recipient"> & { allowMultiSegment: boolean }): TagRules | TagRulesRefusal;
// lib/sends/eligibility.ts:
// StageEligibilityParams gains: tagRules: TagRules   (REQUIRED, §11b)
export function tagExclusionLayers(p: { orgId: string; tagRules: TagRules }): StageEligibilityExclusions; // existing { key; sql }[] shape
// lib/sends/tag-rules.ts (new, DB): loads the stage's shape/brand/footer/representative link, then calls stageTagRules
export async function loadStageTagRules(dbc: typeof db, i: { orgId: string; stageId: number }): Promise<TagRules | TagRulesRefusal>;
// preflight + breakdown results gain: missing_by_tag: Partial<Record<TagKey, number>>
```
- `missing_tag_data` = contacts with no `contact_attributes` row, or any required contact tag missing.
- `segment_limit` = `firstNameCleanLengthSql > firstNameMaxLength`, only when `{first_name}` is required.
- `loadStageTagRules` computes `firstNameMaxLength` with `firstNameMaxLength(...)`, using the stage's shape, brand, representative link and resolved footer.

- [ ] **Step 1: Failing preview tests** (`T3.*`). Fixture: a stage whose creative is `"Hi {first_name}"` and 5 contacts:
  - no attributes row;
  - first_name `"N/A"`;
  - `"Jose"`;
  - a 15-character name with the creative padded so L = 12;
  - `"Mary"`.

  Assert:
  - preflight `excluded` `missing_tag_data` = 2 and `segment_limit` = 1, and `missing_by_tag.first_name` = 2;
  - the recipients list contains exactly Jose and Mary;
  - the audience preview `x_missing_tag_data` = 2;
  - reconcile gap = 0;
  - a tag-less stage's counts are byte-identical to before (compare against a run with `tagRules = {required:[], firstNameMaxLength:null}`);
  - every existing bucket's number is unchanged.
- [ ] **Step 2:** Implement and run `tsc`. Each new required-param error is a call site: real paths pass `loadStageTagRules`; a legacy test passes `{required:[], firstNameMaxLength:null}` with a comment. ✓.
- [ ] **Step 3:** Commit.

### Task 4: Kickoff per-recipient render + opt-out per recipient

**Files:** Modify `lib/sends/kickoff.ts`, `lib/sends/recipients.ts` (`StageRecipientRow` gains `first_name`, `zip`, `state`: `string | null` via `LEFT JOIN contact_attributes ca ON ca.contact_id = c.id`). Test: `scripts/test-kickoff-personalization.ts`.

The flow is spec §C3:
1. `loadStageTagRules`. A refusal maps to the existing reasons / `missing_brand`.
2. Enumerate with `tagRules`.
3. **Validate-all:** render every recipient with `renderMessage` + `checkRecipientBody` + `optOutGateSubject`/`hasOptOutLanguage`.
   - A missing tag or segment breach ⇒ `per_recipient_render_failed` + Telegram (parity bug, fail closed).
   - No STOP: txr ⇒ `missing_opt_out_language`; dry-run providers ⇒ ONE aggregated alert, "N of M rendered bodies have no STOP".
4. Insert the rendered bodies, stamped (P2).

The representative-body block at `kickoff.ts:543-616` is replaced by steps 1 and 3.

- [ ] **Step 1: Failing preview tests:**
  - materialized rows have per-recipient names (`"Hi Jose"`);
  - there are no rows for skipped contacts;
  - a tag-less T1 stage materializes byte-identically to before (snapshot of `rendered_text` against an origin/main fixture run);
  - a dry-run provider with no-STOP custom text produces exactly 1 alert call for 3 recipients (stub `notifyTelegram`);
  - **all-missing stage refuses no_recipients**;
  - forcing a parity mismatch (monkey-patch the layer off) ⇒ `per_recipient_render_failed`, 0 rows inserted.
- [ ] **Step 2:** Implement. ✓. Commit.

### Task 5: "N% would be skipped" + >50% warnings

**Files:** Modify `components/campaigns/stage-form.tsx` (audience preview section), `stage-prepare-dialog.tsx`, `status-change-dialog.tsx`.

- **Stage form:** "N% would be skipped (missing data X · segment limit Y)" from the audience-preview response.
- **Prepare dialog:** shows the two buckets plus `missing_by_tag`, with an amber warning when > 50%.
- **Status dialog (draft → active):** for each stage whose creative or custom text has tags, fetch the audience preview and list the stages over 50%, with an amber warning. The confirm button stays enabled.

- [ ] **Step 1:** Playwright check on preview (fixture campaign with 60% missing): the warning is shown and Activate stays clickable.
- [ ] **Step 2:** Docs (`04-features` creatives + sends, `05-flows`, `07-conventions` tag registry, CLAUDE.md §10h tags, CHANGELOG). PR.

---

## P5 — Tags on drip

### Task 1: Routing rule `creative_tags`

**Files:** Modify `lib/drip/routing-eval.ts` (candidate SQL loads first-send stage texts/shape/allow_multi/brand; per-candidate rule before `eligible` at ~:693; `ca2.first_name`, `ca2.zip` selected), `lib/drip/routing.ts` (per-run cache of each candidate's `TagRules`). Test: `scripts/test-drip-routing-tags.ts`.

**Interfaces — Consumes:** `stageTagRules` (P4 Task 3). **Produces** (in `lib/messages/render.ts`): `campaignTagRules(perStage: (TagRules | TagRulesRefusal)[]): TagRules | TagRulesRefusal`. Its `required` is the union of the stages' tags, `firstNameMaxLength` the minimum (ignoring nulls), and any refusal makes the whole rule fail with that refusal as its detail.

- [ ] **Step 1: Failing preview tests:**
  - a lead without first_name and two same-tag campaigns (priority 1 needs `{first_name}`, priority 2 doesn't) ⇒ routed to priority 2; `skipped` has priority 1 with `rules.creative_tags = "missing"`, detail `missing data: first_name`;
  - only priority 1 exists ⇒ the outcome is `permanent` and an `unroutable` row is written;
  - a tag-less campaign's stored `reason` is byte-identical to before (rule absent);
  - a 15-character name with L = 12 ⇒ detail `segment limit (first_name 15 > 12)`;
  - the hour fallback never picks a `creative_tags` failure;
  - a follow-up child creative's tags do NOT affect routing.
- [ ] **Step 2:** Implement. ✓. Commit.

### Task 2: Scheduler + follow-ups: per-lead render, skip rows, segment rule

**Files:** Modify `lib/drip/scheduler.ts` (`selectDueJourneys` LEFT JOIN `contact_attributes`; render via `renderMessage` + `checkRecipientBody`), `lib/drip/send-one.ts`, `lib/drip/followups.ts` (same join). Create the helper `insertSkippedSend(tx, row: { orgId; campaignId; stageId; contactId; phone; reason: string; renderedText: string })` in `lib/drip/skip-send.ts`.

- **First send skip:** `insertSkippedSend` + journey `exited`/`close_reason` in the same transaction. No mint.
- **Follow-up skip:** `insertSkippedSend` only.
- `renderedText` = the attempted body with unresolved tags left literal.

- [ ] **Step 1: Failing preview tests:**
  - a follow-up for a lead missing first_name ⇒ one `skipped_ineligible` row, `last_error='missing_tag:first_name'`; the next tick doesn't reselect it (`alreadySent`);
  - a first send whose creative changed after routing ⇒ a skipped row + journey `exited` / `missing_tag:first_name`;
  - a multi-segment body with `allow_multi_segment=false` ⇒ `segment_limit` skip; with it true, sent;
  - skipped rows don't count in `dripDailySendsPredicate` and create no exposures;
  - a T1 drip body for a tag-less creative is byte-identical to before.
- [ ] **Step 2:** Implement. Add the sent-writer guard exclusion only if the guard flags the new insert (it writes `skipped_ineligible`, not `sent`). ✓. Commit.

### Task 3: Why-not-routed + journeys UI show the rule/skip

**Files:** `components/drip/why-not-routed.tsx` (label `creative_tags` → "Creative tags"), and the drip journeys export/detail if it lists close reasons. Check visually. Commit.

### Task 4: Lock UI for drip stages

**Files:** `components/campaigns/stage-form.tsx` (creative picker disabled with the A9 copy when `has_sent` and drip; the format picker already locks from P2).

- [ ] **Step 1:** Playwright check on preview. The server 409 is already covered by P2 Task 4 `M3`.
- [ ] **Step 2:** Docs (`drip-campaigns-routing.md` rule + skip rows, `05-flows`, CHANGELOG). PR. Watch after deploy: `skipped_ineligible` counts by `last_error`, and the routing `creative_tags` share.

---

## P6 — By Format report

### Task 1: Dimension

**Files:** Modify `lib/reporting/report-dimensions.ts` (`"format"` + labels "By Format"), `lib/reporting/stage-funnel.ts` (`StageMetrics.message_format_id: number | null`, `format_custom: boolean`, from `campaign_stages`, both selects), `lib/reporting/performance-report.ts` (both `keyOf` + a label lookup: format name, or "Custom"), `lib/reporting/counted-clickers.ts` (`DIMENSION_SQL.format`), `components/reports/reports-tabs.tsx`. Test: `scripts/test-report-by-format.ts`.

- [ ] **Step 1:** Failing preview test: two stages (T1, custom) ⇒ two rows, "T1 — Brand prefix" and "Custom"; the format rows' totals equal the Overview totals for the range.
- [ ] **Step 2:** Implement. ✓. Read-only prod check: the By Format sums equal Overview for the last 7 days (windowed, per the heavy-verification rule).
- [ ] **Step 3:** Docs (`04-features` reports, CHANGELOG). PR.
