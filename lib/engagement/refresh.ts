import { sql, type SQL } from "drizzle-orm";

import { ENGAGEMENT_STATUSES, type EngagementStatus } from "@/lib/engagement/constants";
import { ENGAGEMENT_VALUE_COLUMNS, evaluationSelectSql } from "@/lib/engagement/status-sql";
import { createThresholdTempTables } from "@/lib/engagement/thresholds-sql";
import { HUMAN_CLICK } from "@/lib/reporting/counted-clickers";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// CONTACT ENGAGEMENT REFRESH (migration 0187; spec §5)
//
// The ONLY writer of contact_engagement, contact_engagement_transitions and
// contact_offer_campaigns. It runs inside the CALLER's transaction, because
// every stage is an ON COMMIT DROP temp table, ANALYZEd so the planner sees real
// cardinalities rather than the ~200-row guess a set-op gets (the same lesson as
// the audience snapshot — CLAUDE.md §10b).
//
//   full         recount every contact of the org: one human-click pass and two
//                stage_sends passes, then evaluate everyone.
//   incremental  recount only contacts with a send or a newly scored human click
//                since `since`, and additionally evaluate rows whose time_due_at
//                has passed — hot→warm, warm→cold and freeze→suppressed need no
//                event, so they must not wait for the nightly run.
//
// Per-contact recounts reach one contact's sends through
// stage_sends_org_phone_sent_idx (org_id, phone, sent_at) WHERE status='sent' —
// the only index that does, since stage_sends has none leading with contact_id.
// Prod carried 0 phone mismatches on 2026-09-22, and the nightly full recount
// (which joins by contact_id) is the backstop if that ever drifts.
//
// Recounts always read a contact's FULL history, so re-reading an overlapping
// window is idempotent. Only rows whose values actually changed are written.
// `dryRun` computes everything and skips every write to a real table.
//
// NOT in the send loop: the drain only ever READS contact_engagement.
// =============================================================================

export type RefreshMode = "full" | "incremental";

export interface RefreshOptions {
  mode: RefreshMode;
  /** Compute everything, write nothing to a real table. */
  dryRun: boolean;
  /** Evaluation instant. Default: the transaction's now(). Tests pass a fixed one. */
  asOf?: Date;
  /** Incremental only: recount contacts touched since here (the caller subtracts the overlap). */
  since?: Date;
  /** Transition reason for a contact's first row. The one-off backfill passes "backfill". */
  initialReason?: "backfill" | "first_seen";
  /** Also compute the per-group and opted-out breakdowns (the dry-run report). */
  withReport?: boolean;
}

export interface GroupBreakdownRow {
  group_id: number;
  name: string;
  counts: Record<EngagementStatus, number>;
}

export interface RefreshResult {
  mode: RefreshMode;
  dryRun: boolean;
  /** Contacts whose facts were recounted from history. */
  recounted: number;
  /** Contacts whose status was evaluated (recounted ∪ time-due). */
  evaluated: number;
  statusCounts: Record<EngagementStatus, number>;
  /** "cold→freeze": n, and "∅→new" for a contact's first row. */
  transitions: Record<string, number>;
  rowsWritten: number;
  transitionsWritten: number;
  offerRowsWritten: number;
  offerRowsDeleted: number;
  /** Evaluated freeze contacts whose last message is still inside their cadence. */
  freezeNotDue: number;
  groups?: GroupBreakdownRow[];
  optedOutByStatus?: Record<EngagementStatus, number>;
  phaseMs: Record<string, number>;
  durationMs: number;
}

const zeroCounts = (): Record<EngagementStatus, number> =>
  Object.fromEntries(ENGAGEMENT_STATUSES.map((s) => [s, 0])) as Record<EngagementStatus, number>;

/** The value tuple both the change count and the upsert's WHERE compare. */
const tuple = (alias: string): SQL =>
  sql.raw(`(${ENGAGEMENT_VALUE_COLUMNS.map((c) => `${alias}.${c}`).join(", ")})`);

