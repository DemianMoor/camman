import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { resolveProviderApiKey } from "@/lib/sends/provider-credential";
import { sendSms as realSendSms, type SendSmsResult } from "@/lib/sends/texthub";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Injectable so verify-drain can supply a deterministic fake instead of hitting
// TextHub. Default = the real client.
export type Sender = (opts: {
  apiKey: string;
  text: string;
  number: string;
  leadId?: string | null;
}) => Promise<SendSmsResult>;

export type DrainRefusal =
  | "not_found"
  | "not_approved"
  | "send_disabled"
  | "no_provider"
  | "no_credentials";

export interface DrainResult {
  ok: boolean;
  reason?: DrainRefusal;
  sent: number;
  failed: number;
  processed: number;
  halted: boolean; // stopped early because the kill-switch flipped off
  stuck: number; // rows left in 'sending' (crashed mid-send — manual review)
  remaining: number; // rows still 'pending'
}

// The SEND_ENABLED kill-switch. NOTE: this is an env var, which is fixed for
// the life of a serverless invocation — re-reading it between batches gives a
// fresh read each batch, but a flip only takes effect on the NEXT invocation,
// not truly mid-invocation. A within-invocation kill would require a
// runtime-mutable (DB-backed) flag — see the flagged conflict.
function envSendEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

const EMPTY = { sent: 0, failed: 0, processed: 0, halted: false, stuck: 0, remaining: 0 };

interface ClaimedRow {
  id: string;
  phone: string;
  rendered_text: string;
  lead_id: string | null;
}

// Drain one stage's pending sends. Gates: send_approved (per-stage) + the
// SEND_ENABLED kill-switch (re-checked between batches). Claims a batch with
// FOR UPDATE SKIP LOCKED → 'sending' (durable before the HTTP call), sends via
// TextHub, then marks 'sent' (+texthub_message_id, sent_at) or 'failed'
// (+last_error); attempts++ either way. At-most-once: only 'pending' rows are
// ever claimed, so a row stuck in 'sending' (process died mid-send) is NEVER
// auto-retried — it's surfaced in `stuck` for manual review.
export async function runStageDrain(
  dbc: DbOrTx,
  opts: {
    stageId: number;
    sendSms?: Sender;
    isEnabled?: () => boolean;
    batchSize?: number;
    maxRows?: number;
  },
): Promise<DrainResult> {
  const sendSms = opts.sendSms ?? realSendSms;
  const isEnabled = opts.isEnabled ?? envSendEnabled;
  const batchSize = opts.batchSize ?? 50;
  const maxRows = opts.maxRows ?? 1000;

  const ctx = (await dbc.execute(sql`
    SELECT s.sms_provider_id AS provider_id,
           s.send_approved    AS send_approved,
           c.org_id           AS org_id,
           c.brand_id         AS brand_id
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${opts.stageId}
    LIMIT 1
  `)) as unknown as {
    provider_id: number | null;
    send_approved: boolean;
    org_id: string;
    brand_id: number | null;
  }[];

  const stage = ctx[0];
  if (!stage) return { ok: false, reason: "not_found", ...EMPTY };
  if (!stage.send_approved) return { ok: false, reason: "not_approved", ...EMPTY };
  if (!isEnabled()) return { ok: false, reason: "send_disabled", ...EMPTY };
  if (stage.provider_id == null) return { ok: false, reason: "no_provider", ...EMPTY };

  const apiKey = await resolveProviderApiKey(dbc, {
    orgId: stage.org_id,
    providerId: stage.provider_id,
    brandId: stage.brand_id,
  });
  if (!apiKey) return { ok: false, reason: "no_credentials", ...EMPTY };

  let sent = 0;
  let failed = 0;
  let processed = 0;
  let halted = false;

  while (processed < maxRows) {
    // Re-check the kill-switch BEFORE each batch so flipping it off stops the
    // drain (subject to the env-immutability caveat above).
    if (!isEnabled()) {
      halted = true;
      break;
    }

    const limit = Math.min(batchSize, maxRows - processed);
    const claimed = (await dbc.execute(sql`
      UPDATE stage_sends SET status = 'sending'
      WHERE id IN (
        SELECT id FROM stage_sends
        WHERE stage_id = ${opts.stageId} AND status = 'pending'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, phone, rendered_text, lead_id
    `)) as unknown as ClaimedRow[];

    if (claimed.length === 0) break;

    for (const c of claimed) {
      const res = await sendSms({
        apiKey,
        text: c.rendered_text,
        number: c.phone,
        leadId: c.lead_id,
      });
      if (res.ok) {
        await dbc.execute(sql`
          UPDATE stage_sends
          SET status = 'sent', texthub_message_id = ${res.messageId},
              sent_at = now(), attempts = attempts + 1
          WHERE id = ${c.id}
        `);
        sent++;
      } else {
        await dbc.execute(sql`
          UPDATE stage_sends
          SET status = 'failed', last_error = ${res.error}, attempts = attempts + 1
          WHERE id = ${c.id}
        `);
        failed++;
      }
      processed++;
    }
  }

  const counts = (await dbc.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'sending')::int AS stuck,
      count(*) FILTER (WHERE status = 'pending')::int AS remaining
    FROM stage_sends WHERE stage_id = ${opts.stageId}
  `)) as unknown as { stuck: number; remaining: number }[];

  return {
    ok: true,
    sent,
    failed,
    processed,
    halted,
    stuck: Number(counts[0]?.stuck ?? 0),
    remaining: Number(counts[0]?.remaining ?? 0),
  };
}
