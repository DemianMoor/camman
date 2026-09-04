import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Personal API tokens (ClickUp 869evpmbz, migration 0176).
//
// ⚠️ HASHED, NOT ENCRYPTED — the same call lib/intake/partner-key.ts makes, for
// the same reason. provider_credentials encrypts because CamMan must REPLAY
// those secrets to a provider. An API token is only ever VERIFIED here, so the
// plaintext is never needed again:
//
//   * a database dump yields nothing usable (ciphertext plus a leaked
//     PROVIDER_CREDENTIALS_KEY would yield every live token);
//   * rotating that master key does not invalidate every token;
//   * verification is microseconds rather than a decrypt.
//
// ⚠️ AND DELIBERATELY NOT bcrypt/argon2/scrypt. Slow KDFs defend LOW-ENTROPY
// HUMAN PASSWORDS against offline brute force. The secret here is 256 bits from
// crypto.randomBytes — there is nothing to stretch, and a slow KDF on the auth
// path of an endpoint an agent polls would burn CPU seconds per wall-clock
// second on a function billed by CPU time.
//
// ⚠️ LOOKUP IS BY HASH, WHICH IS WHY THE HASH IS UNIQUE-INDEXED. We never scan
// tokens and compare one by one: the supplied plaintext is hashed and used as
// the index key, so verification is a single index probe regardless of how many
// tokens exist. The constant-time compare below is therefore belt-and-braces
// for the callers that already hold both digests, not the primary defence.

/** Distinguishes a CamMan token at a glance in logs, .env files and pastes. */
const TOKEN_PREFIX = "cmt_";

/** How much of the token is kept in the clear for display. */
const DISPLAY_CHARS = 6;

export interface GeneratedToken {
  /** Shown to the Owner exactly once. Never stored, never logged. */
  plaintext: string;
  /** SHA-256 hex — the only copy that is persisted. */
  hash: string;
  /** Non-secret leading characters, e.g. "cmt_3f9a2b". */
  prefix: string;
}

/**
 * Mint a new token.
 *
 * 32 random bytes, base64url so the whole thing is copy-pasteable into a header
 * or a shell without escaping.
 */
export function generateApiToken(): GeneratedToken {
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return {
    plaintext,
    hash: hashApiToken(plaintext),
    prefix: plaintext.slice(0, TOKEN_PREFIX.length + DISPLAY_CHARS),
  };
}

export function hashApiToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf-8").digest("hex");
}

/**
 * Constant-time compare of two hex digests.
 *
 * The length pre-check leaks nothing: both sides are always 64-char SHA-256 hex,
 * so length never varies with the secret.
 */
export function tokenHashMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

/**
 * Pull the bearer token out of an Authorization header value.
 *
 * Returns null for anything that is not a `cmt_`-prefixed bearer. That prefix
 * test is what keeps this from colliding with the ~20 cron routes that compare
 * the same header against `Bearer <CRON_SECRET>`: a cron call is never mistaken
 * for a token call, and a token is never offered to the cron comparison.
 */
export function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const value = match?.[1];
  if (!value || !value.startsWith(TOKEN_PREFIX)) return null;
  return value;
}

export type TokenRejection =
  | "unknown_token"
  | "token_revoked"
  | "token_expired"
  | "membership_inactive"
  | "api_disabled";

export interface ResolvedApiToken {
  tokenId: string;
  orgId: string;
  orgMemberId: string;
  userId: string;
  role: string;
  readOnly: boolean;
  tokenName: string;
}

export type TokenResolution =
  | { ok: true; token: ResolvedApiToken }
  | {
      ok: false;
      reason: TokenRejection;
      tokenId: string | null;
      orgId: string | null;
      /**
       * The member the token belongs to.
       *
       * ⚠️ CARRIED ON THE FAILURE BRANCH ON PURPOSE. The per-user usage drill-in
       * filters audit_log on `actor_user_id`, so a denial written without one is
       * invisible on the screen built to show denials. Caught by the production
       * smoke test: three `api.denied` rows (api_enabled=false, revoked,
       * switched-off) landed with a NULL actor while the token-keyed counter
       * still counted them, so the panel's totals and its hourly series
       * disagreed. Null only for `unknown_token`, which by definition has no
       * member.
       */
      userId: string | null;
    };

