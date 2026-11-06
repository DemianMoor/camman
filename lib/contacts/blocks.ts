import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { closeJourneyOnBlock } from "@/lib/drip/lifecycle";
import { validatePhone } from "@/lib/phone-validation";
import { pgArray } from "@/lib/telnyx/pg-array";

// Contact blocks + soft delete — the ONLY writer of `contact_blocks`,
// `contacts.blocked_at` / `block_reason` and `contacts.archived_at`
// (spec docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md
// §2 D2 and §4; guard scripts/test-contact-blocks-single-writer.ts).
//
// Every function runs inside the caller's transaction, so a block, its send
// cancellation and its journey close commit together or not at all.
//
// ⚠️ INVARIANTS (D2 + amendment A1):
//   1. contacts.blocked_at IS NOT NULL ⇔ an ACTIVE contact_blocks row for
//      (org, phone) whose reason is not 'deleted'; block_reason mirrors it.
//   2. An archived contact ALWAYS has an active ledger row ('deleted' or a
//      block reason). No transition below may leave it without one.
//   3. One active row per (org, phone) — the partial unique index
//      contact_blocks_org_phone_active_uniq.
//
// ⚠️ PRECEDENCE: opt_out > blocked > archived > active. Nothing here reads or
// writes opt_outs: unblocking never releases an opt-out (O11).
//
// The messaging_status trigger (0237) derives 'blocked' from blocked_at /
// archived_at, so every `= 'eligible'` audience gate drops these contacts with
// no SQL change of its own (D1).

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Reasons a contact can be BLOCKED for (contacts.block_reason). */
export const BLOCK_REASONS = ["provider_list", "manual", "complaint", "carrier_block"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];
/** Ledger reasons: the block reasons plus 'deleted' (soft delete). */
export type LedgerReason = BlockReason | "deleted";

/** pending stage_sends cancelled at block / delete time get this last_error (D6). */
export type CancelCode = "contact_blocked" | "contact_deleted";

const CHUNK = 5000;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/**
 * Normalize ledger keys to strict E.164. Throws on any invalid input, so the
 * ledger only ever holds the key every import path looks up (spec §4).
 */
export function normalizeBlockPhones(raw: string[]): string[] {
  const out = new Set<string>();
  let invalid = 0;
  for (const r of raw) {
    const n = validatePhone(r, "US", "strict").normalized;
    if (n) out.add(n);
    else invalid++;
  }
  if (invalid > 0) throw new Error(`normalizeBlockPhones: ${invalid} invalid phone number(s)`);
  return [...out];
}

/** Classifies a ledger reason for import summaries: deleted vs blocked. */
export function blockKind(reason: LedgerReason): "deleted" | "blocked" {
  return reason === "deleted" ? "deleted" : "blocked";
}

/**
 * The import check (spec §5). Given NORMALIZED phones, returns the ones that
 * must be skipped, with their reason.
 *
 * Belt and braces (A1): a phone whose existing contact is archived or blocked
 * counts as blocked even with no active ledger row. That state breaks the
 * invariant, so it is logged — org and contact id only, never the phone.
 */
export async function findActiveBlocks(
  tx: DbOrTx,
  orgId: string,
  phones: string[],
): Promise<Map<string, LedgerReason>> {
  const out = new Map<string, LedgerReason>();
  for (const part of chunks([...new Set(phones)])) {
    const arr = pgArray(part, "text");
    const ledger = (await tx.execute(sql`
      SELECT phone_number, reason FROM contact_blocks
      WHERE org_id = ${orgId}::uuid AND released_at IS NULL AND phone_number = ANY(${arr})
    `)) as unknown as { phone_number: string; reason: LedgerReason }[];
    for (const r of ledger) out.set(r.phone_number, r.reason);

    const stray = (await tx.execute(sql`
      SELECT id, phone_number, block_reason, archived_at IS NOT NULL AS archived
      FROM contacts
      WHERE org_id = ${orgId}::uuid AND phone_number = ANY(${arr})
        AND (blocked_at IS NOT NULL OR archived_at IS NOT NULL)
    `)) as unknown as { id: string; phone_number: string; block_reason: BlockReason | null; archived: boolean }[];
    for (const c of stray) {
      if (out.has(c.phone_number)) continue;
      console.error("[contact-blocks] invariant: contact is blocked/archived with no active ledger row", {
        orgId,
        contactId: c.id,
      });
      out.set(c.phone_number, c.block_reason ?? "deleted");
    }
  }
  return out;
}

