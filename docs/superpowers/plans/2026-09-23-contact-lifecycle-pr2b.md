# Contact lifecycle — PR 2b (contacts column + filter, detail panel, Prepare stamp, relabel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each contact's lifecycle status *visible* — a column and a filter on the contacts list, and a panel with the last 20 transitions on the contact detail page — and start recording the status a contact held **at the moment a send was prepared**, so PR 5's cohort report has real data to read. Plus the relabel the spec asks for: the opt-out reason `suppressed` reads "Global suppression" everywhere it is shown to a person.

**Architecture:** Read-only, except for one new write. The UI reads `contact_engagement` through predicates that treat **a missing row as `new`** — the contract stated in `db/schema.ts:4106-4108`. The single write is a data-modifying CTE bolted onto the bulk send insert that already runs, so stamping costs no extra round trip and cannot drift from the rows it describes. No migration: every table, column and index this PR needs shipped in 0187.

**Tech Stack:** Next.js 16 route handlers + client pages · Drizzle `sql` templates over postgres-js · TanStack Table via the `DataTable` wrapper · shadcn/ui (`Card`, `Badge`, `MultiSelectPicker`) · tsx tests against the preview DB.

**Spec:** [2026-09-22-contact-lifecycle-status-design.md](../specs/2026-09-22-contact-lifecycle-status-design.md) §6 (contacts list, contact detail), §10 (status-at-send). Prior PRs: [PR 1](2026-09-22-contact-lifecycle-pr1.md) (data layer, job), [PR 2a](2026-09-23-contact-lifecycle-pr2a.md) (settings, group overrides, preview).

## Global Constraints

- **Worktree:** `C:\AFF\camman\.claude\worktrees\lifecycle-recon`, branch `feat/contact-lifecycle-p2b`, already cut from merged main `4c352cfe`. Absolute paths in shell commands.
- **No migration in this PR.** If something appears to need DDL, stop and ask. Specifically:
  - **`stage_sends.status`'s CHECK is NOT extended here.** `skipped_ineligible` is a *send-time drop*, and nothing drops sends until PR 4. Adding the value now would ship a constraint no code can produce and force the 12 status-enumerating UI files to grow a bucket that is permanently empty. It belongs with PR 4's send-time re-check, which is what creates it.
  - `segment_rules.rule_type`'s CHECK stays untouched — that is PR 3.
  - `stage_send_lifecycle` has no index beyond its PK. It does not need one: this PR only ever writes it. PR 5 adds the index its report query needs, alongside that query.
- **A missing `contact_engagement` row means `new`.** In production today that is 122,653 of 906,082 contacts, every one of them legitimately `new`. A filter written as a bare `EXISTS` drops all of them silently; a filter that includes `new` **must** carry an `OR NOT EXISTS` arm. This is the single most likely way to get this PR wrong.
- **The send path stays simple.** The stamp is one CTE inside the insert that already runs: no second statement, no per-row parameters, no new transaction, no status computation. `bulkInsertStageSends`'s return value must keep meaning "rows actually inserted" — the campaign event and the cron report both display it.
- **Lifecycle status and Global suppression are different things** and the UI must never conflate them. `contact_engagement.status = 'suppressed'` is *lifecycle* suppression (too many unanswered messages). `opt_outs.reason = 'suppressed'` is *Global suppression* (an uploaded do-not-contact list). Both would otherwise render as the badge "Suppressed" on the same screen. Task 1 removes the collision before Task 4 can create it — that is why the relabel goes first.
- **Labels have one source per concept.** `CONTACT_STATUS_LABELS` (`lib/imports/contact-status.ts`) for opt-out reasons; a new `ENGAGEMENT_STATUS_LABELS` for lifecycle statuses. No third copy, no inline string. **The database values never change** — not `opt_outs.reason`, not `contact_engagement.status`.
- **Permissions:** everything here is read-only and rides existing gates (`contacts.view`). **No new API route**, so no new `OPERATOR_ROUTE_MAP` key — `contacts/list` and `contacts/[id]` are already `null` (operator-denied). Run `npm run check:authz` anyway.
- **Two Drizzle traps this PR walks straight into** (both already cost this project a bug):
  - Never interpolate a JS array into a `sql` template — it flattens into positional params and only execution finds it. Build `ANY(ARRAY[...])` with `sql.join` of individually-parameterised values.
  - `${table.col}` inside a correlated subquery can bind to the *inner* table. Copy the proven idiom from the `group_ids` block at `app/api/contacts/list/route.ts:72-84`, which already correlates on `${contacts.id}` and works in production.
- **Tests** run on the preview DB only (`_env-preload` then `_require-preview-db`), with `npx tsx --conditions=react-server`. Preview DB env prefix: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)"`. Fixtures use `_fictional-phones`; teardown is by captured org id with a marker check.
- **Lint only changed files.** Docs are part of done. Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Measured facts this plan relies on (production, 2026-09-23 16:40 UTC)

| Fact | Value |
|---|---|
| Contacts | 906,082 |
| `contact_engagement` rows | 906,082 — every contact evaluated |
| Status split | cold 555,863 · freeze 143,368 · new 122,653 · warm 46,072 · hot 38,126 |
| `stage_send_lifecycle` rows | 0 — nothing stamps it until this PR |
| Whole-table `LEFT JOIN` + `GROUP BY` over all contacts | 3.5 s |

The 3.5 s figure is the *whole-table* aggregate. The contacts list is paginated to 20 rows, so its per-row lookup is a PK probe — but Task 3 measures the real query rather than assuming.

## Decisions taken in this plan — override any of them

1. **The status filter is a correlated predicate, not a `LEFT JOIN`.** The route's `where` object is shared by the page query and the capped count subquery (`app/api/contacts/list/route.ts:195` and `:216`). A predicate pushed into `conditions` changes one site; a join must be duplicated into both, and the count silently disagreeing with the page is a classic. The returned *column* is a separate correlated scalar subquery on the page query only.
2. **The filter control is a `MultiSelectPicker`**, matching the groups filter it sits beside. Note this is a judgement call: `CLAUDE.md` §9 reserves pill toggles for enums of ≤5 and `MultiSelectPicker` for >10, and six statuses fall in the gap. Consistency with the adjacent control wins; say so if you'd rather have pills.
3. **Lifecycle status is not sortable.** `SORT_COLUMNS` is a two-key whitelist and an unrecognised `sortBy` falls back to `created_at` silently, so a sortable header would look like it worked and not. `enableSorting: false`.
4. **CSV export is not touched.** `ExportButton` doesn't forward `group_ids` today and `/api/contacts/export` has no group parsing at all, so "export respects the filters" is already untrue. Fixing export's filter parity is its own change, not a rider on this one.
5. **The dashboard's lowercase `suppressed` summary string is included in the relabel** (`app/(protected)/dashboard/page.tsx:845`), even though the spec names only the statuses column and the import UI. This PR is what makes that word ambiguous; leaving one screen behind would be the inconsistency.

