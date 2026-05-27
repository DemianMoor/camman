import { z } from "zod";

// Provider short code validators.
//
// A short code is a 5–6 digit numeric SMS identifier (US/CA short codes are
// 5–6 digits). `provider_id` is not in this schema; it comes from the URL path.
//
// On update, `short_code` is intentionally absent: changing the code means a
// new record. The route also rejects PATCH attempts that include it.

export const SHORT_CODE_STATUSES = ["active", "suspended", "blocked"] as const;

export const SHORT_CODE_REGEX = /^\d{5,6}$/;

export const providerShortCodeCreateSchema = z.object({
  short_code: z
    .string()
    .trim()
    .regex(SHORT_CODE_REGEX, "Short code must be 5 or 6 digits"),
  cost_per_sms: z
    .number()
    .min(0, "Cost per SMS must be 0 or greater")
    .max(999999, "Cost per SMS is too large"),
  brand_id: z.number().int().positive().nullable().optional(),
});

export const providerShortCodeUpdateSchema = z
  .object({
    cost_per_sms: z
      .number()
      .min(0, "Cost per SMS must be 0 or greater")
      .max(999999, "Cost per SMS is too large")
      .optional(),
    brand_id: z.number().int().positive().nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export const providerShortCodeStatusChangeSchema = z.object({
  status: z.enum(SHORT_CODE_STATUSES),
});

export type ProviderShortCodeCreateInput = z.infer<
  typeof providerShortCodeCreateSchema
>;
export type ProviderShortCodeUpdateInput = z.infer<
  typeof providerShortCodeUpdateSchema
>;
export type ProviderShortCodeStatusChangeInput = z.infer<
  typeof providerShortCodeStatusChangeSchema
>;
export type ProviderShortCodeFormValues = z.input<
  typeof providerShortCodeCreateSchema
>;
