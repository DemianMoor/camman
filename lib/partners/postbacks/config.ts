import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { partner_keys } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import type { DbOrTx } from "@/lib/intake/partner-key";
import type { PartnerKeyUpdateInput } from "@/lib/validators/partner-keys";
import { postbackConfigError } from "./template";

// PATCH /api/partner-keys/[keyId] logic, kept out of the route so it can be tested without HTTP.

export type PatchOutcome =
  | { ok: true; row: typeof partner_keys.$inferSelect }
  | { ok: false; status: 400 | 404; error: string; code: string; details?: Record<string, unknown> };

const POSTBACK_TRIGGERS = [
  "postback_url_template",
  "postback_include_payout",
  "passthrough_fields",
  "postback_enabled",
  "postback_event_keys",
] as const;

type EventLiveness = { enabled: boolean; events: string[] };

/**
 * Per-event "since" stamps. An event is live when the key is enabled AND the event is in its
 * event list. Keeps the stamp of an event live before and after, stamps `nowIso` on one that
 * becomes live, drops one that stops being live. Pure.
 */
export function nextEventSince(
  prev: Record<string, string>,
  wasLive: EventLiveness,
  nowLive: EventLiveness,
  nowIso: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!nowLive.enabled) return out;
  for (const ev of nowLive.events) {
    const was = wasLive.enabled && wasLive.events.includes(ev);
    out[ev] = was && prev[ev] ? prev[ev] : nowIso;
  }
  return out;
}

export async function applyPartnerKeyPatch(
  dbc: DbOrTx,
  o: { orgId: string; keyId: number; input: PartnerKeyUpdateInput },
): Promise<PatchOutcome> {
  const { orgId, keyId, input } = o;
  const existing = (
    await dbc
      .select()
      .from(partner_keys)
      .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
      .limit(1)
  )[0];
  if (!existing) {
    return { ok: false, status: 404, error: "Partner key not found", code: API_ERROR_CODES.NOT_FOUND, details: { entity: "partner_key" } };
  }

  // ⚠️ Cross-field validation against the MERGED result, not the patch alone.
  // Patching only interest_tag_mode='force' on a key whose stored tag is NULL
  // would otherwise slip past the Zod refinement (which sees no interest_tag in
  // the payload) and be caught by the DB CHECK as an opaque 500. Same class of
  // bug as a PATCH literal that silently drops fields it does not list.
  const mode = input.interest_tag_mode ?? existing.interest_tag_mode;
  const tag = input.interest_tag !== undefined ? input.interest_tag : existing.interest_tag;
  if (mode === "force" && !tag?.trim()) {
    return {
      ok: false, status: 400, error: "An interest tag is required when the mode is 'force'",
      code: API_ERROR_CODES.VALIDATION, details: { field: "interest_tag" },
    };
  }

  // Postback config, same merge rule. An empty template means "none".
  const template =
    input.postback_url_template !== undefined
      ? input.postback_url_template || null
      : existing.postback_url_template;
  const enabled = input.postback_enabled ?? existing.postback_enabled;
  const includePayout = input.postback_include_payout ?? existing.postback_include_payout;
  const passthrough = input.passthrough_fields ?? (existing.passthrough_fields as string[]);

  if (POSTBACK_TRIGGERS.some((k) => input[k] !== undefined)) {
    if (enabled && template === null) {
      return {
        ok: false, status: 400, error: "A postback URL template is required to enable postbacks",
        code: API_ERROR_CODES.VALIDATION, details: { field: "postback_url_template" },
      };
    }
    if (template !== null) {
      const message = postbackConfigError({ template, passthroughFields: passthrough, includePayout });
      if (message) {
        return { ok: false, status: 400, error: message, code: API_ERROR_CODES.VALIDATION, details: { field: "postback_url_template" } };
      }
    }
  }

  // Status words MERGE into the stored map (a PATCH of one event keeps the others).
  const statusWords = {
    ...((existing.postback_status_words ?? {}) as Record<string, string>),
    ...(input.postback_status_words ?? {}),
  };
  // Per-event since, from the MERGED enabled/events. App clock (new Date()); the DB clock
  // is used for postback_active_since, the two never need to agree to the millisecond.
  const eventKeys = input.postback_event_keys ?? (existing.postback_event_keys as string[]);
  const eventSince = nextEventSince(
    (existing.postback_event_since ?? {}) as Record<string, string>,
    { enabled: existing.postback_enabled, events: existing.postback_event_keys as string[] },
    { enabled, events: eventKeys },
    new Date().toISOString(),
  );

  const activeSince =
    !existing.postback_enabled && enabled
      ? { postback_active_since: sql`now()` }
      : existing.postback_enabled && !enabled
        ? { postback_active_since: null }
        : {};

  const updated = await dbc
    .update(partner_keys)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.interest_tag_mode !== undefined ? { interest_tag_mode: input.interest_tag_mode } : {}),
      ...(input.interest_tag !== undefined ? { interest_tag: input.interest_tag } : {}),
      ...(input.field_mapping !== undefined ? { field_mapping: input.field_mapping } : {}),
      ...(input.passthrough_fields !== undefined ? { passthrough_fields: input.passthrough_fields } : {}),
      ...(input.postback_url_template !== undefined ? { postback_url_template: template } : {}),
      ...(input.postback_enabled !== undefined ? { postback_enabled: input.postback_enabled } : {}),
      ...(input.postback_include_payout !== undefined ? { postback_include_payout: input.postback_include_payout } : {}),
      ...(input.postback_first_purchase_only !== undefined ? { postback_first_purchase_only: input.postback_first_purchase_only } : {}),
      ...(input.postback_event_keys !== undefined ? { postback_event_keys: input.postback_event_keys } : {}),
      ...(input.postback_status_words !== undefined ? { postback_status_words: statusWords } : {}),
      postback_event_since: eventSince,
      ...activeSince,
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      ...(input.rate_per_sec !== undefined ? { rate_per_sec: input.rate_per_sec } : {}),
      ...(input.rate_per_day !== undefined ? { rate_per_day: input.rate_per_day } : {}),
      ...(input.max_payload_bytes !== undefined ? { max_payload_bytes: input.max_payload_bytes } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      // report_show_revenue moved to the PARTNER (0200): PATCH /api/partners/[id].
    })
    .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
    .returning();
  return { ok: true, row: updated[0] };
}