## File map

| File | Responsibility |
|---|---|
| `lib/imports/contact-status.ts` | Modify: `suppressed` label → "Global suppression" |
| `app/(protected)/contacts/page.tsx` | Modify: relabel prose; Lifecycle column; status filter |
| `app/(protected)/contacts/[id]/page.tsx` | Modify: map opt-out reasons through the label map; Lifecycle panel |
| `components/contacts/contact-status-import-form.tsx` | Modify: three hardcoded labels + the paste placeholder |
| `components/phone-upload-form.tsx` | Modify: "Suppressed only" → "Global suppression only" |
| `app/(protected)/dashboard/page.tsx` | Modify: one summary string |
| `lib/sends/kickoff.ts` | Modify: `bulkInsertStageSends` gains the stamping CTE |
| `lib/engagement/labels.ts` | **New.** `ENGAGEMENT_STATUS_LABELS` + badge classes |
| `lib/engagement/list-filter.ts` | **New.** `lifecycleStatusCondition()` — the one place "no row = new" is encoded for filtering |
| `app/api/contacts/list/route.ts` | Modify: parse `lifecycle_status`, push the predicate, return the column |
| `app/api/contacts/[id]/route.ts` | Modify: two more lookups in the existing `Promise.all` |
| `components/settings/lifecycle-settings.tsx` | Modify: use the new label map instead of raw enum values |
| `scripts/test-engagement-db.ts` | Modify: Part G — the stamp and the filter contract |
| `docs/04-features/contact-lifecycle.md`, `docs/05-flows.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md` | Docs |

---

### Task 1: "Global suppression" relabel

Goes first so that Task 4 cannot introduce two different badges both reading "Suppressed" on the same screen.

**Files:**
- Modify: `lib/imports/contact-status.ts:159-163`
- Modify: `app/(protected)/contacts/page.tsx:1268`
- Modify: `app/(protected)/contacts/[id]/page.tsx:220`
- Modify: `components/contacts/contact-status-import-form.tsx:226-228`, `:342`
- Modify: `components/phone-upload-form.tsx:450`
- Modify: `app/(protected)/dashboard/page.tsx:845`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONTACT_STATUS_LABELS.suppressed === "Global suppression"`. No signature change — the map's type is unchanged.

- [ ] **Step 1: Change the one source of truth**

`lib/imports/contact-status.ts`, replacing lines 159-163:

```ts
// Human labels for the three statuses — used in the import preview and result
// summary so the UI doesn't duplicate the mapping. "Global suppression" is
// spelled out because `contact_engagement.status` also has a `suppressed`
// value meaning something else entirely (end of the lifecycle, not a
// do-not-contact list); two badges reading "Suppressed" appear on the same
// contacts screen. The DB value stays `suppressed`.
export const CONTACT_STATUS_LABELS: Record<ContactStatusReason, string> = {
  opt_out: "Opt-out",
  suppressed: "Global suppression",
  scrubbed: "Scrubbed",
};
```

- [ ] **Step 2: Make the contact detail page use the map**

`app/(protected)/contacts/[id]/page.tsx` renders the raw DB string at line 220. Add the import alongside the existing ones:

```ts
import { CONTACT_STATUS_LABELS } from "@/lib/imports/contact-status";
```

and replace line 220:

```tsx
                  <Badge variant="outline">
                    {CONTACT_STATUS_LABELS[
                      o.reason as keyof typeof CONTACT_STATUS_LABELS
                    ] ?? o.reason}
                  </Badge>
```

The `?? o.reason` fallback is load-bearing: `opt_outs.reason` can also be `bounced`, which is not in the three-key map. Dropping the fallback would render an empty badge.

- [ ] **Step 3: Derive the import-dialog prose instead of hardcoding it**

`app/(protected)/contacts/page.tsx`, replacing line 1268 inside the `<DialogDescription>`:

```tsx
            Update {CONTACT_STATUS_LABELS.opt_out}, {CONTACT_STATUS_LABELS.suppressed} and{" "}
            {CONTACT_STATUS_LABELS.scrubbed} statuses in bulk from a CSV.
```

`CONTACT_STATUS_LABELS` is already imported in this file at line 67.

- [ ] **Step 4: Fix the import form's three Stat tiles and the placeholder**

`components/contacts/contact-status-import-form.tsx` already imports the map at line 15 and uses it correctly at line 373. Replace lines 226-228:

```tsx
          <Stat label={CONTACT_STATUS_LABELS.opt_out} value={result.by_reason.opt_out} />
          <Stat label={CONTACT_STATUS_LABELS.suppressed} value={result.by_reason.suppressed} />
          <Stat label={CONTACT_STATUS_LABELS.scrubbed} value={result.by_reason.scrubbed} />
```

Note "Opt-outs" becomes "Opt-out" — a deliberate side effect of having one source; the tile sits beside a count, so the singular reads fine.

And line 342's placeholder — safe to change because the parser accepts the new wording:

```tsx
            placeholder={"+1 202 555 0199, Unsubscribed\n+1 202 555 0200, Landline\n+1 202 555 0201, Global suppression"}
```

- [ ] **Step 5: Verify the parser really does accept it**

This step exists because the placeholder is *input* example text — if the reader rejected "Global suppression", the placeholder would be teaching operators a value that fails.

Run:

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsx -e "import { mapContactStatus } from './lib/imports/contact-status'; console.log(['Global suppression','Suppressed','global suppression','DNC'].map(s => s + ' -> ' + mapContactStatus(s)).join('\n'))"
```

Expected: every one prints `-> suppressed`. `SUPPRESSED_WORDS` already contains both `"suppressed"` and `"global suppression"`. If any prints `null`, stop — do not ship a placeholder the importer rejects.

