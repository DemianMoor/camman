import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

// Project-wide single timezone for all campaign-related times. SMS sending
// is operationally anchored to ET; using one zone everywhere avoids the
// per-user/per-org timezone complexity that we don't need yet.
export const CAMPAIGN_TIMEZONE = "America/New_York";
export const CAMPAIGN_TIMEZONE_LABEL = "ET";

// Render a UTC instant as a human-readable string in the campaign timezone,
// suffixed with the timezone label. Returns "—" for null/undefined so it
// can be dropped straight into a table cell.
export function formatCampaignDateTime(
  utc: Date | string | null | undefined,
): string {
  if (utc == null) return "—";
  const date = typeof utc === "string" ? new Date(utc) : utc;
  if (Number.isNaN(date.getTime())) return "—";
  return `${formatInTimeZone(date, CAMPAIGN_TIMEZONE, "MMM d, yyyy h:mm a")} ${CAMPAIGN_TIMEZONE_LABEL}`;
}

// Format an instant in the campaign timezone using an arbitrary date-fns
// format string. Used by lib/tracking-id.ts to build the MMDDYY date
// segment and the YYYY-MM-DD counter-table key. Throws if `utc` is not a
// valid date — callers always have one (e.g. campaigns.created_at), and
// failing loud beats silently producing a malformed tracking_id.
export function formatInCampaignTimezone(
  utc: Date | string,
  pattern: string,
): string {
  const date = typeof utc === "string" ? new Date(utc) : utc;
  if (Number.isNaN(date.getTime())) {
    throw new Error("formatInCampaignTimezone: invalid date");
  }
  return formatInTimeZone(date, CAMPAIGN_TIMEZONE, pattern);
}

// Convert a value from <input type="datetime-local"> (interpreted as ET
// wall-clock time, no tz suffix) to a UTC ISO string suitable for the API.
export function campaignLocalInputToUtcIso(localInput: string): string {
  return fromZonedTime(localInput, CAMPAIGN_TIMEZONE).toISOString();
}

// Convert a UTC instant to the "yyyy-MM-ddTHH:mm" string the datetime-local
// input expects, expressed in the campaign timezone.
export function utcToCampaignLocalInput(
  utc: Date | string | null | undefined,
): string {
  if (utc == null) return "";
  const date = typeof utc === "string" ? new Date(utc) : utc;
  if (Number.isNaN(date.getTime())) return "";
  return formatInTimeZone(date, CAMPAIGN_TIMEZONE, "yyyy-MM-dd'T'HH:mm");
}

