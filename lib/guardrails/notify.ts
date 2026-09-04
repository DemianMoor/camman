import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { audit_log } from "@/db/schema";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { writeAuditLog } from "@/lib/audit";

// One exit for every guardrail event (ClickUp 869et3vm1, Phase 3).
//
// Each event writes an audit_log row AND posts to the existing Telegram chat.
// Both, always — they answer different questions. The audit row is the record an
// Owner reads later ("what did the operator do last week"); the Telegram message
// is the interruption that makes someone look now. Dropping either one because
// the other exists loses a real capability.
//
// ⚠️ ORDER MATTERS: audit first, Telegram second. notifyTelegram is best-effort
// and never throws, so a Telegram outage must not cost us the durable record.
// Writing the record first means the worst case is "it happened and nobody was
// pinged", not "it happened and nothing knows".

export type GuardrailEvent =
  // BLOCKs — the action was refused
  | "guardrail.cap_blocked"
  | "guardrail.url_rejected"
  | "guardrail.creative_forked"
  | "guardrail.deletion_requested"
  | "guardrail.deletion_decided"
  // WARNs — the action proceeded
  | "guardrail.cap_exceeded"
  | "guardrail.unproven_creative"
  | "guardrail.volume_deviation"
  | "guardrail.frequency_collision";

export interface GuardrailNotice {
  orgId: string;
  actorUserId?: string | null;
  event: GuardrailEvent;
  /** One line for Telegram. Keep it readable on a phone. */
  headline: string;
  /** Extra lines for Telegram, one per entry. */
  detail?: string[];
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

const LABEL: Record<GuardrailEvent, string> = {
  "guardrail.cap_blocked": "🛑 Volume cap hit",
  "guardrail.url_rejected": "🛑 Link rejected",
  "guardrail.creative_forked": "🔀 Creative versioned",
  "guardrail.deletion_requested": "🗑 Deletion requested",
  "guardrail.deletion_decided": "🗑 Deletion decided",
  "guardrail.cap_exceeded": "⚠️ Aggregate volume cap exceeded",
  "guardrail.unproven_creative": "⚠️ Unproven creative at volume",
  "guardrail.volume_deviation": "⚠️ Volume above trailing average",
  "guardrail.frequency_collision": "⚠️ Contacts hit by a second campaign",
};

export async function notifyGuardrail(n: GuardrailNotice): Promise<void> {
  await writeAuditLog({
    orgId: n.orgId,
    actorUserId: n.actorUserId ?? null,
    action: n.event,
    entityType: n.entityType ?? null,
    entityId: n.entityId ?? null,
    summary: n.headline,
    metadata: n.metadata ?? null,
  });

  const lines = [`${LABEL[n.event]}`, n.headline, ...(n.detail ?? [])];
  await notifyTelegram(lines.join("\n"));
}

/**
 * Fire at most once per ET day for a given event + key.
 *
 * ⚠️ THE DEDUPE READS audit_log, NOT MEMORY. A per-process flag would reset on
 * every serverless cold start, which for a "once per day" alert means once per
 * instance per day — i.e. many times. Keying off the durable record is the only
 * version that actually holds.
 *
 * @returns true when the notice was sent, false when it was already sent today.
 */
export async function notifyGuardrailOncePerDay(
  n: GuardrailNotice,
  dedupeKey: string,
): Promise<boolean> {
  const already = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(audit_log)
    .where(
      and(
        eq(audit_log.org_id, n.orgId),
        eq(audit_log.action, n.event),
        sql`${audit_log.metadata}->>'dedupe_key' = ${dedupeKey}`,
        // ET calendar day, matching how every other daily boundary in this
        // codebase is drawn (CAMPAIGN_TIMEZONE).
        gte(
          audit_log.created_at,
          sql`date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'`,
        ),
      ),
    );
  if ((already[0]?.n ?? 0) > 0) return false;

  await notifyGuardrail({
    ...n,
    metadata: { ...(n.metadata ?? {}), dedupe_key: dedupeKey },
  });
  return true;
}