- [ ] **Step 6: The two remaining strings**

`components/phone-upload-form.tsx:450` — `label="Suppressed only"` becomes `label="Global suppression only"`.

`app/(protected)/dashboard/page.tsx:845` — in the summary string, `${…suppressed} suppressed` becomes `${…suppressed} globally suppressed`. Lowercase, because the surrounding string is a lowercase run-on ("… opt-outs · … globally suppressed · … scrubbed · … bounced").

Do **not** touch `app/(protected)/opt-outs/page.tsx:320` — that "Suppressed N from STOP replies" is the verb, not the status label. Do not touch any `lib/sends/*` occurrence: those are TextHub/TextRequest protocol tokens.

- [ ] **Step 7: Confirm no user-facing copy was missed**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git grep -n "Suppressed" -- app components | grep -v "Global suppression"
```

Expected remaining hits: only `app/(protected)/opt-outs/page.tsx:320` (the verb). Anything else in `app/` or `components/` is a miss.

- [ ] **Step 8: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint lib/imports/contact-status.ts "app/(protected)/contacts/page.tsx" "app/(protected)/contacts/[id]/page.tsx" components/contacts/contact-status-import-form.tsx components/phone-upload-form.tsx "app/(protected)/dashboard/page.tsx"
npx tsc --noEmit
git add -A && git commit -m "$(cat <<'EOF'
feat(contacts): relabel the suppressed opt-out reason "Global suppression"

The lifecycle work introduces contact_engagement.status = 'suppressed',
which means something else entirely: end of the lifecycle, not a
do-not-contact list. Both would have rendered as "Suppressed" on the same
contacts screen. Labels now come from CONTACT_STATUS_LABELS everywhere,
including the contact detail page, which rendered the raw DB string.

DB values are unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: eslint reports no NEW problems in these files (compare against `git stash`-free baseline by running the same command on `origin/main` if any appear), `tsc` clean.

---

### Task 2: Stamp the status at Prepare

**Files:**
- Modify: `lib/sends/kickoff.ts:858-883` (`bulkInsertStageSends`)
- Modify: `scripts/test-engagement-db.ts` (Part G)

**Interfaces:**
- Consumes: `stage_send_lifecycle` (migration 0187), `contact_engagement`.
- Produces: no signature change. `bulkInsertStageSends(tx, rows): Promise<number>` still returns the number of `stage_sends` rows actually inserted.

- [ ] **Step 1: Write the failing test first (Part G1-G3)**

Add to `scripts/test-engagement-db.ts`, inside the existing throwaway-org transaction block, after Part F. The test calls the real insert path rather than a copy of its SQL — a test that rebuilds the statement proves nothing about the statement that ships.

`bulkInsertStageSends` is module-private today. Reaching it through the exported `kickoffStageSend` would drag in provider config, pacing and the send window — so Step 3 exports the function itself, and the test imports it directly. That is the smallest change that puts the shipping statement under test.

```ts
    // ── PART G — status-at-send stamping ──────────────────────────────────
    console.log("\nPART G — stage_send_lifecycle stamping");

    // Three contacts: one hot, one freeze, one with NO contact_engagement row
    // (which is 'new' by contract — db/schema.ts:4106-4108).
    const gHot = contactIds[0];
    const gFreeze = contactIds[1];
    const gUnseen = await insertContact(tx, orgId, fictionalPhone());

    await tx.execute(sql`
      UPDATE contact_engagement SET status = 'hot' WHERE contact_id = ${gHot}
    `);
    await tx.execute(sql`
      UPDATE contact_engagement SET status = 'freeze' WHERE contact_id = ${gFreeze}
    `);
    await tx.execute(sql`
      DELETE FROM contact_engagement WHERE contact_id = ${gUnseen}
    `);

    const gRows = [gHot, gFreeze, gUnseen].map((cid, i) => ({
      id: crypto.randomUUID(),
      orgId,
      campaignId: gCampaignId,
      stageId: gStageId,
      contactId: cid,
      phone: `+1555000${String(i).padStart(4, "0")}`,
      linkId: null,
      renderedText: "part G",
      leadId: crypto.randomUUID(),
      carrierNorm: null,
      providerPhoneId: null,
      costPerSms: null,
    }));

    const gInserted = await bulkInsertStageSends(tx, gRows);
    bar("G1 insert returns one row per send", gInserted === 3, `got ${gInserted}`);

    const gStamped = (await tx.execute(sql`
      SELECT ssl.status, ssl.reconstructed
      FROM stage_send_lifecycle ssl
      WHERE ssl.stage_send_id = ANY(ARRAY[${sql.join(gRows.map((r) => sql`${r.id}`), sql`, `)}]::uuid[])
      ORDER BY ssl.status
    `)) as unknown as { status: string; reconstructed: boolean }[];
    bar(
      "G2 every send is stamped, live rows not reconstructed",
      gStamped.length === 3 && gStamped.every((r) => r.reconstructed === false),
      JSON.stringify(gStamped),
    );
    bar(
      "G3 a contact with no engagement row stamps 'new'",
      gStamped.map((r) => r.status).sort().join(",") === "freeze,hot,new",
      gStamped.map((r) => r.status).sort().join(","),
    );

    // Re-materialization is idempotent by design: the send insert conflicts
    // away, so the stamp must too — and must not duplicate or change.
    const gAgain = await bulkInsertStageSends(tx, gRows);
    const gCount = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM stage_send_lifecycle
      WHERE stage_send_id = ANY(ARRAY[${sql.join(gRows.map((r) => sql`${r.id}`), sql`, `)}]::uuid[])
    `)) as unknown as { n: number }[];
    bar("G4 re-running inserts nothing", gAgain === 0 && Number(gCount[0].n) === 3, `${gAgain} / ${gCount[0].n}`);
```

