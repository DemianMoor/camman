import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";

import type { db } from "@/db/client";

// No `"server-only"` import: this module is consumed by API/send-path code
// AND by scripts/verify-mint.ts (a plain tsx entry point). It holds no
// secrets — the imported `db` type is type-only and erased at runtime.

// =============================================================================
// Link minting (link shortener — first piece of the TextHub integration)
//
// In a link_mode='tracked' campaign, the send path mints one short link per
// recipient. Minting is:
//   * idempotent per "message": a unique (stage_id, contact_id, send_token)
//     means a retry of the same outbound message reuses the same link/code,
//     while each genuinely new message (new send_token) gets a fresh code.
//   * transactional: callers pass their own tx so the link rows commit (or
//     roll back) atomically with the send.
//   * gated on readiness: a link is only minted once the campaign AND stage
//     tracking IDs exist. A missing tracking ID means "this stage isn't ready
//     to send yet" and throws rather than minting an untracked link.
//
// The public short code is GLOBALLY unique (the redirect resolves by code
// alone — there's no org context on the URL). Codes are random, not
// sequential, so there's no shared counter to contend on; the rare collision
// is caught and retried against the links_code_unique index.
// =============================================================================

// Drizzle's transaction-callback parameter type. Accept either the top-level
// `db` or a transaction handle so callers pass whatever fits their route.
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// URL-safe, unambiguous alphabet: digits + letters minus look-alikes
// (0/O, 1/l/I). 56 symbols. A length-7 code is ~56^7 ≈ 1.7e12 possibilities,
// so collisions are astronomically rare even at millions of links — the
// unique index is the hard guarantee, the retry loop the safety net.
const CODE_ALPHABET =
  "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 7;
const generateCode = customAlphabet(CODE_ALPHABET, CODE_LENGTH);
const MAX_CODE_ATTEMPTS = 5;

// SHA-256 of the trimmed URL — the dedup key for link_destinations. URLs are
// case- and path-sensitive, so (unlike SMS text) we do NOT lowercase or
// collapse; only surrounding whitespace is stripped.
function hashUrl(url: string): string {
  return createHash("sha256").update(url.trim(), "utf-8").digest("hex");
}

// True when the error is a unique violation specifically on the global code
// index. Drizzle wraps the postgres-js error, so SQLSTATE / constraint_name
// can live on the top-level error or its `cause` (see isUniqueViolation in
// lib/api/helpers.ts).
function isCodeCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: unknown;
    constraint_name?: unknown;
    cause?: { code?: unknown; constraint_name?: unknown };
  };
  const is23505 = e.code === "23505" || e.cause?.code === "23505";
  const isCodeIdx =
    e.constraint_name === "links_code_unique" ||
    e.cause?.constraint_name === "links_code_unique";
  return is23505 && isCodeIdx;
}

export interface MintLinkInput {
  orgId: string;
  campaignId: number;
  stageId: number;
  contactId: string;
  // Present at mint time in practice (the stage tracking ID requires a
  // creative), but typed nullable to mirror the schema.
  creativeId: number | null;
  shortDomainId: number;
  // The final destination URL the short link redirects to.
  destinationUrl: string;
  // Caller-supplied idempotency token identifying ONE outbound message.
  // Same token + same (stage, contact) ⇒ reuse; new token ⇒ fresh link.
  sendToken: string;
  // Denormalized onto the link. Both must be non-empty or minting refuses.
  campaignTrackingId: string | null;
  stageTrackingId: string | null;
}

export interface MintLinkResult {
  id: number;
  code: string;
  // false when this call inserted a new link; true when an existing link for
  // the same (stage, contact, send_token) was reused.
  reused: boolean;
}

