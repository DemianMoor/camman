import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export const optInUploadSchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
  brand_id: z.number().int().positive(),
  provider_id: z.number().int().positive().nullable().optional(),
  source: z.string().trim().max(100).optional(),
});

export const optInBulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export type OptInUploadInput = z.infer<typeof optInUploadSchema>;
