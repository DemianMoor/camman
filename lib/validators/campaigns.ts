import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;

// Campaign carrier filter buckets (migration 0098). Unidentified is NOT selectable
// — when any filter is set, Unidentified contacts are always excluded.
export const CAMPAIGN_CARRIER_FILTER_VALUES = [
  "AT&T",
  "T-Mobile",
  "Verizon",
  "Other Mobile",
  "VoIP",
  "Unknown",
] as const;

const audienceFiltersSchema = z
  .object({
    include_no_status: z.boolean().optional(),
    include_opt_in: z.boolean().optional(),
    include_clickers: z.boolean().optional(),
    include_not_clicked: z.boolean().optional(),
    carrier_filter: z
      .array(z.enum(CAMPAIGN_CARRIER_FILTER_VALUES))
      .max(6)
      .optional(),
  })
  .default({});

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Date must be YYYY-MM-DD",
});

// Create. When `save_as_draft` is true ALL identifying fields are optional —
// a draft is a scratchpad and the API auto-generates a name when none is
// supplied. When `save_as_draft` is false the campaign goes active
// immediately and brand + offer + name + ≥1 segment are required.
// The superRefine below makes that conditional.
//
// Every optional field accepts BOTH undefined and null: front-end forms
// typically initialize fields to null and JSON.stringify ships them as
// literal `null`, while server callers often omit keys entirely. The
// `.nullable().optional()` pair lets both shapes through; the route
// treats them identically via `?? null` and `!= null` checks.
const campaignCreateBaseSchema = z.object({
  name: z.string().trim().max(200).nullable().optional(),
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
    .nullable()
    .optional(),
  brand_id: z.number().int().positive().nullable().optional(),
  offer_id: z.number().int().positive().nullable().optional(),
  routing_type_id: z.number().int().positive().nullable().optional(),
  traffic_type_id: z.number().int().positive().nullable().optional(),
  // Campaign-level default send-from number (migration 0115). Prefill only —
  // the send path never reads it. Null clears the default. Ownership re-verified
  // in the route against provider_phones for this org.
  default_provider_phone_id: z.number().int().positive().nullable().optional(),
  assigned_to_user_id: z.string().uuid().nullable().optional(),
  // audience_segment_ids stays .optional() (NOT nullable) because its DB
  // column is NOT NULL with default '{}'. The form always ships an array;
  // a missing field means "no change" not "set to null". Same for filters
  // and contact_group_ids.
  audience_segment_ids: z.array(z.number().int().positive()).optional(),
  // Per-segment exclude set (migration 0114). Members of these segments are
  // subtracted from the positive base. NOT NULL DEFAULT '{}' in the DB, so a
  // missing field means "no change" (PATCH) / "no excludes" (create). Must be
  // disjoint from audience_segment_ids (a segment is include XOR exclude).
  audience_exclude_segment_ids: z
    .array(z.number().int().positive())
    .optional(),
  audience_contact_group_ids: z
    .array(z.number().int().positive())
    .optional(),
  audience_filters: audienceFiltersSchema.optional(),
  // Optional cap on the random-sampled audience. Null clears the cap.
  // Validated as positive; the DB has a matching CHECK.
  audience_cap: z.number().int().positive().nullable().optional(),
  // Campaign-level "exclude contacts in use by another active campaign".
  // DB column is NOT NULL DEFAULT true, so a missing field means "no
  // change" (PATCH) / "use default" (create) — not "set to false".
  exclude_in_use_contacts: z.boolean().optional(),
  // Campaign-level "exclude leads who already received this offer in a previous
  // campaign" (Phase-2 content dedup, LAYER 3). DB column NOT NULL DEFAULT false;
  // a missing field means "no change" (PATCH) / "use default false" (create).
  exclude_prior_offer_contacts: z.boolean().optional(),
  // Send method. 'manual' (default) uses the pasted Short URL; 'tracked' mints
  // a per-recipient link. Accepted on create + update; the route guards that
  // 'tracked' requires the brand to have an active short domain.
  link_mode: z.enum(["manual", "tracked"]).optional(),
  start_date: dateStringSchema.nullable().optional(),
  end_date: dateStringSchema.nullable().optional(),
  notes: z
    .union([z.string().trim().max(2000), z.literal("")])
    .nullable()
    .optional(),
  save_as_draft: z.boolean().default(false),
});

