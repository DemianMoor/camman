import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
import {
  getDescriptor,
  registryKeysForType,
} from "@/lib/sends/providers/registry";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { nullIfEmpty, providerCreateSchema } from "@/lib/validators/providers";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = providerCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // ── Connection type → provider code (869egmakh P3) ─────────────────────────
  // Resolve the code the row will carry, and enforce the anti-drift rule. The
  // client shows this steer too, but the UI is not a boundary: a direct POST
  // must land in exactly the same place.
  let smsProviderId: string;
  // The CONNECTION TYPE this row will be served by (migration 0134). NULL for a
  // custom / no-API provider, which genuinely has no adapter.
  //
  // ⚠️ Writing this is NOT optional. The picker shipped before adapter_code
  // existed, so for a window every provider created through it landed with
  // adapter_code = NULL — which the send path resolves as
  // getAdapter(COALESCE(NULL, '<row code>')) and refuses with
  // `unknown_provider`. A provider you just created through the UI could not
  // send, which is the exact footgun the picker exists to remove, arriving from
  // the other direction.
  let adapterCode: string | null = null;
  if (parsed.data.connection_type) {
    const canonical = parsed.data.connection_type;
    if (!getDescriptor(canonical)) {
      return apiError(400, "Unknown connection type", API_ERROR_CODES.VALIDATION, {
        field: "connection_type",
      });
    }

    // Alias-aware: TextHub is "already present" if EITHER txh or txh2 exists.
    const keys = registryKeysForType(canonical);
    const existing = keys.length
      ? await db
          .select({
            id: sms_providers.id,
            name: sms_providers.name,
            sms_provider_id: sms_providers.sms_provider_id,
          })
          .from(sms_providers)
          .where(
            and(
              eq(sms_providers.org_id, orgId),
              inArray(sms_providers.sms_provider_id, keys),
            ),
          )
          .orderBy(sms_providers.id)
      : [];

    if (existing.length > 0 && !parsed.data.create_separate_row) {
      // REFUSE — and point at the right action. Adding a second account is a
      // credential on the existing row; a second provider row fragments the
      // per-provider circuit breakers, send windows and reporting, which is the
      // cost txh2 already imposes.
      const first = existing[0];
      return apiError(
        409,
        `${getDescriptor(canonical)!.displayName} already exists as provider "${first.sms_provider_id}". Add a new account to it instead of creating a second provider.`,
        API_ERROR_CODES.CONFLICT,
        {
          reason: "connection_type_exists",
          connection_type: canonical,
          existing_providers: existing,
        },
      );
    }

    if (parsed.data.create_separate_row) {
      // Deliberate separate row: the operator supplies the code (the validator
      // already required it). It must not collide with a registry key, or
      // getAdapter would resolve the new row to an adapter by accident.
      const requested = parsed.data.sms_provider_id!;
      if (getDescriptor(requested)) {
        return apiError(
          400,
          `"${requested}" is a reserved connection-type code. Choose a distinct provider ID.`,
          API_ERROR_CODES.VALIDATION,
          { field: "sms_provider_id", reason: "reserved_connection_code" },
        );
      }
      smsProviderId = requested;
      // The whole point of a separate row: its IDENTITY is distinct (`tls-t`)
      // while its TYPE is the canonical one (`tls`). Without this the row is
      // unsendable — which is precisely how provider 948 was created.
      adapterCode = canonical;
    } else {
      // Derived, never typed. Identity and type coincide here.
      smsProviderId = canonical;
      adapterCode = canonical;
    }
  } else {
    // Custom / no-API provider: the operator names it, and there is no adapter.
    // adapterCode stays NULL — a real state, not missing data. Such a row
    // correctly refuses with `unknown_provider` if anything ever tries to send
    // through it, and supports_api_send is false at creation regardless.
    smsProviderId = parsed.data.sms_provider_id!;
  }

  try {
    const [created] = await db
      .insert(sms_providers)
      .values({
        org_id: orgId,
        name: parsed.data.name,
        sms_provider_id: smsProviderId,
        adapter_code: adapterCode,
        short_link_supported: parsed.data.short_link_supported ?? false,
        // Always OFF at creation — never client-settable. Enabling the go-live
        // gate is a deliberate, audited act via POST /api/providers/[id]/api-send.
        supports_api_send: false,
        send_window_weekday_start: parsed.data.send_window_weekday_start ?? null,
        send_window_weekday_end: parsed.data.send_window_weekday_end ?? null,
        send_window_weekend_start: parsed.data.send_window_weekend_start ?? null,
        send_window_weekend_end: parsed.data.send_window_weekend_end ?? null,
        max_sends_per_run: parsed.data.max_sends_per_run ?? null,
        max_sends_per_minute: parsed.data.max_sends_per_minute ?? null,
        max_sends_per_24h: parsed.data.max_sends_per_24h ?? null,
        short_link_example: nullIfEmpty(parsed.data.short_link_example),
        avatar_url: nullIfEmpty(parsed.data.avatar_url),
        color: nullIfEmpty(parsed.data.color),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A provider with this sms_provider_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "sms_provider_id" },
      );
    }
    throw err;
  }
}