Note `gCampaignId` / `gStageId` / `insertContact` / `fictionalPhone` / `bar` all already exist in this script; reuse them rather than introducing new helpers. If Part F's fixtures don't leave a usable campaign+stage, create one with the same helper Part B uses.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts
```

Expected: G1 passes (the insert already works), **G2 and G3 fail** with 0 stamped rows, G4 passes vacuously. That is the correct failure — nothing writes `stage_send_lifecycle` yet.

- [ ] **Step 3: Add the stamping CTE**

`lib/sends/kickoff.ts`. Change the export line so the test can reach it, and replace the statement:

```ts
// Chunked multi-row INSERT. ON CONFLICT DO NOTHING against the active-contact
// unique index (stage_id, contact_id) WHERE status IN ('pending','sending') makes
// windowed materialization idempotent: a concurrent materializer (or a retried
// window) can't create a second active row for a contact. Returns the number of
// rows actually inserted (RETURNING count) so the caller's progress is accurate.
//
// The `stamp` CTE records the contact's lifecycle status AT PREPARE TIME
// (spec §10). It is part of this statement, not a follow-up, so a stamp can
// never exist without its send or vice versa, and it costs no extra round
// trip on a path that already inserts 13 columns x 1000 rows per chunk.
// `coalesce(ce.status, 'new')` is the documented contract for a contact the
// job has not evaluated yet. Stamping changes no send behaviour, so it
// applies to every campaign, legacy ones included.
//
// Exported only so scripts/test-engagement-db.ts can exercise the real
// statement; no application code outside this module calls it.
export async function bulkInsertStageSends(
  tx: DbOrTx,
  rows: StageSendInsertRow[],
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < rows.length; start += STAGE_SENDS_CHUNK) {
    const chunk = rows.slice(start, start + STAGE_SENDS_CHUNK);
    const values = chunk.map(
      (r) => sql`(
        ${r.id}, ${r.orgId}, ${r.campaignId}, ${r.stageId}, ${r.contactId},
        ${r.phone}, ${r.linkId}, ${r.renderedText}, 'pending', ${r.leadId}, ${r.carrierNorm},
        ${r.providerPhoneId}, ${r.costPerSms}
      )`,
    );
    const res = (await tx.execute(sql`
      WITH ins AS (
        INSERT INTO stage_sends
          (id, org_id, campaign_id, stage_id, contact_id, phone, link_id,
           rendered_text, status, lead_id, carrier_norm, provider_phone_id, cost_per_sms)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (stage_id, contact_id) WHERE status IN ('pending', 'sending')
        DO NOTHING
        RETURNING id, org_id, contact_id
      ), stamp AS (
        INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status)
        SELECT ins.id, ins.org_id, coalesce(ce.status, 'new')
        FROM ins
        LEFT JOIN contact_engagement ce
          ON ce.contact_id = ins.contact_id AND ce.org_id = ins.org_id
        ON CONFLICT (stage_send_id) DO NOTHING
      )
      SELECT id FROM ins
    `)) as unknown as { id: string }[];
    inserted += Array.isArray(res) ? res.length : 0;
  }
  return inserted;
}
```

Two properties to keep in mind while reading this:
- `stamp` selects from `ins`, which forces `ins` to produce its rows first. The foreign key `stage_send_lifecycle.stage_send_id → stage_sends(id)` is checked by an AFTER ROW trigger that fires at the *end of the statement*, by which time the `stage_sends` rows exist. G2 is what proves this rather than the reasoning.
- The outer `SELECT id FROM ins` is what keeps `inserted` meaning the same thing it meant before. Do not change it to `SELECT count(*)`.

- [ ] **Step 4: Run the test again**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts
```

Expected: **all Part G bars green**, and Parts A-F still green.

If G2 fails with a foreign-key violation, the AFTER-trigger assumption is wrong for this shape. Fall back to a second statement inside the same transaction, keeping `RETURNING id` on the first and building the id list with `sql.join` (never a bare JS array — it flattens into positional params). Report the fallback rather than silently taking it.

- [ ] **Step 5: Check nothing else calls the renamed export**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git grep -n "bulkInsertStageSends" -- lib app scripts
```

Expected: the definition, the one call at `lib/sends/kickoff.ts:753`, and the new test import. Nothing else.

- [ ] **Step 6: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint lib/sends/kickoff.ts scripts/test-engagement-db.ts
npx tsc --noEmit
git add -A && git commit -m "$(cat <<'EOF'
feat(engagement): stamp the lifecycle status at Prepare

stage_send_lifecycle records what a contact's status WAS when the send was
materialized, because send rows are never rewritten and the cohort report
(PR 5) has to group by the status that applied at the time.

Done as a CTE inside the bulk insert that already runs, so a stamp cannot
exist without its send, it costs no extra round trip, and re-materialization
stays idempotent on both tables. A contact the job has not evaluated stamps
'new', the documented contract for a missing row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Lifecycle labels and the contacts list API

**Files:**
- Create: `lib/engagement/labels.ts`
- Create: `lib/engagement/list-filter.ts`
- Modify: `app/api/contacts/list/route.ts`
- Modify: `components/settings/lifecycle-settings.tsx:256-258`
- Modify: `scripts/test-engagement-db.ts` (Part G5-G7)

**Interfaces:**
- Consumes: `ENGAGEMENT_STATUSES`, `EngagementStatus` from `lib/engagement/constants.ts`.
- Produces:
```ts
// lib/engagement/labels.ts
export const ENGAGEMENT_STATUS_LABELS: Record<EngagementStatus, string>;
export const ENGAGEMENT_STATUS_CLASSES: Record<EngagementStatus, string>;

// lib/engagement/list-filter.ts
export function parseLifecycleStatuses(raw: string | null): EngagementStatus[];
export function lifecycleStatusCondition(
  orgId: string,
  statuses: EngagementStatus[],
): SQL | null;
```
- The list route's row type gains `lifecycle_status: string`.

- [ ] **Step 1: The label map**

`lib/engagement/labels.ts`:

```ts
import { type EngagementStatus } from "./constants";

// User-facing names for contact_engagement.status. One source: the contacts
// column, the contact detail panel and the settings preview all read this.
//
// "Suppressed" here is the END OF THE LIFECYCLE — a contact that stopped
// responding. It is NOT opt_outs.reason = 'suppressed', which is a
// do-not-contact list and reads "Global suppression"
// (CONTACT_STATUS_LABELS, lib/imports/contact-status.ts).
export const ENGAGEMENT_STATUS_LABELS: Record<EngagementStatus, string> = {
  new: "New",
  cold: "Cold",
  hot: "Hot",
  warm: "Warm",
  freeze: "Freeze",
  suppressed: "Suppressed",
};

