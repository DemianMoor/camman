// One-shot manual import of TextHub STOP replies that the live poller missed
// (200-cap inbox scroll-off), from a TextHub export CSV (`From,Received`), and
// attribution of each to the campaign/stage that sent to the number — using the
// EXACT same rule as the live poller (lib/sends/poll-opt-outs.ts) and the
// existing set-based backfill (scripts/backfill-optout-attributions.ts). Then it
// recomputes per-stage opt-out counters/cost and refreshes the reports rollup so
// the imported opt-outs show up in /reports.
//
// DEFAULT = DRY RUN (read-only): runs the FULL mutation inside a transaction and
// ROLLS BACK, so the printed counts/breakdown are exactly what --apply would do.
// Pass --apply to commit. Reports rollup runs only on --apply.
//
//   npx tsx scripts/import-texthub-optouts.ts --file="<path>.csv"            # dry run
//   npx tsx scripts/import-texthub-optouts.ts --file="<path>.csv" --apply    # commit
//
// TIMEZONE: the CSV's `Received` column is a bare wall-clock. We DON'T bake a
// zone at parse time — we store the naive local timestamp and convert it in SQL
// under each CANDIDATE zone, comparing to the times the live poller already
// stored (which it parsed as US Mountain). The zone whose converted anchors line
// up with the stored opt-outs (~0 offset) is selected, so this import aligns with
// existing data. Force one with --tz=<IANA> to skip auto-selection.
//
// Options:
//   --file=<path>        CSV path (required). Header row `From,Received`.
//   --apply              Commit (else dry-run + rollback).
//   --org=<uuid>         Org to import into (else auto: the org with the most
//                        stage_sends; aborts if ambiguous and none dominates).
//   --tz=<IANA>          Force the Received-column timezone (skip auto-selection).
//   --tolerance-min=60   Dedup window: skip a STOP if an opt_out for that phone
//                        already exists within +/- N minutes of its receipt time.
//   --rollup-days=60     refreshReportRollup recompute depth (must cover the
//                        earliest affected send ~72h before the first STOP).
//   --sample=15          How many calibration rows to print for eyeballing.
//
// Idempotent: opt_outs are gated by the dedup window; attribution is ON CONFLICT
// (opt_out_id, stage_id) DO NOTHING; counters are recomputed from the junction.
// Re-running reports 0 new. Bypasses RLS via the privileged DB connection.
//
// Imported opt_outs carry source='texthub_manual_import' so they stay
// identifiable/reversible. Reports and audience-suppression both ignore `source`,
// so the distinct tag changes neither.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { readFileSync } from "node:fs";

