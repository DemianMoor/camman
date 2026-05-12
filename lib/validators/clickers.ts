import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

// Clickers MUST have a brand — we always know which brand was clicked.
export const clickerUploadSchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
  brand_id: z.number().int().positive(),
  provider_id: z.number().int().positive().nullable().optional(),
  provider_phone_id: z.number().int().positive().nullable().optional(),
  offer_id: z.number().int().positive().nullable().optional(),
  source: z.string().trim().max(100).optional(),
});

export const clickerBulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export type ClickerUploadInput = z.infer<typeof clickerUploadSchema>;
