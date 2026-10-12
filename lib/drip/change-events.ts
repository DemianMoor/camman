import { sql } from "drizzle-orm";

import { logCampaignEvent, type DbOrTx } from "@/lib/campaign-events";

// Drip settings change log (Daily results tab, PR 1).
//
// Before this, a drip campaign's caps, cutoff, carry-over, dates and its stages'
// windows / creative / Active toggle were overwritten in place — nothing could
// say WHEN a setting changed, so a day-by-day report had no way to mark "the
// window moved here". Each save now diffs the row before and after, inside the
// save's own transaction, and appends ONE campaign_events row when anything
// actually changed. A no-op save (the panel PUTs every field on every save)
// writes nothing.
//
// Values are captured through to_jsonb on BOTH sides, so a timestamp or a jsonb
// filter compares in one canonical text form rather than as whatever shape the
// driver happens to hand back.

export type FieldChange = { from: unknown; to: unknown };
export type Changes = Record<string, FieldChange>;

/** Columns of drip_campaign_configs whose edits are logged. */
export const DRIP_CONFIG_FIELDS = [
  "interest_tag",
  "partner_key_id",
  "start_at",
  "end_at",
  "daily_cap",
  "campaign_cap",
  "routing_daily_admission_cap",
  "admission_cutoff_minutes",
  "carry_days",
  "priority",
  "filters",
  "behavioral_enabled",
] as const;

/** Drip fields of campaign_stages whose edits are logged. */
export const DRIP_STAGE_FIELDS = [
  "window_start_min",
  "window_end_min",
  "creative_id",
  "drip_active",
  "drip_followup_minutes",
] as const;

const LABELS: Record<string, string> = {
  interest_tag: "interest tag",
  partner_key_id: "partner key",
  start_at: "start",
  end_at: "admission closes",
  daily_cap: "daily send cap",
  campaign_cap: "campaign cap",
  routing_daily_admission_cap: "daily admission cap",
  admission_cutoff_minutes: "admission cutoff (min)",
  carry_days: "carry-over days",
  priority: "priority",
  filters: "filters",
  behavioral_enabled: "behavioural follow-ups",
  window_start_min: "window start",
  window_end_min: "window end",
  creative_id: "creative",
  drip_active: "Active",
  drip_followup_minutes: "follow-up delay (min)",
};

// Key-order-independent text form, so {a,b} and {b,a} compare equal.
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** The fields whose value differs. A missing `before` row means "created", not a change. */
export function diffFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  fields: readonly string[],
): Changes {
  const changes: Changes = {};
  if (!before || !after) return changes;
  for (const f of fields) {
    if (canonical(before[f]) !== canonical(after[f])) {
      changes[f] = { from: before[f] ?? null, to: after[f] ?? null };
    }
  }
  return changes;
}

function minutesToClock(v: unknown): string {
  if (typeof v !== "number") return "none";
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

function show(field: string, v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (field === "window_start_min" || field === "window_end_min") return minutesToClock(v);
  if (field === "filters") return "…";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

/** "carry-over days 0 → 1; campaign cap 300 → 10000" */
export function summarizeChanges(changes: Changes): string {
  return Object.entries(changes)
    .map(([f, c]) => `${LABELS[f] ?? f} ${show(f, c.from)} → ${show(f, c.to)}`)
    .join("; ");
}

function projection(fields: readonly string[]) {
  return sql.raw(fields.join(", "));
}

/** The config row as canonical jsonb, or null when the campaign has none yet. */
export async function readDripConfigSnapshot(
  dbc: DbOrTx,
  campaignId: number,
  orgId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const rows = (await dbc.execute(sql`
    SELECT to_jsonb(x) AS snap FROM (
      SELECT ${projection(DRIP_CONFIG_FIELDS)} FROM drip_campaign_configs
      WHERE campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
      ${opts.forUpdate ? sql`FOR UPDATE` : sql``}
    ) x
  `)) as unknown as { snap: Record<string, unknown> }[];
  return rows[0]?.snap ?? null;
}

/** The stage's drip fields as canonical jsonb, plus whether its campaign is a drip. */
export async function readDripStageSnapshot(
  dbc: DbOrTx,
  stageId: number,
  orgId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ isDrip: boolean; stageNumber: number; snap: Record<string, unknown> } | null> {
  // Extra keys in `snap` (campaign_id, stage_number) are harmless: the diff
  // only reads DRIP_STAGE_FIELDS.
  const rows = (await dbc.execute(sql`
    SELECT (c.type = 'drip') AS is_drip, x.stage_number, to_jsonb(x) AS snap
    FROM (
      SELECT campaign_id, stage_number, ${projection(DRIP_STAGE_FIELDS)} FROM campaign_stages
      WHERE id = ${stageId} AND org_id = ${orgId}::uuid
      ${opts.forUpdate ? sql`FOR UPDATE` : sql``}
    ) x
    JOIN campaigns c ON c.id = x.campaign_id
  `)) as unknown as { is_drip: boolean; stage_number: number; snap: Record<string, unknown> }[];
  const r = rows[0];
  return r ? { isDrip: r.is_drip, stageNumber: r.stage_number, snap: r.snap } : null;
}

/**
 * Append a `drip_config_changed` event when `before`→`after` differ.
 * Call inside the save's transaction, AFTER the write (see logCampaignEvent).
 */
export async function logDripConfigChange(
  dbc: DbOrTx,
  input: {
    orgId: string;
    campaignId: number;
    actorUserId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<Changes> {
  const changes = diffFields(input.before, input.after, DRIP_CONFIG_FIELDS);
  if (Object.keys(changes).length === 0) return changes;
  await logCampaignEvent(dbc, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    actorUserId: input.actorUserId,
    eventType: "drip_config_changed",
    summary: `Drip settings: ${summarizeChanges(changes)}`,
    metadata: { changes },
  });
  return changes;
}

/** Append a `drip_stage_changed` event when a drip stage's drip fields differ. */
export async function logDripStageChange(
  dbc: DbOrTx,
  input: {
    orgId: string;
    campaignId: number;
    stageId: number;
    stageNumber: number;
    actorUserId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<Changes> {
  const changes = diffFields(input.before, input.after, DRIP_STAGE_FIELDS);
  if (Object.keys(changes).length === 0) return changes;
  await logCampaignEvent(dbc, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    stageId: input.stageId,
    actorUserId: input.actorUserId,
    eventType: "drip_stage_changed",
    summary: `Stage ${input.stageNumber}: ${summarizeChanges(changes)}`,
    metadata: { stage_number: input.stageNumber, changes },
  });
  return changes;
}
