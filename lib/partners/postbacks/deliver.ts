import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { classifyResponse, nextAttemptDelayMs, sendPostback, type SendResult } from "./http";
import { maskUrl, renderPostbackUrl, samplePayload, type PostbackPayload } from "./template";

// Partner postback delivery: claim due rows, send, record the outcome.
//
// ⚠️ NO TRANSACTION IS HELD ACROSS HTTP. The claim is one autocommit UPDATE that
// pushes next_attempt_at 2 minutes out (a lease): a concurrent runner's SKIP LOCKED
// subquery skips rows being claimed, and once committed they are no longer due. A
// runner killed mid-send leaves its rows to come due again in 2 minutes. Each
// result is its own autocommit UPDATE.
//
// The key is re-read at claim time: a key disabled while rows are pending cancels
// them unsent, and the CURRENT template renders the URL (an edit applies to retries).

export function deliveryEnabled(): boolean {
  return process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED === "true";
}

export type DeliveryResult = {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  cancelled: number;
  /** Rows whose processing threw; they come due again when their 2-minute claim lapses. */
  errors: number;
  /** Claimed but not started before the run deadline; they come due again when the claim lapses. */
  deferred: number;
  skipped_kill_switch: boolean;
};

type Claimed = {
  id: number;
  org_id: string;
  partner_key_id: number;
  attempts: number;
  payload: PostbackPayload;
  key_name: string;
  postback_enabled: boolean;
  postback_url_template: string | null;
  postback_include_payout: boolean;
};

type KeyOutcome = {
  orgId: string;
  name: string;
  delivered?: boolean;
  failed?: { masked: string | null; code: number | null; error: string | null };
};

const CONCURRENCY = 5;
// Stop picking up rows after this long, so the batch (plus the per-key alerts)
// fits inside the route's maxDuration = 60.
const RUN_DEADLINE_MS = 40_000;

