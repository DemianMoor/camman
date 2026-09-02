import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { createAdminClient } from "@/lib/supabase/admin";

// Daily audit digest (869et3vm1 Phase 4).
//
// ONE message per day per org: per-actor action counts, guardrail events, and
// the pending deletion queue. The point is a single glance that answers "what
// happened yesterday and is anything waiting on me" — the individual real-time
// alerts already cover "something needs attention right now".
//
// ⚠️ OFF THE SEND PATH. Its own cron entry, reading audit_log and
// deletion_requests only. It never touches stage_sends, materialize or the drain.
//
// The window is the previous ET calendar day, matching every other daily
// boundary in this codebase (CAMPAIGN_TIMEZONE).

export interface DigestResult {
  sent: boolean;
  actors: number;
  events: number;
  pendingDeletions: number;
  skippedReason?: string;
}

export async function buildAndSendAuditDigest(orgId: string): Promise<DigestResult> {
  const perActor = (await db.execute(sql`
    SELECT actor_user_id::text AS actor, action, count(*)::int AS n
    FROM audit_log
    WHERE org_id = ${orgId}::uuid
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York' - interval '1 day') AT TIME ZONE 'America/New_York'
      AND created_at <  date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `)) as unknown as { actor: string | null; action: string; n: number }[];

  const pending = (await db.execute(sql`
    SELECT count(*)::int AS n FROM deletion_requests
    WHERE org_id = ${orgId}::uuid AND status = 'pending'
  `)) as unknown as { n: number }[];
  const pendingDeletions = pending[0]?.n ?? 0;

  const totalEvents = perActor.reduce((a, r) => a + r.n, 0);
  const actorIds = [...new Set(perActor.map((r) => r.actor).filter(Boolean))] as string[];

  // A day with no activity and nothing waiting is not worth a message. A daily
  // "nothing happened" ping trains people to ignore the channel, which is what
  // the real alerts are competing with.
  if (totalEvents === 0 && pendingDeletions === 0) {
    return { sent: false, actors: 0, events: 0, pendingDeletions: 0, skippedReason: "no activity" };
  }

  const emailById = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const u of data?.users ?? []) if (u.email) emailById.set(u.id, u.email);
  } catch {
    // Degrade to raw ids rather than dropping the digest.
  }

  const byActor = new Map<string, { action: string; n: number }[]>();
  for (const r of perActor) {
    const key = r.actor ? (emailById.get(r.actor) ?? r.actor.slice(0, 8)) : "system";
    const list = byActor.get(key) ?? [];
    list.push({ action: r.action, n: r.n });
    byActor.set(key, list);
  }

  const lines: string[] = ["📋 CamMan daily audit digest", ""];

  for (const [actor, rows] of byActor) {
    const total = rows.reduce((a, r) => a + r.n, 0);
    lines.push(`${actor} — ${total} action${total === 1 ? "" : "s"}`);
    for (const r of rows) lines.push(`   ${r.action}: ${r.n}`);
  }

  const guardrail = perActor.filter((r) => r.action.startsWith("guardrail."));
  lines.push("");
  if (guardrail.length === 0) {
    lines.push("Guardrails: none triggered");
  } else {
    lines.push("Guardrails:");
    const agg = new Map<string, number>();
    for (const g of guardrail) agg.set(g.action, (agg.get(g.action) ?? 0) + g.n);
    for (const [a, n] of agg) lines.push(`   ${a}: ${n}`);
  }

  lines.push("");
  lines.push(
    pendingDeletions === 0
      ? "Deletion queue: empty"
      : `⏳ Deletion queue: ${pendingDeletions} awaiting your approval — /settings/deletion-requests`,
  );

  const sent = await notifyTelegram(lines.join("\n"));
  return { sent, actors: actorIds.length, events: totalEvents, pendingDeletions };
}
