import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

// Opt-outs MUST be scoped to at least one brand. Optionally scoped to providers.
export const optOutUploadSchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
  brand_ids: z
    .array(z.number().int().positive())
    .min(1, "Select at least one brand"),
  provider_ids: z.array(z.number().int().positive()).default([]),
  source: z.string().trim().max(100).optional(),
  // Optional: tag every uploaded contact with these contact groups too.
  // The upload pipeline applies them after contacts are upserted.
  assign_to_group_ids: z
    .array(z.number().int().positive())
    .max(50, "At most 50 groups per upload")
    .optional(),
});

export const optOutBulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const optOutBulkDeleteByBrandSchema = z.object({
  brand_id: z.number().int().positive(),
});

export type OptOutUploadInput = z.infer<typeof optOutUploadSchema>;
