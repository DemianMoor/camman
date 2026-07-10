import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { validatePhonesBatch } from "@/lib/phone-validation";

import { telnyxBalance } from "./client";
import { estimateLookupCost, DEFAULT_MOBILE_SHARE } from "./cost";
import { pgArray } from "./pg-array";
import { loadLookupSettings } from "./settings";

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
