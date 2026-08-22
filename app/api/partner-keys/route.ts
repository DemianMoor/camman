import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partner_keys } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { generateSecret, generateToken, hashSecret } from "@/lib/intake/partner-key";
import { can } from "@/lib/permissions";
import { partnerKeyCreateSchema } from "@/lib/validators/partner-keys";

// Partner-key management (Drip Phase 2).
//
// ⚠️ NEITHER `token` NOR `secret_hash` IS EVER RETURNED BY THE LIST ENDPOINT.
// The token is half of the credential — it is the URL a partner posts to — so
// it is shown once at creation and then only on the key's own detail response
// to an admin. The secret is shown exactly once, at creation/rotation, and is
// unrecoverable afterwards by construction: only its SHA-256 is stored.

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Usage joins in one query: last 24h of accepted leads plus today's auth
  // failures, so the settings page is a single round trip rather than N+1.
  const rows = await db.execute(drizzleSql`
    SELECT k.id, k.partner_slug, k.name, k.interest_tag_mode, k.interest_tag,
           k.field_mapping, k.sandbox, k.rate_per_sec, k.rate_per_day,
           k.max_payload_bytes, k.status, k.created_at, k.rotated_at, k.last_seen_at,
           k.secret_last4,
           COALESCE(u.leads_24h, 0)::int   AS leads_24h,
           COALESCE(f.auth_fails_today, 0)::int AS auth_fails_today,
           COALESCE(l.total_leads, 0)::int AS total_leads
    FROM partner_keys k
    LEFT JOIN LATERAL (
      SELECT sum(count) AS leads_24h FROM partner_key_usage
      WHERE partner_key_id = k.id AND window_kind = 'day'
        AND window_start > now() - interval '24 hours'
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT sum(count) AS auth_fails_today FROM partner_key_usage
      WHERE partner_key_id = k.id AND window_kind = 'auth_fail'
        AND window_start > now() - interval '24 hours'
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS total_leads FROM lead_inbox WHERE partner_key_id = k.id
    ) l ON true
    WHERE k.org_id = ${orgId}::uuid
    ORDER BY (k.status = 'active') DESC, k.partner_slug
  `);

  return NextResponse.json({ data: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  // Minting a credential is an admin act, matching provider_credentials.manage.
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = partnerKeyCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION, {
      field: parsed.error.issues[0]?.path.join("."),
    });
  }
  const input = parsed.data;

  const token = generateToken();
  const secret = generateSecret();

  try {
    const inserted = await db
      .insert(partner_keys)
      .values({
        org_id: orgId,
        partner_slug: input.partner_slug,
        name: input.name,
        token,
        secret_hash: hashSecret(secret),
        secret_last4: secret.slice(-4),
        interest_tag_mode: input.interest_tag_mode,
        interest_tag: input.interest_tag ?? null,
        field_mapping: input.field_mapping ?? {},
        // The column default is already true; passing it through means an
        // explicit `sandbox: false` at creation is still possible for an
        // operator who knows what they are doing.
        sandbox: input.sandbox ?? true,
        ...(input.rate_per_sec !== undefined ? { rate_per_sec: input.rate_per_sec } : {}),
        ...(input.rate_per_day !== undefined ? { rate_per_day: input.rate_per_day } : {}),
        ...(input.max_payload_bytes !== undefined
          ? { max_payload_bytes: input.max_payload_bytes }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        created_by: user.id,
      })
      .returning();

    const row = inserted[0];
    return NextResponse.json(
      {
        ...row,
        secret_hash: undefined,
        // ⚠️ THE ONLY TIME THE PLAINTEXT SECRET EXISTS OUTSIDE THE PARTNER'S
        // HANDS. Not recoverable afterwards — rotation mints a new one.
        secret,
        token,
      },
      { status: 201 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError(409, "A partner key with that slug already exists", API_ERROR_CODES.DUPLICATE, {
        field: "partner_slug",
      });
    }
    throw e;
  }
}
