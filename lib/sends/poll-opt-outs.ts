import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import { fetchInbox as realFetchInbox, type FetchInboxResult } from "@/lib/sends/texthub-inbox";
import { validatePhone } from "@/lib/phone-validation";

// Polls TextHub's inbox per credential and turns inbound STOP messages into
// org-wide opt_outs. Idempotent: each TextHub message id is recorded once in
// texthub_inbound_events (unique on provider_id+provider_message_id, migration
// 0056), so a STOP is suppressed at most once across repeated polls.
//
// Per-message atomicity: claiming the message (the dedupe INSERT), the
// suppression, AND the campaign/stage attribution run in ONE transaction. If
// any step throws, the claim rolls back too, so the message is retried on the
// next poll — a STOP is never silently dropped by marking it processed without
// acting on it.
//
// Attribution (migration 0075): TextHub's inbox carries no campaign reference,
// but every API send wrote a stage_sends row (phone, stage_id, campaign_id,
// sent_at). So we reverse-match by phone + recency and credit EVERY stage that
// sent to that number within OPT_OUT_ATTRIBUTION_WINDOW_HOURS (72h) of the
// reply — one opt_out_attributions row per stage, plus a per-stage
// inbound_opt_out_count bump. The org-wide opt_out is unchanged; attribution is
// additive and never gates suppression. No match (CSV-only numbers, non-API
// providers, pre-pipeline sends) ⇒ org-wide opt-out only, counted `unattributed`.
//
// Trusted background context (CLAUDE.md §3): the cron path processes ALL orgs,
// each with its credential's explicit org_id; the on-demand path passes the
// caller's orgId to scope to one org.

// Trailing window: a STOP credits any stage that sent to the number in the last
// 72h. Tunable — the single knob for how aggressively one STOP spreads across
// recently-used campaigns.
export const OPT_OUT_ATTRIBUTION_WINDOW_HOURS = 72;

// TextHub stamps inbound `received_at` in a fixed UTC−6 wall clock with no zone
// suffix (empirically confirmed 2026-06-19: our own ingest clock ran a rock-
// solid ~6h ahead of the stamped value across 132 messages). Earlier this was
// (mis)parsed as UTC, which put the anchor 6h in the past and tripped the
// attribution upper bound (`sent_at <= anchor + 5min`) — a campaign's own STOP
// replies looked like they arrived *before* the send, so they were dropped and
// the stage's opt-out counter read 0. Apply the offset to recover true UTC.
export const TEXTHUB_RECEIVED_AT_UTC_OFFSET_HOURS = -6;

