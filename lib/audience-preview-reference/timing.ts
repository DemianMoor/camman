import "server-only";

import { sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { AudiencePreviewInput } from "@/lib/audience-snapshot";
import { buildSegmentAudienceClause, ruleInnerQuery } from "@/lib/segment-rules-eval";

import { buildGroupMembershipClause, type PreviewRunner } from "./index";

// Measurement helpers for scripts/verify-preview-parity.ts (Task 2, T1 + T7).
// The SQL lives here, not in the script, so the script carries no SQL text of
// its own (plan §7, guard constraint). Removed with the reference copy.

const dialect = new PgDialect();

export interface PlanStats {
  execution_ms: number;
  shared_hit: number;
  shared_read: number;
  // Task 3 §9: which statement, and its costliest plan nodes by EXCLUSIVE
  // time (own time minus children), so a single statement can be broken down
  // by layer (CTE / relation).
  label?: string;
  top_nodes?: { node: string; ms: number; rows: number }[];
}

function topNodes(plan: Record<string, unknown>, n = 6) {
  const out: { node: string; ms: number; rows: number }[] = [];
  const walk = (node: Record<string, unknown>) => {
    const loops = Number(node["Actual Loops"] ?? 1);
    const total = Number(node["Actual Total Time"] ?? 0) * loops;
    const kids = (node.Plans as Record<string, unknown>[] | undefined) ?? [];
    const kidTotal = kids.reduce(
      (a, k) => a + Number(k["Actual Total Time"] ?? 0) * Number(k["Actual Loops"] ?? 1),
      0,
    );
    const name = [
      node["Node Type"],
      node["Relation Name"] ?? node["CTE Name"] ?? node["Index Name"] ?? "",
      node["Alias"] && node["Alias"] !== node["Relation Name"] ? `(${node["Alias"]})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    out.push({ node: name, ms: Math.max(0, total - kidTotal), rows: Number(node["Actual Rows"] ?? 0) * loops });
    kids.forEach(walk);
  };
  walk(plan);
  return out.sort((a, b) => b.ms - a.ms).slice(0, n).map((x) => ({ ...x, ms: Math.round(x.ms) }));
}

function statsOf(plan: unknown): PlanStats {
  const top = (plan as { Plan: Record<string, number>; "Execution Time": number }[])[0];
  return {
    execution_ms: top["Execution Time"],
    shared_hit: top.Plan["Shared Hit Blocks"] ?? 0,
    shared_read: top.Plan["Shared Read Blocks"] ?? 0,
    top_nodes: topNodes(top.Plan as unknown as Record<string, unknown>),
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
          // Not explainable: run as is. ANALYZE is timed (it is part of the
          // narrowed path's cost); the lock probe returns its real row.
          if (text.startsWith("analyze")) {
            const t0 = performance.now();
            const r = await tx.execute(q);
            opts.onPlan({ execution_ms: performance.now() - t0, shared_hit: 0, shared_read: 0, label: text.slice(0, 40) });
            return r;
          }
          if (text.includes("pg_try_advisory_xact_lock")) return tx.execute(q);
          const stats = await explainOne((x) => tx.execute(x), q);
          stats.label = text.replace(/\s+/g, " ").slice(0, 60);
          opts.onPlan(stats);
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

/**
 * Rows inserted, updated or deleted in NON-temporary tables by the current
 * transaction so far. The parity harness runs read-write only because the
 * narrowed audience part needs a temp table; this is the proof that nothing
 * else was written. Temp tables live in pg_temp_N schemas.
 */
export async function nonTempWritesInTransaction(
  tx: PreviewRunner | { execute: (q: SQL) => Promise<unknown> },
): Promise<number> {
  const exec = (tx as { execute: (q: SQL) => Promise<unknown> }).execute;
  const rows = (await exec.call(
    tx,
    drizzleSql`
      select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as n
      from pg_stat_xact_user_tables
      where schemaname not like 'pg_temp%'
    `,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// ── Task 3 §9 measurement helpers (read-only except TEMP tables) ────────────

/**
 * §9 item 2: the timestamp-fact prototype, built as a TEMP table inside the
 * caller's transaction (dropped at commit), compared per RULE (not per
 * segment: segments combine this rule with others) over the same universe:
 *   today — the real rule set (ruleInnerQuery in_use_in_campaign_last_period)
 *   fact  — meaning (a) read from the fact: last_live_use_at >= now() - N
 *   sent  — meaning (b): contact_engagement.last_sent_at >= now() - N
 * Each counts "used" contacts in the universe. today and fact must be equal.
 */
export async function measureCampaignUseFact(
  tx: { execute: (q: SQL) => Promise<unknown> },
  p: { orgId: string; universe?: SQL; periods: ("3d" | "1w" | "2w")[] },
) {
  // Default universe: every contact of the org (the worst case).
  const universe =
    p.universe ?? drizzleSql`select id as contact_id from contacts where org_id = ${p.orgId}::uuid`;
  const intervals = {
    "3d": drizzleSql`make_interval(days => 3)`,
    "1w": drizzleSql`make_interval(weeks => 1)`,
    "2w": drizzleSql`make_interval(weeks => 2)`,
  };
  const timed = async (q: SQL) => {
    const t0 = performance.now();
    const r = (await tx.execute(q)) as unknown as { n: number }[];
    return { count: Number(r[0]?.n ?? 0), ms: Math.round(performance.now() - t0) };
  };
  const t0 = performance.now();
  await tx.execute(drizzleSql`
    create temp table pv_fact on commit drop as
    select p.contact_id, max(ca.created_at) as last_live_use_at
    from campaign_audience_pool p
    join campaigns ca on ca.id = p.campaign_id
    where p.org_id = ${p.orgId}::uuid
      and ca.org_id = ${p.orgId}::uuid
      and ca.status in ('active', 'paused', 'completed')
      and exists (
        select 1 from campaign_stages s
        where s.campaign_id = ca.id and s.org_id = ${p.orgId}::uuid
          and s.status in ('draft', 'pending', 'sent', 'success'))
    group by p.contact_id`);
  await tx.execute(drizzleSql`create index on pv_fact (contact_id, last_live_use_at)`);
  await tx.execute(drizzleSql`analyze pv_fact`);
  const factBuildMs = Math.round(performance.now() - t0);
  const factRows = (await timed(drizzleSql`select count(*)::int as n from pv_fact`)).count;
  const rows = [];
  for (const period of p.periods) {
    const iv = intervals[period];
    const rule = ruleInnerQuery(
      { rule_type: "in_use_in_campaign_last_period", operator: "is", value: period },
      0,
      p.orgId,
    );
    const today = await timed(drizzleSql`
      select count(*)::int as n from (${universe}) u
      where u.contact_id in (${rule})`);
    const fact = await timed(drizzleSql`
      select count(*)::int as n from (${universe}) u
      where exists (
        select 1 from pv_fact f
        where f.contact_id = u.contact_id and f.last_live_use_at >= now() - ${iv})`);
    const lastSent = await timed(drizzleSql`
      select count(*)::int as n from (${universe}) u
      where exists (
        select 1 from contact_engagement ce
        where ce.contact_id = u.contact_id and ce.org_id = ${p.orgId}::uuid
          and ce.last_sent_at >= now() - ${iv})`);
    // The SEGMENT shape the builder emits for a lone is_not rule — eligible
    // contacts EXCEPT the rule — for today's rule and for the planned
    // "last texted within N" rule (meaning b): contact_engagement through
    // (org_id, last_sent_at), plus the lag tail: sends since the engagement
    // job's watermark minus its own 30-minute overlap, via
    // stage_sends_org_sent_at_idx. Timed with EXPLAIN (ANALYZE, BUFFERS).
    const eligible = drizzleSql`select id as contact_id from contacts where org_id = ${p.orgId}::uuid and messaging_status = 'eligible'`;
    const tail = drizzleSql`
      select contact_id from stage_sends
      where org_id = ${p.orgId}::uuid and status = 'sent'
        and sent_at >= (select watermark from cron_locks where job_name = 'contact-engagement') - interval '30 minutes'`;
    const ruleB = drizzleSql`
      select contact_id from contact_engagement
      where org_id = ${p.orgId}::uuid and last_sent_at >= now() - ${iv}
      union
      ${tail}`;
    const exec = (x: SQL) => tx.execute(x);
    const segToday = await explainOne(exec, drizzleSql`select count(*) from (${eligible} except ${rule}) x`);
    const segB = await explainOne(exec, drizzleSql`select count(*) from (${eligible} except (${ruleB})) x`);
    const notTexted = await timed(drizzleSql`select count(*)::int as n from (${eligible} except (${ruleB})) x`);
    const tailRows = await timed(drizzleSql`select count(*)::int as n from (${tail}) t`);
    rows.push({
      period, today, fact, lastSent, factMatchesToday: today.count === fact.count,
      segToday, segB, notTexted, tailRows,
    });
  }
  return { factRows, factBuildMs, rows };
}

/**
 * §9 item 3: what a covering index (org_id, offer_id, contact_id) INCLUDE
 * (last_sent_at) would save. The offer rules need last_sent_at, which the
 * existing (org_id, offer_id, contact_id) index lacks, so every row is a heap
 * fetch. The same read without last_sent_at can be index-only: the buffer
 * difference estimates the index without creating it.
 */
export async function explainOfferHistoryRead(
  tx: { execute: (q: SQL) => Promise<unknown> },
  orgId: string,
  offerId: number,
) {
  const exec = (x: SQL) => tx.execute(x);
  const withCooldown = await explainOne(exec, drizzleSql`
    select contact_id, count(*), max(last_sent_at) from contact_offer_campaigns
    where org_id = ${orgId}::uuid and offer_id = ${offerId}::int group by contact_id`);
  const indexOnly = await explainOne(exec, drizzleSql`
    select contact_id, count(*) from contact_offer_campaigns
    where org_id = ${orgId}::uuid and offer_id = ${offerId}::int group by contact_id`);
  return { offerId, withLastSent: withCooldown, withoutLastSent: indexOnly };
}
