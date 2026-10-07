import "server-only";

import { sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";

import { CAMPAIGN_TIMEZONE, campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { getCalibratedLookupRate } from "@/lib/reporting/lookup-rate";
import { telnyxBalance } from "@/lib/telnyx/client";

import { hourStart } from "./counters";
import type { DbOrTx } from "./groups";
import {
  formatIntakeDigest,
  type DigestRow,
  type InvariantBreak,
} from "./intake-digest-format";

// Hourly partner-intake Telegram digest. Replaces the per-batch
// "Lookup batch complete (drip_intake …)" messages, which lib/telnyx/worker.ts
// no longer sends for drip_intake.
//
// SOURCE: lead_intake_hourly (0199) — the hourly twin of lead_intake_daily,
// written in the same statement. The hour is the PROCESSING hour (when
// enrichment counted the lead), not the partner's received_at.
//
// COST: lookups x the partner report's calibrated rate (lib/reporting/
// lookup-rate.ts) — never the per-batch Telnyx balance delta, which reads $0.00
// on the 1-2-lookup drip batches. (The footer used to spell out the rate
// derivation; the owner dropped that line on 2026-10-07.)
//
// It's a DIGEST, not an alert: no alert_state, no transition gating. An hour
// with no intake sends nothing.
//
// SELF-CHECK: every digest re-verifies that the hourly rows of the digested
// hour's ET day sum to the daily row, column by column, per partner x tag, and
// appends a warning line when they don't — rather than failing silently.

const COUNTER_COLS = [
  "received", "mobile", "voip", "unknown", "landline",
  "rejected", "duplicate", "sandbox", "lookups_spent",
] as const;

/** Only partner keys/tags with real (non-sandbox) intake appear in a digest. */
async function hourRows(dbc: DbOrTx, orgId: string, hour: Date): Promise<DigestRow[]> {
  const rows = (await dbc.execute(sql`
    SELECT pk.partner_slug AS partner, h.interest_tag AS tag,
           h.received, h.mobile, h.voip, h.unknown, h.landline,
           h.lookups_spent AS lookups
    FROM lead_intake_hourly h
    JOIN partner_keys pk ON pk.id = h.partner_key_id
    WHERE h.org_id = ${orgId}::uuid
      AND h.hour_et = ${hour.toISOString()}::timestamptz
      AND (h.received > 0 OR h.lookups_spent > 0)
  `)) as unknown as DigestRow[];
  return rows.map((r) => ({
    ...r,
    received: Number(r.received),
    mobile: Number(r.mobile),
    voip: Number(r.voip),
    unknown: Number(r.unknown),
    landline: Number(r.landline),
    lookups: Number(r.lookups),
  }));
}

/**
 * Day-sum invariant for the ET day containing `hour`: SUM(hourly) = daily, per
 * partner x tag, every counter column. A FULL OUTER JOIN so a row present on
 * only one side is a break too.
 *
 * Returns null (not checked) when hourly tracking began after the day started —
 * the deploy day's daily row legitimately includes pre-0199 intake that has no
 * hourly rows. Every later day is fully covered.
 */
export async function checkDaySumInvariant(
  dbc: DbOrTx,
  orgId: string,
  hour: Date,
  /** The org's earliest lead_intake_hourly.hour_et (when tracking began). */
  firstHour: Date,
): Promise<{ day: string; breaks: InvariantBreak[] } | null> {
  const { start, end } = campaignDayBoundsUtc(hour);
  const day = formatInTimeZone(hour, CAMPAIGN_TIMEZONE, "yyyy-MM-dd");
  if (firstHour.getTime() > start.getTime()) return null;

  const sums = COUNTER_COLS.map((c) => sql`sum(${sql.raw(c)})::int AS ${sql.raw(c)}`);
  const diffs = COUNTER_COLS.map(
    (c) => sql`COALESCE(h.${sql.raw(c)}, 0) <> COALESCE(d.${sql.raw(c)}, 0)`,
  );
  const pairs = COUNTER_COLS.map(
    (c) => sql`COALESCE(h.${sql.raw(c)}, 0) AS h_${sql.raw(c)}, COALESCE(d.${sql.raw(c)}, 0) AS d_${sql.raw(c)}`,
  );
  const rows = (await dbc.execute(sql`
    WITH h AS (
      SELECT partner_key_id, interest_tag, ${sql.join(sums, sql`, `)}
      FROM lead_intake_hourly
      WHERE org_id = ${orgId}::uuid
        AND hour_et >= ${start.toISOString()}::timestamptz
        AND hour_et <  ${end.toISOString()}::timestamptz
      GROUP BY 1, 2
    ),
    d AS (
      SELECT partner_key_id, interest_tag, ${sql.join(COUNTER_COLS.map((c) => sql.raw(c)), sql`, `)}
      FROM lead_intake_daily
      WHERE org_id = ${orgId}::uuid AND day_et = ${day}::date
    )
    SELECT pk.partner_slug AS partner,
           COALESCE(h.interest_tag, d.interest_tag) AS tag,
           ${sql.join(pairs, sql`, `)}
    FROM h FULL OUTER JOIN d
      ON d.partner_key_id = h.partner_key_id AND d.interest_tag = h.interest_tag
    JOIN partner_keys pk ON pk.id = COALESCE(h.partner_key_id, d.partner_key_id)
    WHERE ${sql.join(diffs, sql` OR `)}
  `)) as unknown as Record<string, string | number>[];

  const breaks: InvariantBreak[] = [];
  for (const r of rows) {
    for (const c of COUNTER_COLS) {
      const hv = Number(r[`h_${c}`]);
      const dv = Number(r[`d_${c}`]);
      if (hv !== dv) {
        breaks.push({ partner: String(r.partner), tag: String(r.tag), column: c, hourlySum: hv, daily: dv });
      }
    }
  }
  return { day, breaks };
}

/**
 * Note for the FIRST digest ever, so nobody hunts for missing history.
 * Tracking begins mid-hour (whenever 0199's code deployed), so that first
 * partial hour is never digested on schedule; the first digest is the first
 * later hour with intake.
 */
async function firstDigestNote(dbc: DbOrTx, orgId: string, hour: Date, first: Date): Promise<string | null> {
  // Intake in any full hour between the partial first hour and this one means
  // an earlier digest already went out.
  const earlier = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM lead_intake_hourly
    WHERE org_id = ${orgId}::uuid
      AND hour_et > ${first.toISOString()}::timestamptz
      AND hour_et < ${hour.toISOString()}::timestamptz
      AND (received > 0 OR lookups_spent > 0)
  `)) as unknown as { n: number }[];
  if (Number(earlier[0]?.n ?? 0) > 0) return null;
  return (
    `First hourly digest. Hourly intake tracking began during the ` +
    `${formatInTimeZone(first, CAMPAIGN_TIMEZONE, "HH:00")} ET hour on ` +
    `${formatInTimeZone(first, CAMPAIGN_TIMEZONE, "EEE d MMM")}; that partial hour and ` +
    `everything before it have no hourly breakdown — use the daily partner report.`
  );
}

function windowLabel(hour: Date): string {
  const end = new Date(hour.getTime() + 3_600_000);
  return (
    `${formatInTimeZone(hour, CAMPAIGN_TIMEZONE, "HH:00")}–` +
    `${formatInTimeZone(end, CAMPAIGN_TIMEZONE, "HH:00")} ET · ` +
    `${formatInTimeZone(hour, CAMPAIGN_TIMEZONE, "EEE d MMM")}`
  );
}

export interface DigestRunResult {
  hour: string;
  orgs: { orgId: string; rows: number; messages: number; invariantBreaks: number | null; skipped?: string }[];
}

/**
 * Build the digest messages for the hour starting at `hour` (default: the hour
 * that just ended). Sending is the caller's (the telegram-report cron), so the
 * build can be time-boxed without ever cutting a send short. `manual` marks a
 * hand-triggered re-run of a past hour and lifts the partial-first-hour skip.
 */
export async function buildIntakeDigest(opts: {
  /** The app's `db`, or a transaction (the rolled-back preview write test). */
  dbc: DbOrTx;
  now: Date;
  hour?: Date;
  manual?: boolean;
}): Promise<DigestRunResult & { messages: string[] }> {
  const hour = opts.hour ? hourStart(opts.hour) : new Date(hourStart(opts.now).getTime() - 3_600_000);
  const result: DigestRunResult & { messages: string[] } = { hour: hour.toISOString(), orgs: [], messages: [] };

  // Org-scoped throughout: one digest per org that had intake this hour.
  const dbc = opts.dbc;
  const orgs = (await dbc.execute(sql`
    SELECT DISTINCT h.org_id, o.name,
           (SELECT min(hour_et) FROM lead_intake_hourly x WHERE x.org_id = h.org_id) AS first_hour
    FROM lead_intake_hourly h
    JOIN organizations o ON o.id = h.org_id
    WHERE h.hour_et = ${hour.toISOString()}::timestamptz
      AND (h.received > 0 OR h.lookups_spent > 0)
  `)) as unknown as { org_id: string; name: string; first_hour: string | Date }[];
  if (orgs.length === 0) return result;

  // Shared across orgs: one Telnyx account, one calibrated rate.
  const [rate, bal] = await Promise.all([getCalibratedLookupRate(), telnyxBalance(5000)]);
  const balanceUsd = bal.ok ? bal.availableCredit : null;

  for (const org of orgs) {
    const firstHour = new Date(org.first_hour);
    // The hour 0199's code started writing in is partial by construction.
    if (!opts.manual && firstHour.getTime() === hour.getTime()) {
      result.orgs.push({ orgId: org.org_id, rows: 0, messages: 0, invariantBreaks: null, skipped: "partial_first_hour" });
      continue;
    }
    const rows = await hourRows(dbc, org.org_id, hour);
    const invariant = await checkDaySumInvariant(dbc, org.org_id, hour, firstHour);
    const messages = formatIntakeDigest({
      windowLabel: orgs.length > 1 ? `${windowLabel(hour)} · ${org.name}` : windowLabel(hour),
      rows,
      rate: rate.rate,
      balanceUsd,
      invariant,
      firstDigestNote: opts.manual ? null : await firstDigestNote(dbc, org.org_id, hour, firstHour),
      manual: !!opts.manual,
    });
    result.messages.push(...messages);
    result.orgs.push({
      orgId: org.org_id,
      rows: rows.length,
      messages: messages.length,
      invariantBreaks: invariant ? invariant.breaks.length : null,
    });
  }
  return result;
}
