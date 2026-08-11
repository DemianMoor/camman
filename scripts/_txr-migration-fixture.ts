import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Test-only fixture: apply not-yet-deployed txr migrations INSIDE a rolled-back
// transaction, so the DB-backed opt-out/DLR tests can exercise real SQL against
// tables that don't exist in the shared database yet.
//
// WHY THIS NEEDS CARE: this project's "dev" database IS production
// (CLAUDE.md §14 — one Supabase project). The txr tables carry foreign keys to
// contacts and stage_sends, and creating them takes a ShareRowExclusiveLock on
// those tables — which live sends and pollers are writing to constantly. A first
// version of this fixture deadlocked against real traffic (40P01).
//
// So: take a short lock_timeout FIRST. A conflicting live write now makes the
// fixture give up in seconds (and the caller SKIPs the DB half) instead of
// queueing behind — or deadlocking with — production writers. Never remove the
// lock_timeout.
const LOCK_TIMEOUT = "3s";

// Postgres codes worth skipping rather than failing on: lock_not_available,
// deadlock_detected, statement/lock timeout.
const LOCK_ERROR_CODES = new Set(["55P03", "40P01", "57014"]);

export function isLockContentionError(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code
    ?? (e as { cause?: { code?: string } })?.cause?.code;
  return !!code && LOCK_ERROR_CODES.has(code);
}

export function migrationStatements(file: string): string[] {
  return readFileSync(resolve(process.cwd(), "db/migrations", file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    // Drop comment-only fragments (a trailing comment block after the last
    // breakpoint is not a statement).
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}

// Applies each migration file's statements in order. Splitting on
// `--> statement-breakpoint` mirrors what drizzle does, so this also proves the
// breakpoints are present and every statement actually runs — the exact failure
// a missing breakpoint causes in production.
export async function applyTxrMigrationsInTx(tx: Tx, files: string[]): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
  // The migrations may already be DEPLOYED (applied to prod 2026-08-11). When
  // they are, the tables/indexes exist and re-running the DDL errors (42P07).
  // Detect the last table (0124) as the sentinel and skip the DDL apply — the
  // DB-backed tests then exercise the LIVE schema, and their data writes still
  // roll back with the caller's transaction. Safe on either side of the apply.
  const applied = (await tx.execute(
    sql`SELECT to_regclass('public.textrequest_inbound_events') AS t`,
  )) as unknown as { t: string | null }[];
  if (applied[0]?.t) return;
  for (const file of files) {
    for (const stmt of migrationStatements(file)) {
      await tx.execute(sql.raw(stmt));
    }
  }
}

export const TXR_MIGRATION_FILES = [
  "0122_textrequest_dlr_events.sql",
  "0123_textrequest_dlr_poll_idempotency.sql",
  "0124_textrequest_inbound_events.sql",
];
