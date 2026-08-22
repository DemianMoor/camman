import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Partner-key credentials — Drip Phase 2, ruling G11.
//
// ⚠️ THE SECRET IS HASHED, NOT ENCRYPTED, and that is a deliberate departure
// from lib/crypto/secret-box.ts. provider_credentials encrypts because CamMan
// must REPLAY those secrets to a provider. A partner secret is only ever
// VERIFIED here, so the plaintext is never needed again:
//
//   * a database dump yields nothing usable (ciphertext + a leaked
//     PROVIDER_CREDENTIALS_KEY would yield every live partner secret);
//   * rotating that master key does not break every partner;
//   * verification is microseconds, not a decrypt.
//
// ⚠️ And deliberately NOT bcrypt/argon2/scrypt. Slow KDFs defend LOW-ENTROPY
// HUMAN PASSWORDS against offline brute force. `secret` here is 256 bits from
// crypto.randomBytes — there is nothing to stretch, and at the 50 req/s this
// endpoint is specced for, bcrypt cost-10 would burn ~5 CPU-seconds per
// wall-clock second on a function billed by CPU time.

/** Opaque path token. URL-safe, no padding. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The shared secret. Shown to the operator exactly once, then only its hash is kept. */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf-8").digest("hex");
}

/**
 * Constant-time compare of two hex digests.
 *
 * Same construction as `safeEqual` in lib/sends/tells-webhook-shared.ts. Its
 * length pre-check is not a leak here: both sides are always 64-char SHA-256
 * hex, so length never varies with the secret.
 */
export function secretMatches(supplied: string | null, storedHash: string | null): boolean {
  if (!supplied || !storedHash) return false;
  const a = hashSecret(supplied);
  if (a.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ storedHash.charCodeAt(i);
  return diff === 0;
}

export interface ResolvedPartnerKey {
  id: number;
  org_id: string;
  partner_slug: string;
  name: string;
  secret_hash: string;
  interest_tag_mode: "force" | "default";
  interest_tag: string | null;
  field_mapping: Record<string, string>;
  sandbox: boolean;
  rate_per_sec: number;
  rate_per_day: number;
  max_payload_bytes: number;
  status: string;
}

/**
 * Resolve an opaque path token to its key.
 *
 * Returns disabled keys too — the caller distinguishes "unknown token" (log
 * only; a public URL is scanned constantly) from "disabled key" (a 403 the
 * partner should see), and conflating them would make a disabled partner look
 * like a scanner.
 */
export async function resolvePartnerKey(
  dbc: DbOrTx,
  token: string,
): Promise<ResolvedPartnerKey | null> {
  const rows = (await dbc.execute(sql`
    SELECT id, org_id, partner_slug, name, secret_hash, interest_tag_mode, interest_tag,
           field_mapping, sandbox, rate_per_sec, rate_per_day, max_payload_bytes, status
    FROM partner_keys
    WHERE token = ${token}
    LIMIT 1
  `)) as unknown as ResolvedPartnerKey[];
  return rows[0] ?? null;
}

/**
 * Stamp last_seen_at. Best-effort and fire-and-forget: this is an observability
 * nicety, and failing a partner's lead delivery because a timestamp write lost a
 * race would be absurd. Throttled to once a minute so a 50 req/s partner does
 * not turn one hot row into the bottleneck for the whole endpoint.
 */
export async function touchLastSeen(dbc: DbOrTx, partnerKeyId: number): Promise<void> {
  await dbc.execute(sql`
    UPDATE partner_keys
    SET last_seen_at = now()
    WHERE id = ${partnerKeyId}
      AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')
  `);
}