// Badge classes, ordered warm-to-cold so the column reads as a temperature.
export const ENGAGEMENT_STATUS_CLASSES: Record<EngagementStatus, string> = {
  hot: "border-red-200 bg-red-50 text-red-700",
  warm: "border-amber-200 bg-amber-50 text-amber-700",
  new: "border-sky-200 bg-sky-50 text-sky-700",
  cold: "border-slate-200 bg-slate-50 text-slate-600",
  freeze: "border-violet-200 bg-violet-50 text-violet-700",
  suppressed: "border-muted bg-muted text-muted-foreground",
};
```

- [ ] **Step 2: The filter predicate — the one place "no row = new" is encoded**

`lib/engagement/list-filter.ts`:

```ts
import { sql, type SQL } from "drizzle-orm";

import { contacts } from "@/db/schema";
import { ENGAGEMENT_STATUSES, type EngagementStatus } from "./constants";

/** Whitelist a comma-separated `lifecycle_status` param. Unknown values are dropped. */
export function parseLifecycleStatuses(raw: string | null): EngagementStatus[] {
  if (!raw) return [];
  const valid = new Set<string>(ENGAGEMENT_STATUSES);
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => valid.has(s)) as EngagementStatus[];
  return [...new Set(out)];
}

/**
 * A contacts-list predicate for "lifecycle status is one of these".
 *
 * A contact with NO contact_engagement row IS 'new' (db/schema.ts:4106-4108) —
 * 122,653 of 906,082 production contacts on 2026-09-23. So a bare EXISTS is
 * WRONG whenever 'new' is wanted: it drops every one of them. The NOT EXISTS
 * arm is not an optimisation, it is the contract.
 *
 * Returns null when every status is selected (or none), so the caller adds no
 * predicate at all rather than a tautology the planner has to prove.
 */
export function lifecycleStatusCondition(
  orgId: string,
  statuses: EngagementStatus[],
): SQL | null {
  if (statuses.length === 0 || statuses.length === ENGAGEMENT_STATUSES.length) {
    return null;
  }
  const stored = statuses.filter((s) => s !== "new");
  const wantsNew = statuses.includes("new");

  // Correlated on ${contacts.id}, the idiom already proven by the group_ids
  // block in app/api/contacts/list/route.ts. Values are parameterised one by
  // one — interpolating the JS array would flatten it into positional params.
  const storedArm =
    stored.length > 0
      ? sql`exists (
          select 1 from contact_engagement ce
          where ce.contact_id = ${contacts.id}
            and ce.org_id = ${orgId}
            and ce.status = ANY(ARRAY[${sql.join(
              stored.map((s) => sql`${s}`),
              sql`, `,
            )}]::text[])
        )`
      : null;

  const newArm = wantsNew
    ? sql`(
        not exists (
          select 1 from contact_engagement ce
          where ce.contact_id = ${contacts.id} and ce.org_id = ${orgId}
        )
        or exists (
          select 1 from contact_engagement ce
          where ce.contact_id = ${contacts.id}
            and ce.org_id = ${orgId}
            and ce.status = 'new'
        )
      )`
    : null;

  if (storedArm && newArm) return sql`(${storedArm} or ${newArm})`;
  return storedArm ?? newArm;
}
```

The `newArm` has both halves because `new` is *both* a stored status and the absence of a row. Either one alone is wrong.

- [ ] **Step 3: Wire it into the list route**

`app/api/contacts/list/route.ts`. Add the import, parse the param next to `group_ids` (after line 69), and push the predicate right after the `group_ids` block (after line 84):

```ts
import { lifecycleStatusCondition, parseLifecycleStatuses } from "@/lib/engagement/list-filter";
```

```ts
  // lifecycle_status=hot,warm — comma-separated, any-of. Whitelisted against
  // ENGAGEMENT_STATUSES; unknown values are dropped rather than 400'd, like
  // every other filter on this route.
  const lifecycleStatuses = parseLifecycleStatuses(sp.get("lifecycle_status"));
```

```ts
  const lifecycleCondition = lifecycleStatusCondition(orgId, lifecycleStatuses);
  if (lifecycleCondition) conditions.push(lifecycleCondition);
```

Because `conditions` feeds the single `where` used by BOTH the page query and `capSub`, the filtered count and the filtered page stay in agreement with no second edit.

- [ ] **Step 4: Return the status as a column**

Still in `app/api/contacts/list/route.ts`, add a correlated scalar next to `statusesAggSql` (after line 183):

```ts
  // The page query only — 20 rows, so this is 20 PK probes. Deliberately NOT a
  // LEFT JOIN: the count subquery builds its own FROM, and a join added to one
  // and not the other is how a filtered count and a filtered page drift apart.
  const lifecycleStatusSql = drizzleSql<string>`coalesce((
    select ce.status from contact_engagement ce
    where ce.contact_id = ${contacts.id} and ce.org_id = ${orgId}
  ), 'new')`;
```

and add it to the page query's select object after line 213:

```ts
      lifecycle_status: lifecycleStatusSql,
```

- [ ] **Step 5: Use the labels in the settings preview**

`components/settings/lifecycle-settings.tsx:256-258` renders raw lowercase enum values. Replace with:

```tsx
                {ENGAGEMENT_STATUSES.map(
                  (s) =>
                    `${ENGAGEMENT_STATUS_LABELS[s]} ${(preview.projectedCounts[s] ?? 0).toLocaleString()}`,
                ).join(" · ")}
```

adding the import from `@/lib/engagement/labels`.

- [ ] **Step 6: Test the filter contract (Part G5-G7)**

Append to Part G in `scripts/test-engagement-db.ts`. It calls `lifecycleStatusCondition` — the function the route ships — not a copy of its SQL.

```ts
    const countWith = async (statuses: EngagementStatus[]) => {
      const cond = lifecycleStatusCondition(orgId, statuses);
      const rows = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contacts)
        .where(cond ? and(eq(contacts.org_id, orgId), cond) : eq(contacts.org_id, orgId))) as {
        n: number;
      }[];
      return Number(rows[0].n);
    };

    const nNew = await countWith(["new"]);
    bar(
      "G5 'new' includes contacts with NO engagement row",
      nNew >= 1,
      `expected the row-less contact to match, got ${nNew}`,
    );

    const nHot = await countWith(["hot"]);
    const nHotNew = await countWith(["hot", "new"]);
    bar("G6 multi-select is a union", nHotNew === nHot + nNew, `${nHotNew} vs ${nHot}+${nNew}`);

    const nAll = await countWith([...ENGAGEMENT_STATUSES]);
    const nUnfiltered = await countWith([]);
    bar(
      "G7 every status selected == no filter",
      nAll === nUnfiltered,
      `${nAll} vs ${nUnfiltered}`,
    );
