import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "../lib/campaign-timezone";
import { ingestKeitaroConversions } from "../lib/conversions/ingest";
import { etDayWindows } from "../lib/conversions/keitaro-row";

// Backfill conversion_events from Keitaro's full conversion history.
//   npx tsx scripts/backfill-conversion-events.ts            # DRY RUN — no writes
//   npx tsx scripts/backfill-conversion-events.ts --apply    # writes (prod: needs approval)
// Idempotent: re-running changes only conversions Keitaro has changed since.
// Exit 1 on any fetch error (incl. a truncated or malformed page), unparseable
// row, unresolved or unmapped conversion, a conversion FIRST seen through a
// status-only mapping (it lands with no event type), org mismatch, or an empty
// scope — each needs a human decision, not a silent pass. The table-level
// unmapped / status-only / conflict check runs only with --apply; a dry run
// reports per-run counts only (the first-seen count is computed on a dry run
// too — it is a read).

// Keitaro's earliest conversion is 2026-06-15; starting earlier costs nothing.
const FROM = process.env.BACKFILL_FROM ?? "2026-06-01";
// A window whose fetch is TRUNCATED fails (nothing from it is written); re-run
// with a smaller window, e.g. BACKFILL_WINDOW_DAYS=1.
const WINDOW_DAYS = Number(process.env.BACKFILL_WINDOW_DAYS ?? 7);
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!Number.isInteger(WINDOW_DAYS) || WINDOW_DAYS < 1) {
    console.log(`FAIL: BACKFILL_WINDOW_DAYS must be a positive integer, got ${process.env.BACKFILL_WINDOW_DAYS}`);
    process.exit(1);
  }
  const nowEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd HH:mm:ss");
  const windows = etDayWindows(FROM, nowEt, WINDOW_DAYS);
  console.log(APPLY ? "APPLY — writes conversion_events" : "DRY RUN — no writes (pass --apply to write)");
  console.log(`Scope: ${FROM} 00:00:00 → ${nowEt} ${CAMPAIGN_TIMEZONE}, ${windows.length} windows of ${WINDOW_DAYS} day(s)\n`);

  const t = { fetched: 0, invalid: 0, unresolved: 0, rows: 0, unmapped: 0, statusOnly: 0, statusOnlyFirstSeen: 0, inserted: 0, updated: 0, unchanged: 0, typeConflicts: 0, orgMismatch: 0 };
  let errors = 0;
  for (const w of windows) {
    const r = await ingestKeitaroConversions(db, { range: w, dryRun: !APPLY });
    console.log(
      `${w.from.slice(0, 10)} → ${w.to.slice(0, 10)}  fetched ${r.fetched}  rows ${r.rows}  unmapped ${r.unmappedInBatch}  status-only ${r.statusOnlyInBatch}  status-only-first-seen ${r.statusOnlyFirstSeenInBatch}  unresolved ${r.unresolved}  invalid ${r.invalid}` +
        (APPLY ? `  inserted ${r.inserted}  updated ${r.updated}  unchanged ${r.unchanged}  type-conflicts ${r.typeConflicts}  org-mismatch ${r.orgMismatch}` : "") +
        (r.error ? `  ERROR ${r.error}` : ""),
    );
    for (const s of r.invalidSamples) console.log(`    unparseable: ${s}`);
    for (const s of r.unresolvedSamples) console.log(`    unresolved: ${s}`);
    for (const s of r.orgMismatchSamples) console.log(`    org mismatch (not written): ${s}`);
    for (const s of r.statusOnlyFirstSeenSamples) console.log(`    status-only, first sighting (lands with NO event type): ${s}`);
    if (!r.ok) errors++;
    t.fetched += r.fetched;
    t.invalid += r.invalid;
    t.unresolved += r.unresolved;
    t.rows += r.rows;
    t.unmapped += r.unmappedInBatch;
    t.statusOnly += r.statusOnlyInBatch;
    t.statusOnlyFirstSeen += r.statusOnlyFirstSeenInBatch;
    t.inserted += r.inserted;
    t.updated += r.updated;
    t.unchanged += r.unchanged;
    t.typeConflicts += r.typeConflicts;
    t.orgMismatch += r.orgMismatch;
  }

  console.log(`\nTotals: ${JSON.stringify(t)}`);
  if (t.statusOnly > 0) {
    console.log(
      `NOTE: ${t.statusOnly} conversion(s) resolved through a status-only mapping (no event type). A status-only rule keeps the row's existing event type, which is correct as long as the row already exists.`,
    );
  }
  const problems: string[] = [];
  if (errors > 0) problems.push(`${errors} window(s) failed to fetch, came back truncated or malformed — NOTHING from those windows was written; re-run (with a smaller BACKFILL_WINDOW_DAYS if truncated)`);
  if (t.fetched === 0) problems.push("Keitaro returned no conversions — an empty scope is a failure, not a pass");
  if (t.invalid > 0) problems.push(`${t.invalid} unparseable row(s)`);
  if (t.unresolved > 0) problems.push(`${t.unresolved} unresolvable conversion(s) (no stage, no offers.keitaro_offer_id)`);
  if (t.unmapped > 0) problems.push(`${t.unmapped} unmapped conversion(s) in this run (no mapping for their network/offer + type)`);
  // A status-only rule says "keep the row's existing event type". With no prior
  // row there is none to keep, so the conversion lands with a status and a NULL
  // event type and counts as nothing. No later postback heals it.
  if (t.statusOnlyFirstSeen > 0)
    problems.push(
      `${t.statusOnlyFirstSeen} conversion(s) FIRST seen through a status-only mapping — they have no event type to keep and land unclassified; add a mapping with an event_type_id for the Keitaro type that should arrive first, and set these rows' event_type_id by SQL`,
    );
  if (t.orgMismatch > 0) problems.push(`${t.orgMismatch} conversion(s) NOT written: the stored row belongs to a different org than this run resolved`);
  // The per-run counts only see rows WRITTEN this run (an unchanged conflicted or
  // unmapped row is skipped by the upsert), so after --apply the TABLE is the truth.
  if (APPLY) {
    const [tbl] = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status IS NULL)::int AS unmapped,
             count(*) FILTER (WHERE event_type_id IS NULL AND status IS NOT NULL)::int AS status_only_unmapped,
             count(*) FILTER (WHERE conflicting_event_type_id IS NOT NULL)::int AS conflicts
      FROM conversion_events
    `)) as unknown as { total: number; unmapped: number; status_only_unmapped: number; conflicts: number }[];
    console.log(
      `Table after apply: ${tbl.total} rows · ${tbl.unmapped} unmapped · ${tbl.status_only_unmapped} status-only with no event type · ${tbl.conflicts} event-type conflict(s)`,
    );
    if (tbl.unmapped > 0) problems.push(`${tbl.unmapped} unmapped row(s) in conversion_events (status IS NULL)`);
    if (tbl.status_only_unmapped > 0)
      problems.push(
        `${tbl.status_only_unmapped} row(s) in conversion_events with a status but NO event type — first seen through a status-only mapping; no mapping can heal them, set their event_type_id by SQL`,
      );
    if (tbl.conflicts > 0) problems.push(`${tbl.conflicts} event-type conflict(s) in conversion_events (a Keitaro type now maps to a different event than the locked one)`);
  }
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
