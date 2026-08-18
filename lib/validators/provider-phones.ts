import { z } from "zod";

import { CARRIER_NORMS } from "@/lib/sends/carrier-policy";

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
    // Text Request only: the TR dashboard this number sends through (one
    // dashboard per number by API design). Stored as TEXT (integer or GUID).
    // The UI only surfaces this field for the txr provider; other providers
    // never send it. Null when unset.
    dashboard_id: z.string().trim().min(1).max(128).nullable().optional(),
    // Per-number short-domain override (migration 0137). Null = no override:
    // links mint under the campaign brand's domain, which is what every number
    // did before this existed. The route verifies the domain belongs to the
    // caller's org and is active before storing it.
    short_domain_id: z.number().int().positive().nullable().optional(),
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
    // Text Request only (see create schema). Editable so a number's dashboard
    // binding can be corrected; null clears it.
    dashboard_id: z.string().trim().min(1).max(128).nullable().optional(),
    // Per-number short-domain override (migration 0137). Null clears it, which
    // returns the number to the brand default rather than breaking minting.
    short_domain_id: z.number().int().positive().nullable().optional(),
    // Q4: may this number text contacts whose carrier we could not determine?
    allow_unknown_carrier: z.boolean().optional(),
    // Per-number opt-out footer (migration 0141) — the MOST SPECIFIC level of
    // the footer chain (number > account > stage > default).
    //
    // COMPLIANCE-BEARING: whatever wins the chain is the opt-out wording that
    // ships, and the kickoff gate validates the winner. A value set here must
    // contain a STOP keyword or every stage sending from this number is refused
    // with `missing_opt_out_language`. Nullable so an operator can clear it and
    // fall back to the account, which is NOT the same as setting it to "".
    opt_out_footer: z
      .string()
      .trim()
      .max(160, "Opt-out text must be 160 characters or fewer")
      .nullable()
      .optional()
      // "" and "   " mean NO PREFERENCE, not an empty footer. resolveOptOutFooter
      // already treats whitespace-only as absent; normalising here keeps the
      // column from storing a value that reads as set but behaves as unset.
      .transform((v) => (v == null || v.trim() === "" ? null : v.trim())),
    // Q4: this number's per-carrier policy rows, REPLACE-ALL. The payload is
    // the complete desired state for the number — carriers omitted from it end
    // up with no row, which means allowed and uncapped. Sent in the same PATCH
    // as the phone's own columns so the two land in ONE transaction; a separate
    // endpoint would let the toggle save while the allow-list failed.
    //
    // `daily_limit` is carried here (not just `allowed`) so the Q5 cap edits
    // through the same replace-all and neither field can wipe the other.
    carrier_limits: z
      .array(
        z.object({
          carrier_norm: z.enum(CARRIER_NORMS),
          allowed: z.boolean(),
          daily_limit: z.number().int().positive().nullable().optional(),
        }),
      )
      .max(CARRIER_NORMS.length)
      .optional()
      .superRefine((rows, ctx) => {
        if (!rows) return;
        const seen = new Set<string>();
        for (const r of rows) {
          if (seen.has(r.carrier_norm)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate carrier in carrier_limits: ${r.carrier_norm}`,
            });
          }
          seen.add(r.carrier_norm);
        }
      }),
    // Move the number to a different provider (reassigns provider_id in place;
    // clears the number's account link). When it differs from the current
    // provider and not-yet-sent stages reference the number, the route returns
    // 409 MOVE_NEEDS_CONFIRMATION unless `confirm_move` is true.
    provider_id: z.number().int().positive().optional(),
    confirm_move: z.boolean().optional(),
  })
  // `confirm_move` is a control flag, not an edit — a body carrying only it
  // (no real field change and no provider move) is a no-op, so exclude it here.
  .refine(
    (data) =>
      data.cost_per_sms !== undefined ||
      data.brand_id !== undefined ||
      data.max_sends_per_second !== undefined ||
      data.dashboard_id !== undefined ||
      data.allow_unknown_carrier !== undefined ||
      data.opt_out_footer !== undefined ||
      data.carrier_limits !== undefined ||
      data.short_domain_id !== undefined ||
      data.provider_id !== undefined,
    { message: "At least one field must be provided" },
  );

export const providerPhoneStatusChangeSchema = z.object({
  status: z.enum(PHONE_STATUSES),
});

export type ProviderPhoneCreateInput = z.infer<typeof providerPhoneCreateSchema>;
export type ProviderPhoneUpdateInput = z.infer<typeof providerPhoneUpdateSchema>;
export type ProviderPhoneStatusChangeInput = z.infer<
  typeof providerPhoneStatusChangeSchema
>;
export type ProviderPhoneFormValues = z.input<typeof providerPhoneCreateSchema>;
