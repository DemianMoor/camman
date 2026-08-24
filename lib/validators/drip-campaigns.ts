import { z } from "zod";

import { CAMPAIGN_CARRIER_FILTER_VALUES } from "@/lib/validators/campaigns";
import { DEMOGRAPHIC_FILTERS } from "@/lib/drip/routing-eval";
// Shared with the campaign editor so the dropdown can never offer a value the
// validator rejects (or omit one it accepts).
import { AGE_BANDS, GENDERS, INCOME_BANDS } from "@/lib/drip/demographics";

// Drip campaign config validators (Drip Phase 4).
//
// ⚠️ The demographic filter keys are validated against DEMOGRAPHIC_FILTERS, the
// SAME list the routing evaluator reads. A filter key that validates here but is
// unknown there would be stored, displayed, and silently ignored at routing —
// the campaign would look narrower than it is. One list, both sides, the same
// discipline segment rule types use.



// Each filter is a LIST of accepted values (or a boolean for the yes/no ones).
// A list rather than a scalar because "TX or FL" is the common case and encoding
// it as one row per state would multiply campaigns.
const filtersSchema = z
  .object({
    gender: z.array(z.enum(GENDERS)).min(1).optional(),
    age_band: z.array(z.enum(AGE_BANDS)).min(1).optional(),
    state: z.array(z.string().trim().min(1).max(64)).min(1).optional(),
    country: z.array(z.string().trim().min(1).max(64)).min(1).optional(),
    income_band: z.array(z.enum(INCOME_BANDS)).min(1).optional(),
    kids: z.boolean().optional(),
    married: z.boolean().optional(),
  })
  .strict()
  .default({});

// Belt and braces: if someone adds a key to the Zod object above but forgets
// DEMOGRAPHIC_FILTERS, this fails at module load rather than silently at routing.
const declared = new Set<string>(Object.keys(filtersSchema._def.innerType.shape));
for (const f of DEMOGRAPHIC_FILTERS) {
  if (!declared.has(f)) {
    throw new Error(
      `drip filter "${f}" is in DEMOGRAPHIC_FILTERS but not in the validator — ` +
        `it would be ignored at routing`,
    );
  }
}

export const dripConfigSchema = z
  .object({
    interest_tag: z.string().trim().min(1, "Interest tag is required").max(64),
    partner_key_id: z.number().int().positive().nullable().optional(),
    start_at: z.string().datetime({ offset: true }).nullable().optional(),
    end_at: z.string().datetime({ offset: true }).nullable().optional(),
    // Stored and displayed, but NOT enforced in Phase 4 — the send-time cap
    // lands in Phase 5. The UI must say so.
    daily_cap: z.number().int().positive().nullable().optional(),
    campaign_cap: z.number().int().positive().nullable().optional(),
    // The distinctly-named routing throttle. NULL = unlimited.
    routing_daily_admission_cap: z.number().int().positive().nullable().optional(),
    priority: z.number().int().min(1).max(10000).optional(),
    filters: filtersSchema.optional(),
    // Drip reuses the regular campaign carrier filter representation.
    carrier_filter: z.array(z.enum(CAMPAIGN_CARRIER_FILTER_VALUES)).max(6).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.start_at && v.end_at && new Date(v.end_at) <= new Date(v.start_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_at"],
        message: "End must be after start",
      });
    }
  });

export type DripConfigInput = z.infer<typeof dripConfigSchema>;
