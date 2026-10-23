import { sql, type SQL } from "drizzle-orm";

import type { db as Db } from "@/db/client";
import {
  CARRIER_REJECTION_CODES,
  matchKeys,
  normalizeRejectionCode,
  type CarrierRejectionProvider,
} from "@/lib/carrier-rejection/codes";

// CARRIER-REJECTION LEDGER (migration 0225, ClickUp 1amdve2850v).
//
// Three derived tables, written ONLY from here:
//   carrier_rejections        one row per REJECTED MESSAGE (stage_send): hard|soft + code
//   carrier_phone_delivery    per phone: sent_at of its latest DELIVERED message
//   carrier_rejected_phones   per phone: the numbers that currently meet the rule
//
// The rule (owner, 2026-10-24): one outcome per message; a phone is
// carrier-rejected when hard >= hard threshold (all time) OR soft >= soft
// threshold inside the soft window. Only rejections on messages sent AFTER the
// phone's latest delivered message count — a delivered message resets it.
// "Delivered wins" for a message falls out of the same comparison: a message
// with both receipts has sent_at = last_delivered, and the test is strict `>`.
//
// The flagged set is computed whether or not the org's toggle is on (the
// Settings page previews it). The toggle only decides whether eligibility
// filters READ it. Nothing here writes opt_outs or touches STOP handling.
//
// WRITERS (app/api/cron/carrier-rejections), all under ONE lease so they never
// overlap: the 15-min incremental pass, the daily trailing rebuild (last 14
// days of receipts + the whole flagged set), and the on-demand resumable
// full-history rebuild (the backfill, and the repair after a code-map change).

type DbOrTx = typeof Db | Parameters<Parameters<typeof Db.transaction>[0]>[0];

export const CARRIER_REJECTION_DEFAULTS = {
  hardThreshold: 2,
  softThreshold: 3,
  softWindowDays: 30,
} as const;

export const LEASE_JOB = "carrier-rejections";
const WATERMARK_JOB = "carrier-rejections:watermark";

// Receipts are stamped received_at = now() at INSERT, but the insert's
// transaction can commit a moment later, so the window stops short of now().
const SAFETY_LAG = sql`interval '2 minutes'`;
// The incremental window re-reads this much before the watermark. A Tells
// receipt is matched to its send by the tells-sweep cron (every 5 min) AFTER
// insert, so its received_at is already behind the cursor when it becomes
// usable. Upserts are idempotent; the daily rebuild repairs anything later.
const OVERLAP = sql`interval '1 hour'`;

// ---------------------------------------------------------------------------
// Classification SQL — built from the code map, never retyped.
// ---------------------------------------------------------------------------

function inList(keys: string[]): SQL {
  return sql.join(keys.map((k) => sql`${k}`), sql`, `);
}

function classSql(p: CarrierRejectionProvider, codeExpr: SQL): SQL {
  return sql`CASE WHEN ${codeExpr} IN (${inList(matchKeys(p, "hard"))}) THEN 'hard'
                  WHEN ${codeExpr} IN (${inList(matchKeys(p, "soft"))}) THEN 'soft' END`;
}

// Stored code: txr webhook aliases → the poll's code; Ahoi/Tells text in the
// casing the code map lists it; anything unlisted as received (normalized).
function canonSql(p: CarrierRejectionProvider, codeExpr: SQL): SQL {
  const m = CARRIER_REJECTION_CODES[p];
  const pairs: [string, string][] = [
    ...Object.entries(m.aliases ?? {}),
    ...[...m.hard, ...m.soft, ...m.ignore].map((c): [string, string] => [normalizeRejectionCode(c), c]),
  ];
  return sql`CASE ${codeExpr} ${sql.join(
    pairs.map(([from, to]) => sql`WHEN ${from} THEN ${to}`),
    sql` `,
  )} ELSE ${codeExpr} END`;
}

// The txr webhook leaves error_code NULL and carries the code only in raw_body.
const TXR_CODE = sql`lower(trim(coalesce(nullif(error_code, ''),
  substring(lower(raw_body) from '"error_?code"\\s*:\\s*"?([0-9]+)'))))`;