export async function mintLink(
  tx: DbOrTx,
  input: MintLinkInput,
): Promise<MintLinkResult> {
  const campaignTrackingId = (input.campaignTrackingId ?? "").trim();
  const stageTrackingId = (input.stageTrackingId ?? "").trim();
  if (!campaignTrackingId || !stageTrackingId) {
    throw new Error(
      "mintLink: stage isn't ready to send — both the campaign and stage " +
        "tracking IDs must exist before a tracked link can be minted",
    );
  }

  // 1) Upsert the deduped destination. DO UPDATE (not DO NOTHING) so RETURNING
  //    yields the row id on both insert and conflict.
  const destHash = hashUrl(input.destinationUrl);
  const destRows = (await tx.execute(sql`
    INSERT INTO link_destinations (org_id, url, url_hash)
    VALUES (${input.orgId}, ${input.destinationUrl}, ${destHash})
    ON CONFLICT (org_id, url_hash)
    DO UPDATE SET url = EXCLUDED.url
    RETURNING id
  `)) as unknown as { id: number }[];
  const destinationId = Number(destRows[0]?.id);
  if (!Number.isInteger(destinationId)) {
    throw new Error("mintLink: failed to resolve destination id");
  }

  // 2) Insert the link, idempotent on (stage_id, contact_id, send_token).
  //    The insert is isolated in a SAVEPOINT (nested tx) so that the rare
  //    code collision — which trips the OTHER unique index and aborts the
  //    statement — can be rolled back and retried without poisoning the
  //    caller's surrounding transaction.
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateCode();
    try {
      return await tx.transaction(async (sp) => {
        const inserted = (await sp.execute(sql`
          INSERT INTO links (
            org_id, code, short_domain_id, destination_id, campaign_id,
            stage_id, creative_id, contact_id, send_token,
            campaign_tracking_id, stage_tracking_id
          )
          VALUES (
            ${input.orgId}, ${code}, ${input.shortDomainId}, ${destinationId},
            ${input.campaignId}, ${input.stageId}, ${input.creativeId},
            ${input.contactId}, ${input.sendToken},
            ${campaignTrackingId}, ${stageTrackingId}
          )
          ON CONFLICT (stage_id, contact_id, send_token) DO NOTHING
          RETURNING id, code
        `)) as unknown as { id: number; code: string }[];

        if (inserted[0]) {
          return {
            id: Number(inserted[0].id),
            code: inserted[0].code,
            reused: false,
          };
        }

        // Empty RETURNING ⇒ the (stage, contact, send_token) row already
        // exists. Fetch and reuse it.
        const existing = (await sp.execute(sql`
          SELECT id, code FROM links
          WHERE stage_id = ${input.stageId}
            AND contact_id = ${input.contactId}
            AND send_token = ${input.sendToken}
          LIMIT 1
        `)) as unknown as { id: number; code: string }[];

        if (!existing[0]) {
          throw new Error(
            "mintLink: insert was a no-op but no existing link row was found",
          );
        }
        return {
          id: Number(existing[0].id),
          code: existing[0].code,
          reused: true,
        };
      });
    } catch (err) {
      // Only a code collision is retryable; everything else propagates.
      if (isCodeCollision(err) && attempt < MAX_CODE_ATTEMPTS) continue;
      throw err;
    }
  }

  throw new Error(
    `mintLink: exhausted ${MAX_CODE_ATTEMPTS} attempts to generate a unique code`,
  );
}

// One outbound message to mint a link for: send_token IS the stage_sends row id.
export interface MintLinkBatchItem {
  contactId: string;
  sendToken: string;
}

export interface MintLinkBatchInput {
  orgId: string;
  campaignId: number;
  stageId: number;
  creativeId: number | null;
  shortDomainId: number;
  destinationUrl: string;
  campaignTrackingId: string | null;
  stageTrackingId: string | null;
  items: MintLinkBatchItem[];
}

// 2000 rows × 11 columns = 22K bind params per INSERT — well under Postgres's
// 65535 limit. 500 was conservative and did 4× the round-trips it needed.
const MINT_BATCH_CHUNK = 2000;

