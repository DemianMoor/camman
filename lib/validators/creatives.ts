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
  "1st",
  "2nd",
  "3rd",
  "any",
  "unknown",
] as const;
export type CreativeSequencePlacement =
  (typeof SEQUENCE_PLACEMENT_VALUES)[number];

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
    applies_to_all_offers: z.boolean().default(false),
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
    applies_to_all_offers: z.boolean().optional(),
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

export type CreativeCreateInput = z.infer<typeof creativeCreateSchema>;
export type CreativeUpdateInput = z.infer<typeof creativeUpdateSchema>;
export type CreativeBulkCreateInput = z.infer<
  typeof creativeBulkCreateSchema
>;

export const BULK_CREATE_MAX = BULK_MAX_ROWS;
