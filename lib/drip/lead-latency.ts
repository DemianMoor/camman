import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Lead-to-send latency (drip poke chain, 0206). ONE definition, read by the
// per-minute log line, the hourly intake digest, the regression alert and
// scripts/lead-to-send-latency.ts — so the number the alert fires on is the
// number the owner reads.
//
//   received  = lead_inbox.received_at   (set when the intake API stored it)
//   looked up = lead_inbox.processed_at  (enrichment finished: lookup + contact)
//   routed    = drip_journeys.routed_at
//   queued    = drip_journeys.first_send_at (the pending stage_sends row)
//   sent      = stage_sends.sent_at       (handed to the provider)
//
// ⚠️ ONLY LEADS ROUTED ON ARRIVAL COUNT: carried_days = 0 and never deferred
// (lead_events.drip_recheck_at IS NULL). A lead that waited on a paused or
// capped campaign waited by design; counting it would make the figure — and
// the alert — measure campaign settings instead of the pipeline. Window waits
// (stage outside its send window) DO count: the journey is routed and waiting.
//
// Windowed by stage_sends.sent_at, driven from stage_sends_org_sent_at_idx;
// drip_journeys is reached through drip_journeys_org_contact_idx. A full ET
// day measured 0.53 s on prod (2026-10-12, 16,864 leads).

export interface LeadLatency {
  n: number;
  p50Sec: number | null;
  p95Sec: number | null;
  /** Median of each hop, seconds. */
  stepP50Sec: {
    lookup: number | null; // received → looked up
    route: number | null; // looked up → routed
    queue: number | null; // routed → queued
    send: number | null; // queued → sent
  };
}

export async function leadToSendLatency(
  dbc: DbOrTx,
  { orgId, from, to }: { orgId: string; from: Date; to: Date },
): Promise<LeadLatency> {
  const rows = (await dbc.execute(sql`
    SELECT count(*)::int AS n,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM ss.sent_at - li.received_at)) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ss.sent_at - li.received_at)) AS p95,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM li.processed_at - li.received_at)) AS lookup,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM dj.routed_at - li.processed_at)) AS route,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM dj.first_send_at - dj.routed_at)) AS queue,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM ss.sent_at - dj.first_send_at)) AS send
    FROM stage_sends ss
    JOIN campaigns c      ON c.id = ss.campaign_id AND c.type = 'drip'
    JOIN drip_journeys dj ON dj.org_id = ss.org_id AND dj.contact_id = ss.contact_id
                         AND dj.first_send_id = ss.id
    JOIN lead_events e    ON e.id = dj.lead_event_id
    JOIN lead_inbox li    ON li.id = e.inbox_id
    WHERE ss.org_id = ${orgId}::uuid
      AND ss.status = 'sent'
      AND ss.sent_at >= ${from.toISOString()}::timestamptz
      AND ss.sent_at <  ${to.toISOString()}::timestamptz
      AND COALESCE(dj.carried_days, 0) = 0
      AND e.drip_recheck_at IS NULL
      AND e.sandbox = false
  `)) as unknown as Record<string, string | number | null>[];
  const r = rows[0] ?? {};
  const num = (v: string | number | null | undefined) => (v == null ? null : Math.round(Number(v)));
  return {
    n: Number(r.n ?? 0),
    p50Sec: num(r.p50),
    p95Sec: num(r.p95),
    stepP50Sec: { lookup: num(r.lookup), route: num(r.route), queue: num(r.queue), send: num(r.send) },
  };
}

/** "45s" under two minutes, "4.3m" above. */
export function formatLatency(sec: number | null): string {
  if (sec == null) return "n/a";
  return sec < 120 ? `${sec}s` : `${(sec / 60).toFixed(1)}m`;
}
