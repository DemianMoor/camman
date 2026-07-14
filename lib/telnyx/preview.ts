import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { validatePhonesBatch } from "@/lib/phone-validation";

import { telnyxBalance } from "./client";
import { estimateLookupCost, DEFAULT_MOBILE_SHARE } from "./cost";
import { matchExistingContacts, type ListMatch } from "./match-list";
import { pgArray } from "./pg-array";
import { loadLookupSettings } from "./settings";

// Above this many numbers, the confirm step escalates to a heavier "large run"
// warning (still allowed — the operator chose the scope — but scale-conscious).
export const LARGE_RUN_THRESHOLD = 25_000;

export interface LookupPreview {
  rows_in_file: number; // raw rows submitted
  unique_numbers: number; // distinct valid E.164 (same-file dupes collapsed)
  valid: number;
  invalid: number;
  cached: number; // already looked up (free)
  new_lookups: number; // to actually run
  est_cost_usd: number;
  balance_usd: number | null; // live Telnyx balance (null if unavailable)
  balance_error: string | null;
}

// Review-panel preview for a new-contact upload with the lookup toggle ON. Does NOT
// insert or enqueue anything — pure read + a balance call. `rawLines` is the parsed
// phone list (one per element); dedupe/collapse happens here.
export async function previewLookup(rawLines: string[]): Promise<LookupPreview> {
  const rows_in_file = rawLines.length;
  const { valid, invalid } = validatePhonesBatch(rawLines);
  const unique = Array.from(new Set(valid.map((v) => v.normalized)));

  let cached = 0;
  if (unique.length > 0) {
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM phone_lookups
      WHERE lookup_status = 'complete' AND phone = ANY(${pgArray(unique, "text")})
    `);
    cached = Number(rows[0]?.n ?? 0);
  }
  const new_lookups = unique.length - cached;

  const settings = await loadLookupSettings();
  const est_cost_usd = estimateLookupCost(
    new_lookups,
    { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile },
    DEFAULT_MOBILE_SHARE,
  );

  const bal = await telnyxBalance();
  return {
    rows_in_file,
    unique_numbers: unique.length,
    valid: valid.length,
    invalid: invalid.length,
    cached,
    new_lookups,
    est_cost_usd,
    balance_usd: bal.ok ? bal.availableCredit : null,
    balance_error: bal.ok ? null : bal.error,
  };
}

// ===== Targeted (scoped) lookup previews =====

export interface GroupLookupPreview {
  group_id: number;
  group_name: string | null;
  remaining: number; // distinct un-looked-up numbers in the group (== Stats Panel "Remaining un-looked-up")
  already_queued: number; // of those, already pending in a batch (won't re-enqueue)
  to_enqueue: number; // remaining − already_queued (what actually gets enqueued now)
  est_cost_usd: number; // provisional (rate-based; see LARGE_RUN note / Est-vs-Billed line)
  balance_usd: number | null;
  balance_error: string | null;
  daily_cap: number;
  eta_days: number; // ceil(to_enqueue / daily_cap) — time to drain at the shared cap
  large_run: boolean; // to_enqueue > LARGE_RUN_THRESHOLD
}

// Read-only preview for "Look up this group": the group's remaining un-looked-up
// numbers, how many would actually enqueue (already-queued excluded), provisional
// cost, live balance, and days-to-drain at the shared daily cap. Matches the
// enqueueGroup source set exactly. Enqueues nothing.
export async function previewGroupLookup(
  orgId: string,
  groupId: number,
): Promise<GroupLookupPreview> {
  const rows = await db.execute<{
    group_name: string | null;
    remaining: string;
    already_queued: string;
  }>(sql`
    WITH d AS (
      SELECT DISTINCT c.phone_number AS phone
      FROM contact_contact_groups ccg
      JOIN contacts c ON c.id = ccg.contact_id
      JOIN contact_groups cg ON cg.id = ccg.contact_group_id
      WHERE ccg.org_id = ${orgId}::uuid
        AND ccg.contact_group_id = ${groupId}
        AND cg.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM phone_lookups pl
          WHERE pl.phone = c.phone_number AND pl.lookup_status = 'complete'
        )
    )
    SELECT
      (SELECT name FROM contact_groups WHERE id = ${groupId} AND org_id = ${orgId}::uuid) AS group_name,
      (SELECT count(*) FROM d)::text AS remaining,
      (SELECT count(*) FROM d WHERE EXISTS (
        SELECT 1 FROM lookup_queue q WHERE q.phone = d.phone AND q.status = 'pending'
      ))::text AS already_queued
  `);
  const remaining = Number(rows[0]?.remaining ?? 0);
  const already_queued = Number(rows[0]?.already_queued ?? 0);
  const to_enqueue = remaining - already_queued;

  const settings = await loadLookupSettings();
  const est_cost_usd = estimateLookupCost(
    to_enqueue,
    { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile },
    DEFAULT_MOBILE_SHARE,
  );
  const bal = await telnyxBalance();
  const daily_cap = settings.lookup_daily_cap;
  const eta_days = daily_cap > 0 ? Math.ceil(to_enqueue / daily_cap) : 0;

  return {
    group_id: groupId,
    group_name: rows[0]?.group_name ?? null,
    remaining,
    already_queued,
    to_enqueue,
    est_cost_usd,
    balance_usd: bal.ok ? bal.availableCredit : null,
    balance_error: bal.ok ? null : bal.error,
    daily_cap,
    eta_days,
    large_run: to_enqueue > LARGE_RUN_THRESHOLD,
  };
}

export interface MatchListPreview extends Omit<ListMatch, "matchedPhones"> {
  est_cost_usd: number; // provisional
  balance_usd: number | null;
  balance_error: string | null;
  daily_cap: number;
  eta_days: number;
  large_run: boolean;
}

// Read-only preview for "Upload a list to look up (existing numbers only)": match
// the pasted list against existing contacts, break it into matched / not-found /
// already-looked-up / to-enqueue, add cost + balance + cap ETA. Enqueues nothing;
// creates no contacts. `matchedPhones` is dropped from the response (the enqueue
// route re-matches server-side — it never trusts a client-supplied match set).
export async function previewMatchList(
  orgId: string,
  rawLines: string[],
): Promise<MatchListPreview> {
  const { matchedPhones: _drop, ...m } = await matchExistingContacts(orgId, rawLines);
  void _drop;

  const settings = await loadLookupSettings();
  const est_cost_usd = estimateLookupCost(
    m.to_enqueue,
    { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile },
    DEFAULT_MOBILE_SHARE,
  );
  const bal = await telnyxBalance();
  const daily_cap = settings.lookup_daily_cap;
  const eta_days = daily_cap > 0 ? Math.ceil(m.to_enqueue / daily_cap) : 0;

  return {
    ...m,
    est_cost_usd,
    balance_usd: bal.ok ? bal.availableCredit : null,
    balance_error: bal.ok ? null : bal.error,
    daily_cap,
    eta_days,
    large_run: m.to_enqueue > LARGE_RUN_THRESHOLD,
  };
}
