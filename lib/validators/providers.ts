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
  // Whether this provider can be sent through via API (TextHub). Toggled in the
  // provider edit UI; a tracked send requires this on + a resolvable credential.
  supports_api_send: z.boolean().optional().default(false),
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

// Set/rotate a provider's API key. brand_id null = the provider-wide default
// key; a positive id scopes the key to that brand. The key itself is never
// echoed back to the client (responses are masked).
export const providerCredentialSetSchema = z.object({
  brand_id: z.number().int().positive().nullable().optional().default(null),
  api_key: z.string().trim().min(1, "API key is required").max(500),
});

export type ProviderCredentialSetInput = z.infer<
  typeof providerCredentialSetSchema
>;

// Send a one-off test SMS using a specific stored credential. The key is
// resolved server-side from credential_id (never sent by the client). number
// is validated/normalized to E.164 in the route.
export const providerCredentialTestSchema = z.object({
  credential_id: z.number().int().positive(),
  number: z.string().trim().min(1, "Recipient number is required").max(40),
  text: z.string().trim().min(1, "Message text is required").max(1000),
});

export type ProviderCredentialTestInput = z.infer<
  typeof providerCredentialTestSchema
>;