const AHI_CODE = sql`lower(trim(error))`;
const TLS_CODE = sql`lower(trim(error_message))`;

// One row per RECEIPT EVENT received in [from, to): delivered flag, or a class.
function classifiedEvents(from: SQL, to: SQL): SQL {
  return sql`
    SELECT 'txr'::text AS provider, coalesce(matched_stage_send_id, stage_send_id) AS ss_id,
           lower(status) = 'delivered' AS d,
           CASE WHEN lower(status) = 'undelivered' THEN ${classSql("txr", TXR_CODE)} END AS cls,
           ${canonSql("txr", TXR_CODE)} AS code
    FROM textrequest_dlr_events
    WHERE received_at >= ${from} AND received_at < ${to}
      AND lower(status) IN ('delivered', 'undelivered')
    UNION ALL
    SELECT 'ahi', matched_stage_send_id, lower(status) = 'delivered',
           CASE WHEN lower(status) = 'error' THEN ${classSql("ahi", AHI_CODE)} END,
           ${canonSql("ahi", AHI_CODE)}
    FROM ahoi_dlr_events
    WHERE received_at >= ${from} AND received_at < ${to}
      AND lower(status) IN ('delivered', 'error')
    UNION ALL
    SELECT 'tls', matched_stage_send_id, lower(status) = 'delivered',
           CASE WHEN lower(status) = 'undelivered' THEN ${classSql("tls", TLS_CODE)} END,
           ${canonSql("tls", TLS_CODE)}
    FROM tells_webhook_events
    WHERE kind = 'dlr' AND received_at >= ${from} AND received_at < ${to}
      AND lower(status) IN ('delivered', 'undelivered')`;
}

export interface IngestResult {
  delivered_phones: number;
  rejections: number;
}

export interface IngestMerge {
  /** carrier_rejections rows refreshed at/after this are merged, older replaced. */
  rejections: SQL;
  /** carrier_phone_delivery rows refreshed at/after this are merged, older replaced. */
  delivery: SQL;
}

/** Merge always — the incremental pass, and delivery markers in the daily pass. */
export const NEVER = sql`'-infinity'::timestamptz`;

// Fold the window's receipts to ONE outcome per message and upsert both
// ledgers. `merge`: per table, a row refreshed at/after the given instant is
// MERGED with the new outcome (hard beats soft; latest delivery wins); an older
// row is REPLACED. The incremental pass merges always (NEVER); a rebuild passes
// its own start for the tables it re-derives, so pre-rebuild rows are
// overwritten — which is what lets a code-map change reach history.
export async function ingestWindow(
  dbc: DbOrTx,
  from: SQL,
  to: SQL,
  merge: IngestMerge,
): Promise<IngestResult> {
  const rows = (await dbc.execute(sql`
    WITH ev AS (${classifiedEvents(from, to)}),
    msg AS (
      SELECT ss_id, min(provider) AS provider, bool_or(d) AS d,
             bool_or(cls = 'hard') AS h, bool_or(cls = 'soft') AS s,
             (array_agg(code ORDER BY (cls = 'hard') DESC) FILTER (WHERE cls IS NOT NULL))[1] AS code
      FROM ev WHERE ss_id IS NOT NULL AND (d OR cls IS NOT NULL)
      GROUP BY ss_id
    ),
    o AS (
      SELECT m.*, s.org_id, s.phone, s.sent_at
      FROM msg m JOIN stage_sends s ON s.id = m.ss_id
      WHERE s.status = 'sent' AND s.sent_at IS NOT NULL
    ),
    deliv AS (
      INSERT INTO carrier_phone_delivery AS t (org_id, phone, last_delivered_sent_at, refreshed_at)
      SELECT org_id, phone, max(sent_at), now() FROM o WHERE d GROUP BY org_id, phone
      ON CONFLICT (org_id, phone) DO UPDATE SET
        last_delivered_sent_at = CASE WHEN t.refreshed_at >= ${merge.delivery}
          THEN greatest(t.last_delivered_sent_at, excluded.last_delivered_sent_at)
          ELSE excluded.last_delivered_sent_at END,
        refreshed_at = now()
      RETURNING 1
    ),
    rej AS (
      INSERT INTO carrier_rejections AS t (stage_send_id, org_id, phone, provider, severity, code, sent_at, refreshed_at)
      SELECT ss_id, org_id, phone, provider, CASE WHEN h THEN 'hard' ELSE 'soft' END, code, sent_at, now()
      FROM o WHERE NOT d AND (h OR s)
      ON CONFLICT (stage_send_id) DO UPDATE SET
        severity = CASE WHEN t.refreshed_at >= ${merge.rejections} AND t.severity = 'hard' THEN 'hard' ELSE excluded.severity END,
        code     = CASE WHEN t.refreshed_at >= ${merge.rejections} AND t.severity = 'hard' AND excluded.severity = 'soft'
                        THEN t.code ELSE excluded.code END,
        provider = excluded.provider,
        refreshed_at = now()
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM deliv)::int AS delivered_phones, (SELECT count(*) FROM rej)::int AS rejections
  `)) as unknown as { delivered_phones: number; rejections: number }[];
  return { delivered_phones: Number(rows[0].delivered_phones), rejections: Number(rows[0].rejections) };
}

