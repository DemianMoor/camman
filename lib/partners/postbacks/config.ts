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
] as const;

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
  conversion_event_id: number | null;
  status: string;
  attempts: number;
  last_response_code: number | null;
  last_error: string | null;
  last_url_masked: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
};

/** Last 50 postbacks of one key, newest first. Never the raw URL or the payload. */
export async function listKeyPostbacks(
  dbc: DbOrTx,
  o: { orgId: string; keyId: number; failedOnly: boolean },
): Promise<PostbackLogRow[]> {
  const rows = (await dbc.execute(sql`
    SELECT id, created_at, is_test, conversion_event_id, status, attempts, last_response_code,
           last_error, last_url_masked, last_attempt_at, delivered_at
    FROM partner_postbacks
    WHERE org_id = ${o.orgId}::uuid AND partner_key_id = ${o.keyId}::int
      ${o.failedOnly ? sql`AND status = 'failed'` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT 50`)) as unknown as Record<string, unknown>[];
  // Raw db.execute rows carry Date objects for timestamptz; the declared type is string.
  return rows.map((r) => {
    const out = { ...r };
    for (const f of ["created_at", "last_attempt_at", "delivered_at"]) {
      if (out[f] instanceof Date) out[f] = (out[f] as Date).toISOString();
    }
    return out as unknown as PostbackLogRow;
  });
}