export async function refreshContactEngagement(
  dbc: DbOrTx,
  orgId: string,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const started = Date.now();
  if (opts.mode === "incremental" && !opts.since) {
    throw new Error("refreshContactEngagement: an incremental run needs `since`");
  }
  const phaseMs: Record<string, number> = {};
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const r = await fn();
    phaseMs[name] = Date.now() - t;
    return r;
  };
  const q = async <T>(query: SQL): Promise<T[]> => (await dbc.execute(query)) as unknown as T[];
  const org = sql`${orgId}::uuid`;
  const asOf = opts.asOf ? sql`${opts.asOf.toISOString()}::timestamptz` : sql`now()`;
  const full = opts.mode === "full";

  // ── 1. Who gets recounted ────────────────────────────────────────────────
  await phase("touched", async () => {
    await dbc.execute(sql`CREATE TEMP TABLE eng_touched (contact_id uuid PRIMARY KEY) ON COMMIT DROP`);
    if (full) {
      await dbc.execute(sql`INSERT INTO eng_touched SELECT id FROM contacts WHERE org_id = ${org}`);
    } else {
      const since = sql`${opts.since!.toISOString()}::timestamptz`;
      await dbc.execute(sql`
        INSERT INTO eng_touched
        SELECT contact_id FROM stage_sends
         WHERE sent_at >= ${since} AND sent_at <= ${asOf} AND status = 'sent' AND org_id = ${org}
        UNION
        SELECT l.contact_id FROM clicks ck JOIN links l ON l.id = ck.link_id
         WHERE ${HUMAN_CLICK} AND ck.scored_at >= ${since} AND ck.scored_at <= ${asOf}
           AND ck.org_id = ${org}`);
    }
    await dbc.execute(sql`ANALYZE eng_touched`);
  });

  // The sends a recount reads. Full: the org's whole table in one pass.
  // Incremental: one index probe per touched contact.
  const sendsFrom = full
    ? sql`FROM stage_sends ss`
    : sql`FROM eng_touched t
          JOIN contacts c ON c.id = t.contact_id AND c.org_id = ${org}
          JOIN stage_sends ss ON ss.org_id = ${org} AND ss.phone = c.phone_number AND ss.contact_id = t.contact_id`;

  // ── 2. Human clicks (first / last), as of the evaluation instant ─────────
  await phase("clicks", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_clicks ON COMMIT DROP AS
      SELECT l.contact_id, min(ck.clicked_at) AS first_click_at, max(ck.clicked_at) AS last_click_at
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      ${full ? sql`` : sql`JOIN eng_touched t ON t.contact_id = l.contact_id`}
      WHERE ${HUMAN_CLICK} AND ck.org_id = ${org}
        AND ck.clicked_at <= ${asOf} AND ck.scored_at <= ${asOf}
      GROUP BY l.contact_id`);
    await dbc.execute(sql`ANALYZE eng_clicks`);
  });

  // ── 3. Send facts, relative to the last click and the stored freeze clock ─
  await phase("sends", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_facts ON COMMIT DROP AS
      SELECT ss.contact_id,
             count(*)::int AS msgs_total,
             count(*) FILTER (WHERE cl.last_click_at IS NULL OR ss.sent_at > cl.last_click_at)::int AS msgs_since_click,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '7 days')::int AS msgs_7d,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '14 days')::int AS msgs_14d,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '30 days')::int AS msgs_30d,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '90 days')::int AS msgs_90d,
             min(ss.sent_at) AS first_sent_at,
             max(ss.sent_at) AS last_sent_at,
             min(ss.sent_at) FILTER (WHERE ss.sent_at > p.freeze_entered_at) AS calc_freeze_started_at,
             count(*) FILTER (WHERE ss.sent_at > p.freeze_entered_at)::int AS calc_freeze_msgs
      ${sendsFrom}
      LEFT JOIN eng_clicks cl ON cl.contact_id = ss.contact_id
      LEFT JOIN contact_engagement p ON p.contact_id = ss.contact_id
      WHERE ss.org_id = ${org} AND ss.status = 'sent' AND ss.sent_at <= ${asOf}
      GROUP BY ss.contact_id`);
    await dbc.execute(sql`ANALYZE eng_facts`);
  });

  // ── 4. Per (contact, offer, campaign) exposure — ClickUp 869f53efz's data ─
  await phase("offers", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_offer ON COMMIT DROP AS
      SELECT ss.contact_id, ca.offer_id, ss.campaign_id,
             min(ss.sent_at) AS first_sent_at, max(ss.sent_at) AS last_sent_at, count(*)::int AS messages
      ${sendsFrom}
      JOIN campaigns ca ON ca.id = ss.campaign_id AND ca.org_id = ${org}
      WHERE ss.org_id = ${org} AND ss.status = 'sent' AND ss.sent_at <= ${asOf} AND ca.offer_id IS NOT NULL
      GROUP BY 1, 2, 3`);
    await dbc.execute(sql`ANALYZE eng_offer`);
  });

  // ── 5. Effective thresholds ──────────────────────────────────────────────
  // The org row (or the code defaults), then the STRICTEST value across the
  // contact's ACTIVE groups — ONE resolution, shared with the settings preview.
  await phase("thresholds", () => createThresholdTempTables(dbc, orgId));

  // ── 6. The evaluation set and its inputs ─────────────────────────────────
  await phase("evaluate", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_set ON COMMIT DROP AS
      SELECT contact_id FROM eng_touched
      ${
        full
          ? sql``
          : sql`UNION SELECT contact_id FROM contact_engagement
                 WHERE org_id = ${org} AND time_due_at <= ${asOf}`
      }`);
    await dbc.execute(sql`ANALYZE eng_set`);
    // A recounted contact takes the fresh facts; everyone else keeps their stored ones.
    const pick = (fresh: SQL, stored: SQL) =>
      sql`CASE WHEN t.contact_id IS NOT NULL THEN ${fresh} ELSE ${stored} END`;
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_eval ON COMMIT DROP AS
      SELECT s.contact_id,
             p.status AS prev_status,
             p.status_changed_at AS prev_status_changed_at,
             p.freeze_entered_at AS prev_freeze_entered_at,
             ${pick(sql`coalesce(f.msgs_total, 0)`, sql`p.msgs_total`)} AS msgs_total,
             ${pick(sql`coalesce(f.msgs_since_click, 0)`, sql`p.msgs_since_click`)} AS msgs_since_click,
             ${pick(sql`coalesce(f.msgs_7d, 0)`, sql`p.msgs_7d`)} AS msgs_7d,
             ${pick(sql`coalesce(f.msgs_14d, 0)`, sql`p.msgs_14d`)} AS msgs_14d,
             ${pick(sql`coalesce(f.msgs_30d, 0)`, sql`p.msgs_30d`)} AS msgs_30d,
             ${pick(sql`coalesce(f.msgs_90d, 0)`, sql`p.msgs_90d`)} AS msgs_90d,
             ${pick(sql`f.first_sent_at`, sql`p.first_sent_at`)} AS first_sent_at,
             ${pick(sql`f.last_sent_at`, sql`p.last_sent_at`)} AS last_sent_at,
             ${pick(sql`cl.first_click_at`, sql`p.first_click_at`)} AS first_click_at,
             ${pick(sql`cl.last_click_at`, sql`p.last_click_at`)} AS last_click_at,
             ${pick(sql`f.calc_freeze_started_at`, sql`p.freeze_started_at`)} AS calc_freeze_started_at,
             ${pick(sql`coalesce(f.calc_freeze_msgs, 0)`, sql`p.freeze_msgs`)} AS calc_freeze_msgs,
             o.hot_days, o.warm_days,
             coalesce(g.freeze_after_messages, o.freeze_after_messages) AS freeze_after_messages,
             coalesce(g.freeze_cadence_days, o.freeze_cadence_days) AS freeze_cadence_days,
             coalesce(g.suppress_after_days, o.suppress_after_days) AS suppress_after_days,
             coalesce(g.suppress_min_freeze_messages, o.suppress_min_freeze_messages) AS suppress_min_freeze_messages,
             coalesce(g.override_group_ids, '{}'::int[]) AS override_group_ids
      FROM eng_set s
      LEFT JOIN eng_touched t ON t.contact_id = s.contact_id
      LEFT JOIN eng_facts f ON f.contact_id = s.contact_id
      LEFT JOIN eng_clicks cl ON cl.contact_id = s.contact_id
      LEFT JOIN contact_engagement p ON p.contact_id = s.contact_id
      LEFT JOIN eng_grp_thr g ON g.contact_id = s.contact_id
      CROSS JOIN eng_org_thr o`);
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_final ON COMMIT DROP AS
      ${evaluationSelectSql(sql`eng_eval`, asOf, opts.initialReason ?? "first_seen")}`);
    await dbc.execute(sql`ANALYZE eng_final`);
  });

  // ── 7. What changed — the same numbers whether or not we write ───────────
  const statusCounts = zeroCounts();
  for (const r of await q<{ status: EngagementStatus; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM eng_final GROUP BY 1`)) {
    statusCounts[r.status] = Number(r.n);
  }
  const transitions: Record<string, number> = {};
  for (const r of await q<{ from_status: string | null; to_status: string; n: number }>(sql`
    SELECT prev_status AS from_status, status AS to_status, count(*)::int AS n
    FROM eng_final WHERE prev_status IS DISTINCT FROM status GROUP BY 1, 2`)) {
    transitions[`${r.from_status ?? "∅"}→${r.to_status}`] = Number(r.n);
  }
  const [counts] = await q<{
    evaluated: number; recounted: number; changed: number;
    freeze_not_due: number; offer_changed: number; offer_gone: number;
  }>(sql`
    SELECT (SELECT count(*) FROM eng_final)::int AS evaluated,
           (SELECT count(*) FROM eng_touched)::int AS recounted,
           (SELECT count(*) FROM eng_final f
             LEFT JOIN contact_engagement ce ON ce.contact_id = f.contact_id
             WHERE ce.contact_id IS NULL OR ${tuple("ce")} IS DISTINCT FROM ${tuple("f")})::int AS changed,
           (SELECT count(*) FROM eng_final
             WHERE status = 'freeze'
               AND last_sent_at > ${asOf} - make_interval(days => freeze_cadence_days))::int AS freeze_not_due,
           (SELECT count(*) FROM eng_offer e
             LEFT JOIN contact_offer_campaigns oc
               ON oc.contact_id = e.contact_id AND oc.offer_id = e.offer_id AND oc.campaign_id = e.campaign_id
             WHERE oc.contact_id IS NULL
                OR (oc.first_sent_at, oc.last_sent_at, oc.messages)
                   IS DISTINCT FROM (e.first_sent_at, e.last_sent_at, e.messages))::int AS offer_changed,
           (SELECT count(*) FROM contact_offer_campaigns oc
             WHERE oc.org_id = ${org} AND oc.contact_id IN (SELECT contact_id FROM eng_touched)
               AND NOT EXISTS (SELECT 1 FROM eng_offer e
                                WHERE e.contact_id = oc.contact_id AND e.offer_id = oc.offer_id
                                  AND e.campaign_id = oc.campaign_id))::int AS offer_gone`);

  let rowsWritten = Number(counts.changed);
  let transitionsWritten = Object.values(transitions).reduce((a, b) => a + b, 0);
  let offerRowsWritten = Number(counts.offer_changed);
  let offerRowsDeleted = Number(counts.offer_gone);

  // ── 8. Write (skipped entirely in a dry run) ─────────────────────────────
  if (!opts.dryRun) {
    await phase("write", async () => {
      const setList = sql.raw(
        [...ENGAGEMENT_VALUE_COLUMNS, "status_changed_at", "computed_at"]
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", "),
      );
      const [w] = await q<{ n: number }>(sql`
        WITH w AS (
          INSERT INTO contact_engagement AS ce (
            contact_id, org_id, status, status_changed_at,
            msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
            first_sent_at, last_sent_at, first_click_at, last_click_at,
            freeze_entered_at, freeze_started_at, freeze_msgs, freeze_cadence_days,
            thresholds, time_due_at, computed_at)
          SELECT f.contact_id, ${org}, f.status,
                 CASE WHEN f.prev_status IS DISTINCT FROM f.status THEN ${asOf} ELSE f.prev_status_changed_at END,
                 f.msgs_total, f.msgs_since_click, f.msgs_7d, f.msgs_14d, f.msgs_30d, f.msgs_90d,
                 f.first_sent_at, f.last_sent_at, f.first_click_at, f.last_click_at,
                 f.freeze_entered_at, f.freeze_started_at, f.freeze_msgs, f.freeze_cadence_days,
                 f.thresholds, f.time_due_at, ${asOf}
          FROM eng_final f
          ON CONFLICT (contact_id) DO UPDATE SET ${setList}
          WHERE ${tuple("ce")} IS DISTINCT FROM ${tuple("EXCLUDED")}
          RETURNING 1)
        SELECT count(*)::int AS n FROM w`);
      rowsWritten = Number(w.n);

      const [tw] = await q<{ n: number }>(sql`
        WITH w AS (
          INSERT INTO contact_engagement_transitions
            (org_id, contact_id, from_status, to_status, reason, thresholds, created_at)
          SELECT ${org}, contact_id, prev_status, status, reason, thresholds, ${asOf}
          FROM eng_final WHERE prev_status IS DISTINCT FROM status
          RETURNING 1)
        SELECT count(*)::int AS n FROM w`);
      transitionsWritten = Number(tw.n);

      const [ow] = await q<{ n: number }>(sql`
        WITH w AS (
          INSERT INTO contact_offer_campaigns AS oc
            (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
          SELECT ${org}, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages
          FROM eng_offer
          ON CONFLICT (contact_id, offer_id, campaign_id) DO UPDATE
            SET first_sent_at = EXCLUDED.first_sent_at,
                last_sent_at = EXCLUDED.last_sent_at,
                messages = EXCLUDED.messages
          WHERE (oc.first_sent_at, oc.last_sent_at, oc.messages)
                IS DISTINCT FROM (EXCLUDED.first_sent_at, EXCLUDED.last_sent_at, EXCLUDED.messages)
          RETURNING 1)
        SELECT count(*)::int AS n FROM w`);
      offerRowsWritten = Number(ow.n);

      const [od] = await q<{ n: number }>(sql`
        WITH d AS (
          DELETE FROM contact_offer_campaigns oc
          WHERE oc.org_id = ${org} AND oc.contact_id IN (SELECT contact_id FROM eng_touched)
            AND NOT EXISTS (SELECT 1 FROM eng_offer e
                             WHERE e.contact_id = oc.contact_id AND e.offer_id = oc.offer_id
                               AND e.campaign_id = oc.campaign_id)
          RETURNING 1)
        SELECT count(*)::int AS n FROM d`);
      offerRowsDeleted = Number(od.n);
    });
  }

  // ── 9. The dry-run report's breakdowns ───────────────────────────────────
  let groups: GroupBreakdownRow[] | undefined;
  let optedOutByStatus: Record<EngagementStatus, number> | undefined;
  if (opts.withReport) {
    const byGroup = new Map<number, GroupBreakdownRow>();
    for (const r of await q<{ group_id: number; name: string; status: EngagementStatus; n: number }>(sql`
      SELECT g.id::int AS group_id, g.name, f.status, count(*)::int AS n
      FROM eng_final f
      JOIN contact_contact_groups ccg ON ccg.contact_id = f.contact_id AND ccg.org_id = ${org}
      JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 0, '(no active group)', f.status, count(*)::int
      FROM eng_final f
      WHERE NOT EXISTS (
        SELECT 1 FROM contact_contact_groups ccg
        JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
        WHERE ccg.contact_id = f.contact_id AND ccg.org_id = ${org})
      GROUP BY 3`)) {
      const id = Number(r.group_id);
      const g = byGroup.get(id) ?? { group_id: id, name: r.name, counts: zeroCounts() };
      g.counts[r.status] = Number(r.n);
      byGroup.set(id, g);
    }
    groups = [...byGroup.values()].sort((a, b) => a.group_id - b.group_id);
    optedOutByStatus = zeroCounts();
    for (const r of await q<{ status: EngagementStatus; n: number }>(sql`
      SELECT f.status, count(*)::int AS n FROM eng_final f
      WHERE EXISTS (SELECT 1 FROM opt_outs o WHERE o.org_id = ${org} AND o.contact_id = f.contact_id)
      GROUP BY 1`)) {
      optedOutByStatus[r.status] = Number(r.n);
    }
  }

  return {
    mode: opts.mode,
    dryRun: opts.dryRun,
    recounted: Number(counts.recounted),
    evaluated: Number(counts.evaluated),
    statusCounts,
    transitions,
    rowsWritten,
    transitionsWritten,
    offerRowsWritten,
    offerRowsDeleted,
    freezeNotDue: Number(counts.freeze_not_due),
    groups,
    optedOutByStatus,
    phaseMs,
    durationMs: Date.now() - started,
  };
}