/** The `blocked` part of every import summary (spec §5). */
export interface BlockedSummary {
  blocked: number;
  blocked_by_reason: { deleted: number; blocked: number };
  /** Up to 10 skipped phones, for the result screen. */
  blocked_samples: string[];
}

/**
 * The one import rule (spec §5): split already-validated, deduped items into
 * those that may proceed and those whose phone is blocked or deleted. A blocked
 * phone gets no contact insert or update, no membership, no attributes.
 */
export async function partitionBlocked<T>(
  tx: DbOrTx,
  orgId: string,
  items: T[],
  phoneOf: (item: T) => string,
): Promise<{ allowed: T[]; blockedPhones: Map<string, LedgerReason>; summary: BlockedSummary }> {
  const found = await findActiveBlocks(tx, orgId, items.map(phoneOf));
  const summary: BlockedSummary = { blocked: 0, blocked_by_reason: { deleted: 0, blocked: 0 }, blocked_samples: [] };
  const allowed: T[] = [];
  for (const item of items) {
    const reason = found.get(phoneOf(item));
    if (!reason) {
      allowed.push(item);
      continue;
    }
    summary.blocked++;
    summary.blocked_by_reason[blockKind(reason)]++;
    if (summary.blocked_samples.length < 10) summary.blocked_samples.push(phoneOf(item));
  }
  return { allowed, blockedPhones: found, summary };
}

/**
 * Cancel what a blocked / deleted contact still has queued: PENDING stage_sends
 * become `filtered` with last_error = code (D6) — never `sending`, which may
 * already be out — and its campaign_audience_pool rows go, so nothing
 * re-materializes. The lib/telnyx/sync-contacts.ts landline model, org-scoped.
 */
export async function cancelForContacts(
  tx: DbOrTx,
  orgId: string,
  contactIds: string[],
  code: CancelCode,
): Promise<{ sends_cancelled: number; pool_removed: number }> {
  let sends_cancelled = 0;
  let pool_removed = 0;
  for (const part of chunks(contactIds)) {
    const arr = pgArray(part, "uuid");
    const s = (await tx.execute(sql`
      UPDATE stage_sends SET status = 'filtered', last_error = ${code}
      WHERE org_id = ${orgId}::uuid AND contact_id = ANY(${arr}) AND status = 'pending'
      RETURNING id
    `)) as unknown as unknown[];
    const p = (await tx.execute(sql`
      DELETE FROM campaign_audience_pool
      WHERE org_id = ${orgId}::uuid AND contact_id = ANY(${arr})
      RETURNING contact_id
    `)) as unknown as unknown[];
    sends_cancelled += s.length;
    pool_removed += p.length;
  }
  return { sends_cancelled, pool_removed };
}

/** Close live drip journeys as `exited` (D4). */
export async function closeJourneysForContacts(
  tx: DbOrTx,
  orgId: string,
  contactIds: string[],
  reason: "contact_blocked" | "contact_deleted",
): Promise<number> {
  let closed = 0;
  for (const part of chunks(contactIds)) {
    closed += (await closeJourneyOnBlock(tx, { orgId, contactIds: part, reason })).closed;
  }
  return closed;
}

