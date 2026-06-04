import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import { fetchInbox as realFetchInbox, type FetchInboxResult } from "@/lib/sends/texthub-inbox";
import { validatePhone } from "@/lib/phone-validation";

// Polls TextHub's inbox per credential and turns inbound STOP messages into
// org-wide opt_outs. Idempotent: each TextHub message id is recorded once in
// texthub_inbound_events (unique on provider_id+provider_message_id, migration
// 0056), so a STOP is suppressed at most once across repeated polls.
//
// Per-message atomicity: claiming the message (the dedupe INSERT) and the
// suppression run in ONE transaction. If suppression throws, the claim rolls
// back too, so the message is retried on the next poll — a STOP is never
// silently dropped by marking it processed without acting on it.
//
// Trusted background context (CLAUDE.md §3): the cron path processes ALL orgs,
// each with its credential's explicit org_id; the on-demand path passes the
// caller's orgId to scope to one org.

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
  perCredential: CredentialPollSummary[];
}

const EMPTY = { fetched: 0, new: 0, suppressed: 0, ignored: 0, invalid_phone: 0, errored: 0 };

type Outcome = "dupe" | "ignored" | "invalid" | "suppressed";

async function pollCredential(
  database: Database,
  cred: CredentialRow,
  fetchInbox: InboxFetcher,
): Promise<CredentialPollSummary> {
  const base = { credential_id: cred.credential_id, org_id: cred.org_id, ...EMPTY };

  const inbox = await fetchInbox({ apiKey: cred.api_key });
  if (!inbox.ok) return { ...base, error: inbox.error };

  let neu = 0;
  let suppressed = 0;
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
        if (claimed.length === 0) return "dupe";
        const eventId = claimed[0].id;

        if (!isStop) {
          await tx.execute(sql`
            UPDATE texthub_inbound_events
            SET result = 'ignored', processed_at = now()
            WHERE id = ${eventId}
          `);
          return "ignored";
        }
        if (!phone) {
          await tx.execute(sql`
            UPDATE texthub_inbound_events
            SET result = 'invalid_phone', processed_at = now()
            WHERE id = ${eventId}
          `);
          return "invalid";
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

        await tx.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
          VALUES (${cred.org_id}, ${contactId}, ${phone}, 'sms_inbound')
        `);
        await tx.execute(sql`
          UPDATE texthub_inbound_events
          SET result = 'suppressed', matched_contact_id = ${contactId},
              processed_at = now()
          WHERE id = ${eventId}
        `);
        return "suppressed";
      });
    } catch {
      // Transaction rolled back (claim + suppression both undone) — the message
      // stays unclaimed and is retried on the next poll.
      errored++;
      continue;
    }

    if (outcome === "dupe") continue;
    neu++;
    if (outcome === "suppressed") suppressed++;
    else if (outcome === "ignored") ignored++;
    else if (outcome === "invalid") invalid++;
  }

  return {
    ...base,
    fetched: inbox.messages.length,
    new: neu,
    suppressed,
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

  for (const cred of creds) {
    const summary = await pollCredential(database, cred, fetchInbox);
    perCredential.push(summary);
    fetched += summary.fetched;
    neu += summary.new;
    suppressed += summary.suppressed;
  }

  return { credentials_polled: creds.length, fetched, new: neu, suppressed, perCredential };
}