```

G5 is the regression gate for the bug this whole design is shaped around. Run:

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts
```

Expected: G5-G7 green alongside G1-G4.

- [ ] **Step 7: Measure the filtered query against production data**

The 3.5 s whole-table figure is not what this route does, so measure what it does.

Write `scripts/measure-lifecycle-list.ts`, modelled on the existing `scripts/measure-lifecycle-preview.ts` (same `import "./_env-preload"` first line, same read-only shape — the script must live under `scripts/` so that relative import resolves). Against the production org it runs `EXPLAIN (ANALYZE, BUFFERS)` on four shapes and prints the timings:

1. the page query (20 rows) with the new `lifecycle_status` scalar column, unfiltered;
2. the page query plus the `hot,warm` predicate;
3. the page query plus the `new` predicate — the `NOT EXISTS` arm, the one most likely to be slow;
4. the capped count subquery (`COUNT_CAP + 1`) under each of 2 and 3.

**Read-only: no INSERT, UPDATE or DELETE anywhere in the script.**

Acceptance: each under ~2 s. If the `new` arm is materially slower, say so with the plan before proceeding — the fix is a partial index, which needs a migration and therefore approval, not a silent timeout bump.

- [ ] **Step 8: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint lib/engagement/labels.ts lib/engagement/list-filter.ts app/api/contacts/list/route.ts components/settings/lifecycle-settings.tsx scripts/test-engagement-db.ts scripts/measure-lifecycle-list.ts
npx tsc --noEmit
npm run check:authz
git add -A && git commit -m "$(cat <<'EOF'
feat(contacts): lifecycle status in the contacts list API

Adds a lifecycle_status column (correlated scalar, page query only) and a
lifecycle_status=hot,warm filter pushed into the shared `conditions` array,
so the capped count and the page cannot disagree.

The filter lives in lib/engagement/list-filter.ts because "no contact_engagement
row means new" has to be encoded exactly once: a bare EXISTS would silently
drop 122,653 production contacts. Part G5 is the regression gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The contacts list column and filter

**Files:**
- Modify: `app/(protected)/contacts/page.tsx`

**Interfaces:**
- Consumes: `lifecycle_status` on each row; `ENGAGEMENT_STATUS_LABELS`, `ENGAGEMENT_STATUS_CLASSES`, `ENGAGEMENT_STATUSES`.
- Produces: `Filters` gains `lifecycle_status: string[]`.

- [ ] **Step 1: Types and defaults**

Add to the `Contact` row interface, the `Filters` type (line 162-170) and `DEFAULT_FILTERS` (172-180):

```ts
  lifecycle_status: string;       // on Contact
```
```ts
  lifecycle_status: string[];     // on Filters
```
```ts
  lifecycle_status: [],           // in DEFAULT_FILTERS
```

`usePersistedFilters` shallow-merges `{...defaults, ...parsed}`, so an already-persisted blob without the key hydrates correctly — no migration of localStorage needed.

- [ ] **Step 2: Include it in `filtersAreDefault`**

Replace the expression at lines 403-406:

```ts
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.view === DEFAULT_FILTERS.view &&
    filters.group_ids.length === 0 &&
    filters.lifecycle_status.length === 0;
```

Miss this and "Reset filters" never appears once a lifecycle filter is set.

- [ ] **Step 3: Send it to the API**

In the params builder (around line 509):

```ts
      if (filters.lifecycle_status.length > 0)
        params.set("lifecycle_status", filters.lifecycle_status.join(","));
```

And in the fetch effect's dep array (around line 538), alongside `filters.group_ids.join(",")`:

```ts
    filters.lifecycle_status.join(","),
```

An array-valued dep must be joined or the effect refires on every render. The existing `eslint-disable-next-line react-hooks/exhaustive-deps` at line 530 already covers the array.

- [ ] **Step 4: The column**

Add to the `useMemo<ColumnDef<Contact>[]>` array (680-905), between the `indicators` column (ends 790) and the `groups` column (starts 791) — the two status-ish columns belong together, with lifecycle before groups:

```tsx
      {
        id: "lifecycle_status",
        header: "Lifecycle",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original.lifecycle_status as EngagementStatus;
          const label = ENGAGEMENT_STATUS_LABELS[s];
          if (!label) return <span className="text-muted-foreground">—</span>;
          return (
            <span
              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs ${ENGAGEMENT_STATUS_CLASSES[s]}`}
            >
              {label}
            </span>
          );
        },
      },
```

`enableSorting: false` is deliberate — see decision 3. A sortable header here would silently sort by `created_at`.

- [ ] **Step 5: The filter control**

Insert between the groups `MultiSelectPicker` (ends 1005) and the Reset button (starts 1006):

```tsx
        <div className="w-[220px]">
          <MultiSelectPicker
            label="Lifecycle"
            options={ENGAGEMENT_STATUSES.map((s) => ({
              value: s,
              label: ENGAGEMENT_STATUS_LABELS[s],
            }))}
            selected={filters.lifecycle_status}
            onChange={(next) =>
              updateFilters({ lifecycle_status: next as string[], page: 0 })
            }
          />
        </div>
```

Match the exact prop names the groups picker uses at lines 986-1005 — this snippet is the shape, not a promise about the API.

- [ ] **Step 6: Clear the selection when the filter changes**

The selection-clearing effect at 466-468 keys on `filters.group_ids.join(",")`. Add `filters.lifecycle_status.join(",")` to it: changing a filter changes which rows are on screen, and a stale checkbox selection applied to a bulk action is a real hazard on this page.

- [ ] **Step 7: Look at the page**

Start the dev server, open `/contacts`, and check by eye:
- the Lifecycle column renders a badge on every row, never blank;
- filtering to New returns contacts and the count above the table agrees with the number of rows across pages;
- "Reset filters" appears when only a lifecycle status is selected, and clears it;
- reloading the page restores the filter from localStorage;
- the Global suppression badge from Task 1 and the Lifecycle badge are distinguishable at a glance.

This step exists because a source guard names a file, not a screen — grepping for the column name proves it was written, not that it renders.

- [ ] **Step 8: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint "app/(protected)/contacts/page.tsx"
npx tsc --noEmit
```