export interface BlockResult {
  blocked_added: number;
  already_blocked: number;
  contacts_updated: number;
  sends_cancelled: number;
  pool_removed: number;
  journeys_closed: number;
}

/**
 * Block phones (D2 rows "Block"):
 *   no active row        → insert; set blocked_at on the contact, if any
 *   active 'deleted'     → release it and insert the block (history kept);
 *                          the contact stays archived
 *   another block reason → no-op, counted already_blocked
 */
export async function blockPhones(
  tx: DbOrTx,
  input: {
    orgId: string;
    phones: string[];
    reason: BlockReason;
    source: string | null;
    note: string | null;
    actorId: string | null;
    batchId: number | null;
  },
): Promise<BlockResult> {
  const { orgId, reason, source, note, actorId, batchId } = input;
  const res: BlockResult = {
    blocked_added: 0,
    already_blocked: 0,
    contacts_updated: 0,
    sends_cancelled: 0,
    pool_removed: 0,
    journeys_closed: 0,
  };
  const newlyBlocked: string[] = [];

  for (const part of chunks(normalizeBlockPhones(input.phones))) {
    const arr = pgArray(part, "text");
    const active = (await tx.execute(sql`
      SELECT phone_number, reason FROM contact_blocks
      WHERE org_id = ${orgId}::uuid AND released_at IS NULL AND phone_number = ANY(${arr})
      FOR UPDATE
    `)) as unknown as { phone_number: string; reason: LedgerReason }[];
    const blocked = new Set(active.filter((r) => r.reason !== "deleted").map((r) => r.phone_number));
    const deleted = active.filter((r) => r.reason === "deleted").map((r) => r.phone_number);
    res.already_blocked += blocked.size;

    if (deleted.length > 0) {
      await tx.execute(sql`
        UPDATE contact_blocks SET released_at = now(), released_by = ${actorId}::uuid
        WHERE org_id = ${orgId}::uuid AND released_at IS NULL AND reason = 'deleted'
          AND phone_number = ANY(${pgArray(deleted, "text")})
      `);
    }

    const toInsert = part.filter((p) => !blocked.has(p));
    if (toInsert.length === 0) continue;
    const inserted = (await tx.execute(sql`
      INSERT INTO contact_blocks (org_id, phone_number, reason, source, note, batch_id, created_by)
      SELECT ${orgId}::uuid, p, ${reason}, ${source}, ${note}, ${batchId}::int, ${actorId}::uuid
      FROM unnest(${pgArray(toInsert, "text")}) AS p
      ON CONFLICT (org_id, phone_number) WHERE released_at IS NULL DO NOTHING
      RETURNING phone_number
    `)) as unknown as { phone_number: string }[];
    res.blocked_added += inserted.length;
    res.already_blocked += toInsert.length - inserted.length; // lost a race to a concurrent block
    if (inserted.length === 0) continue;

    const contacts = (await tx.execute(sql`
      UPDATE contacts SET blocked_at = now(), block_reason = ${reason}, updated_at = now()
      WHERE org_id = ${orgId}::uuid AND blocked_at IS NULL
        AND phone_number = ANY(${pgArray(inserted.map((r) => r.phone_number), "text")})
      RETURNING id
    `)) as unknown as { id: string }[];
    res.contacts_updated += contacts.length;
    newlyBlocked.push(...contacts.map((c) => c.id));
  }

  const c = await cancelForContacts(tx, orgId, newlyBlocked, "contact_blocked");
  res.sends_cancelled = c.sends_cancelled;
  res.pool_removed = c.pool_removed;
  res.journeys_closed = await closeJourneysForContacts(tx, orgId, newlyBlocked, "contact_blocked");
  return res;
}

export interface UnblockResult {
  released: number;
  contacts_unblocked: number;
  /** A1: archived contacts whose block was released got a 'deleted' row instead. */
  deleted_rows_inserted: number;
}

