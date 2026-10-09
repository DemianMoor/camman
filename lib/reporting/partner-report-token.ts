import "server-only";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";

// Signed report links for partners (Drip Phase 7; on the PARTNER since 0200).
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
// ⚠️ SCOPE COMES FROM THE PARTNER ROW, NEVER THE URL. resolveReportToken returns
// the partner id it resolved to, and every query downstream is filtered by
// that. The route never accepts a partner id, so there is no parameter to
// tamper with. Since 0200 the link lives on `partners`, one per partner: a
// partner with two keys, or with no key at all (file delivery), has exactly
// one link. The four token columns left on partner_keys are dead copies.
//
// Every function takes an executor (default: the pooled client) so a rolled-
// back fixture test can exercise the real query text —
// scripts/test-partner-report-token-db.ts.

const TOKEN_BYTES = 24;

export interface ResolvedReportToken {
  partnerId: number;
  orgId: string;
  partnerSlug: string;
  partnerName: string;
  showRevenue: boolean;
}

/**
 * Who may hold a link (ruling Q7): a partner with NO keys (file-only) or with at
 * least one NON-sandbox key. A sandbox-only partner never resolves. One
 * definition, used by issue AND resolve, so the Settings button's precondition
 * and the public page agree. The key's own status does not matter here: a
 * disabled key stops intake, archiving the PARTNER stops the link.
 *
 * ⚠️ Expects the partner aliased as `p`. scripts/partners-phase1-exit-check.ts
 * carries this predicate as a literal (it also runs from a checkout that
 * predates this module) — a change here is a change there.
 */
export const PARTNER_CAN_HAVE_LINK: SQL = sql`(
        NOT EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id)
        OR EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id AND k.sandbox = false)
      )`;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/**
 * Issue (or rotate) a partner's report link. Returns the plaintext ONCE.
 *
 * Rotation is the same call: it overwrites the stored hash, which instantly
 * invalidates the previous link — there is only ever one live link per partner.
 * Returns null when the partner is missing (in this org), archived, or
 * sandbox-only; the route tells those apart before calling.
 */
export async function issueReportToken(
  orgId: string,
  partnerId: number,
  expiresAt: Date | null,
  dbc: DbOrTx = db,
): Promise<string | null> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const rows = (await dbc.execute(sql`
    UPDATE partners p
    SET report_token_hash = ${hashToken(token)},
        report_token_issued_at = now(),
        report_token_expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
    WHERE p.id = ${partnerId} AND p.org_id = ${orgId}::uuid
      AND p.status = 'active'
      AND ${PARTNER_CAN_HAVE_LINK}
    RETURNING p.id
  `)) as unknown as { id: number }[];
  return rows.length > 0 ? token : null;
}

/** Revoke the link. The partner and its keys are untouched — intake keeps working. */
export async function revokeReportToken(
  orgId: string,
  partnerId: number,
  dbc: DbOrTx = db,
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    UPDATE partners p
    SET report_token_hash = NULL, report_token_issued_at = NULL,
        report_token_expires_at = NULL
    WHERE p.id = ${partnerId} AND p.org_id = ${orgId}::uuid
    RETURNING p.id
  `)) as unknown as { id: number }[];
  return rows.length > 0;
}

/**
 * Resolve a token to its partner, or null.
 *
 * ⚠️ NULL FOR EVERY FAILURE MODE, INDISTINGUISHABLY — unknown token, revoked
 * token, expired token, archived partner, sandbox-only partner. The caller
 * renders one 404 for all of them, so the page cannot be used to probe which
 * tokens ever existed.
 *
 * ⚠️ The PARTNER's status gates the link (ruling Q7): archiving a partner kills
 * its report link in the same action. A key's status does not — a disabled
 * key only stops intake.
 */
export async function resolveReportToken(
  token: string | null | undefined,
  dbc: DbOrTx = db,
): Promise<ResolvedReportToken | null> {
  const t = (token ?? "").trim();
  // Bound the work an attacker can cause before any DB access.
  if (!t || t.length > 128) return null;

  const rows = (await dbc.execute(sql`
    SELECT p.id, p.org_id, p.slug, p.name, p.report_show_revenue,
           p.report_token_hash, p.report_token_expires_at
    FROM partners p
    WHERE p.report_token_hash = ${hashToken(t)}
      AND p.status = 'active'
      AND ${PARTNER_CAN_HAVE_LINK}
    LIMIT 1
  `)) as unknown as {
    id: number;
    org_id: string;
    slug: string;
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
    partnerId: row.id,
    orgId: row.org_id,
    partnerSlug: row.slug,
    partnerName: row.name,
    showRevenue: row.report_show_revenue === true,
  };
}
