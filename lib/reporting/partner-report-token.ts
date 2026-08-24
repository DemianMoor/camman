import "server-only";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Signed report links for partners (Drip Phase 7).
//
// ⚠️ OPAQUE TOKEN RESOLVED BY DB LOOKUP, NOT A SIGNED HMAC/JWT. Revocation is
// the requirement that decides it: a signed token cannot be revoked without a
// denylist — i.e. without the very lookup signing was meant to avoid. Here,
// revoking is one UPDATE.
//
// ⚠️ HASHED AT REST, like the intake secret. The plaintext is returned once at
// issue and is unrecoverable afterwards, so a database read — a dump, a backup,
// a support query — cannot yield a working report link.
//
// ⚠️ SCOPE COMES FROM THE KEY ROW, NEVER THE URL. resolveReportToken returns the
// partner_key_id it resolved to, and every query downstream is filtered by that.
// The route never accepts a partner id, so there is no parameter to tamper with.

const TOKEN_BYTES = 24;

export interface ResolvedReportToken {
  partnerKeyId: number;
  orgId: string;
  partnerSlug: string;
  partnerName: string;
  showRevenue: boolean;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/**
 * Issue (or rotate) a partner's report link. Returns the plaintext ONCE.
 *
 * Rotation is the same call: it overwrites the stored hash, which instantly
 * invalidates the previous link. That is the ruling's "rotation follows the
 * partner key" — there is only ever one live link per key.
 */
export async function issueReportToken(
  orgId: string,
  partnerKeyId: number,
  expiresAt: Date | null,
): Promise<string | null> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const rows = (await db.execute(sql`
    UPDATE partner_keys
    SET report_token_hash = ${hashToken(token)},
        report_token_issued_at = now(),
        report_token_expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
    WHERE id = ${partnerKeyId} AND org_id = ${orgId}::uuid
    RETURNING id
  `)) as unknown as { id: number }[];
  return rows.length > 0 ? token : null;
}

/** Revoke the link. The key itself is untouched — intake keeps working. */
export async function revokeReportToken(
  orgId: string,
  partnerKeyId: number,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE partner_keys
    SET report_token_hash = NULL, report_token_issued_at = NULL,
        report_token_expires_at = NULL
    WHERE id = ${partnerKeyId} AND org_id = ${orgId}::uuid
    RETURNING id
  `)) as unknown as { id: number }[];
  return rows.length > 0;
}

/**
 * Resolve a token to its partner, or null.
 *
 * ⚠️ NULL FOR EVERY FAILURE MODE, INDISTINGUISHABLY — unknown token, revoked
 * token, expired token, archived key. The caller renders one 404 for all of
 * them, so the page cannot be used to probe which tokens ever existed.
 *
 * ⚠️ The key's OWN status gates the link (ruling): disabling a partner key kills
 * its report link in the same action, with no second thing to remember.
 */
export async function resolveReportToken(
  token: string | null | undefined,
): Promise<ResolvedReportToken | null> {
  const t = (token ?? "").trim();
  // Bound the work an attacker can cause before any DB access.
  if (!t || t.length > 128) return null;

  const rows = (await db.execute(sql`
    SELECT id, org_id, partner_slug, name, report_show_revenue,
           report_token_hash, report_token_expires_at
    FROM partner_keys
    WHERE report_token_hash = ${hashToken(t)}
      AND status = 'active'
      AND sandbox = false
    LIMIT 1
  `)) as unknown as {
    id: number;
    org_id: string;
    partner_slug: string;
    name: string;
    report_show_revenue: boolean;
    report_token_hash: string;
    report_token_expires_at: string | null;
  }[];

  const row = rows[0];
  if (!row) return null;

  // The lookup already matched on the hash; this re-compares it in constant
  // time so the code does not depend on the index comparison's timing
  // characteristics for its security property.
  const a = Buffer.from(hashToken(t), "utf-8");
  const b = Buffer.from(row.report_token_hash, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.report_token_expires_at && new Date(row.report_token_expires_at) <= new Date()) {
    return null;
  }

  return {
    partnerKeyId: row.id,
    orgId: row.org_id,
    partnerSlug: row.partner_slug,
    partnerName: row.name,
    showRevenue: row.report_show_revenue === true,
  };
}