/**
 * Unblock (D2 rows "Unblock"): release the active block row and clear
 * blocked_at / block_reason. If the contact is archived, insert a 'deleted' row
 * in the same transaction so it keeps an active ledger row (A1). 'deleted' rows
 * are never released here (that is restoreContacts). opt_outs are never touched.
 */
export async function unblockPhones(
  tx: DbOrTx,
  input: { orgId: string; actorId: string | null } & (
    | { phones: string[]; blockIds?: never }
    | { blockIds: number[]; phones?: never }
  ),
): Promise<UnblockResult> {
  const { orgId, actorId } = input;
  const res: UnblockResult = { released: 0, contacts_unblocked: 0, deleted_rows_inserted: 0 };
  const keys: { col: "phone_number" | "id"; vals: string[] } = input.phones
    ? { col: "phone_number", vals: normalizeBlockPhones(input.phones) }
    : { col: "id", vals: input.blockIds.map(String) };

  for (const part of chunks(keys.vals)) {
    const match =
      keys.col === "phone_number"
        ? sql`phone_number = ANY(${pgArray(part, "text")})`
        : sql`id = ANY(${pgArray(part, "bigint")})`;
    const released = (await tx.execute(sql`
      UPDATE contact_blocks SET released_at = now(), released_by = ${actorId}::uuid
      WHERE org_id = ${orgId}::uuid AND released_at IS NULL AND reason <> 'deleted' AND ${match}
      RETURNING phone_number
    `)) as unknown as { phone_number: string }[];
    res.released += released.length;
    if (released.length === 0) continue;

    const phones = pgArray(released.map((r) => r.phone_number), "text");
    const contacts = (await tx.execute(sql`
      UPDATE contacts SET blocked_at = NULL, block_reason = NULL, updated_at = now()
      WHERE org_id = ${orgId}::uuid AND phone_number = ANY(${phones})
      RETURNING phone_number, archived_at IS NOT NULL AS archived
    `)) as unknown as { phone_number: string; archived: boolean }[];
    res.contacts_unblocked += contacts.length;

    const archived = contacts.filter((c) => c.archived).map((c) => c.phone_number);
    if (archived.length > 0) {
      const ins = (await tx.execute(sql`
        INSERT INTO contact_blocks (org_id, phone_number, reason, source, created_by)
        SELECT ${orgId}::uuid, p, 'deleted', 'unblock of a deleted contact', ${actorId}::uuid
        FROM unnest(${pgArray(archived, "text")}) AS p
        ON CONFLICT (org_id, phone_number) WHERE released_at IS NULL DO NOTHING
        RETURNING id
      `)) as unknown as unknown[];
      res.deleted_rows_inserted += ins.length;
    }
  }
  return res;
}

export interface SoftDeleteResult {
  contacts_deleted: number;
  deleted_rows_inserted: number;
  sends_cancelled: number;
  pool_removed: number;
  journeys_closed: number;
}

/**
 * Soft delete (D2 rows "Delete"): set archived_at (and the legacy is_archived
 * until 0238 drops it); insert a 'deleted' ledger row unless the phone already
 * has an active block row, which is kept. Cancels sends, closes journeys.
 * Already-deleted contacts are a no-op.
 */
