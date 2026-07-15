import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const TEXT_MAX = 1600; // ~10 GSM-7 segments — a sane upper bound
const BULK_MAX_ROWS = 50;

export const CREATIVE_STATUSES = ["active", "archived"] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];

export const QUALITY_VALUES = [
  "high",
  "average",
  "poor",
  "unknown",
] as const;
export type CreativeQuality = (typeof QUALITY_VALUES)[number];

export const SEQUENCE_PLACEMENT_VALUES = [
  "warmup",
  "1st",
  "2nd",
  "3rd",
  "4th",
  "5th",
  "6th",
  "any",
  "unknown",
] as const;
export type CreativeSequencePlacement =
  (typeof SEQUENCE_PLACEMENT_VALUES)[number];

// Manual funnel-stage metadata. Like `quality`, this is user-managed and
// not enforced anywhere else in the system. Ordered funnel-first with
// 'unknown' last (the default).
export const FUNNEL_STAGE_VALUES = [
  "start",
  "clicked",
  "checkout",
  "ignored",
  "unknown",
] as const;
export type CreativeFunnelStage = (typeof FUNNEL_STAGE_VALUES)[number];

const creativeIdField = z
  .union([
    z
      .string()
      .trim()
      .max(80)
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "creative_id may only contain letters, digits, hyphens, and underscores",
      ),
    z.literal(""),
  ])
  .optional();

// At-least-one association rule. Either applies_to_all_offers is true,
// or there's at least one offer_id. Used by single-create and bulk-create.
const OFFER_REQUIREMENT_MSG =
  "Must apply to at least one offer (or select 'All offers').";

export const creativeCreateSchema = z
  .object({
    text: z
      .string()
      .min(1, "Message text is required")
      .max(TEXT_MAX, `Message text must be at most ${TEXT_MAX} characters`),
    creative_id: creativeIdField,
    quality: z.enum(QUALITY_VALUES).default("unknown"),
    sequence_placement: z
      .enum(SEQUENCE_PLACEMENT_VALUES)
      .default("unknown"),
    funnel_stage: z.enum(FUNNEL_STAGE_VALUES).default("unknown"),
    applies_to_all_offers: z.boolean().default(false),
    allow_multi_segment: z.boolean().default(false),
    offer_ids: z.array(z.number().int().positive()).default([]),
  })
  .refine(
    (d) => d.applies_to_all_offers === true || d.offer_ids.length > 0,
    { message: OFFER_REQUIREMENT_MSG, path: ["offer_ids"] },
  );

// Update schema: every field optional. The OFFER_REQUIREMENT rule isn't
// enforced here at the schema level — the resulting state after merging
// the patch with the existing row may still satisfy the rule even when
// the patch alone doesn't. The route handler checks the merged state.
export const creativeUpdateSchema = z
  .object({
    text: z.string().min(1).max(TEXT_MAX).optional(),
    creative_id: creativeIdField,
    quality: z.enum(QUALITY_VALUES).optional(),
    sequence_placement: z.enum(SEQUENCE_PLACEMENT_VALUES).optional(),
    funnel_stage: z.enum(FUNNEL_STAGE_VALUES).optional(),
    applies_to_all_offers: z.boolean().optional(),
    allow_multi_segment: z.boolean().optional(),
    offer_ids: z.array(z.number().int().positive()).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

// Bulk create. Shared offer association + quality + sequence applies to
// every row in the batch; only `text` (and optional `creative_id`) varies
// per row. Cap at BULK_MAX_ROWS to prevent transaction abuse.
export const creativeBulkCreateSchema = z
  .object({
    applies_to_all_offers: z.boolean().default(false),
    offer_ids: z.array(z.number().int().positive()).default([]),
    quality: z.enum(QUALITY_VALUES).default("unknown"),
    sequence_placement: z
      .enum(SEQUENCE_PLACEMENT_VALUES)
      .default("unknown"),
    funnel_stage: z.enum(FUNNEL_STAGE_VALUES).default("unknown"),
    creatives: z
      .array(
        z.object({
          text: z.string().min(1, "Message text is required").max(TEXT_MAX),
          creative_id: creativeIdField,
        }),
      )
      .min(1, "At least one creative is required")
      .max(BULK_MAX_ROWS, `At most ${BULK_MAX_ROWS} creatives per batch`),
  })
  .refine(
    (d) => d.applies_to_all_offers === true || d.offer_ids.length > 0,
    { message: OFFER_REQUIREMENT_MSG, path: ["offer_ids"] },
  );

// Bulk edit. Applies one set of changes to many existing creatives.
// Every mutation field is optional; the refine guarantees at least one is
// present. `add_offer_ids` is ADDITIVE — it appends to each creative's
// existing offer set (union), never replacing. `status` doubles as a bulk
// archive/restore (the route maps it to the archive/restore permissions).
const BULK_EDIT_MAX_IDS = 5000;
const BULK_EDIT_MAX_OFFERS = 200;

export const creativeBulkUpdateSchema = z
  .object({
    creative_ids: z
      .array(z.number().int().positive())
      .min(1, "Select at least one creative")
      .max(BULK_EDIT_MAX_IDS, `At most ${BULK_EDIT_MAX_IDS} creatives per request`),
    quality: z.enum(QUALITY_VALUES).optional(),
    sequence_placement: z.enum(SEQUENCE_PLACEMENT_VALUES).optional(),
    funnel_stage: z.enum(FUNNEL_STAGE_VALUES).optional(),
    status: z.enum(CREATIVE_STATUSES).optional(),
    add_offer_ids: z
      .array(z.number().int().positive())
      .max(BULK_EDIT_MAX_OFFERS)
      .optional(),
  })
  .refine(
    (d) =>
      d.quality !== undefined ||
      d.sequence_placement !== undefined ||
      d.funnel_stage !== undefined ||
      d.status !== undefined ||
      (d.add_offer_ids !== undefined && d.add_offer_ids.length > 0),
    { message: "At least one change must be provided" },
  );

// Bulk spam score. The route caps each request to a small batch and the
// client chunks larger selections, so the per-request id cap is low to keep
// each request well under the serverless function timeout.
const BULK_SCORE_MAX_IDS = 100;

export const creativeBulkScoreSchema = z.object({
  creative_ids: z
    .array(z.number().int().positive())
    .min(1, "Select at least one creative")
    .max(BULK_SCORE_MAX_IDS, `At most ${BULK_SCORE_MAX_IDS} creatives per request`),
  force: z.boolean().optional(),
});

export type CreativeCreateInput = z.infer<typeof creativeCreateSchema>;
export type CreativeUpdateInput = z.infer<typeof creativeUpdateSchema>;
export type CreativeBulkCreateInput = z.infer<
  typeof creativeBulkCreateSchema
>;
export type CreativeBulkUpdateInput = z.infer<
  typeof creativeBulkUpdateSchema
>;
export type CreativeBulkScoreInput = z.infer<
  typeof creativeBulkScoreSchema
>;

export const BULK_CREATE_MAX = BULK_MAX_ROWS;
export const BULK_SCORE_MAX = BULK_SCORE_MAX_IDS;
