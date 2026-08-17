import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerOptOutFooterSchema } from "@/lib/validators/providers";

// Per-provider STOP text (`sms_providers.opt_out_footer`, migration 0138).
//
// ⚠️ STORED BUT NOT YET APPLIED. Nothing on the send path reads this column.
// Every message still renders its opt-out language from the stage's `stop_text`
// exactly as before, and will keep doing so until card 869ej8r1y (Q3) ships the
// precedence chain:
//
//     provider_phones.opt_out_footer  >  THIS  >  campaign_stages.stop_text  >  'Stop to END'
//
// The UI states that plainly rather than presenting a field that silently does
// nothing. Shipping the storage ahead of the chain is deliberate — it lets the
// operator stage per-provider wording as a compliance decision without changing
// a single outgoing message today.
//
// Its own endpoint rather than the bulk provider PATCH, same rule as the two
// send-posture switches: a whole-object form that re-submits every key with no
// concurrency check must not be able to write a field that will affect message
// text the moment Q3 lands.
function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId: pParam } = await params;
  const providerId = parseId(pParam);
  if (providerId === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = providerOptOutFooterSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  // Empty string already normalized to NULL by the schema, so "cleared" is one
  // value rather than two — NULL is what makes the future chain fall through.
  const optOutFooter = parsed.data.opt_out_footer;

  const existing = await db
    .select({ id: sms_providers.id })
    .from(sms_providers)
    .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)))
    .limit(1);
  if (!existing[0]) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider" });
  }

  await db
    .update(sms_providers)
    .set({ opt_out_footer: optOutFooter })
    .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)));

  return NextResponse.json({ ok: true, opt_out_footer: optOutFooter });
}