export interface RefreshResult {
  flagged: number;
  added: number;
  removed: number;
}

// Recompute carrier_rejected_phones from the ledger under each org's current
// thresholds. The ledger is small (~300K rows), so this is a full recompute
// every time — self-healing, and the soft window ages correctly. `orgId`
// limits it to one org (the Settings save path).
export async function refreshFlaggedPhones(dbc: DbOrTx, orgId: string | null): Promise<RefreshResult> {
  const D = CARRIER_REJECTION_DEFAULTS;
  const orgFilter = (col: SQL) => (orgId ? sql`AND ${col} = ${orgId}::uuid` : sql``);
  const rows = (await dbc.execute(sql`
    WITH cfg AS (
      SELECT o.id AS org_id,
             coalesce(s.carrier_rejection_hard_threshold, ${D.hardThreshold}::int)::int AS hard_thr,
             coalesce(s.carrier_rejection_soft_threshold, ${D.softThreshold}::int)::int AS soft_thr,
             coalesce(s.carrier_rejection_soft_window_days, ${D.softWindowDays}::int)::int AS soft_days
      FROM organizations o LEFT JOIN org_settings s ON s.org_id = o.id
      WHERE true ${orgFilter(sql`o.id`)}
    ),
    c AS (
      SELECT r.org_id, r.phone, cfg.hard_thr, cfg.soft_thr,
             count(*) FILTER (WHERE r.severity = 'hard')::int AS hard_count,
             count(*) FILTER (WHERE r.severity = 'soft'
                               AND r.sent_at >= now() - make_interval(days => cfg.soft_days))::int AS soft_count,
             max(r.sent_at) AS last_rejected_at,
             (array_agg(r.code ORDER BY r.sent_at DESC))[1] AS last_code,
             (array_agg(r.provider ORDER BY r.sent_at DESC))[1] AS last_provider
      FROM carrier_rejections r
      JOIN cfg ON cfg.org_id = r.org_id
      LEFT JOIN carrier_phone_delivery d ON d.org_id = r.org_id AND d.phone = r.phone
      WHERE r.sent_at > coalesce(d.last_delivered_sent_at, '-infinity'::timestamptz)
      GROUP BY r.org_id, r.phone, cfg.hard_thr, cfg.soft_thr, cfg.soft_days
    ),
    f AS (SELECT * FROM c WHERE hard_count >= hard_thr OR soft_count >= soft_thr),
    del AS (
      DELETE FROM carrier_rejected_phones p
      WHERE NOT EXISTS (SELECT 1 FROM f WHERE f.org_id = p.org_id AND f.phone = p.phone)
        ${orgFilter(sql`p.org_id`)}
      RETURNING 1
    ),
    up AS (
      INSERT INTO carrier_rejected_phones AS t
        (org_id, phone, hard_count, soft_count, last_rejected_at, last_code, last_provider, flagged_at, evaluated_at)
      SELECT org_id, phone, hard_count, soft_count, last_rejected_at, last_code, last_provider, now(), now() FROM f
      ON CONFLICT (org_id, phone) DO UPDATE SET
        hard_count = excluded.hard_count, soft_count = excluded.soft_count,
        last_rejected_at = excluded.last_rejected_at, last_code = excluded.last_code,
        last_provider = excluded.last_provider, evaluated_at = now()
      RETURNING (xmax = 0) AS inserted
    )
    SELECT (SELECT count(*) FROM up)::int AS flagged,
           (SELECT count(*) FROM up WHERE inserted)::int AS added,
           (SELECT count(*) FROM del)::int AS removed
  `)) as unknown as { flagged: number; added: number; removed: number }[];
  const r = rows[0];
  return { flagged: Number(r.flagged), added: Number(r.added), removed: Number(r.removed) };
}