/**
 * Resolve a plaintext token to the membership it authorises.
 *
 * ONE query. It joins org_members so `is_active` and `api_enabled` are read in
 * the same round trip that resolves the token — exactly the property that makes
 * getApiMembershipRow() cheap for sessions, preserved here. A revocation, a
 * deactivation or an API switch-off therefore takes effect on the very NEXT
 * request rather than at some cache expiry.
 *
 * ⚠️ A REJECTION STILL REPORTS token_id AND org_id WHERE IT KNOWS THEM. The
 * caller needs both to write the `api.denied` audit row and to count the denial
 * against the right token — a denial that cannot be attributed is a denial the
 * Owner cannot investigate. Only `unknown_token` (a string matching no row —
 * a scanner, or a token deleted outright) has neither.
 */
export async function resolveApiToken(
  plaintext: string,
): Promise<TokenResolution> {
  const hash = hashApiToken(plaintext);

  const rows = (await db.execute(sql`
    SELECT
      t.id::text          AS token_id,
      t.org_id::text      AS org_id,
      t.org_member_id::text AS org_member_id,
      t.token_hash        AS token_hash,
      t.name              AS token_name,
      t.read_only         AS read_only,
      t.revoked_at        AS revoked_at,
      t.expires_at        AS expires_at,
      m.user_id::text     AS user_id,
      m.role              AS role,
      m.is_active         AS is_active,
      m.api_enabled       AS api_enabled
    FROM api_tokens t
    JOIN org_members m ON m.id = t.org_member_id
    WHERE t.token_hash = ${hash}
    LIMIT 1
  `)) as unknown as {
    token_id: string;
    org_id: string;
    org_member_id: string;
    token_hash: string;
    token_name: string;
    read_only: boolean;
    revoked_at: Date | null;
    expires_at: Date | null;
    user_id: string;
    role: string;
    is_active: boolean;
    api_enabled: boolean;
  }[];

  const row = rows[0];
  if (!row) {
    return { ok: false, reason: "unknown_token", tokenId: null, orgId: null, userId: null };
  }
  // Redundant after an index hit on a unique column, but free and it keeps the
  // comparison constant-time if this lookup is ever widened.
  if (!tokenHashMatches(row.token_hash, hash)) {
    return { ok: false, reason: "unknown_token", tokenId: null, orgId: null, userId: null };
  }

  const ids = { tokenId: row.token_id, orgId: row.org_id, userId: row.user_id };

  // ORDER IS DELIBERATE: properties of the TOKEN first, then of the MEMBERSHIP.
  // A revoked token belonging to a deactivated user should report as revoked —
  // that is the fact the Owner acted on.
  if (row.revoked_at !== null) {
    return { ok: false, reason: "token_revoked", ...ids };
  }
  // `new Date(...)` rather than calling .getTime() on the driver's value: this
  // row comes back from a raw db.execute, where the column arrives as whatever
  // postgres-js decides to hand back. Re-wrapping is free and cannot throw on an
  // auth path; trusting the static type here could.
  if (
    row.expires_at !== null &&
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    return { ok: false, reason: "token_expired", ...ids };
  }
  if (!row.is_active) {
    return { ok: false, reason: "membership_inactive", ...ids };
  }
  if (!row.api_enabled) {
    return { ok: false, reason: "api_disabled", ...ids };
  }

  return {
    ok: true,
    token: {
      tokenId: row.token_id,
      orgId: row.org_id,
      orgMemberId: row.org_member_id,
      userId: row.user_id,
      role: row.role,
      readOnly: row.read_only,
      tokenName: row.token_name,
    },
  };
}

/**
 * Stamp last_used_at.
 *
 * Best-effort and throttled to once a minute: this is observability, and making
 * a request fail because a timestamp write lost a race would be absurd. The
 * throttle also keeps a chatty agent from turning one hot row into the
 * bottleneck for every call. Same construction as touchLastSeen() for partner
 * keys.
 */
export async function touchTokenLastUsed(tokenId: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE api_tokens
      SET last_used_at = now()
      WHERE id = ${tokenId}::uuid
        AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
    `);
  } catch (err) {
    console.error("[api-tokens] last_used_at stamp failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