// Bulk equivalent of mintLink for a fresh send run (the kickoff path): all items
// share ONE destination and ONE stage, so the destination is upserted ONCE and
// links are inserted in multi-row chunks instead of per-recipient round-trips.
// This is the difference between O(recipients) sequential round-trips (≈178s for
// 1000) and a handful of statements (≈seconds).
//
// Unlike mintLink there is no idempotent "reuse" path — kickoff only calls this
// after refusing on `already_pending`, so every send_token is brand new. The
// only conflict that can occur is the rare global `code` collision, resolved by
// regenerating just the colliding rows' codes and retrying that chunk.
//
// Returns a map send_token → { id, code } so the caller can build each row's
// final tracked URL (the rendered text embeds the code, so it MUST be built from
// the code that actually landed).
export async function mintLinksBatch(
  tx: DbOrTx,
  input: MintLinkBatchInput,
): Promise<Map<string, { id: number; code: string }>> {
  const campaignTrackingId = (input.campaignTrackingId ?? "").trim();
  const stageTrackingId = (input.stageTrackingId ?? "").trim();
  if (!campaignTrackingId || !stageTrackingId) {
    throw new Error(
      "mintLinksBatch: stage isn't ready to send — both the campaign and stage " +
        "tracking IDs must exist before tracked links can be minted",
    );
  }

  const result = new Map<string, { id: number; code: string }>();
  if (input.items.length === 0) return result;

  // 1) Upsert the single shared destination ONCE.
  const destHash = hashUrl(input.destinationUrl);
  const destRows = (await tx.execute(sql`
    INSERT INTO link_destinations (org_id, url, url_hash)
    VALUES (${input.orgId}, ${input.destinationUrl}, ${destHash})
    ON CONFLICT (org_id, url_hash)
    DO UPDATE SET url = EXCLUDED.url
    RETURNING id
  `)) as unknown as { id: number }[];
  const destinationId = Number(destRows[0]?.id);
  if (!Number.isInteger(destinationId)) {
    throw new Error("mintLinksBatch: failed to resolve destination id");
  }

  // 2) Insert links chunk-by-chunk, regenerating codes for the rare collision.
  for (let start = 0; start < input.items.length; start += MINT_BATCH_CHUNK) {
    const chunk = input.items.slice(start, start + MINT_BATCH_CHUNK);
    // sendToken → { contactId, code }; entries drain out as they're confirmed.
    const pending = new Map<string, { contactId: string; code: string }>();
    for (const it of chunk) {
      pending.set(it.sendToken, { contactId: it.contactId, code: generateCode() });
    }

    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS && pending.size > 0; attempt++) {
      const values = [...pending.entries()].map(
        ([sendToken, v]) => sql`(
          ${input.orgId}, ${v.code}, ${input.shortDomainId}, ${destinationId},
          ${input.campaignId}, ${input.stageId}, ${input.creativeId},
          ${v.contactId}, ${sendToken}, ${campaignTrackingId}, ${stageTrackingId}
        )`,
      );
      const inserted = (await tx.execute(sql`
        INSERT INTO links (
          org_id, code, short_domain_id, destination_id, campaign_id,
          stage_id, creative_id, contact_id, send_token,
          campaign_tracking_id, stage_tracking_id
        )
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (code) DO NOTHING
        RETURNING id, code, send_token
      `)) as unknown as { id: number; code: string; send_token: string }[];

      for (const row of inserted) {
        result.set(row.send_token, { id: Number(row.id), code: row.code });
        pending.delete(row.send_token);
      }
      // Whatever didn't come back collided on `code` — give those fresh codes.
      for (const v of pending.values()) v.code = generateCode();
    }

    if (pending.size > 0) {
      throw new Error(
        `mintLinksBatch: exhausted ${MAX_CODE_ATTEMPTS} attempts to mint ${pending.size} unique codes`,
      );
    }
  }

  return result;
}
