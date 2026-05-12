import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;

const audienceFiltersSchema = z
  .object({
    include_no_status: z.boolean().optional(),
    include_opt_in: z.boolean().optional(),
    include_clickers: z.boolean().optional(),
    include_not_clicked: z.boolean().optional(),
  })
  .default({});

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Date must be YYYY-MM-DD",
});

// Create. When `save_as_draft` is true we relax: only `name` is required so
// the user can scaffold an idea and fill in the rest later. When false, the
// campaign goes active immediately and the full set of fields must be
// present. The superRefine below makes that conditional.
const campaignCreateBaseSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  human_id: z
    .union([
      z
        .string()
        .trim()
        .max(60)
        .regex(
          /^[A-Za-z0-9_-]+$/,
          "human_id may only contain letters, digits, hyphens, and underscores",
        ),
      z.literal(""),
    ])
    .optional(),
  brand_id: z.number().int().positive().optional(),
  offer_id: z.number().int().positive().optional(),
  routing_type_id: z.number().int().positive().nullable().optional(),
  traffic_type_id: z.number().int().positive().nullable().optional(),
  assigned_to_user_id: z.string().uuid().nullable().optional(),
  audience_segment_ids: z.array(z.number().int().positive()).optional(),
  audience_filters: audienceFiltersSchema.optional(),
  start_date: dateStringSchema.optional(),
  end_date: dateStringSchema.optional(),
  notes: z.union([z.string().trim().max(2000), z.literal("")]).optional(),
  save_as_draft: z.boolean().default(false),
});

// `save_as_draft` only relaxes the audience portion of the form — the
// top-of-form identifiers (brand_id, offer_id) are still required because
// the audience snapshot is brand-scoped and a campaign without an offer
// has no destination URL to wrap in short links. Other fields that ARE
// relaxed by drafts: audience_segment_ids, start_date, end_date,
// routing_type_id, traffic_type_id, notes (already optional),
// assigned_to_user_id (defaults to creator anyway).
export const campaignCreateSchema = campaignCreateBaseSchema.superRefine(
  (data, ctx) => {
    if (data.brand_id == null) {
      ctx.addIssue({
        path: ["brand_id"],
        code: z.ZodIssueCode.custom,
        message: "brand_id is required",
      });
    }
    if (data.offer_id == null) {
      ctx.addIssue({
        path: ["offer_id"],
        code: z.ZodIssueCode.custom,
        message: "offer_id is required",
      });
    }
    if (
      !data.save_as_draft &&
      (!data.audience_segment_ids ||
        data.audience_segment_ids.length === 0)
    ) {
      ctx.addIssue({
        path: ["audience_segment_ids"],
        code: z.ZodIssueCode.custom,
        message: "At least one segment is required when launching",
      });
    }
  },
);

export const campaignUpdateSchema = campaignCreateBaseSchema
  .partial()
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export const campaignStatusChangeSchema = z.object({
  status: z.enum(["draft", "active", "paused", "completed", "archived"]),
});

// Audience preview takes the same shape as the audience portion of create —
// segment_ids + filters — without the rest of the campaign metadata.
export const audiencePreviewSchema = z.object({
  audience_segment_ids: z.array(z.number().int().positive()).min(1),
  audience_filters: audienceFiltersSchema.optional(),
});

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