// TextHub stamps inbound messages "YYYY-MM-DD HH:MM:SS" in UTC−6 (see above).
// Shift to true UTC for a stable, deterministic window anchor. NULL when
// unparseable (the caller falls back to the poll time). Inputs that already
// carry a zone (ISO 8601 with offset) are honored as-is.
export function parseProviderReceivedAt(raw: string | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (m) {
    const [, Y, Mo, D, H, Mi, S] = m;
    // UTC = local − offset; offset is −6, so add 6h. Date.UTC carries overflow.
    const d = new Date(
      Date.UTC(+Y, +Mo - 1, +D, +H - TEXTHUB_RECEIVED_AT_UTC_OFFSET_HOURS, +Mi, +S),
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type Database = typeof db;

export type InboxFetcher = (opts: { apiKey: string }) => Promise<FetchInboxResult>;

interface CredentialRow {
  credential_id: number;
  org_id: string;
  provider_id: number;
  api_key: string;
}

export interface CredentialPollSummary {
  credential_id: number;
  org_id: string;
  fetched: number; // messages returned by the inbox
  new: number; // not-seen-before messages claimed this run
  suppressed: number; // STOP messages that produced an opt_out
  attributed: number; // stage credits written (one STOP can credit several)
  unattributed: number; // suppressed STOPs that matched no send in the window
  ignored: number; // new messages that weren't opt-out keywords
  invalid_phone: number; // STOP messages whose phone wouldn't parse
  errored: number; // messages whose transaction failed (will retry next poll)
  error: string | null; // inbox-fetch-level error (whole credential skipped)
}

export interface PollOptOutsResult {
  credentials_polled: number;
  fetched: number;
  new: number;
  suppressed: number;
  attributed: number;
  unattributed: number;
  perCredential: CredentialPollSummary[];
}

const EMPTY = {
  fetched: 0,
  new: 0,
  suppressed: 0,
  attributed: 0,
  unattributed: 0,
  ignored: 0,
  invalid_phone: 0,
  errored: 0,
};

// "suppressed" now carries how many stage credits the STOP produced so the
// caller can tally attributed / unattributed without re-querying.
type Outcome =
  | { kind: "dupe" | "ignored" | "invalid" }
  | { kind: "suppressed"; attributed: number };

async function pollCredential(
  database: Database,
  cred: CredentialRow,
  fetchInbox: InboxFetcher,
): Promise<CredentialPollSummary> {
  const base = { credential_id: cred.credential_id, org_id: cred.org_id, ...EMPTY };

  const inbox = await fetchInbox({ apiKey: cred.api_key });
  if (!inbox.ok) {
    // Compliance-critical: a failing opt-out poll means inbound STOPs aren't
    // being ingested. This used to fail silently. Best-effort alert; never
    // throws or blocks the rest of the poll (other credentials still run).
    await notifyTelegram(
      `⚠️ Opt-out poller FAILED (inbound STOPs not ingested)\n` +
        `error: ${inbox.error ?? "unknown"}\n` +
        `credential: ${cred.credential_id} · provider: ${cred.provider_id} (org ${cred.org_id})`,
    );
    return { ...base, error: inbox.error };
  }

  let neu = 0;
  let suppressed = 0;
  let attributed = 0;
  let unattributed = 0;
  let ignored = 0;
  let invalid = 0;
  let errored = 0;

  for (const m of inbox.messages) {
    const isStop = isOptOutKeyword(m.message);
    const parsed = isStop ? validatePhone(m.phone) : null;
    const phone = parsed?.valid ? parsed.normalized : null;

    let outcome: Outcome;
    try {
      outcome = await database.transaction(async (tx) => {
        // Claim the message (dedupe). No row back => already processed.
        const claimed = (await tx.execute(sql`
          INSERT INTO texthub_inbound_events
            (org_id, credential_id, provider_id, method, raw_body,
             provider_message_id, result)
          VALUES (${cred.org_id}, ${cred.credential_id}, ${cred.provider_id},
                  'poll', ${JSON.stringify(m)}, ${m.id}, 'pending')
          ON CONFLICT (provider_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL DO NOTHING
          RETURNING id
        `)) as unknown as { id: string }[];
        if (claimed.length === 0) return { kind: "dupe" } as const;
        const eventId = claimed[0].id;

        // TextHub's own receipt time anchors the attribution window; fall back
        // to the poll time when the payload's timestamp won't parse.
        const receivedAt = parseProviderReceivedAt(m.received_at);
        const anchorIso = (receivedAt ?? new Date()).toISOString();

        if (!isStop) {
          await tx.execute(sql`
            UPDATE texthub_inbound_events
            SET result = 'ignored', processed_at = now(),
                provider_received_at = ${receivedAt?.toISOString() ?? null}
            WHERE id = ${eventId}
          `);
          return { kind: "ignored" } as const;
        }
        if (!phone) {
          await tx.execute(sql`
            UPDATE texthub_inbound_events
            SET result = 'invalid_phone', processed_at = now(),
                provider_received_at = ${receivedAt?.toISOString() ?? null}
            WHERE id = ${eventId}
          `);
          return { kind: "invalid" } as const;
        }

        // Upsert the contact (create if unknown — a STOP must suppress the
        // number even if it isn't an existing contact yet; mirrors the opt-out
        // CSV flow). Then insert the org-wide opt_out (no brand junction =
        // universal suppression, which the audience enumeration already honors).
        const c = (await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${cred.org_id}, ${phone})
          ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
          RETURNING id
        `)) as unknown as { id: string }[];
        const contactId = c[0]?.id;

        const oo = (await tx.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
          VALUES (${cred.org_id}, ${contactId}, ${phone}, 'sms_inbound')
          RETURNING id
        `)) as unknown as { id: number }[];
        const optOutId = oo[0]?.id;

        // Attribution: every stage that sent to this number within the trailing
        // window, one (latest) send per stage. sent_at <= anchor + grace so a
        // send that fired AFTER the reply isn't credited; >= anchor - window is
        // the 72h trailing bound.
        const matches = (await tx.execute(sql`
          SELECT DISTINCT ON (stage_id)
                 id AS stage_send_id, stage_id, campaign_id, sent_at
          FROM stage_sends
          WHERE org_id = ${cred.org_id}
            AND phone = ${phone}
            AND status = 'sent'
            AND sent_at IS NOT NULL
            AND sent_at >= ${anchorIso}::timestamptz
                            - (${OPT_OUT_ATTRIBUTION_WINDOW_HOURS} * interval '1 hour')
            AND sent_at <= ${anchorIso}::timestamptz + interval '5 minutes'
          ORDER BY stage_id, sent_at DESC
        `)) as unknown as {
          stage_send_id: string;
          stage_id: number;
          campaign_id: number;
          sent_at: string;
        }[];

        let attributed = 0;
        let latestSendId: string | null = null;
        let latestSentAt = "";
        for (const mt of matches) {
          // ON CONFLICT guards the idempotent re-run case; the per-message claim
          // already makes this run once, so RETURNING is the increment gate.
          const ins = (await tx.execute(sql`
            INSERT INTO opt_out_attributions
              (org_id, opt_out_id, stage_send_id, stage_id, campaign_id)
            VALUES (${cred.org_id}, ${optOutId}, ${mt.stage_send_id},
                    ${mt.stage_id}, ${mt.campaign_id})
            ON CONFLICT (opt_out_id, stage_id) DO NOTHING
            RETURNING id
          `)) as unknown as { id: number }[];
          if (ins.length === 0) continue;
          attributed++;
          // Bump the attribution counter AND mirror it into opt_out_count so the
          // per-stage Results panel (which reads opt_out_count) reflects live
          // TextHub STOPs automatically. Both RHS references read the pre-UPDATE
          // value, so the two columns stay in lock-step.
          await tx.execute(sql`
            UPDATE campaign_stages
            SET inbound_opt_out_count = inbound_opt_out_count + 1,
                opt_out_count = inbound_opt_out_count + 1
            WHERE id = ${mt.stage_id}
          `);
          if (mt.sent_at > latestSentAt) {
            latestSentAt = mt.sent_at;
            latestSendId = mt.stage_send_id;
          }
        }

        await tx.execute(sql`
          UPDATE texthub_inbound_events
          SET result = 'suppressed', matched_contact_id = ${contactId},
              matched_stage_send_id = ${latestSendId},
              provider_received_at = ${receivedAt?.toISOString() ?? null},
              processed_at = now()
          WHERE id = ${eventId}
        `);
        return { kind: "suppressed", attributed } as const;
      });
    } catch {
      // Transaction rolled back (claim + suppression both undone) — the message
      // stays unclaimed and is retried on the next poll.
      errored++;
      continue;
    }

    if (outcome.kind === "dupe") continue;
    neu++;
    if (outcome.kind === "suppressed") {
      suppressed++;
      attributed += outcome.attributed;
      if (outcome.attributed === 0) unattributed++;
    } else if (outcome.kind === "ignored") ignored++;
    else if (outcome.kind === "invalid") invalid++;
  }

  return {
    ...base,
    fetched: inbox.messages.length,
    new: neu,
    suppressed,
    attributed,
    unattributed,
    ignored,
    invalid_phone: invalid,
    errored,
    error: null,
  };
}

// Poll inbound opt-outs for every API-capable TextHub credential (optionally
// scoped to one org). Per-credential failures are isolated — one bad inbox
// fetch never aborts the rest.
export async function pollOptOuts(
  database: Database,
  opts?: { orgId?: string; fetchInbox?: InboxFetcher },
): Promise<PollOptOutsResult> {
  const fetchInbox = opts?.fetchInbox ?? realFetchInbox;
  const orgFilter = opts?.orgId ? sql`AND pc.org_id = ${opts.orgId}` : sql``;

  const creds = (await database.execute(sql`
    SELECT pc.id AS credential_id, pc.org_id AS org_id,
           pc.provider_id AS provider_id, pc.api_key AS api_key
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.supports_api_send = true
    ${orgFilter}
  `)) as unknown as CredentialRow[];

  const perCredential: CredentialPollSummary[] = [];
  let fetched = 0;
  let neu = 0;
  let suppressed = 0;
  let attributed = 0;
  let unattributed = 0;

  for (const cred of creds) {
    const summary = await pollCredential(database, cred, fetchInbox);
    perCredential.push(summary);
    fetched += summary.fetched;
    neu += summary.new;
    suppressed += summary.suppressed;
    attributed += summary.attributed;
    unattributed += summary.unattributed;
  }

  return {
    credentials_polled: creds.length,
    fetched,
    new: neu,
    suppressed,
    attributed,
    unattributed,
    perCredential,
  };
}