export async function softDeleteContacts(
  tx: DbOrTx,
  input: { orgId: string; contactIds: string[]; actorId: string | null },
): Promise<SoftDeleteResult> {
  const { orgId, actorId } = input;
  const res: SoftDeleteResult = {
    contacts_deleted: 0,
    deleted_rows_inserted: 0,
    sends_cancelled: 0,
    pool_removed: 0,
    journeys_closed: 0,
  };
  const deletedIds: string[] = [];
  for (const part of chunks([...new Set(input.contactIds)])) {
    const rows = (await tx.execute(sql`
      UPDATE contacts SET archived_at = now(), is_archived = true, updated_at = now()
      WHERE org_id = ${orgId}::uuid AND id = ANY(${pgArray(part, "uuid")}) AND archived_at IS NULL
      RETURNING id, phone_number
    `)) as unknown as { id: string; phone_number: string }[];
    res.contacts_deleted += rows.length;
    if (rows.length === 0) continue;
    deletedIds.push(...rows.map((r) => r.id));
    const ins = (await tx.execute(sql`
      INSERT INTO contact_blocks (org_id, phone_number, reason, source, created_by)
      SELECT ${orgId}::uuid, p, 'deleted', 'contact deleted', ${actorId}::uuid
      FROM unnest(${pgArray(rows.map((r) => r.phone_number), "text")}) AS p
      ON CONFLICT (org_id, phone_number) WHERE released_at IS NULL DO NOTHING
      RETURNING id
    `)) as unknown as unknown[];
    res.deleted_rows_inserted += ins.length;
  }
  const c = await cancelForContacts(tx, orgId, deletedIds, "contact_deleted");
  res.sends_cancelled = c.sends_cancelled;
  res.pool_removed = c.pool_removed;
  res.journeys_closed = await closeJourneysForContacts(tx, orgId, deletedIds, "contact_deleted");
  return res;
}

/**
 * Restore (D2 rows "Restore"): clear archived_at and release the 'deleted' row.
 * A block row is kept, so a restored blocked contact stays blocked. Cancelled
 * sends and removed pool rows are NOT brought back.
 */
export async function restoreContacts(
  tx: DbOrTx,
  input: { orgId: string; contactIds: string[]; actorId: string | null },
): Promise<{ contacts_restored: number; deleted_rows_released: number }> {
  const { orgId, actorId } = input;
  const res = { contacts_restored: 0, deleted_rows_released: 0 };
  for (const part of chunks([...new Set(input.contactIds)])) {
    const rows = (await tx.execute(sql`
      UPDATE contacts SET archived_at = NULL, is_archived = false, updated_at = now()
      WHERE org_id = ${orgId}::uuid AND id = ANY(${pgArray(part, "uuid")}) AND archived_at IS NOT NULL
      RETURNING phone_number
    `)) as unknown as { phone_number: string }[];
    res.contacts_restored += rows.length;
    if (rows.length === 0) continue;
    const rel = (await tx.execute(sql`
      UPDATE contact_blocks SET released_at = now(), released_by = ${actorId}::uuid
      WHERE org_id = ${orgId}::uuid AND released_at IS NULL AND reason = 'deleted'
        AND phone_number = ANY(${pgArray(rows.map((r) => r.phone_number), "text")})
      RETURNING id
    `)) as unknown as unknown[];
    res.deleted_rows_released += rel.length;
  }
  return res;
}

/**
 * Release every still-active row of an upload batch through unblockPhones, and
 * stamp the batch. Returns null when the batch is not in this org.
 */
export async function releaseBatch(
  tx: DbOrTx,
  input: { orgId: string; batchId: number; actorId: string | null },
): Promise<UnblockResult | null> {
  const { orgId, batchId, actorId } = input;
  const batch = (await tx.execute(sql`
    SELECT id FROM contact_block_batches WHERE id = ${batchId} AND org_id = ${orgId}::uuid FOR UPDATE
  `)) as unknown as { id: number }[];
  if (batch.length === 0) return null;
  const ids = (await tx.execute(sql`
    SELECT id FROM contact_blocks
    WHERE org_id = ${orgId}::uuid AND batch_id = ${batchId} AND released_at IS NULL
  `)) as unknown as { id: number }[];
  const res = await unblockPhones(tx, { orgId, actorId, blockIds: ids.map((r) => Number(r.id)) });
  await tx.execute(sql`
    UPDATE contact_block_batches
    SET released_at = now(), released_by = ${actorId}::uuid,
        released_count = COALESCE(released_count, 0) + ${res.released}
    WHERE id = ${batchId}
  `);
  return res;
}
