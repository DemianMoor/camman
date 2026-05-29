import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

export const STAGE_STATUSES = [
  "draft",
  "pending",
  "sent",
  "success",
  "cancelled",
  "failed",
  "archived",
] as const;

// Every optional field accepts both undefined (key omitted) and null
// (key sent with explicit null), matching campaigns.ts. Forms typically
// JSON.stringify null fields rather than omitting them.
const stageBaseSchema = z.object({
  label: z
    .union([z.string().trim().max(120), z.literal("")])
    .nullable()
    .optional(),
  creative_id: z.number().int().positive().nullable().optional(),
  sms_provider_id: z.number().int().positive().nullable().optional(),
  provider_phone_id: z.number().int().positive().nullable().optional(),
  sales_page_label: z
    .union([z.string().trim().max(80), z.literal("")])
    .nullable()
    .optional(),
  // Optional URLs. short_url is rendered into the SMS preview; full_url
  // is tracking metadata only. Length caps are loose because providers
  // vary on what they'll shorten — we don't second-guess them here.
  short_url: z
    .union([z.string().trim().max(500), z.literal("")])
    .nullable()
    .optional(),
  full_url: z
    .union([z.string().trim().max(2000), z.literal("")])
    .nullable()
    .optional(),
  stop_text: z.string().trim().min(1).max(80).default("Stop to END"),
  include_clickers: z.boolean().default(false),
  exclude_clickers: z.boolean().default(false),
  include_no_status: z.boolean().default(true),
  scheduled_at: z
    .string()
    .datetime({ offset: true, message: "scheduled_at must be an ISO 8601 datetime with timezone offset" })
    .nullable()
    .optional(),
  notes: z
    .union([z.string().trim().max(2000), z.literal("")])
    .nullable()
    .optional(),
});

export const stageCreateSchema = stageBaseSchema.refine(
  (d) => !(d.include_clickers && d.exclude_clickers),
  {
    path: ["include_clickers"],
    message: "include_clickers and exclude_clickers can't both be true",
  },
);

export const stageUpdateSchema = stageBaseSchema
  .partial()
  // Same pattern as campaignUpdateSchema: accept tracking_id only to
  // explicitly reject it with a TRACKING_ID_IMMUTABLE code instead of
  // silently stripping. The route inspects issue.params.code.
  .extend({ tracking_id: z.unknown().optional() })
  .superRefine((d, ctx) => {
    if (d.tracking_id !== undefined) {
      ctx.addIssue({
        path: ["tracking_id"],
        code: z.ZodIssueCode.custom,
        message: "tracking_id is read-only",
        params: { code: "TRACKING_ID_IMMUTABLE" },
      });
    }
    if (!Object.entries(d).some(([k, v]) => k !== "tracking_id" && v !== undefined)) {
      ctx.addIssue({
        path: [],
        code: z.ZodIssueCode.custom,
        message: "At least one field must be provided",
      });
    }
    if (d.include_clickers === true && d.exclude_clickers === true) {
      ctx.addIssue({
        path: ["include_clickers"],
        code: z.ZodIssueCode.custom,
        message: "include_clickers and exclude_clickers can't both be true",
      });
    }
  });

// Manual results entry. Directly SETS the stage's aggregate result
// counters by hand, for providers that don't expose a CSV/report to
// import. Distinct from the CSV import path: no phone-level rows, no
// opt-out/clicker propagation — just the headline numbers.
export const stageManualResultsSchema = z.object({
  sms_count: z.number().int().nonnegative(),
  delivered_count: z.number().int().nonnegative(),
  opt_out_count: z.number().int().nonnegative(),
  // click_count = "Clicker 1st Day"; late_click_count = "Late Clickers".
  click_count: z.number().int().nonnegative(),
  late_click_count: z.number().int().nonnegative(),
  scrubbed_count: z.number().int().nonnegative(),
  bounced_count: z.number().int().nonnegative(),
  checkout_click_count: z.number().int().nonnegative(),
  sales_count: z.number().int().nonnegative(),
  total_cost: z.number().nonnegative().finite(),
  // sales_payout_each is NOT accepted from the client — the server snapshots
  // it from the campaign's offer payout to keep revenue trustworthy.
});

export type StageManualResultsInput = z.infer<
  typeof stageManualResultsSchema
>;

// Note: `archived` transitions go through the dedicated archive endpoint,
// not this one — same pattern as creatives.
export const stageStatusChangeSchema = z.object({
  status: z.enum([
    "draft",
    "pending",
    "sent",
    "success",
    "cancelled",
    "failed",
  ]),
});

export type StageCreateInput = z.infer<typeof stageCreateSchema>;
export type StageUpdateInput = z.infer<typeof stageUpdateSchema>;
export type StageStatus = (typeof STAGE_STATUSES)[number];