const ts = (s: string) => sql`${s}::timestamptz`;

async function scalarText(dbc: DbOrTx, q: SQL): Promise<string | null> {
  const rows = (await dbc.execute(q)) as unknown as { v: string | null }[];
  return rows[0]?.v ?? null;
}

export type IncrementalResult =
  | { ran: false; reason: "awaiting_rebuild" }
  | ({ ran: true; from: string; to: string } & IngestResult & RefreshResult);

// The 15-min pass: receipts received in (watermark - OVERLAP, now() - LAG],
// then the flagged-set recompute, then the cursor — ONE transaction, so a
// failure leaves the watermark where it was. Refuses until a FULL rebuild has
// set a watermark: an incremental pass alone would build a ledger with no history.
export async function runIncremental(dbc: typeof Db): Promise<IncrementalResult> {
  return dbc.transaction(async (tx) => {
    const wm = await scalarText(
      tx,
      sql`SELECT watermark::text AS v FROM cron_locks WHERE job_name = ${WATERMARK_JOB}`,
    );
    if (wm == null) return { ran: false, reason: "awaiting_rebuild" } as const;
    const from = (await scalarText(tx, sql`SELECT (${ts(wm)} - ${OVERLAP})::text AS v`))!;
    const to = (await scalarText(tx, sql`SELECT (now() - ${SAFETY_LAG})::text AS v`))!;
    const ingest = await ingestWindow(tx, ts(from), ts(to), { rejections: NEVER, delivery: NEVER });
    const refresh = await refreshFlaggedPhones(tx, null);
    await tx.execute(sql`
      UPDATE cron_locks SET watermark = greatest(watermark, ${ts(to)}) WHERE job_name = ${WATERMARK_JOB}`);
    return { ran: true, from, to, ...ingest, ...refresh } as const;
  });
}

const REBUILD_CHUNK = sql`interval '3 days'`;
// Receipts never change once written and land at most 5 days after the send
// (txr reconcile poll), so every way the incremental ledger can drift — a Tells
// receipt matched late, a failed tick — lies inside this window.
const TRAILING_WINDOW = sql`interval '14 days'`;
// A receipt can be written seconds BEFORE its send's sent_at is stamped
// (lib/reporting/delivery.ts, DLR_EARLY_ARRIVAL_MARGIN); same 1 h margin.
const EARLY_RECEIPT_MARGIN = sql`interval '1 hour'`;

const FULL_START = "carrier-rejections:full-start";
const FULL_TO = "carrier-rejections:full-to";
const FULL_CURSOR = "carrier-rejections:full-cursor";

// One chunk in its own transaction, so no statement nears the 120 s server-wide
// statement_timeout. A full rebuild advances its persisted cursor in the SAME
// transaction, so a resumed run never skips or repeats a committed chunk.
async function ingestChunk(dbc: typeof Db, from: string, to: string, merge: IngestMerge, cursorJob?: string) {
  return dbc.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    const r = await ingestWindow(tx, ts(from), ts(to), merge);
    if (cursorJob) {
      await tx.execute(sql`UPDATE cron_locks SET watermark = ${ts(to)} WHERE job_name = ${cursorJob}`);
    }
    return r;
  });
}

