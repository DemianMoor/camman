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

// Number categories. '10dlc' and 'toll_free' are E.164 phone numbers
// (validated via validatePhone in the route); 'short_code' is a 5–6 digit
// numeric code (validated against SHORT_CODE_REGEX, no E.164 parsing).
export const NUMBER_TYPES = ["10dlc", "toll_free", "short_code"] as const;
export type NumberType = (typeof NUMBER_TYPES)[number];

export const SHORT_CODE_REGEX = /^\d{5,6}$/;

export const NUMBER_TYPE_LABELS: Record<NumberType, string> = {
  "10dlc": "10DLC",
  toll_free: "Toll-Free",
  short_code: "Short Code",
};

export const providerPhoneCreateSchema = z
  .object({
    phone_number: z.string().trim().min(1, "Phone number is required").max(30),
    number_type: z.enum(NUMBER_TYPES),
    cost_per_sms: z
      .number()
      .min(0, "Cost per SMS must be 0 or greater")
      .max(999999, "Cost per SMS is too large"),
    brand_id: z.number().int().positive().nullable().optional(),
    // HARD per-second send rate for this number (carrier limit; differs by
    // number type — e.g. 60/s short code, 3/s toll free). Null = built-in
    // default. The drain paces parallel sends to never exceed it.
    max_sends_per_second: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // Short codes have a fixed numeric shape; phone numbers are validated
    // (and normalized) server-side via validatePhone.
    if (
      data.number_type === "short_code" &&
      !SHORT_CODE_REGEX.test(data.phone_number.trim())
    ) {
      ctx.addIssue({
        path: ["phone_number"],
        code: z.ZodIssueCode.custom,
        message: "Short code must be 5 or 6 digits",
      });
    }
  });

export const providerPhoneUpdateSchema = z
  .object({
    cost_per_sms: z
      .number()
      .min(0, "Cost per SMS must be 0 or greater")
      .max(999999, "Cost per SMS is too large")
      .optional(),
    brand_id: z.number().int().positive().nullable().optional(),
    max_sends_per_second: z.number().int().min(1).max(1000).nullable().optional(),
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
