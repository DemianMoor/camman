import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Segment Group validators. Mirror of routing-types/traffic-types — same
// shape, different entity. Segments themselves don't exist yet (Step 6).

export const segmentGroupCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  segment_group_id: z
    .string()
    .trim()
    .min(1, "segment_group_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "segment_group_id may only contain letters, digits, hyphens, and underscores",
    ),
  description: z.string().trim().max(500).optional(),
  color: z
    .union([
      z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "color must be a 6-char hex like #1A2B3C"),
      z.literal(""),
    ])
    .optional(),
});

export const segmentGroupUpdateSchema = segmentGroupCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type SegmentGroupCreateInput = z.infer<typeof segmentGroupCreateSchema>;
export type SegmentGroupUpdateInput = z.infer<typeof segmentGroupUpdateSchema>;
export type SegmentGroupFormValues = z.input<typeof segmentGroupCreateSchema>;
