import "server-only";

import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider_route_aliases, sms_providers } from "@/db/schema";
import type { Role } from "@/lib/permissions";

// redactForRole() — the single response-boundary layer that keeps SMS provider
// identity away from the operator (ClickUp 869et3vm1, Phase 2).
//
// ── WHY A VALUE SWEEP AND NOT A FIELD LIST ────────────────────────────────
//
// The obvious design is "null out provider_name on the routes that select it".
// That fails the moment someone adds a join, renames a field, or returns a
// nested provider object from a new endpoint — and it fails SILENTLY, because
// nothing goes red when a name starts leaking through a field nobody listed.
//
// So this sweeps VALUES, not just keys: any string in the payload that is
// exactly a provider name (or a provider code like `txh`) is replaced with its
// route alias, wherever it appears and however deeply nested. That is the
// property scripts/verify-operator-access.ts asserts directly — it fetches
// every allowed route as a real operator and greps the body for every string
// in `SELECT name FROM sms_providers`. A field-list redactor could not make
// that assertion true by construction; this can.
//
// EXACT, WHOLE-STRING MATCHES ONLY. Substring matching would mangle real
// content — a creative body mentioning a brand, a campaign named after a
// partner. A whole-string match on "TextHub" cannot collide with prose, and
// over-redaction here is the safe direction anyway.
//
// ── WHAT AN ALIAS IS ──────────────────────────────────────────────────────
//
// "Route A", "Route B", … one per provider, assigned in provider-id order and
// then STABLE FOREVER: the operator refers to routes by these letters, so a
// letter that moves is worse than no alias at all. Stored in
// provider_route_aliases (migration 0175) rather than computed, precisely so
// it cannot drift when a provider is added or archived.
//
// Owner and every other role see the real names; only `operator` is redacted.

const PROVIDER_IDENTITY_KEYS = new Set([
  "provider_name",
  "sms_provider_id",
  "adapter_code",
  "connection_type",
  "connection_type_name",
  "connection_type_blurb",
  "provider_key",
]);

export interface AliasTable {
  /** provider id → alias */
  byId: Map<number, string>;
  /** every redactable string (provider name, provider code) → alias */
  byValue: Map<string, string>;
}

function aliasFor(index: number): string {
  // A, B, … Z, then AA, AB, … Enough for far more providers than will ever
  // exist, and never a bare number, which would read like an id.
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Route ${out}`;
}

/**
 * Load the alias table, seeding any provider that does not have one yet.
 *
 * Seeding on read (rather than in a migration or a one-off script) means a
 * provider added next month gets an alias the first time an operator loads a
 * page, with no deploy and no manual step. It is idempotent and ordered by
 * provider id, so the letters are deterministic.
 */
export async function loadAliasTable(orgId: string): Promise<AliasTable> {
  const providers = await db
    .select({
      id: sms_providers.id,
      name: sms_providers.name,
      code: sms_providers.sms_provider_id,
    })
    .from(sms_providers)
    .where(eq(sms_providers.org_id, orgId))
    .orderBy(asc(sms_providers.id));

  const existing = await db
    .select({
      sms_provider_id: provider_route_aliases.sms_provider_id,
      alias: provider_route_aliases.alias,
    })
    .from(provider_route_aliases)
    .where(eq(provider_route_aliases.org_id, orgId));

  const byId = new Map<number, string>();
  for (const row of existing) byId.set(row.sms_provider_id, row.alias);

  // Seed missing ones. The next free letter continues from however many
  // aliases already exist, so an existing "Route A" is never reassigned.
  let next = byId.size;
  const toInsert: { org_id: string; sms_provider_id: number; alias: string }[] = [];
  for (const p of providers) {
    if (byId.has(p.id)) continue;
    const alias = aliasFor(next++);
    byId.set(p.id, alias);
    toInsert.push({ org_id: orgId, sms_provider_id: p.id, alias });
  }
  if (toInsert.length > 0) {
    // ON CONFLICT DO NOTHING: two concurrent operator requests can race here,
    // and losing the race is fine — the winner's alias is just as valid, and
    // the next read picks it up.
    await db.insert(provider_route_aliases).values(toInsert).onConflictDoNothing();
  }

  const byValue = new Map<string, string>();
  for (const p of providers) {
    const alias = byId.get(p.id);
    if (!alias) continue;
    if (p.name) byValue.set(p.name.toLowerCase(), alias);
    if (p.code) byValue.set(String(p.code).toLowerCase(), alias);
  }

  return { byId, byValue };
}

function redactValue(value: unknown, table: AliasTable, key?: string): unknown {
  if (typeof value === "string") {
    const hit = table.byValue.get(value.trim().toLowerCase());
    if (hit) return hit;
    // A key known to carry provider identity is blanked even when its value is
    // not a name we recognise — an unrecognised provider code is still a
    // provider code.
    if (key && PROVIDER_IDENTITY_KEYS.has(key)) return null;
    return value;
  }
  if (typeof value === "number" && key === "sms_provider_id") {
    // Numeric provider ids are an identity too: they join straight back to a
    // name for anyone with the other half.
    return table.byId.get(value) ?? null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, table));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, table, k);
    }
    return out;
  }
  return value;
}

/**
 * Redact provider identity from an API response payload.
 *
 * A no-op for every role except `operator`, so calling it on a shared route is
 * always safe — the Owner keeps seeing real names.
 */
export function redactForRole<T>(role: Role, payload: T, table: AliasTable): T {
  if (role !== "operator") return payload;
  return redactValue(payload, table) as T;
}

/** Convenience: load the table and redact in one call. */
export async function redactResponse<T>(
  role: Role,
  orgId: string,
  payload: T,
): Promise<T> {
  if (role !== "operator") return payload;
  const table = await loadAliasTable(orgId);
  return redactForRole(role, payload, table);
}

/**
 * Response helper: redact for the role, then serialise.
 *
 * The two extra arguments go at the FRONT of the argument list on purpose, so
 * `NextResponse.json(payload, init)` becomes
 * `await jsonForRole(role, orgId, payload, init)` — a pure prefix edit that
 * leaves the payload expression and its closing parenthesis untouched, however
 * many lines it spans. Mechanical to apply, and easy to read in a diff.
 */
export async function jsonForRole<T>(
  role: Role,
  orgId: string,
  payload: T,
  init?: ResponseInit,
): Promise<Response> {
  const body = await redactResponse(role, orgId, payload);
  return NextResponse.json(body, init);
}