// Drafts: a scratchpad — every field is optional. Activations (the launch
// path) require name + brand + offer + ≥1 contact group. Segments are
// optional (they widen the audience when present). The same checks run
// again in the status endpoint at draft → active so a stale draft can't
// slip through with missing fields.
// A segment can't be both an include and an exclude on the same campaign.
function assertSegmentsDisjoint(
  include: number[] | undefined,
  exclude: number[] | undefined,
  ctx: z.RefinementCtx,
) {
  if (!include || !exclude || exclude.length === 0) return;
  const inc = new Set(include);
  if (exclude.some((id) => inc.has(id))) {
    ctx.addIssue({
      path: ["audience_exclude_segment_ids"],
      code: z.ZodIssueCode.custom,
      message: "A segment can't be both included and excluded",
    });
  }
}

export const campaignCreateSchema = campaignCreateBaseSchema.superRefine(
  (data, ctx) => {
    assertSegmentsDisjoint(
      data.audience_segment_ids,
      data.audience_exclude_segment_ids,
      ctx,
    );
    if (data.save_as_draft) return;
    if (!data.name || data.name.trim().length === 0) {
      ctx.addIssue({
        path: ["name"],
        code: z.ZodIssueCode.custom,
        message: "name is required when launching",
      });
    }
    if (data.brand_id == null) {
      ctx.addIssue({
        path: ["brand_id"],
        code: z.ZodIssueCode.custom,
        message: "brand_id is required when launching",
      });
    }
    if (data.offer_id == null) {
      ctx.addIssue({
        path: ["offer_id"],
        code: z.ZodIssueCode.custom,
        message: "offer_id is required when launching",
      });
    }
    const hasGroups =
      data.audience_contact_group_ids != null &&
      data.audience_contact_group_ids.length > 0;
    if (!hasGroups) {
      ctx.addIssue({
        path: ["audience_contact_group_ids"],
        code: z.ZodIssueCode.custom,
        message: "At least one contact group is required when launching",
      });
    }
  },
);

export const campaignUpdateSchema = campaignCreateBaseSchema
  .partial()
  // Use a passthrough-then-explicit-check pattern so we can reject the
  // immutable tracking_id with a stable code rather than silently
  // stripping it. Other unknown keys still pass through (campaign create
  // schema is not strict), preserving existing PATCH behavior.
  //
  // link_mode is update-only (campaigns always start 'manual' at create).
  // The route additionally guards that 'tracked' requires the campaign's
  // brand to have an active short_domain.
  .extend({
    tracking_id: z.unknown().optional(),
  })
  .superRefine((d, ctx) => {
    assertSegmentsDisjoint(
      d.audience_segment_ids,
      d.audience_exclude_segment_ids,
      ctx,
    );
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
  });

export const campaignStatusChangeSchema = z.object({
  status: z.enum(["draft", "active", "paused", "completed", "archived"]),
});

// Audience preview takes the same shape as the audience portion of create —
// segment_ids + contact_group_ids + filters — without the rest of the
// campaign metadata. At least one of segments / groups must be non-empty;
// caller short-circuits the empty case so we don't even hit the network.
export const audiencePreviewSchema = z
  .object({
    audience_segment_ids: z.array(z.number().int().positive()).default([]),
    audience_exclude_segment_ids: z
      .array(z.number().int().positive())
      .default([]),
    audience_contact_group_ids: z
      .array(z.number().int().positive())
      .default([]),
    audience_filters: audienceFiltersSchema.optional(),
    audience_cap: z.number().int().positive().nullable().optional(),
    exclude_in_use_contacts: z.boolean().optional(),
    exclude_prior_offer_contacts: z.boolean().optional(),
    // Consumed only when exclude_prior_offer_contacts is true, to count/drop
    // leads who already received this offer (content-dedup LAYER 3 preview).
    offer_id: z.number().int().positive().nullable().optional(),
  })
  .refine(
    // A positive base is required: include segments or groups. An exclude-only
    // selection has nothing to subtract from (see design). The caller
    // short-circuits the empty case anyway.
    (d) =>
      d.audience_segment_ids.length > 0 ||
      d.audience_contact_group_ids.length > 0,
    {
      path: ["audience_segment_ids"],
      message: "Provide at least one segment or contact group",
    },
  )
  .superRefine((d, ctx) =>
    assertSegmentsDisjoint(
      d.audience_segment_ids,
      d.audience_exclude_segment_ids,
      ctx,
    ),
  );

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
