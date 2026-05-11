import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// SMS Provider validators. Brands/Networks shape plus two short-link fields.

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  sms_provider_id: z
    .string()
    .trim()
    .min(1, "sms_provider_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "sms_provider_id may only contain letters, digits, hyphens, and underscores",
    ),
  short_link_supported: z.boolean().optional().default(false),
  short_link_example: z.string().trim().max(200).optional(),
  avatar_url: z
    .union([z.string().url("avatar_url must be a valid URL"), z.literal("")])
    .optional(),
  color: z
    .union([
      z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "color must be a 6-char hex like #1A2B3C"),
      z.literal(""),
    ])
    .optional(),
});

export const providerUpdateSchema = providerCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;
export type ProviderUpdateInput = z.infer<typeof providerUpdateSchema>;
export type ProviderFormValues = z.input<typeof providerCreateSchema>;
