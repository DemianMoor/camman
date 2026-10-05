import { sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";
import {
  CAMPAIGN_USE_PERIOD_INTERVAL,
  buildSegmentAudienceClause,
  ruleInnerQuery,
  textedInLastPeriodSql,
} from "@/lib/segment-rules-eval";
import type { CampaignUsePeriod } from "@/lib/validators/segment-rule-types";

// Nightly trial of the "Texted in the last…" rule (Task 3 T5; plan
// docs/superpowers/plans/2026-10-02-task3-texted-rule-plan.md §6).
//
// DRIFT. For each period, the rule as served ("fact": contact_engagement +
// lag tail + manual recipients) is compared with the same meaning computed
// from the sends themselves ("direct": stage_sends + manual recipients — the
// kill-switch path). The second side is anchored to the send records, which
// do not move, so the comparison is not a value checked against itself. Both
// sides run in the CALLER's transaction: it must be one REPEATABLE READ
// snapshot, or a send landing between the two reads is reported as drift.
// Any contact on one side only is drift.
//
// MANUAL-SEND GAPS. A manual stage marked sent / success / failed whose
// recipients were never recorded (exported before migration 0197, or not
// through export-phones) is texted but invisible to the rule. Reported, not
// repaired.
//
// SEGMENTS. Information for the owner's switch decision (D1), not drift: for
// each active segment whose only active rule is in_use_in_campaign_last_period
// `is_not` <period>, its audience today vs the same segment with the texted
// rule.
//
// STREAK. 14 consecutive clean nights before the first segment switch
// (owner, 2026-10-03). Stored per org in operator_rollups under
// TEXTED_TRIAL_KEY; only a clean run on the UTC day after the previous run
// extends it, so a missed night restarts it at 1 and a second run on the same
// day counts once.

export const TEXTED_TRIAL_KEY = "texted_rule_trial";
export const TEXTED_TRIAL_TARGET_NIGHTS = 14;
const ALWAYS: CampaignUsePeriod[] = ["3d", "1w", "2w"];

export interface TextedTrialPeriod {
  period: CampaignUsePeriod;
  fact: number;
  direct: number;
  only_fact: number;
  only_direct: number;
  examples_only_fact: string[];
  examples_only_direct: string[];
  ms: number;
}
export interface TextedTrialManualGap {
  stage_id: number;
  campaign_id: number;
  status: string;
  status_changed_at: string;
}
export interface TextedTrialSegment {
  segment_id: number;
  name: string;
  period: CampaignUsePeriod;
  today_rule: number;
  texted_rule: number;
}
export interface TextedTrialReport {
  org_id: string;
  ran_at: string;
  periods: TextedTrialPeriod[];
  drift: boolean;
  manual_gaps: TextedTrialManualGap[];
  segments: TextedTrialSegment[];
}
export interface TextedTrialState {
  streak: number;
  last_run_day: string | null;
  last_clean_day: string | null;
  last_drift_at: string | null;
  last_report: TextedTrialReport | null;
}

const ids = (xs: unknown) => (Array.isArray(xs) ? xs.map(String) : []);

export async function runTextedRuleTrial(tx: DbOrTx, orgId: string): Promise<TextedTrialReport> {
  const used = (await tx.execute(sql`
    SELECT DISTINCT r.value #>> '{}' AS period
    FROM segment_rules r JOIN segments s ON s.id = r.segment_id
    WHERE r.org_id = ${orgId}::uuid AND r.is_active AND s.status = 'active'
      AND r.rule_type = 'texted_in_last_period'`)) as unknown as { period: string }[];
  const periods = [...new Set([...ALWAYS, ...used.map((u) => u.period as CampaignUsePeriod)])].filter(
    (p) => p in CAMPAIGN_USE_PERIOD_INTERVAL,
  );

  const out: TextedTrialPeriod[] = [];
  for (const period of periods) {
    const iv = CAMPAIGN_USE_PERIOD_INTERVAL[period];
    const fact = textedInLastPeriodSql(orgId, iv, "fact");
    const direct = textedInLastPeriodSql(orgId, iv, "direct");
    const t0 = performance.now();
    const [r] = (await tx.execute(sql`
      WITH f AS MATERIALIZED (${fact}), d AS MATERIALIZED (${direct}),
           of_ AS (SELECT contact_id FROM f EXCEPT SELECT contact_id FROM d),
           od AS (SELECT contact_id FROM d EXCEPT SELECT contact_id FROM f)
      SELECT (SELECT count(*) FROM f)::int AS fact,
             (SELECT count(*) FROM d)::int AS direct,
             (SELECT count(*) FROM of_)::int AS only_fact,
             (SELECT count(*) FROM od)::int AS only_direct,
             (SELECT array_agg(contact_id) FROM (SELECT contact_id FROM of_ LIMIT 3) x) AS ex_fact,
             (SELECT array_agg(contact_id) FROM (SELECT contact_id FROM od LIMIT 3) y) AS ex_direct`)) as unknown as {
      fact: number; direct: number; only_fact: number; only_direct: number; ex_fact: unknown; ex_direct: unknown;
    }[];
    out.push({
      period,
      fact: r.fact,
      direct: r.direct,
      only_fact: r.only_fact,
      only_direct: r.only_direct,
      examples_only_fact: ids(r.ex_fact),
      examples_only_direct: ids(r.ex_direct),
      ms: Math.round(performance.now() - t0),
    });
  }

  const gaps = (await tx.execute(sql`
    SELECT s.id AS stage_id, s.campaign_id, s.status,
           to_char(s.status_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS status_changed_at
    FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.org_id = ${orgId}::uuid AND c.link_mode = 'manual'
      AND s.status IN ('sent', 'success', 'failed')
      AND s.status_changed_at > now() - interval '26 hours'
      AND NOT EXISTS (SELECT 1 FROM stage_manual_recipients mr WHERE mr.stage_id = s.id AND mr.sent_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM stage_sends ss WHERE ss.stage_id = s.id AND ss.status = 'sent')
    ORDER BY s.id`)) as unknown as TextedTrialManualGap[];

  const candidates = (await tx.execute(sql`
    SELECT s.id, s.name, min(r.value #>> '{}') AS period
    FROM segments s JOIN segment_rules r ON r.segment_id = s.id AND r.is_active
    WHERE s.org_id = ${orgId}::uuid AND s.status = 'active'
    GROUP BY s.id, s.name
    HAVING count(*) = 1
       AND bool_and(r.rule_type = 'in_use_in_campaign_last_period' AND r.operator = 'is_not')
    ORDER BY s.id`)) as unknown as { id: number; name: string; period: string }[];
  const segments: TextedTrialSegment[] = [];
  const eligible: SQL = sql`SELECT id AS contact_id FROM contacts WHERE org_id = ${orgId}::uuid AND messaging_status = 'eligible'`;
  for (const c of candidates) {
    const period = c.period as CampaignUsePeriod;
    if (!(period in CAMPAIGN_USE_PERIOD_INTERVAL)) continue;
    const today = await buildSegmentAudienceClause(c.id, orgId);
    const texted = ruleInnerQuery({ rule_type: "texted_in_last_period", operator: "is", value: period }, c.id, orgId);
    const [n] = (await tx.execute(sql`
      SELECT (SELECT count(*) FROM (${today}) a)::int AS today_rule,
             (SELECT count(*) FROM (${eligible} EXCEPT SELECT contact_id FROM (${texted}) t) b)::int AS texted_rule`)) as unknown as {
      today_rule: number; texted_rule: number;
    }[];
    segments.push({ segment_id: c.id, name: c.name, period, today_rule: n.today_rule, texted_rule: n.texted_rule });
  }

  return {
    org_id: orgId,
    ran_at: new Date().toISOString(),
    periods: out,
    drift: out.some((p) => p.only_fact > 0 || p.only_direct > 0),
    manual_gaps: gaps,
    segments,
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const prevDay = (day: string) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000));

/** Pure: the next streak state after a report. Exported for the test. */
export function nextTrialState(prev: TextedTrialState | null, report: TextedTrialReport): TextedTrialState {
  const day = utcDay(new Date(report.ran_at));
  const base: TextedTrialState = prev ?? {
    streak: 0, last_run_day: null, last_clean_day: null, last_drift_at: null, last_report: null,
  };
  if (report.drift) {
    return { ...base, streak: 0, last_run_day: day, last_drift_at: report.ran_at, last_report: report };
  }
  if (base.last_clean_day === day) return { ...base, last_run_day: day, last_report: report };
  const consecutive = base.streak > 0 && base.last_clean_day === prevDay(day);
  return {
    ...base,
    streak: consecutive ? base.streak + 1 : 1,
    last_run_day: day,
    last_clean_day: day,
    last_report: report,
  };
}

export async function readTrialState(dbc: DbOrTx, orgId: string): Promise<TextedTrialState | null> {
  const rows = (await dbc.execute(sql`
    SELECT data FROM operator_rollups WHERE org_id = ${orgId}::uuid AND rollup_key = ${TEXTED_TRIAL_KEY}`)) as unknown as {
    data: TextedTrialState | null;
  }[];
  return rows[0]?.data ?? null;
}

export async function writeTrialState(dbc: DbOrTx, orgId: string, state: TextedTrialState, ms: number): Promise<void> {
  await dbc.execute(sql`
    INSERT INTO operator_rollups (org_id, rollup_key, data, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${TEXTED_TRIAL_KEY}, ${JSON.stringify(state)}::jsonb, now(), ${ms}, now())
    ON CONFLICT (org_id, rollup_key) DO UPDATE
      SET data = EXCLUDED.data, computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms, updated_at = now()`);
}

/** Telegram text for a drift or gap night, or the day the streak reaches the target. Null = say nothing. */
export function trialMessage(report: TextedTrialReport, state: TextedTrialState): string | null {
  const lines: string[] = [];
  for (const p of report.periods.filter((x) => x.only_fact > 0 || x.only_direct > 0)) {
    lines.push(
      `• ${p.period}: served ${p.fact} vs sends ${p.direct} — only served ${p.only_fact}, only sends ${p.only_direct}` +
        (p.examples_only_direct.length ? ` (e.g. missing ${p.examples_only_direct.map((x) => x.slice(0, 8)).join(", ")})` : "") +
        (p.examples_only_fact.length ? ` (e.g. extra ${p.examples_only_fact.map((x) => x.slice(0, 8)).join(", ")})` : ""),
    );
  }
  const parts: string[] = [];
  if (lines.length) parts.push(`⚠️ Texted-rule trial: DRIFT — streak reset to 0\n${lines.join("\n")}`);
  if (report.manual_gaps.length)
    parts.push(
      `⚠️ Manual stages marked texted with no recorded recipients (invisible to the texted rule): ` +
        report.manual_gaps.map((g) => `stage ${g.stage_id} (campaign ${g.campaign_id}, ${g.status})`).join(", "),
    );
  if (!report.drift && state.streak === TEXTED_TRIAL_TARGET_NIGHTS)
    parts.push(`✅ Texted-rule trial: ${TEXTED_TRIAL_TARGET_NIGHTS} consecutive clean nights — a segment switch may now be decided (owner).`);
  return parts.length ? parts.join("\n\n") : null;
}
