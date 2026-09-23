import { type EngagementStatus } from "./constants";

// User-facing names for contact_engagement.status. One source: the contacts
// column, the contact detail panel and the settings preview all read this.
//
// "Suppressed" HERE is the end of the lifecycle — a contact that stopped
// responding to messages. It is NOT opt_outs.reason = 'suppressed', which is
// an uploaded do-not-contact list and reads "Global suppression"
// (CONTACT_STATUS_LABELS, lib/imports/contact-status.ts). Both badges can
// appear on the same contacts row, which is why only one of them says
// "Suppressed".
export const ENGAGEMENT_STATUS_LABELS: Record<EngagementStatus, string> = {
  new: "New",
  cold: "Cold",
  hot: "Hot",
  warm: "Warm",
  freeze: "Freeze",
  suppressed: "Suppressed",
};

// Badge classes. Read as a temperature: hot is the warmest, suppressed the
// most inert. Freeze is violet rather than blue so it does not read as "cold
// but colder" — it is a different kind of state, a cadence throttle.
export const ENGAGEMENT_STATUS_CLASSES: Record<EngagementStatus, string> = {
  hot: "border-red-200 bg-red-50 text-red-700",
  warm: "border-amber-200 bg-amber-50 text-amber-700",
  new: "border-sky-200 bg-sky-50 text-sky-700",
  cold: "border-slate-200 bg-slate-50 text-slate-600",
  freeze: "border-violet-200 bg-violet-50 text-violet-700",
  suppressed: "border-muted bg-muted text-muted-foreground",
};
