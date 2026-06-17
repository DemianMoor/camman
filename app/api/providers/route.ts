import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
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

  try {
    const [created] = await db
      .insert(sms_providers)
      .values({
        org_id: orgId,
        name: parsed.data.name,
        sms_provider_id: parsed.data.sms_provider_id,
        short_link_supported: parsed.data.short_link_supported ?? false,
        supports_api_send: parsed.data.supports_api_send ?? false,
        send_window_weekday_start: parsed.data.send_window_weekday_start ?? null,
        send_window_weekday_end: parsed.data.send_window_weekday_end ?? null,
        send_window_weekend_start: parsed.data.send_window_weekend_start ?? null,
        send_window_weekend_end: parsed.data.send_window_weekend_end ?? null,
        max_sends_per_second: parsed.data.max_sends_per_second ?? null,
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