async function nextChunkEnd(dbc: typeof Db, cursor: string, to: string): Promise<string> {
  return (await scalarText(dbc, sql`SELECT least(${ts(cursor)} + ${REBUILD_CHUNK}, ${ts(to)})::text AS v`))!;
}

export type TrailingRebuildResult =
  | { ran: false; reason: "awaiting_full_rebuild" }
  | ({
      ran: true;
      from: string;
      to: string;
      chunks: number;
      rejections_upserted: number;
      stale_rejections_removed: number;
      elapsed_ms: number;
    } & RefreshResult);

// The DAILY rebuild (owner: "daily full rebuild of the flagged set"). Re-derives
// the ledger from the last 14 days of receipts — where every incremental drift
// source lies — then recomputes the WHOLE flagged set. Re-reading all history
// every night was measured at ~34 chunks x ~20 s (2026-10-24) and grows daily;
// that is runFullRebuild's job, on demand. Rejections are REPLACED (a
// re-derived message reflects the current code map) and rejection rows for
// messages sent inside the window that it did not re-derive are deleted.
// Delivery markers are MERGED: a marker set by a message older than the window
// must not be lowered to the window's own maximum.
export async function runTrailingRebuild(dbc: typeof Db): Promise<TrailingRebuildResult> {
  const started = Date.now();
  const wm = await scalarText(dbc, sql`SELECT watermark::text AS v FROM cron_locks WHERE job_name = ${WATERMARK_JOB}`);
  if (wm == null) return { ran: false, reason: "awaiting_full_rebuild" };
  const runStart = (await scalarText(dbc, sql`SELECT now()::text AS v`))!;
  const to = (await scalarText(dbc, sql`SELECT (now() - ${SAFETY_LAG})::text AS v`))!;
  const from = (await scalarText(dbc, sql`SELECT (now() - ${TRAILING_WINDOW})::text AS v`))!;

  let chunks = 0;
  let upserted = 0;
  for (let cursor = from; cursor !== to; chunks++) {
    const next = await nextChunkEnd(dbc, cursor, to);
    upserted += (await ingestChunk(dbc, cursor, next, { rejections: ts(runStart), delivery: NEVER })).rejections;
    cursor = next;
  }

  const fin = await dbc.transaction(async (tx) => {
    const stale = (await tx.execute(sql`
      WITH r AS (
        DELETE FROM carrier_rejections
        WHERE refreshed_at < ${ts(runStart)} AND sent_at >= ${ts(from)}::timestamptz + ${EARLY_RECEIPT_MARGIN}
        RETURNING 1)
      SELECT count(*)::int AS r FROM r`)) as unknown as { r: number }[];
    const refresh = await refreshFlaggedPhones(tx, null);
    await tx.execute(sql`
      UPDATE cron_locks SET watermark = greatest(watermark, ${ts(to)}) WHERE job_name = ${WATERMARK_JOB}`);
    return { stale: Number(stale[0].r), refresh };
  });
  return {
    ran: true,
    from,
    to,
    chunks,
    rejections_upserted: upserted,
    stale_rejections_removed: fin.stale,
    ...fin.refresh,
    elapsed_ms: Date.now() - started,
  };
}

export type FullRebuildResult =
  | { complete: false; run_start: string; cursor: string; to: string; chunks: number; elapsed_ms: number }
  | ({
      complete: true;
      run_start: string;
      to: string;
      chunks: number;
      stale_rejections_removed: number;
      stale_deliveries_removed: number;
      elapsed_ms: number;
    } & RefreshResult);

