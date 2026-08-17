import { asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { getDescriptor } from "@/lib/sends/providers/registry";

// GET — everything /settings/providers renders, in one call: the provider row's
// send posture, its capabilities, how many accounts and numbers hang off it, and
// the connection type's operator notes.
//
// SECRET-FREE. It never selects api_key / api_key_encrypted; accounts are a
// COUNT, never a list of credentials. Descriptor content is compile-time
// constant and describes what to ASK for, never what is stored.
//
// Two columns, two meanings, both returned because the panel must show them
// separately (docs/07-conventions.md):
//   • adapter_code    — CONNECTION TYPE. What resolves the descriptor.
//   • sms_provider_id — ROW IDENTITY. Which account this is.
// The descriptor is looked up by adapter_code, so the SECOND account of a type
// (the txh2 row) gets its type's notes and capabilities — an identity-keyed
// lookup would return nothing for it.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Counts as correlated scalar sub-selects rather than joins: both child tables
  // are small per provider, and a join would need GROUP BY over two dimensions
  // and could double-count. Both are org-scoped independently — the provider row
  // being org-scoped is not sufficient on its own (multi-tenancy is per-query).
  const rows = await db
    .select({
      id: sms_providers.id,
      name: sms_providers.name,
      sms_provider_id: sms_providers.sms_provider_id,
      adapter_code: sms_providers.adapter_code,
      status: sms_providers.status,
      color: sms_providers.color,
      supports_api_send: sms_providers.supports_api_send,
      sends_enabled: sms_providers.sends_enabled,
      opt_out_footer: sms_providers.opt_out_footer,
      send_paused: sms_providers.send_paused,
      send_paused_reason: sms_providers.send_paused_reason,
      send_paused_at: sms_providers.send_paused_at,
      max_sends_per_run: sms_providers.max_sends_per_run,
      max_sends_per_minute: sms_providers.max_sends_per_minute,
      max_sends_per_24h: sms_providers.max_sends_per_24h,
      accounts_count: sql<number>`(
        SELECT count(*)::int FROM provider_credentials pc
        WHERE pc.provider_id = ${sms_providers.id} AND pc.org_id = ${orgId}
      )`,
      numbers_count: sql<number>`(
        SELECT count(*)::int FROM provider_phones pp
        WHERE pp.provider_id = ${sms_providers.id} AND pp.org_id = ${orgId}
          AND pp.status <> 'archived'
      )`,
    })
    .from(sms_providers)
    .where(eq(sms_providers.org_id, orgId))
    .orderBy(asc(sms_providers.id));

  const data = rows.map((r) => {
    // NULL adapter_code = no API adapter (a manual/custom provider). A real
    // state, not missing data — the panel says so rather than showing a blank.
    const d = r.adapter_code ? getDescriptor(r.adapter_code) : null;
    return {
      ...r,
      connection_type: r.adapter_code,
      connection_type_name: d?.displayName ?? null,
      connection_type_blurb: d?.blurb ?? null,
      // Always an array so the client renders a list or nothing, never an
      // undefined check at the call site.
      notes: d?.notes ?? [],
      capabilities: {
        api_send: r.supports_api_send,
        // false ⇒ this connection type has no non-sending way to prove a key.
        // The UI must SAY so rather than offer a check that cannot fail.
        can_validate: typeof d?.validateCredentials === "function",
        test_send: d?.supportsTestSend === true,
        opt_out_callback: d?.supportsOptOutCallbackRegistration === true,
      },
    };
  });

  return NextResponse.json({ data });
}