export async function runPostbackDelivery(
  o: {
    limit?: number;
    send?: (url: string) => Promise<SendResult>;
    /** TESTS ONLY: restrict the claim to one org on a shared database. Production never passes it. */
    orgId?: string;
    /** TESTS ONLY: override the 40 s pick-up deadline. */
    deadlineMs?: number;
  } = {},
): Promise<DeliveryResult> {
  const out: DeliveryResult = {
    claimed: 0, delivered: 0, retried: 0, failed: 0, cancelled: 0, errors: 0, deferred: 0, skipped_kill_switch: false,
  };
  if (!deliveryEnabled()) return { ...out, skipped_kill_switch: true };

  const startedAt = Date.now();
  const deadlineMs = o.deadlineMs ?? RUN_DEADLINE_MS;
  const limit = o.limit ?? 50;
  const send = o.send ?? ((url: string) => sendPostback(url));
  const orgFilter = o.orgId ? sql`AND org_id = ${o.orgId}::uuid` : sql``;

  const rows = (await db.execute(sql`
    UPDATE partner_postbacks p
    SET next_attempt_at = now() + interval '2 minutes'
    FROM partner_keys k
    WHERE k.id = p.partner_key_id AND k.org_id = p.org_id
      AND p.id IN (
        SELECT id FROM partner_postbacks
        WHERE status = 'pending' AND NOT is_test AND next_attempt_at <= now() ${orgFilter}
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
    RETURNING p.id, p.org_id::text AS org_id, p.partner_key_id, p.attempts, p.payload,
              k.name AS key_name, k.postback_enabled, k.postback_url_template, k.postback_include_payout
  `)) as unknown as Claimed[];
  out.claimed = rows.length;

  // Per key, the outcome that decides its alert: any failure this run wins over a delivery.
  const keyOutcome = new Map<number, KeyOutcome>();

  const processRow = async (r: Claimed) => {
    const id = Number(r.id);
    const keyId = Number(r.partner_key_id);
    const ko = keyOutcome.get(keyId) ?? { orgId: r.org_id, name: r.key_name };
    keyOutcome.set(keyId, ko);

    if (!r.postback_enabled) {
      await db.execute(sql`
        UPDATE partner_postbacks SET status = 'cancelled', last_error = 'postback_disabled'
        WHERE id = ${id}::bigint AND org_id = ${r.org_id}::uuid AND status = 'pending'`);
      out.cancelled++;
      return;
    }

    let url: string;
    try {
      url = renderPostbackUrl(r.postback_url_template ?? "", r.payload, r.postback_include_payout);
    } catch (err) {
      // Not retryable: the template (or this payload) cannot produce a safe URL. Nothing is sent.
      const message = err instanceof Error ? err.message : String(err);
      await db.execute(sql`
        UPDATE partner_postbacks SET status = 'failed', last_error = ${message}, last_attempt_at = now()
        WHERE id = ${id}::bigint AND org_id = ${r.org_id}::uuid AND status = 'pending'`);
      out.failed++;
      ko.failed = { masked: null, code: null, error: message };
      return;
    }

    const masked = maskUrl(url);
    const res = await send(url);
    const attempts = Number(r.attempts) + 1;
    const verdict = classifyResponse(res);
    const error = res.error ?? (verdict === "delivered" ? null : `HTTP ${res.status}`);
    const delay = verdict === "retry" ? nextAttemptDelayMs(attempts) : null;
    const status = verdict === "delivered" ? "delivered" : delay === null ? "failed" : "pending";

    // status = 'pending' guard: a concurrent cancel is not overwritten.
    await db.execute(sql`
      UPDATE partner_postbacks
      SET status = ${status},
          attempts = ${attempts}::int,
          last_attempt_at = now(),
          next_attempt_at = CASE WHEN ${status} = 'pending'
                                 THEN now() + make_interval(secs => ${(delay ?? 0) / 1000}::float8)
                                 ELSE next_attempt_at END,
          delivered_at = CASE WHEN ${status} = 'delivered' THEN now() ELSE delivered_at END,
          last_response_code = ${res.status}::int,
          last_error = ${error},
          last_url_masked = ${masked}
      WHERE id = ${id}::bigint AND org_id = ${r.org_id}::uuid AND status = 'pending'`);

    if (status === "delivered") {
      out.delivered++;
      ko.delivered = true;
    } else if (status === "pending") {
      out.retried++;
    } else {
      out.failed++;
      ko.failed = { masked, code: res.status, error };
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
      while (next < rows.length && Date.now() - startedAt < deadlineMs) {
        const r = rows[next++];
        try {
          await processRow(r);
        } catch (err) {
          // Isolated: the row keeps its 2-minute claim and comes due again. No URL in the log.
          out.errors++;
          console.error(`[partner-postbacks] row ${r.id} failed (left for retry):`, err instanceof Error ? err.message : err);
        }
      }
    }),
  );
  out.deferred = rows.length - next;

  for (const [keyId, ko] of keyOutcome) {
    const alertKey = `partner-postback-failed:${keyId}`;
    try {
      if (!ko.failed) {
        if (ko.delivered) await clearAlert(db, { alertKey, orgId: ko.orgId });
        continue;
      }
      const n = (await db.execute(sql`
        SELECT count(*)::int AS n FROM partner_postbacks
        WHERE partner_key_id = ${keyId}::int AND org_id = ${ko.orgId}::uuid AND status = 'failed' AND NOT is_test
          AND last_attempt_at >= now() - interval '24 hours'`)) as unknown as { n: number }[];
      const f = ko.failed;
      const last = f.masked
        ? `${f.masked} → ${f.code ?? f.error ?? "no response"}`
        : `not sent: ${f.error}`;
      await notifyOnTransition(db, {
        alertKey,
        orgId: ko.orgId,
        text: `🔴 Partner postback failed — key "${ko.name}" (#${keyId})\n${n[0]?.n ?? 0} failed in the last 24 h\nLast: ${last}`,
      });
    } catch (err) {
      console.error(`[partner-postbacks] alert for key ${keyId} failed (swallowed):`, err instanceof Error ? err.message : err);
    }
  }

  return out;
}

/**
 * Whether any key, in any org, has postbacks switched on. Read by the
 * drip-monitors watchdog (a system cron, cross-org by design: it only gates
 * whether a dead delivery cron pages).
 */