export type PostbackLogRow = {
  id: number;
  created_at: string;
  is_test: boolean;
  event: string;
  conversion_event_id: number | null;
  status: string;
  attempts: number;
  last_response_code: number | null;
  last_error: string | null;
  last_url_masked: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
};

export const POSTBACK_LOG_PAGE_SIZE = 25;
export const POSTBACK_LOG_SEARCH_MAX = 100;

/**
 * One page of a key's postbacks, newest first. Keyset on id: `beforeId` is the last
 * id of the previous page. Never the raw URL or the payload. `search` matches the
 * MASKED url, the conversion id and the lead's passthrough values (e.g. the
 * partner's lead id), case-insensitive.
 */
export async function listKeyPostbacks(
  dbc: DbOrTx,
  o: { orgId: string; keyId: number; failedOnly: boolean; search: string | null; beforeId: number | null },
): Promise<{ rows: PostbackLogRow[]; nextBeforeId: number | null }> {
  const term = o.search?.trim().slice(0, POSTBACK_LOG_SEARCH_MAX) || null;
  // LIKE metacharacters typed by the user are literal.
  const pattern = term === null ? null : `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // One row more than a page tells whether another page exists.
  const raw = (await dbc.execute(sql`
    SELECT id, created_at, is_test, event, conversion_event_id, status, attempts, last_response_code,
           last_error, last_url_masked, last_attempt_at, delivered_at
    FROM partner_postbacks p
    WHERE org_id = ${o.orgId}::uuid AND partner_key_id = ${o.keyId}::int
      ${o.failedOnly ? sql`AND status = 'failed'` : sql``}
      ${o.beforeId === null ? sql`` : sql`AND id < ${o.beforeId}::bigint`}
      ${pattern === null ? sql`` : sql`AND (
        last_url_masked ILIKE ${pattern}
        OR conversion_event_id::text ILIKE ${pattern}
        OR (p.payload ->> 'event_id') ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM jsonb_each_text(coalesce(p.payload -> 'fields', '{}'::jsonb)) f
                   WHERE f.value ILIKE ${pattern}))`}
    ORDER BY id DESC
    LIMIT ${POSTBACK_LOG_PAGE_SIZE + 1}`)) as unknown as Record<string, unknown>[];
  const page = raw.slice(0, POSTBACK_LOG_PAGE_SIZE);
  // Raw db.execute rows carry Date objects for timestamptz; the declared type is string.
  const rows = page.map((r) => {
    const out: Record<string, unknown> = { ...r, id: Number(r.id) };
    for (const f of ["created_at", "last_attempt_at", "delivered_at"]) {
      if (out[f] instanceof Date) out[f] = (out[f] as Date).toISOString();
    }
    return out as unknown as PostbackLogRow;
  });
  return { rows, nextBeforeId: raw.length > POSTBACK_LOG_PAGE_SIZE ? rows[rows.length - 1].id : null };
}