// The FULL-HISTORY rebuild: the initial backfill, and the repair after a
// code-map change. Re-derives both ledgers from every receipt ever received, in
// 3-day chunks, each committing a persisted cursor. A call that reaches its
// time budget returns {complete:false} and the next call RESUMES — call until
// complete. Every call runs at least one chunk. Only when the cursor reaches the
// run's end does it delete every row the run did not re-derive, ANALYZE,
// recompute the flagged set and set the incremental watermark; until then the
// previous ledger stays in place, merged forward, never truncated. This is the
// only path that CREATES the watermark, so the incremental and daily passes
// refuse until one full rebuild has completed.
export async function runFullRebuild(dbc: typeof Db, opts: { budgetMs: number }): Promise<FullRebuildResult> {
  const started = Date.now();
  const read = (job: string) =>
    scalarText(dbc, sql`SELECT watermark::text AS v FROM cron_locks WHERE job_name = ${job}`);
  let runStart = await read(FULL_START);
  let to = await read(FULL_TO);
  let cursor = await read(FULL_CURSOR);
  if (runStart == null || to == null || cursor == null) {
    runStart = (await scalarText(dbc, sql`SELECT now()::text AS v`))!;
    to = (await scalarText(dbc, sql`SELECT (now() - ${SAFETY_LAG})::text AS v`))!;
    cursor = (await scalarText(dbc, sql`
      SELECT coalesce(least(
        (SELECT min(received_at) FROM textrequest_dlr_events),
        (SELECT min(received_at) FROM ahoi_dlr_events),
        (SELECT min(received_at) FROM tells_webhook_events WHERE kind = 'dlr')), ${ts(to)})::text AS v`))!;
    await dbc.execute(sql`
      INSERT INTO cron_locks (job_name, watermark)
      VALUES (${FULL_START}, ${ts(runStart)}), (${FULL_TO}, ${ts(to)}), (${FULL_CURSOR}, ${ts(cursor)})
      ON CONFLICT (job_name) DO UPDATE SET watermark = excluded.watermark`);
  }
  const start = runStart;
  const end = to;

  let chunks = 0;
  while (cursor !== end) {
    if (chunks > 0 && Date.now() - started > opts.budgetMs) {
      return { complete: false, run_start: start, cursor, to: end, chunks, elapsed_ms: Date.now() - started };
    }
    const next = await nextChunkEnd(dbc, cursor, end);
    await ingestChunk(dbc, cursor, next, { rejections: ts(start), delivery: ts(start) }, FULL_CURSOR);
    cursor = next;
    chunks++;
  }

  const fin = await dbc.transaction(async (tx) => {
    const stale = (await tx.execute(sql`
      WITH r AS (DELETE FROM carrier_rejections WHERE refreshed_at < ${ts(start)} RETURNING 1),
           d AS (DELETE FROM carrier_phone_delivery WHERE refreshed_at < ${ts(start)} RETURNING 1)
      SELECT (SELECT count(*) FROM r)::int AS r, (SELECT count(*) FROM d)::int AS d`)) as unknown as {
      r: number;
      d: number;
    }[];
    // Real row stats before the recompute joins them. After the first bulk load
    // the tables have none, and a mis-estimated join here is the 1M x 700K
    // nested loop the verify script hit (scripts/verify-carrier-rejections.ts).
    await tx.execute(sql`ANALYZE carrier_rejections, carrier_phone_delivery`);
    const refresh = await refreshFlaggedPhones(tx, null);
    await tx.execute(sql`
      INSERT INTO cron_locks (job_name, watermark) VALUES (${WATERMARK_JOB}, ${ts(end)})
      ON CONFLICT (job_name) DO UPDATE
        SET watermark = greatest(coalesce(cron_locks.watermark, '-infinity'::timestamptz), excluded.watermark)`);
    await tx.execute(sql`DELETE FROM cron_locks WHERE job_name IN (${FULL_START}, ${FULL_TO}, ${FULL_CURSOR})`);
    return { staleR: Number(stale[0].r), staleD: Number(stale[0].d), refresh };
  });

  return {
    complete: true,
    run_start: start,
    to: end,
    chunks,
    stale_rejections_removed: fin.staleR,
    stale_deliveries_removed: fin.staleD,
    ...fin.refresh,
    elapsed_ms: Date.now() - started,
  };
}
