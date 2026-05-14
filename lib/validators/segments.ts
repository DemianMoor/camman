import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

// Segments no longer carry group membership (groups are on contacts now,
// not on segments). The `segment_group_ids` field was removed in 0031.
export const segmentCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  segment_id: z
    .string()
    .trim()
    .min(1, "segment_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "segment_id may only contain letters, digits, hyphens, and underscores",
    ),
  original_name: z.string().trim().max(120).optional(),
});

export const segmentUpdateSchema = segmentCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export const segmentContactsUploadSchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
});

export const segmentContactsRemoveSchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
});

export const segmentOverlapsSchema = z.object({
  segment_ids: z
    .array(z.number().int().positive())
    .min(2, "Select at least 2 segments")
    .max(15, "Select at most 15 segments"),
});

export type SegmentCreateInput = z.infer<typeof segmentCreateSchema>;
export type SegmentUpdateInput = z.infer<typeof segmentUpdateSchema>;
export type SegmentFormValues = z.input<typeof segmentCreateSchema>;