Compare the eslint problem count against `origin/main` for this file; it must not increase. Then commit:

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat(contacts): Lifecycle column and status filter on the contacts list

Not sortable: SORT_COLUMNS is a two-key whitelist and an unknown sortBy
falls back to created_at silently, so a sortable header would look like it
worked and not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The contact detail Lifecycle panel

**Files:**
- Modify: `app/api/contacts/[id]/route.ts:55-99`
- Modify: `app/(protected)/contacts/[id]/page.tsx`

**Interfaces:**
- Consumes: `contact_engagement`, `contact_engagement_transitions`, `ENGAGEMENT_STATUS_LABELS`.
- Produces: the `GET /api/contacts/[id]` body gains:
```ts
  lifecycle: {
    status: string;
    status_changed_at: string;
    msgs_total: number;
    last_sent_at: string | null;
    last_click_at: string | null;
    freeze_entered_at: string | null;
    freeze_started_at: string | null;
    freeze_msgs: number;
    freeze_cadence_days: number;
    thresholds: Record<string, unknown>;
    computed_at: string;
  } | null;                                     // null = never evaluated = 'new'
  lifecycle_transitions: {
    from_status: string | null;
    to_status: string;
    reason: string;
    created_at: string;
  }[];
```

No new route, and therefore no `OPERATOR_ROUTE_MAP` entry: `contacts/[id]` is already `null`.

- [ ] **Step 1: Two more lookups in the existing `Promise.all`**

`app/api/contacts/[id]/route.ts`. The route already fans out three small indexed lookups (lines 55-84); add two more to the same array. Both are single-key index probes — `contact_engagement`'s PK, and `contact_engagement_transitions_contact_idx (contact_id, created_at)`.

```ts
    db
      .select()
      .from(contact_engagement)
      .where(
        and(
          eq(contact_engagement.contact_id, id),
          eq(contact_engagement.org_id, orgId),
        ),
      )
      .limit(1),
    db
      .select({
        from_status: contact_engagement_transitions.from_status,
        to_status: contact_engagement_transitions.to_status,
        reason: contact_engagement_transitions.reason,
        created_at: contact_engagement_transitions.created_at,
      })
      .from(contact_engagement_transitions)
      .where(
        and(
          eq(contact_engagement_transitions.contact_id, id),
          eq(contact_engagement_transitions.org_id, orgId),
        ),
      )
      .orderBy(desc(contact_engagement_transitions.created_at))
      .limit(20),
```

`orderBy` is explicit here, unlike the `opt_outs` lookup above it which has none — a history list without an order is not a history list. Import `desc` from `drizzle-orm` and the two tables from `@/db/schema`.

Then in the response object (lines 87-99):

```ts
    // null when the job has never evaluated this contact. The page renders
    // that as "New — not yet evaluated" rather than inventing a timestamp:
    // a missing row IS 'new' (db/schema.ts:4106-4108), but it is not the same
    // as a row that says 'new'.
    lifecycle: engagementRows[0] ?? null,
    lifecycle_transitions: transitionRows,
```

- [ ] **Step 2: The panel**

`app/(protected)/contacts/[id]/page.tsx`. Extend the `ContactDetail` interface (31-45) with the two fields above, then add a new `<Card>` between the Groups card (ends 158) and the Attributes card (starts 160).

It follows the page's existing idioms exactly: `<h2 className="mb-2 text-sm font-medium">` for the heading, the `<Field>` helper for scalars, and the Suppression card's `<ul>` / `<li>` / `<Badge variant="outline">` + muted timestamp shape for the history.

