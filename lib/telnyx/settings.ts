import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { lookup_settings } from "@/db/schema";

export interface LookupSettingsRow {
  lookup_paused: boolean;
  lookup_daily_cap: number;
  lookup_rate_base: number;
  lookup_rate_mobile: number;
  lookup_concurrency_rps: number;
  worker_lease_until: Date | null;
  carrier_resolver_v2: boolean;
  carrier_ai_run_cap: number;
}

// Load the single global lookup_settings row. Seeded in migration 0095, so it
// always exists; we coalesce defensively anyway.
export async function loadLookupSettings(): Promise<LookupSettingsRow> {
  const rows = await db
    .select()
    .from(lookup_settings)
    .where(sql`id = true`)
    .limit(1);
  const r = rows[0];
  if (!r) {
    // Should never happen (0095 seeds it) — fall back to schema defaults.
    return {
      lookup_paused: false,
      lookup_daily_cap: 50000,
      lookup_rate_base: 0.0015,
      lookup_rate_mobile: 0.0025,
      lookup_concurrency_rps: 10,
      worker_lease_until: null,
      carrier_resolver_v2: false,
      carrier_ai_run_cap: 200,
    };
  }
  return {
    lookup_paused: r.lookup_paused,
    lookup_daily_cap: r.lookup_daily_cap,
    lookup_rate_base: Number(r.lookup_rate_base),
    lookup_rate_mobile: Number(r.lookup_rate_mobile),
    lookup_concurrency_rps: r.lookup_concurrency_rps,
    worker_lease_until: r.worker_lease_until,
    carrier_resolver_v2: r.carrier_resolver_v2,
    carrier_ai_run_cap: r.carrier_ai_run_cap,
  };
}
