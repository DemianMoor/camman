import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";

// Drip admission window (carry-over, spec 2026-10-12 §4.1). PURE — no DB, so
// the routing evaluator, the worker's scan floor and the tests share one formula.
//
//   admission closes = end of (arrival ET day + carry days) + cutoff minutes
//
// ⭐ A lead that arrived BEFORE the effective widened_at gets window 0 — the end
// of its arrival day, no carry, no cutoff. Window 0 is the smallest window that
// has ever existed, so a lead that expired under ANY earlier setting is still
// expired: widening the setting can drop pending carries, never revive anything.
// widened_at is stamped by DB triggers (migration 0204), not by callers.

export const MAX_CARRY_DAYS = 7;

export interface AdmissionSettings {
  cfgCarryDays: number | null;
  cfgCutoffMinutes: number | null;
  cfgWidenedAt: Date | string | null;
  orgCarryDays: number | null;
  orgCutoffMinutes: number | null;
  orgWidenedAt: Date | string | null;
}

export interface AdmissionClose {
  closesAt: Date;
  carryDays: number;
  cutoffMinutes: number;
  preWidening: boolean;
  widenedAt: Date | null;
}

const ms = (v: Date | string | null) => (v == null ? null : new Date(v).getTime());

/** GREATEST(campaign, org) — an org-default raise also resets an overriding campaign (drops only). */
export function effectiveWidenedAt(s: AdmissionSettings): Date | null {
  const a = ms(s.cfgWidenedAt);
  const b = ms(s.orgWidenedAt);
  if (a == null && b == null) return null;
  return new Date(Math.max(a ?? -Infinity, b ?? -Infinity));
}

function carryOf(s: AdmissionSettings) {
  return s.cfgCarryDays ?? s.orgCarryDays ?? 0;
}
function cutoffOf(s: AdmissionSettings) {
  return s.cfgCutoffMinutes ?? s.orgCutoffMinutes ?? 0;
}

/** Start of the ET day `days` before the ET day containing `d` (DST-safe). */
function etDayStartBack(d: Date, days: number): Date {
  let start = campaignDayBoundsUtc(d).start;
  for (let i = 0; i < days; i++) start = campaignDayBoundsUtc(new Date(start.getTime() - 1)).start;
  return start;
}

export function admissionCloses(receivedAt: Date | string, s: AdmissionSettings): AdmissionClose {
  const rec = new Date(receivedAt);
  const widenedAt = effectiveWidenedAt(s);
  const preWidening = widenedAt != null && rec.getTime() < widenedAt.getTime();
  const carryDays = preWidening ? 0 : carryOf(s);
  const cutoffMinutes = preWidening ? 0 : cutoffOf(s);
  let end = campaignDayBoundsUtc(rec).end;
  for (let i = 0; i < carryDays; i++) end = campaignDayBoundsUtc(end).end;
  return {
    closesAt: new Date(end.getTime() + cutoffMinutes * 60_000),
    carryDays, cutoffMinutes, preWidening, widenedAt,
  };
}

/**
 * The earliest received_at this campaign could still admit at `now`. With carry
 * 0 and no widening it is today's floor: dayStart(now − cutoff). Leads before
 * widened_at only have their arrival day, so the floor never goes below
 * min(widened_at, today's midnight).
 */
export function scanFloor(now: Date, s: AdmissionSettings): Date {
  const floor = etDayStartBack(new Date(now.getTime() - cutoffOf(s) * 60_000), carryOf(s));
  const widenedAt = effectiveWidenedAt(s);
  if (widenedAt == null) return floor;
  const today = campaignDayBoundsUtc(now).start;
  return new Date(Math.max(floor.getTime(), Math.min(widenedAt.getTime(), today.getTime())));
}

/** Admitted on a later ET day than the lead arrived. */
export function isCarried(receivedAt: Date | string, now: Date): boolean {
  return campaignDayBoundsUtc(new Date(receivedAt)).start.getTime() < campaignDayBoundsUtc(now).start.getTime();
}
