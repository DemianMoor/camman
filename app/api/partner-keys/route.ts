import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partner_keys } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { generateSecret, generateToken, hashSecret } from "@/lib/intake/partner-key";
import { KEY_LIST_SQL } from "@/lib/partners/queries";
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

  // Usage joins in one query (KEY_LIST_SQL, shared with /api/partners): last
  // 24h of accepted leads plus today's auth failures, one round trip not N+1.
  // Since 0200 the signed-link state and the revenue flag live on the PARTNER
  // and come from /api/partners, not from a key row.
  const rows = await db.execute(drizzleSql`${KEY_LIST_SQL}
    WHERE k.org_id = ${orgId}::uuid
    ORDER BY (k.status = 'active') DESC, k.partner_slug, k.created_at
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

  // The key belongs to a partner (0200). Slug is copied from it, never typed.
  const owner = (await db.execute(drizzleSql`
    SELECT id, slug, status FROM partners WHERE id = ${input.partner_id} AND org_id = ${orgId}::uuid
  `)) as unknown as { id: number; slug: string; status: string }[];
  if (!owner[0]) {
    return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  }
  if (owner[0].status !== "active") {
    return apiError(409, "Cannot add a key to an archived partner", API_ERROR_CODES.CONFLICT, {
      code: "partner_archived",
    });
  }

  const token = generateToken();
  const secret = generateSecret();

  try {
    const inserted = await db
      .insert(partner_keys)
      .values({
        org_id: orgId,
        partner_id: owner[0].id,
        partner_slug: owner[0].slug,
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
      // Only partner_keys_token_uniq remains since 0200 (the per-org slug
      // uniqueness moved to partners); a 24-byte random collision is theory.
      return apiError(409, "A partner key with that token already exists", API_ERROR_CODES.DUPLICATE, {
        field: "token",
      });
    }
    throw e;
  }
}
