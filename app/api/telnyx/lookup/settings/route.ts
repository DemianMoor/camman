import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { lookup_settings } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Read the single global lookup config row. Permission: operator+.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.run")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const [row] = await db
    .select()
    .from(lookup_settings)
    .where(eq(lookup_settings.id, true))
    .limit(1);

  return NextResponse.json(row ?? {});
}

const patchSchema = z
  .object({
    lookup_paused: z.boolean().optional(),
    lookup_daily_cap: z.number().int().positive().optional(),
    lookup_rate_base: z.union([z.string(), z.number()]).optional(),
    lookup_rate_mobile: z.union([z.string(), z.number()]).optional(),
    lookup_concurrency_rps: z.number().int().positive().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

// Update the single global lookup config row. Numeric-rate columns arrive as
// string|number and are coerced to String() for the numeric column. Permission: manager+.
export async function PATCH(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.lookup_paused !== undefined) {
    patch.lookup_paused = parsed.data.lookup_paused;
  }
  if (parsed.data.lookup_daily_cap !== undefined) {
    patch.lookup_daily_cap = parsed.data.lookup_daily_cap;
  }
  if (parsed.data.lookup_rate_base !== undefined) {
    patch.lookup_rate_base = String(parsed.data.lookup_rate_base);
  }
  if (parsed.data.lookup_rate_mobile !== undefined) {
    patch.lookup_rate_mobile = String(parsed.data.lookup_rate_mobile);
  }
  if (parsed.data.lookup_concurrency_rps !== undefined) {
    patch.lookup_concurrency_rps = parsed.data.lookup_concurrency_rps;
  }

  const [row] = await db
    .update(lookup_settings)
    .set(patch)
    .where(eq(lookup_settings.id, true))
    .returning();

  return NextResponse.json(row ?? {});
}
