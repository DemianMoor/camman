import type { KickoffRefusal } from "@/lib/sends/kickoff";

// Operator-readable message + HTTP status per kickoff refusal. Shared by the
// kickoff route and the collapsed Approve-Send endpoint so the wording can't drift.
export const KICKOFF_REFUSAL: Record<KickoffRefusal, { status: number; message: string }> = {
  not_found: { status: 404, message: "Campaign or stage not found" },
  no_creative: { status: 400, message: "Add a creative to this stage before sending" },
  no_schedule: {
    status: 400,
    message: "Set a send date/time before sending (a copied stage starts with no date)",
  },
  already_pending: {
    status: 409,
    message: "This stage already has a pending send batch — resolve it before starting another",
  },
  no_recipients: { status: 400, message: "No recipients qualify for this stage" },
  stage_not_ready: {
    status: 400,
    message: "Stage isn't ready to send — it's missing its tracking ID",
  },
  no_provider: { status: 400, message: "Assign an SMS provider to this stage first" },
  provider_not_api_capable: {
    status: 400,
    message: "The stage's SMS provider isn't enabled for API sending",
  },
  no_credentials: {
    status: 400,
    message: "The stage's SMS provider has no API credentials configured",
  },
  no_short_domain: {
    status: 400,
    message: "Add an active short domain for this brand before sending tracked links",
  },
  no_destination: {
    status: 400,
    message: "The tracked link has no destination — set a sales page (and tracking) on the stage",
  },
};
