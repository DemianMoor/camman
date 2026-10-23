import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { HUMAN_CLICK } from "@/lib/reporting/counted-clickers";

// FILL stage_send_lifecycle.last_click_at ON WARM STAMPS (migration 0220).
//
// The Lifecycle report splits Warm into 31–60 / 61–120 days since the
// contact's last human click at send time. Stamps written since 2026-10-23
// carry last_click_at (lib/engagement/lifecycle-stamp.ts); older warm stamps
// have NULL and show as "Warm (no click time)" until this runs. Only WARM
// stamps are touched, and only where last_click_at IS NULL — a live value is
// never overwritten, and a re-run writes nothing.
//
// THE VALUE is the contact's latest HUMAN click at or before the send's
// sent_at — "days since the last human click at send time", as the report
// states it.
//
// ⚠️ ONE TRANSACTION, built for the quiet window: the warm stamps are joined
// to their sends once, and the contacts' human clicks are collected once, so
// the I/O is a few large reads rather than a probe per row. ON COMMIT DROP temp
// tables, so it is safe on the transaction pooler. Callers: the script
// scripts/backfill-lifecycle-last-click.ts and the one-shot quiet-window cron.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WarmLastClickResult {
  warm_stamps: number;
  no_click_found: number;
  warm_31_60: number;
  warm_61_120: number;
  /** Warm at evaluation but ≤ 30 days at sent_at (still Warm; lands in 31–60). */
  within_30d: number;
  /** Warm at evaluation but > 120 days at sent_at (still Warm; lands in 61–120). */
  beyond_120d: number;
  written: number;
}

export async function backfillWarmLastClick(
  tx: Tx,
  opts: { orgId: string; apply: boolean; splitDays: number },
): Promise<WarmLastClickResult> {
  const org = sql`${opts.orgId}::uuid`;
  await tx.execute(sql`SET LOCAL statement_timeout = '700s'`);
  await tx.execute(sql`SET LOCAL work_mem = '256MB'`);
  await tx.execute(sql`
    CREATE TEMP TABLE lb_target ON COMMIT DROP AS
    SELECT l.stage_send_id, ss.contact_id, ss.sent_at
    FROM stage_send_lifecycle l
    JOIN stage_sends ss ON ss.id = l.stage_send_id
    WHERE l.org_id = ${org} AND l.status = 'warm' AND l.last_click_at IS NULL
      AND ss.status = 'sent' AND ss.sent_at IS NOT NULL`);
  await tx.execute(sql`ANALYZE lb_target`);
  await tx.execute(sql`
    CREATE TEMP TABLE lb_clicks ON COMMIT DROP AS
    SELECT lk.contact_id, ck.clicked_at
    FROM clicks ck
    JOIN links lk ON lk.id = ck.link_id
    WHERE ck.org_id = ${org} AND ${HUMAN_CLICK}
      AND lk.contact_id IN (SELECT DISTINCT contact_id FROM lb_target)`);
  await tx.execute(sql`CREATE INDEX ON lb_clicks (contact_id, clicked_at)`);
  await tx.execute(sql`ANALYZE lb_clicks`);
  await tx.execute(sql`
    CREATE TEMP TABLE lb_result ON COMMIT DROP AS
    SELECT t.stage_send_id, t.sent_at,
           (SELECT max(c.clicked_at) FROM lb_clicks c
            WHERE c.contact_id = t.contact_id AND c.clicked_at <= t.sent_at) AS lca
    FROM lb_target t`);
  await tx.execute(sql`ANALYZE lb_result`);

  const split = sql.raw(String(Math.trunc(opts.splitDays)));
  const s = ((await tx.execute(sql`
    SELECT count(*)::int AS warm_stamps,
           count(*) FILTER (WHERE lca IS NULL)::int AS no_click_found,
           count(*) FILTER (WHERE lca >= sent_at - make_interval(days => ${split}))::int AS warm_31_60,
           count(*) FILTER (WHERE lca < sent_at - make_interval(days => ${split}))::int AS warm_61_120,
           count(*) FILTER (WHERE lca >= sent_at - interval '30 days')::int AS within_30d,
           count(*) FILTER (WHERE lca < sent_at - interval '120 days')::int AS beyond_120d
    FROM lb_result`)) as unknown as Omit<WarmLastClickResult, "written">[])[0];

  let written = 0;
  if (opts.apply) {
    // Counted in SQL: RETURNING ~490K rows to Node would be pure overhead.
    const upd = (await tx.execute(sql`
      WITH u AS (
        UPDATE stage_send_lifecycle l SET last_click_at = r.lca
        FROM lb_result r
        WHERE l.stage_send_id = r.stage_send_id
          AND r.lca IS NOT NULL AND l.last_click_at IS NULL
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM u`)) as unknown as { n: number }[];
    written = Number(upd[0]?.n ?? 0);
  }
  return {
    warm_stamps: Number(s.warm_stamps),
    no_click_found: Number(s.no_click_found),
    warm_31_60: Number(s.warm_31_60),
    warm_61_120: Number(s.warm_61_120),
    within_30d: Number(s.within_30d),
    beyond_120d: Number(s.beyond_120d),
    written,
  };
}
