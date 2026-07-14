import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { lookup_group_stats_cache } from "@/db/schema";

// Lookup Stats Panel — per-Contact-Group coverage + landline-suppression rollup.
//
// Sendable reuses the send-audience definition verbatim (lib/audience-snapshot.ts /
// lib/segment-rules-eval.ts): messaging_status='eligible' AND NOT in the org's
// opt_outs set (deduped). Columns are a DISJOINT partition of the population so they
// always reconcile:
//   total = sendable + landlines + opt_outs(non-landline)
// because messaging_status='eligible' ⇔ line_type<>'landline':
//   - landlines        = line_type='landline'                 (not eligible)
//   - opt_outs         = eligible AND in opt_outs             (eligible, suppressed by opt-out)
//   - sendable         = eligible AND NOT in opt_outs
// and telnyx + manual = looked_up. assertReconciles() enforces both on EVERY compute
// (not just tests), so any future change that breaks disjointness fails loudly.
//
// NO cost/spend metric — coverage/suppression only (deferred until Telnyx per-lookup
// cost is confirmed reliable).

export interface GroupStat {
  group_id: number;
  name: string;
  total: number;
  looked_up: number;
  telnyx: number;
  manual: number;
  coverage_pct: number; // looked_up / total * 100 (0 when total=0)
  landlines: number; // auto-suppressed fixed-line contacts (retained)
  opt_outs: number; // NON-landline opt-outs (disjoint from landlines)
  sendable: number;
  remaining: number; // total - looked_up (the "needs a lookup run" number)
}

export type StatsSummary = Omit<GroupStat, "group_id" | "name"> & {
  groups: number; // number of active groups
};

export interface LookupStatsBlob {
  summary: StatsSummary; // distinct contacts across all active groups (each counted once)
  groups: GroupStat[]; // per-group; a multi-group contact is counted in each group
}

// Data older than this is flagged "may be stale" in the UI (refresh is manual).
export const LOOKUP_STATS_TTL_MS = 15 * 60 * 1000;

export interface CachedStats {
  data: LookupStatsBlob;
  computed_at: string; // ISO
  stale: boolean; // computed_at older than the TTL at read time (server clock)
}

function n(v: unknown): number {
  return Number(v ?? 0);
}

// Permanent invariant — throws if the disjoint partition or source split ever breaks.
function assertReconciles(
  label: string,
  r: { total: number; looked_up: number; telnyx: number; manual: number; landlines: number; opt_outs: number; sendable: number },
) {
  if (r.sendable + r.landlines + r.opt_outs !== r.total) {
    throw new Error(
      `lookup-stats reconciliation FAILED for ${label}: sendable(${r.sendable}) + landlines(${r.landlines}) + opt_outs(${r.opt_outs}) = ${r.sendable + r.landlines + r.opt_outs} != total(${r.total}). Disjoint-column invariant broken.`,
    );
  }
  if (r.telnyx + r.manual !== r.looked_up) {
    throw new Error(
      `lookup-stats source-split FAILED for ${label}: telnyx(${r.telnyx}) + manual(${r.manual}) = ${r.telnyx + r.manual} != looked_up(${r.looked_up}).`,
    );
  }
}

function coverage(lookedUp: number, total: number): number {
  return total > 0 ? Math.round((lookedUp / total) * 1000) / 10 : 0;
}

