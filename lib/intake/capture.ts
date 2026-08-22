import { sql } from "drizzle-orm";

import { validatePhone } from "@/lib/phone-validation";
import { extractLeadFields } from "./fields";
import type { DbOrTx, ResolvedPartnerKey } from "./partner-key";

// lead_inbox capture — step 4 of the Q7 webhook pattern: one committed INSERT
// carrying a dedup key, then return. No lookups, no contacts, no sends.

export interface PreparedLead {
  raw: Record<string, unknown>;
  phone_e164: string | null;
  interest_tag: string | null;
  status: "received" | "rejected";
  error: string | null;
  dedup_key: string | null;
}

/**
 * Dedup key: (partner_key_id, phone, received_minute).
 *
 * partner_key_id is the index's leading column, so it is not repeated here.
 * The minute is UTC-truncated — it is a de-duplication bucket, not a
 * user-facing date, so the ET convention does not apply and a timezone here
 * would only add a way to get it wrong.
 *
 * Returns null when there is no phone, which is exactly why the column is
 * nullable: the lead is still stored.
 */
export function leadDedupKey(phoneE164: string | null, receivedAt: Date): string | null {
  if (!phoneE164) return null;
  const minute = receivedAt.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  return `${phoneE164}:${minute}`;
}

/**
 * Validate and shape one payload for storage. Never throws, and never returns
 * "drop this" — every payload becomes a row.
 *
 * ⚠️ A lead that fails validation is STORED with status 'rejected' and a
 * populated `error` (ruling G17), not discarded. A partner integration that is
 * sending the wrong field name is invisible if bad payloads vanish at the edge;
 * stored, it is one query away from being diagnosed.
 */
export function prepareLead(
  payload: unknown,
  key: Pick<ResolvedPartnerKey, "field_mapping" | "interest_tag_mode" | "interest_tag">,
  receivedAt: Date,
): PreparedLead {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      raw: { _unparseable: String(payload) },
      phone_e164: null,
      interest_tag: null,
      status: "rejected",
      error: "Lead must be a JSON object",
      dedup_key: null,
    };
  }

  const raw = payload as Record<string, unknown>;
  const mapping = (key.field_mapping ?? {}) as Record<string, string>;
  const fields = extractLeadFields(raw, mapping);

  // 'force' ignores whatever the partner sent; 'default' fills only a gap.
  const supplied = typeof fields.interest_tag === "string" ? fields.interest_tag.trim() : null;
  const interest_tag =
    key.interest_tag_mode === "force" ? key.interest_tag : supplied || key.interest_tag || null;

  const rawPhone = fields.phone;
  if (rawPhone === undefined || rawPhone === null || String(rawPhone).trim() === "") {
    return {
      raw, phone_e164: null, interest_tag,
      status: "rejected",
      error: "Missing required field: phone",
      dedup_key: null,
    };
  }

  const parsed = validatePhone(String(rawPhone));
  if (!parsed.valid || !parsed.normalized) {
    return {
      raw, phone_e164: null, interest_tag,
      status: "rejected",
      error: `Invalid phone number: ${parsed.error ?? "unparseable"}`,
      dedup_key: null,
    };
  }

  return {
    raw,
    phone_e164: parsed.normalized,
    interest_tag,
    status: "received",
    error: null,
    dedup_key: leadDedupKey(parsed.normalized, receivedAt),
  };
}

export interface CaptureResult {
  id: string;
  duplicate: boolean;
  status: string;
}

/**
 * Insert prepared leads in ONE statement.
 *
 * ⚠️ `(xmax = 0) AS inserted` distinguishes a fresh insert from a conflict — the
 * same trick captureTellsWebhookEvent uses. A duplicate is NOT an error: the
 * partner gets 202 and the id of the row we already hold, so a retry after a
 * network timeout is safe and idempotent rather than producing a second lead.
 *
 * The multi-row VALUES keeps a 500-lead batch at ONE round trip.
 */
export async function captureLeads(
  dbc: DbOrTx,
  {
    orgId,
    partnerKeyId,
    partnerSlug,
    sandbox,
    leads,
    receivedAt,
  }: {
    orgId: string;
    partnerKeyId: number;
    partnerSlug: string;
    sandbox: boolean;
    leads: PreparedLead[];
    receivedAt: Date;
  },
): Promise<CaptureResult[]> {
  if (leads.length === 0) return [];

  // ⚠️ INTRA-BATCH DEDUP IS MANDATORY, not an optimization. Postgres raises
  // 21000 "ON CONFLICT DO UPDATE command cannot affect row a second time" if
  // one statement tries to conflict-update the same row twice — so a single
  // batch containing the same (phone, minute) twice would fail the WHOLE call,
  // rejecting 499 good leads because of one duplicate. Collapse first; repeats
  // resolve to the same row and are reported as duplicates, exactly as they
  // would be across two separate calls.
  const firstSeen = new Map<string, number>();
  const unique: PreparedLead[] = [];
  const slot: number[] = [];
  // isFirst must be tracked explicitly. Inferring it from `slot[i] === i` is
  // wrong the moment any earlier duplicate shifts the indices: [A, A, B] gives
  // slot [0, 0, 1], and B at i=2 would be misreported as a duplicate.
  const isFirst: boolean[] = [];
  for (const l of leads) {
    if (l.dedup_key) {
      const at = firstSeen.get(l.dedup_key);
      if (at !== undefined) { slot.push(at); isFirst.push(false); continue; }
      firstSeen.set(l.dedup_key, unique.length);
    }
    slot.push(unique.length);
    isFirst.push(true);
    unique.push(l);
  }

  const values = unique.map(
    (l) => sql`(
      ${orgId}::uuid, ${partnerKeyId}, ${partnerSlug}, ${receivedAt.toISOString()}::timestamptz,
      ${JSON.stringify(l.raw)}::jsonb, ${l.phone_e164}, ${l.interest_tag}, ${sandbox},
      ${l.status}, ${l.error}, ${l.dedup_key}
    )`,
  );

  const rows = (await dbc.execute(sql`
    INSERT INTO lead_inbox
      (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, interest_tag,
       sandbox, status, error, dedup_key)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (partner_key_id, dedup_key) WHERE dedup_key IS NOT NULL
    DO UPDATE SET received_at = lead_inbox.received_at
    RETURNING id, status, (xmax = 0) AS inserted
  `)) as unknown as { id: string; status: string; inserted: boolean }[];

  const byUnique = rows.map((r) => ({
    id: r.id,
    duplicate: !r.inserted,
    status: r.status,
  }));
  // Re-expand to the caller's original order/length: a partner that sent 500
  // leads must get 500 results back, or their index-based reconciliation breaks.
  return leads.map((_, i) => {
    const u = byUnique[slot[i]];
    return isFirst[i] ? u : { ...u, duplicate: true };
  });
}