export async function anyPostbackKeyEnabled(): Promise<boolean> {
  const r = (await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM partner_keys WHERE postback_enabled) AS on`)) as unknown as { on: boolean }[];
  return r[0]?.on === true;
}

export type TestPostbackResult = {
  ok: boolean;
  status_code: number | null;
  url_masked: string;
  error: string | null;
};

export type TestPostbackOutcome = TestPostbackResult | { too_soon: true };

// Per-key advisory-lock namespace for test sends. A bigint far from ENQUEUE_LOCK_KEY
// (7_228_000_000_001) and from hashtext() int4 keys, which are < 2^31.
const TEST_LOCK_BASE = 7_228_100_000_000;

/**
 * Fire ONE sample postback with the key's CURRENT saved template. No retries. Works
 * whether or not the key has postbacks enabled.
 *
 * WARNING: the delivery KILL SWITCH is NOT checked here. It is enforced by the CALLER
 * (the postback-test route returns 409 when `deliveryEnabled()` is false); any new
 * caller must check `deliveryEnabled()` itself.
 *
 * The 10 s limit is claimed BEFORE sending: in one short transaction, under a per-key
 * advisory lock, it checks for an `is_test` row created < 10 s ago and otherwise inserts
 * this send's row as `pending` (attempts 0), then commits; only then does it send and
 * UPDATE the row with the result. Two concurrent calls therefore cannot both send; the
 * loser gets `{ too_soon: true }` (route: 429). A row left `pending` by a crash is
 * harmless: the delivery runner claims only `NOT is_test` rows.
 *
 * Throws `no_template` if the key has none saved, `key_not_found` for a key outside the org.
 */
export async function sendTestPostback(
  dbc: DbOrTx,
  o: { orgId: string; keyId: number },
  send: (url: string) => Promise<SendResult> = (url) => sendPostback(url),
): Promise<TestPostbackOutcome> {
  const claimed = await dbc.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TEST_LOCK_BASE + o.keyId}::bigint)`);
    const k = (await tx.execute(sql`
      SELECT postback_url_template, postback_include_payout, passthrough_fields
      FROM partner_keys WHERE id = ${o.keyId}::int AND org_id = ${o.orgId}::uuid`)) as unknown as {
      postback_url_template: string | null;
      postback_include_payout: boolean;
      passthrough_fields: string[];
    }[];
    if (!k[0]) throw new Error("key_not_found");
    if (!k[0].postback_url_template) throw new Error("no_template");

    const recent = (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM partner_postbacks
        WHERE org_id = ${o.orgId}::uuid AND partner_key_id = ${o.keyId}::int AND is_test
          AND created_at > clock_timestamp() - interval '10 seconds') AS recent`)) as unknown as { recent: boolean }[];
    if (recent[0]?.recent) return null;

    const payload = samplePayload(k[0].passthrough_fields);
    const ins = (await tx.execute(sql`
      INSERT INTO partner_postbacks (org_id, partner_key_id, is_test, payload, status, attempts)
      VALUES (${o.orgId}::uuid, ${o.keyId}::int, true, ${JSON.stringify(payload)}::jsonb, 'pending', 0)
      RETURNING id`)) as unknown as { id: number }[];
    return { id: Number(ins[0].id), payload, template: k[0].postback_url_template, includePayout: k[0].postback_include_payout };
  });
  if (!claimed) return { too_soon: true };

  const record = (r: { status: string; code: number | null; error: string | null; masked: string | null }) =>
    dbc.execute(sql`
      UPDATE partner_postbacks
      SET status = ${r.status}, attempts = 1, last_attempt_at = now(),
          delivered_at = ${r.status === "delivered" ? sql`now()` : sql`NULL`},
          last_response_code = ${r.code}::int, last_error = ${r.error}, last_url_masked = ${r.masked}
      WHERE id = ${claimed.id}::bigint AND org_id = ${o.orgId}::uuid`);

  let url: string;
  try {
    url = renderPostbackUrl(claimed.template, claimed.payload, claimed.includePayout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record({ status: "failed", code: null, error: message, masked: null });
    return { ok: false, status_code: null, url_masked: "", error: message };
  }

  const masked = maskUrl(url);
  const res = await send(url);
  const delivered = classifyResponse(res) === "delivered";
  const error = res.error ?? (delivered ? null : `HTTP ${res.status}`);
  await record({ status: delivered ? "delivered" : "failed", code: res.status, error, masked });
  return { ok: delivered, status_code: res.status, url_masked: masked, error };
}