// Run the aggregate + assert + return the blob. Throws on a query error OR a broken
// invariant — the caller (refresh) only writes the cache AFTER a clean return, so a
// failure never touches the prior cache.
export async function computeLookupGroupStats(
  orgId: string,
): Promise<LookupStatsBlob> {
  // Per-group rows. Opt-outs pre-hashed to a distinct set (matches the audience
  // builder's oo_set) instead of a per-contact probe — ~1.2s vs ~13s at prod scale.
  const groupRows = await db.execute<{
    group_id: number;
    name: string;
    total: number;
    looked_up: number;
    telnyx: number;
    manual: number;
    landlines: number;
    opt_outs: number;
    sendable: number;
  }>(sql`
    WITH oo AS (SELECT DISTINCT contact_id FROM opt_outs WHERE org_id = ${orgId}::uuid)
    SELECT
      cg.id AS group_id,
      cg.name AS name,
      COUNT(*) AS total,
      COUNT(pl.phone) AS looked_up,
      COUNT(*) FILTER (WHERE pl.source = 'telnyx') AS telnyx,
      COUNT(*) FILTER (WHERE pl.source = 'csv_import') AS manual,
      COUNT(*) FILTER (WHERE c.line_type = 'landline') AS landlines,
      COUNT(*) FILTER (WHERE oo.contact_id IS NOT NULL AND c.line_type <> 'landline') AS opt_outs,
      COUNT(*) FILTER (WHERE c.messaging_status = 'eligible' AND oo.contact_id IS NULL) AS sendable
    FROM contact_contact_groups ccg
    JOIN contacts c ON c.id = ccg.contact_id
    JOIN contact_groups cg ON cg.id = ccg.contact_group_id
    LEFT JOIN phone_lookups pl ON pl.phone = c.phone_number
    LEFT JOIN oo ON oo.contact_id = c.id
    WHERE ccg.org_id = ${orgId}::uuid AND cg.status = 'active'
    GROUP BY cg.id, cg.name
    ORDER BY total DESC`);

  const groups: GroupStat[] = groupRows.map((r) => {
    const g = {
      total: n(r.total),
      looked_up: n(r.looked_up),
      telnyx: n(r.telnyx),
      manual: n(r.manual),
      landlines: n(r.landlines),
      opt_outs: n(r.opt_outs),
      sendable: n(r.sendable),
    };
    assertReconciles(`group "${r.name}" (${r.group_id})`, g);
    return {
      group_id: n(r.group_id),
      name: r.name,
      ...g,
      coverage_pct: coverage(g.looked_up, g.total),
      remaining: g.total - g.looked_up,
    };
  });

  // Summary = DISTINCT contacts in ≥1 active group (multi-group contacts counted
  // once), so the strip reflects true population, not the sum of overlapping rows.
  const sumRows = await db.execute<{
    total: number;
    looked_up: number;
    telnyx: number;
    manual: number;
    landlines: number;
    opt_outs: number;
    sendable: number;
  }>(sql`
    WITH oo AS (SELECT DISTINCT contact_id FROM opt_outs WHERE org_id = ${orgId}::uuid)
    SELECT
      COUNT(*) AS total,
      COUNT(pl.phone) AS looked_up,
      COUNT(*) FILTER (WHERE pl.source = 'telnyx') AS telnyx,
      COUNT(*) FILTER (WHERE pl.source = 'csv_import') AS manual,
      COUNT(*) FILTER (WHERE c.line_type = 'landline') AS landlines,
      COUNT(*) FILTER (WHERE oo.contact_id IS NOT NULL AND c.line_type <> 'landline') AS opt_outs,
      COUNT(*) FILTER (WHERE c.messaging_status = 'eligible' AND oo.contact_id IS NULL) AS sendable
    FROM contacts c
    LEFT JOIN phone_lookups pl ON pl.phone = c.phone_number
    LEFT JOIN oo ON oo.contact_id = c.id
    WHERE c.org_id = ${orgId}::uuid
      AND EXISTS (
        SELECT 1 FROM contact_contact_groups ccg
        JOIN contact_groups cg ON cg.id = ccg.contact_group_id
        WHERE ccg.contact_id = c.id AND cg.status = 'active'
      )`);
  const s = sumRows[0] ?? {
    total: 0, looked_up: 0, telnyx: 0, manual: 0, landlines: 0, opt_outs: 0, sendable: 0,
  };
  const sm = {
    total: n(s.total),
    looked_up: n(s.looked_up),
    telnyx: n(s.telnyx),
    manual: n(s.manual),
    landlines: n(s.landlines),
    opt_outs: n(s.opt_outs),
    sendable: n(s.sendable),
  };
  assertReconciles("summary", sm);

  const summary: StatsSummary = {
    ...sm,
    coverage_pct: coverage(sm.looked_up, sm.total),
    remaining: sm.total - sm.looked_up,
    groups: groups.length,
  };

  return { summary, groups };
}

async function readCache(orgId: string): Promise<CachedStats | null> {
  const rows = await db
    .select({
      data: lookup_group_stats_cache.data,
      computed_at: lookup_group_stats_cache.computed_at,
    })
    .from(lookup_group_stats_cache)
    .where(sql`org_id = ${orgId}::uuid`)
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const computedAt = r.computed_at as Date;
  return {
    data: r.data as LookupStatsBlob,
    computed_at: computedAt.toISOString(),
    stale: Date.now() - computedAt.getTime() > LOOKUP_STATS_TTL_MS,
  };
}

// Force a recompute + ATOMIC single-upsert of the whole blob. computeLookupGroupStats
// runs FIRST; if it throws (query error or broken invariant), we never reach the write,
// so the prior cached row is left intact — a failed refresh degrades to older data,
// never to blank/partial.
export async function refreshLookupGroupStats(
  orgId: string,
  compute: (orgId: string) => Promise<LookupStatsBlob> = computeLookupGroupStats,
): Promise<CachedStats> {
  const blob = await compute(orgId); // throws first -> cache untouched below
  await db
    .insert(lookup_group_stats_cache)
    .values({ org_id: orgId, data: blob, computed_at: sql`now()` })
    .onConflictDoUpdate({
      target: lookup_group_stats_cache.org_id,
      set: { data: blob, computed_at: sql`now()` },
    });
  const fresh = await readCache(orgId);
  return fresh!;
}

// Panel read path: return the cache (may be stale — the UI shows computed_at). Only
// the FIRST-ever load (no cached row) computes; staleness is refreshed manually.
export async function getLookupGroupStats(orgId: string): Promise<CachedStats> {
  const cached = await readCache(orgId);
  if (cached) return cached;
  return refreshLookupGroupStats(orgId);
}