```tsx
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-2 text-sm font-medium">Lifecycle</h2>
          {contact.lifecycle ? (
            <>
              <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Field
                  label="Status"
                  value={
                    <span
                      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs ${
                        ENGAGEMENT_STATUS_CLASSES[
                          contact.lifecycle.status as EngagementStatus
                        ]
                      }`}
                    >
                      {ENGAGEMENT_STATUS_LABELS[
                        contact.lifecycle.status as EngagementStatus
                      ]}
                    </span>
                  }
                />
                <Field
                  label="Since"
                  value={format(
                    new Date(contact.lifecycle.status_changed_at),
                    "d MMM yyyy HH:mm",
                  )}
                />
                <Field label="Messages" value={contact.lifecycle.msgs_total} />
                <Field
                  label="Last message"
                  value={
                    contact.lifecycle.last_sent_at
                      ? format(new Date(contact.lifecycle.last_sent_at), "d MMM yyyy")
                      : "—"
                  }
                />
                <Field
                  label="Last human click"
                  value={
                    contact.lifecycle.last_click_at
                      ? format(new Date(contact.lifecycle.last_click_at), "d MMM yyyy")
                      : "—"
                  }
                />
                <Field
                  label="Freeze clock"
                  value={
                    contact.lifecycle.freeze_entered_at
                      ? `${contact.lifecycle.freeze_msgs} msg${
                          contact.lifecycle.freeze_msgs === 1 ? "" : "s"
                        } since ${format(
                          new Date(contact.lifecycle.freeze_entered_at),
                          "d MMM yyyy",
                        )}`
                      : "—"
                  }
                />
                <Field
                  label="Send cadence"
                  value={`every ${contact.lifecycle.freeze_cadence_days}d`}
                />
                <Field label="Thresholds from" value={thresholdSource} />
              </dl>
              <p className="text-muted-foreground mt-3 text-xs">
                Evaluated {format(new Date(contact.lifecycle.computed_at), "d MMM yyyy HH:mm")}.
                Status changes on the next run, never instantly.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              New — not yet evaluated by the status job.
            </p>
          )}
          {contact.lifecycle_transitions.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm">
              {contact.lifecycle_transitions.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <Badge variant="outline">
                    {t.from_status
                      ? `${ENGAGEMENT_STATUS_LABELS[t.from_status as EngagementStatus]} → ${
                          ENGAGEMENT_STATUS_LABELS[t.to_status as EngagementStatus]
                        }`
                      : ENGAGEMENT_STATUS_LABELS[t.to_status as EngagementStatus]}
                  </Badge>
                  <span className="text-muted-foreground">{t.reason.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">
                    {format(new Date(t.created_at), "d MMM yyyy HH:mm")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
```

- [ ] **Step 3: Resolve the threshold source to group names**

`contact_engagement.thresholds` carries `override_group_ids` (an int array, written by `lib/engagement/status-sql.ts:161`). The route **already returns the contact's groups**, so this needs no extra query — compute it just above the return, near `optedOut` at line 110:

```tsx
  const overrideIds: number[] = Array.isArray(
    (contact.lifecycle?.thresholds as { override_group_ids?: number[] } | undefined)
      ?.override_group_ids,
  )
    ? ((contact.lifecycle!.thresholds as { override_group_ids: number[] }).override_group_ids)
    : [];
  const thresholdSource =
    overrideIds.length === 0
      ? "Org defaults"
      : contact.groups
          .filter((g) => overrideIds.includes(g.id))
          .map((g) => g.name)
          .join(", ") || "Group overrides";
```

The final `|| "Group overrides"` covers a group that has since been archived out of the contact's list but whose override was in effect at evaluation time — showing an empty string there would read as a bug.

- [ ] **Step 4: Look at the page**

Open `/contacts/[id]` for three contacts picked from production statuses — one `hot`, one `freeze` (so the freeze clock is populated), and one recently uploaded with no `contact_engagement` row — and confirm:
- the hot contact shows a Since date and a last click;
- the freeze contact shows a freeze clock and a cadence;
- the never-evaluated contact shows "New — not yet evaluated" with no broken dates;
- the history lists transitions newest-first and reads as English ("Hot → Warm  click aged warm  23 Sep 2026 16:40");
- the Suppression card below still renders "Global suppression" from Task 1.

- [ ] **Step 5: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint "app/api/contacts/[id]/route.ts" "app/(protected)/contacts/[id]/page.tsx"
npx tsc --noEmit
npm run check:authz
git add -A && git commit -m "$(cat <<'EOF'
feat(contacts): Lifecycle panel on the contact detail page

Status, the facts behind it, the effective thresholds and their source, and
the last 20 transitions. Two more indexed lookups in the Promise.all the
route already runs — no new endpoint, so no route-map change.

A contact with no contact_engagement row reads "New — not yet evaluated"
rather than inventing a status_changed_at.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/04-features/contact-lifecycle.md`
- Modify: `docs/05-flows.md`
- Modify: `docs/07-conventions.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: The feature doc**

Add to `docs/04-features/contact-lifecycle.md`: a "Where you see it" section covering the contacts column and filter, the detail panel, and the status-at-send stamp; the "no row means new" contract with the production number that makes it matter; and the note that `stage_send_lifecycle` is written but not yet read (PR 5).

- [ ] **Step 2: The flow diagram**

`docs/05-flows.md` — the materialization sequence now writes two tables in one statement. Update the diagram; do not leave it describing a single insert.

- [ ] **Step 3: Conventions**

`docs/07-conventions.md` — two entries:
- `opt_outs.reason = 'suppressed'` is labelled "Global suppression"; `contact_engagement.status = 'suppressed'` is labelled "Suppressed". Different concepts, same DB word, and both can appear on the contacts screen.
- Any query filtering on lifecycle status goes through `lifecycleStatusCondition()`, because a missing `contact_engagement` row is `new` and a bare `EXISTS` drops it.

- [ ] **Step 4: Changelog and the last-updated dates**

Append one line to `docs/CHANGELOG.md` and update the "last updated" date on every doc touched.

**Beware:** the changelog has now produced a rebase conflict on two consecutive PRs in this series. Rebase on `main` **before** opening the PR, resolve the changelog by keeping both entries in date order, and confirm no conflict markers survive:

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git fetch origin && git rebase origin/main
git grep -n "^<<<<<<<\|^>>>>>>>\|^=======$" -- docs/ || echo "clean"
```

- [ ] **Step 5: Full check and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npm run check:docs && npm run check:authz && npm run check:guards
npx tsc --noEmit
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts
git add -A && git commit -m "$(cat <<'EOF'
docs: contact lifecycle PR 2b — visibility, stamping, relabel

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: all three check scripts pass, `tsc` clean, Parts A-G all green.

---

## Merge gate

**Ship on green**, per the spec's rollout table (PR 2 is not an "ask before merge" row). Nothing in this PR changes who is sent a message: the column, the filter and the panel are reads, and the stamp is a record of a decision already made. `campaigns.lifecycle_rules` stays `false` on every campaign; the send path's behaviour is untouched.

Two things to report at PR time rather than decide alone:
- the Step 7 measurement of the `new` filter against production, if it is slow;
- the CTE fallback, if the foreign key does not hold inside one statement.

## Self-review

**Spec coverage.** §6's contacts list ("a Lifecycle column plus a multi-select status filter") → Tasks 3-4. §6's contact detail (status and since when; messages total, last message, last human click; the freeze clock; the effective thresholds and their source; the last 20 transitions) → Task 5, all six bullets present. §6's relabel ("in the statuses column and in the import UI") → Task 1, plus the dashboard by decision 5. §10's "status is stamped at Prepare … one statement in the same transaction … applies to every campaign, legacy included" → Task 2. §10's 60-day reconstruction script is explicitly PR 5 and is not here. Nothing else in §6 or §10 is unclaimed.

**Placeholders.** None. Every code step carries the code. The one place a snippet is knowingly approximate — the `MultiSelectPicker` props in Task 4 Step 5 — says so and names the lines to copy from instead.

**Type consistency.** `EngagementStatus` is used identically in `labels.ts`, `list-filter.ts` and both pages. `lifecycle_status` (singular, string) is the row column; `lifecycle_status` (array) is the filter key and the query param — same name, different shapes, which is the existing `group_ids` convention on this route. `lifecycleStatusCondition` returns `SQL | null` and every caller checks for null. `bulkInsertStageSends` keeps its exact signature.

**One gap I want to name rather than bury:** Task 2 exports a previously module-private function purely so the test can reach the real statement. The alternative — a test that rebuilds the SQL — would compare the statement against a copy of itself and prove nothing. The export carries a comment saying no application code outside the module calls it, and Step 5 greps to keep that true.
