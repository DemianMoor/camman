import { z } from "zod";

// Provider phone validators.
//
// On create, `phone_number` is the raw user input — the API normalizes it via
// validatePhone() before insert. `provider_id` is not in this schema; it comes
// from the URL path.
//
// On update, `phone_number` is intentionally absent: changing the number means
// a new record. The route also rejects PATCH attempts that include it.

export const PHONE_STATUSES = ["active", "suspended", "blocked"] as const;

export const providerPhoneCreateSchema = z.object({
  phone_number: z.string().trim().min(1, "Phone number is required").max(30),
  cost_per_sms: z
    .number()
    .min(0, "Cost per SMS must be 0 or greater")
    .max(999999, "Cost per SMS is too large"),
  brand_id: z.number().int().positive().nullable().optional(),
});

export const providerPhoneUpdateSchema = z
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

export const providerPhoneStatusChangeSchema = z.object({
  status: z.enum(PHONE_STATUSES),
});

export type ProviderPhoneCreateInput = z.infer<typeof providerPhoneCreateSchema>;
export type ProviderPhoneUpdateInput = z.infer<typeof providerPhoneUpdateSchema>;
export type ProviderPhoneStatusChangeInput = z.infer<
  typeof providerPhoneStatusChangeSchema
>;
export type ProviderPhoneFormValues = z.input<typeof providerPhoneCreateSchema>;