import { sql as dsql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { OPT_OUT_ATTRIBUTION_WINDOW_HOURS } from "@/lib/sends/poll-opt-outs";
import { refreshReportRollup } from "@/lib/reporting/rollup";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

const MANUAL_SOURCE = "texthub_manual_import";
// Zones the CSV could plausibly be in — Mountain (what the poller parses TextHub
// as) and Eastern (what the operator believes the export is). Calibration picks.
const CANDIDATE_TZS = ["America/Denver", "America/New_York"];

function arg(name: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

interface StopEvent {
  phone: string; // E.164 with +
  local: string; // naive wall-clock "YYYY-MM-DD HH:MM:00" (no zone)
}

// The export is all NANP (US/Canada) 11-digit numbers. Normalize deterministically
// to E.164 `+1XXXXXXXXXX` — the exact format the poller stored via libphonenumber
// (verified against opt_outs/stage_sends), without depending on libphonenumber
// (whose metadata fails to load under tsx). The phone-equality join to existing
// rows is the correctness check: the calibration `matched` count would be ~0 if
// this format were wrong.
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

// Parse `M/D/YYYY H:MM[:SS]` into a naive "YYYY-MM-DD HH:MM:SS" local string.
// Returns null on anything that doesn't match, so a stray line is skipped.
function parseReceivedLocal(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const [, mo, d, y, h, mi, s] = m;
  return (
    `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")} ` +
    `${h.padStart(2, "0")}:${mi}:${(s ?? "00").padStart(2, "0")}`
  );
}

interface ParseResult {
  events: StopEvent[]; // deduped (phone, minute)
  rawRows: number;
  badPhone: number;
  badDate: number;
  collapsedDupes: number;
}

function parseCsv(path: string): ParseResult {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  let rawRows = 0;
  let badPhone = 0;
  let badDate = 0;
  // Collapse exact (phone, same-minute) duplicates — multi-segment / export
  // artifacts, not separate STOPs. Wall-clock minute is zone-independent.
  const seen = new Map<string, StopEvent>();
  let collapsed = 0;

  for (const line of lines) {
    const row = line.trim();
    if (!row) continue;
    const comma = row.indexOf(",");
    if (comma < 0) continue;
    const from = row.slice(0, comma).trim();
    const received = row.slice(comma + 1).trim();
    if (!/^\+?\d{7,}$/.test(from)) continue; // skip header / junk

    rawRows++;
    const phone = normalizePhone(from);
    if (!phone) {
      badPhone++;
      continue;
    }
    const local = parseReceivedLocal(received);
    if (!local) {
      badDate++;
      continue;
    }
    const minuteKey = `${phone}|${local.slice(0, 16)}`; // to the minute
    if (seen.has(minuteKey)) {
      collapsed++;
      continue;
    }
    seen.set(minuteKey, { phone, local });
  }

  return { events: [...seen.values()], rawRows, badPhone, badDate, collapsedDupes: collapsed };
}

type Db = ReturnType<typeof drizzle>;
// Any drizzle executor (top-level client or a transaction handle) — we only ever
// call `.execute`, so this minimal shape lets the same helpers take either.
type Exec = { execute: (q: SQL) => Promise<unknown> };

async function resolveOrg(db: Db, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const rows = (await db.execute(dsql`
    SELECT o.id, count(ss.id)::int AS sends
    FROM organizations o
    LEFT JOIN stage_sends ss ON ss.org_id = o.id
    GROUP BY o.id
    ORDER BY sends DESC
  `)) as unknown as { id: string; sends: number }[];
  if (rows.length === 0) throw new Error("No organizations found.");
  if (rows.length === 1) return rows[0].id;
  console.log(`  Orgs (by stage_sends): ` + rows.map((r) => `${r.id}=${r.sends}`).join(", "));
  const [top, second] = rows;
  if (top.sends > 0 && top.sends >= (second?.sends ?? 0) * 10) return top.id;
  throw new Error("Multiple orgs with sends and none dominates — pass --org=<uuid>.");
}

// Stage the deduped events' naive wall-clock into a TEMP table (chunked inserts).
// Anchors are derived per-zone in SQL via `local AT TIME ZONE <tz>`.
async function stageEvents(tx: Exec, events: StopEvent[]): Promise<void> {
  await tx.execute(dsql`
    CREATE TEMP TABLE _stop_events (phone text NOT NULL, local timestamp NOT NULL)
    ON COMMIT DROP
  `);
  const CHUNK = 1000;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const values = dsql.join(
      slice.map((e) => dsql`(${e.phone}, ${e.local}::timestamp)`),
      dsql`, `,
    );
    await tx.execute(dsql`INSERT INTO _stop_events (phone, local) VALUES ${values}`);
  }
  await tx.execute(dsql`ANALYZE _stop_events`);
}

// `local AT TIME ZONE tz` — interpret the naive wall-clock as `tz` → timestamptz.
function anchorSql(tz: string): SQL {
  return dsql`(e.local AT TIME ZONE ${tz})`;
}

interface Calibration {
  tz: string;
  matched: number;
  avgAbsMin: number;
}

// For each candidate zone, compare our anchor to the NEAREST existing opt_out
// for that phone. The zone with ~0 offset is the one the export is really in.
async function calibrate(tx: Exec, orgId: string): Promise<Calibration[]> {
  const out: Calibration[] = [];
  for (const tz of CANDIDATE_TZS) {
    const a = anchorSql(tz);
    const rows = (await tx.execute(dsql`
      SELECT count(*)::int AS matched,
             coalesce(round(avg(abs(extract(epoch FROM (oo.created_at - ${a})) / 60.0))), -1)::int AS avg_abs_min
      FROM _stop_events e
      JOIN LATERAL (
        SELECT created_at FROM opt_outs
        WHERE org_id = ${orgId} AND phone_number = e.phone
        ORDER BY abs(extract(epoch FROM (created_at - ${a}))) ASC
        LIMIT 1
      ) oo ON true
    `)) as unknown as { matched: number; avg_abs_min: number }[];
    out.push({ tz, matched: rows[0].matched, avgAbsMin: rows[0].avg_abs_min });
  }
  return out;
}

interface MutationResult {
  newOptOuts: number;
  newAttributions: number;
  unattributed: number;
  affectedStages: number[];
  breakdown: { campaign_id: number; stage_id: number; n: number }[];
}

async function runMutation(
  tx: Exec,
  orgId: string,
  tz: string,
  toleranceMin: number,
  apply: boolean,
  events: StopEvent[],
): Promise<MutationResult> {
  await stageEvents(tx, events);
  const a = anchorSql(tz);

  // Dedup gate: events with NO existing opt_out for that phone within +/-
  // tolerance of the anchor. Covers poller ('sms_inbound') rows AND a prior run.
  await tx.execute(dsql`
    CREATE TEMP TABLE _new_events ON COMMIT DROP AS
    SELECT e.phone, ${a} AS anchor
    FROM _stop_events e
    WHERE NOT EXISTS (
      SELECT 1 FROM opt_outs oo
      WHERE oo.org_id = ${orgId}
        AND oo.phone_number = e.phone
        AND oo.created_at BETWEEN ${a} - (${toleranceMin} * interval '1 minute')
                              AND ${a} + (${toleranceMin} * interval '1 minute')
    )
  `);
  const newCount = (await tx.execute(
    dsql`SELECT count(*)::int AS n FROM _new_events`,
  )) as unknown as { n: number }[];

  await tx.execute(dsql`
    INSERT INTO contacts (org_id, phone_number)
    SELECT DISTINCT ${orgId}::uuid, phone FROM _new_events
    ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
  `);

  const insertedOptOuts = (await tx.execute(dsql`
    INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
    SELECT ${orgId}::uuid, c.id, ne.phone, ${MANUAL_SOURCE}, ne.anchor
    FROM _new_events ne
    JOIN contacts c ON c.org_id = ${orgId} AND c.phone_number = ne.phone
    RETURNING id
  `)) as unknown as { id: number }[];

  // Attribute — the SINGLE most-recent send to the number across ALL stages in
  // the 72h window (ONE opt_out -> ONE stage), matching the CURRENT live poller
  // rule `latestSendForAttribution` (ORDER BY sent_at DESC, stage_id DESC, id
  // DESC; LIMIT 1). NOTE: this deliberately differs from the older
  // backfill-optout-attributions.ts, which fans out one-row-per-stage — the
  // pre-2026-06-24 behavior that double-counts a STOP across a multi-stage
  // sequence and inflates the /reports opt-out rate. DISTINCT ON (oo.id) here
  // keeps it to one. created_at = the STOP receipt time (the opt_out's anchor).
  const attributed = (await tx.execute(dsql`
    INSERT INTO opt_out_attributions
      (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
    SELECT DISTINCT ON (oo.id)
           oo.org_id, oo.id, ss.id, ss.stage_id, ss.campaign_id, oo.created_at
    FROM opt_outs oo
    JOIN stage_sends ss
      ON ss.org_id = oo.org_id
     AND ss.phone = oo.phone_number
     AND ss.status = 'sent'
     AND ss.sent_at IS NOT NULL
     AND ss.sent_at >= oo.created_at - (${OPT_OUT_ATTRIBUTION_WINDOW_HOURS} * interval '1 hour')
     AND ss.sent_at <= oo.created_at + interval '5 minutes'
    WHERE oo.source = ${MANUAL_SOURCE}
    ORDER BY oo.id, ss.sent_at DESC, ss.stage_id DESC, ss.id DESC
    ON CONFLICT (opt_out_id, stage_id) DO NOTHING
    RETURNING stage_id, campaign_id
  `)) as unknown as { stage_id: number; campaign_id: number }[];

  const breakdownMap = new Map<string, { campaign_id: number; stage_id: number; n: number }>();
  for (const at of attributed) {
    const k = `${at.campaign_id}:${at.stage_id}`;
    const cur = breakdownMap.get(k) ?? { campaign_id: at.campaign_id, stage_id: at.stage_id, n: 0 };
    cur.n++;
    breakdownMap.set(k, cur);
  }
  const affectedStages = [...new Set(attributed.map((at) => at.stage_id))];

  // Recompute per-stage counter from the FULL junction (idempotent), mirror
  // opt_out_count upward — exactly as backfill-optout-attributions.ts.
  await tx.execute(dsql`
    UPDATE campaign_stages cs
    SET inbound_opt_out_count = agg.n
    FROM (
      SELECT cs2.id AS stage_id, count(oa.id)::int AS n
      FROM campaign_stages cs2
      LEFT JOIN opt_out_attributions oa ON oa.stage_id = cs2.id
      GROUP BY cs2.id
    ) agg
    WHERE cs.id = agg.stage_id AND cs.inbound_opt_out_count <> agg.n
  `);
  await tx.execute(dsql`
    UPDATE campaign_stages cs
    SET opt_out_count = cs.inbound_opt_out_count
    WHERE cs.inbound_opt_out_count > cs.opt_out_count
  `);

  // Opt-outs bill like sends — recompute total cost for each affected stage.
  for (const stageId of affectedStages) {
    await recomputeStageTotalCost(tx as never, stageId);
  }

  const result: MutationResult = {
    newOptOuts: insertedOptOuts.length,
    newAttributions: attributed.length,
    unattributed: newCount[0].n - attributed.length,
    affectedStages,
    breakdown: [...breakdownMap.values()].sort((x, y) => y.n - x.n),
  };

  if (!apply) throw Object.assign(new Error("__dry_run_rollback__"), { result });
  return result;
}

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("Missing --file=<path.csv>");
    process.exit(1);
  }
  const apply = flag("apply");
  const forcedTz = arg("tz");
  const toleranceMin = Number(arg("tolerance-min") ?? "60");
  const rollupDays = Number(arg("rollup-days") ?? "60");
  const sampleN = Number(arg("sample") ?? "15");

  console.log(`=== TextHub opt-out manual import — ${apply ? "APPLY" : "DRY RUN"} ===`);
  console.log(`  file=${file}  tolerance=${toleranceMin}min  rollup=${rollupDays}d`);

  const parsed = parseCsv(file);
  console.log(
    `  CSV: ${parsed.rawRows} data rows -> ${parsed.events.length} unique STOP events ` +
      `(collapsed ${parsed.collapsedDupes} same-minute dupes; ${parsed.badPhone} bad phone, ${parsed.badDate} bad date)`,
  );
  if (parsed.events.length === 0) {
    console.log("  Nothing to import.");
    return;
  }

  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const orgId = await resolveOrg(db, arg("org"));
    console.log(`  org_id=${orgId}`);

    // Timezone calibration (read-only) — test each candidate zone against stored
    // opt-outs; pick the aligning one (unless --tz forces it).
    let chosenTz = forcedTz ?? CANDIDATE_TZS[0];
    await db
      .transaction(async (tx) => {
        await stageEvents(tx, parsed.events);
        const cals = await calibrate(tx, orgId);
        console.log(`  Timezone calibration (nearest existing opt_out per phone):`);
        for (const c of cals) {
          console.log(
            `    ${c.tz.padEnd(18)} matched=${c.matched}  avg|offset|=${c.avgAbsMin}min` +
              (c.avgAbsMin === -1 ? " (no matches)" : ""),
          );
        }
        if (!forcedTz) {
          const usable = cals.filter((c) => c.matched > 0 && c.avgAbsMin >= 0);
          const best = usable.sort((x, y) => x.avgAbsMin - y.avgAbsMin)[0];
          if (best) chosenTz = best.tz;
        }
        console.log(
          `  -> Using timezone: ${chosenTz}` + (forcedTz ? " (forced via --tz)" : " (auto-selected)"),
        );
        // Sample rows under the chosen zone for eyeballing.
        const a = anchorSql(chosenTz);
        const rows = (await tx.execute(dsql`
          SELECT e.phone, (${a})::text AS anchor, oo.created_at::text AS stored,
                 round(extract(epoch FROM (oo.created_at - ${a}))/60.0)::int AS diff_min
          FROM _stop_events e
          JOIN LATERAL (
            SELECT created_at FROM opt_outs
            WHERE org_id = ${orgId} AND phone_number = e.phone
            ORDER BY abs(extract(epoch FROM (created_at - ${a}))) ASC LIMIT 1
          ) oo ON true
          LIMIT ${sampleN}
        `)) as unknown as { phone: string; anchor: string; stored: string; diff_min: number }[];
        for (const r of rows) {
          console.log(`    ${r.phone}  anchor=${r.anchor}  stored=${r.stored}  diff=${r.diff_min}min`);
        }
        throw new Error("__calibration_rollback__");
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== "__calibration_rollback__") throw e;
      });

    // The mutation. Dry-run throws __dry_run_rollback__ (with result attached) to
    // roll back, so reported numbers equal what apply would write.
    let result: MutationResult | null = null;
    try {
      await db.transaction(async (tx) => {
        result = await runMutation(tx, orgId, chosenTz, toleranceMin, apply, parsed.events);
      });
    } catch (e) {
      if (e instanceof Error && e.message === "__dry_run_rollback__") {
        result = (e as unknown as { result: MutationResult }).result;
      } else throw e;
    }

    const r = result!;
    console.log(`\n  ${apply ? "WROTE" : "WOULD WRITE"}:`);
    console.log(`    new opt_outs:                 ${r.newOptOuts}`);
    console.log(`    new attributions:             ${r.newAttributions}`);
    console.log(`    unattributed (suppress-only): ${r.unattributed}`);
    console.log(`    stages affected:              ${r.affectedStages.length}`);
    console.log(`  Top campaigns/stages by new attributions:`);
    for (const b of r.breakdown.slice(0, 40)) {
      console.log(`    campaign ${b.campaign_id}  stage ${b.stage_id}  +${b.n}`);
    }
    if (r.breakdown.length > 40) console.log(`    ... and ${r.breakdown.length - 40} more`);

    if (apply) {
      console.log(`\n  Refreshing reports rollup (recomputeSinceDays=${rollupDays}) ...`);
      const roll = await refreshReportRollup(db as never, { recomputeSinceDays: rollupDays });
      console.log(`  rollup: ${JSON.stringify(roll)}`);
      console.log(`\n  DONE. Re-run without --apply to confirm 0 new (idempotency).`);
    } else {
      console.log(`\n  Dry run only — nothing written. Re-run with --apply to commit.`);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Import crashed:", err);
  process.exit(1);
});
