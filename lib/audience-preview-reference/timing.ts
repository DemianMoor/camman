import "server-only";

import { sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { AudiencePreviewInput } from "@/lib/audience-snapshot";
import { buildSegmentAudienceClause } from "@/lib/segment-rules-eval";

import { buildGroupMembershipClause, type PreviewRunner } from "./index";

// Measurement helpers for scripts/verify-preview-parity.ts (Task 2, T1 + T7).
// The SQL lives here, not in the script, so the script carries no SQL text of
// its own (plan §7, guard constraint). Removed with the reference copy.

const dialect = new PgDialect();

export interface PlanStats {
  execution_ms: number;
  shared_hit: number;
  shared_read: number;
}

function statsOf(plan: unknown): PlanStats {
  const top = (plan as { Plan: Record<string, number>; "Execution Time": number }[])[0];
  return {
    execution_ms: top["Execution Time"],
    shared_hit: top.Plan["Shared Hit Blocks"] ?? 0,
    shared_read: top.Plan["Shared Read Blocks"] ?? 0,
  };
}

async function explainOne(
  exec: (q: SQL) => Promise<unknown>,
  q: SQL,
): Promise<PlanStats> {
  const rows = (await exec(
    drizzleSql`explain (analyze, buffers, format json) ${q}`,
  )) as unknown as Record<string, unknown>[];
  return statsOf(Object.values(rows[0])[0]);
}

/**
 * Wraps a transaction so a preview implementation runs UNCHANGED inside it,
 * with two harness-only substitutions:
 *
 *  - its `SET LOCAL statement_timeout` is replaced by `ceilingMs`, so a recipe
 *    that exceeds the production 30 s still produces numbers to compare
 *    (every timing it reports says whether it would have timed out);
 *  - with `onPlan`, every other statement runs as EXPLAIN (ANALYZE, BUFFERS)
 *    instead, and the plan's stats are handed back. The implementation then
 *    sees no result rows, so its return value is meaningless in this mode —
 *    use it for timing only, never for parity.
 */
export function harnessRunner(
  outer: PreviewRunner,
  opts: { ceilingMs: number; onPlan?: (s: PlanStats) => void },
): PreviewRunner {
  return {
    transaction: ((fn: (tx: unknown) => Promise<unknown>) =>
      outer.transaction((tx) => {
        const execute = async (q: SQL) => {
          const text = dialect.sqlToQuery(q).sql.trim().toLowerCase();
          if (text.startsWith("set local statement_timeout")) {
            return tx.execute(
              drizzleSql.raw(`set local statement_timeout = '${Math.trunc(opts.ceilingMs)}ms'`),
            );
          }
          if (!opts.onPlan) return tx.execute(q);
          opts.onPlan(await explainOne((x) => tx.execute(x), q));
          return [];
        };
        return fn(new Proxy(tx, {
          get: (t, k) => (k === "execute" ? execute : Reflect.get(t, k)),
        }));
      })) as PreviewRunner["transaction"],
  };
}

/**
 * The cost of SEGMENT EVALUATION alone for a recipe: every selected include
 * segment's clause, built exactly as the preview builds it (same restricted
 * universe when groups are also selected), counted and nothing else. Compared
 * with the whole preview this is the share of the [change 3] segment gate.
 * Returns null when the recipe selects no segments.
 */
export async function explainSegmentEvaluation(
  outer: PreviewRunner,
  input: AudiencePreviewInput,
  ceilingMs: number,
): Promise<PlanStats | null> {
  if (input.segmentIds.length === 0) return null;
  const groupIds = input.contactGroupIds ?? [];
  const restrict =
    groupIds.length > 0
      ? buildGroupMembershipClause(input.orgId, groupIds)!
      : undefined;
  const clauses = await Promise.all(
    input.segmentIds.map((id) =>
      buildSegmentAudienceClause(id, input.orgId, restrict),
    ),
  );
  const branches = clauses
    .map((c) => drizzleSql`select contact_id from (${c}) seg_inner`)
    .reduce((acc, b) => drizzleSql`${acc} union all ${b}`);
  return outer.transaction(async (tx) => {
    await tx.execute(
      drizzleSql.raw(`set local statement_timeout = '${Math.trunc(ceilingMs)}ms'`),
    );
    return explainOne(
      (x) => tx.execute(x),
      drizzleSql`select count(*) from (${branches}) seg_all`,
    );
  });
}

/** Size of each contact group, for tagging recipes small / large. */
export async function contactGroupSizes(
  outer: PreviewRunner,
  orgId: string,
  groupIds: number[],
): Promise<Map<number, number>> {
  if (groupIds.length === 0) return new Map();
  return outer.transaction(async (tx) => {
    const rows = (await tx.execute(drizzleSql`
      select contact_group_id as id, count(*)::int as n
      from contact_contact_groups
      where org_id = ${orgId}::uuid
        and contact_group_id = any(${`{${groupIds.join(",")}}`}::int[])
      group by 1
    `)) as unknown as { id: number; n: number }[];
    return new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
  });
}
