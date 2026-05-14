import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Offer validators.
//
// Mirrors the Brands shape, with two extras specific to offers:
// 1) Conditional payout fields — only one of payout_cpa / payout_revshare is
//    required, gated on payout_model. Enforced via .superRefine so RHF can show
//    inline errors on the right field.
// 2) sales_pages array — up to 10 { label, url } entries. Stored verbatim in
//    JSONB; pre-validated here so the API doesn't have to re-check structure.
//
// Optional string fields accept empty strings (form inputs default to "") and
// are normalized to NULL at the API boundary via nullIfEmpty.

export const salesPageSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  url: z.string().trim().min(1, "URL is required").max(500),
});

const payoutModelEnum = z.enum(["cpa", "revshare"]);

const baseOfferShape = {
  name: z.string().trim().min(1, "Name is required").max(120),
  offer_id: z
    .string()
    .trim()
    .min(1, "offer_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "offer_id may only contain letters, digits, hyphens, and underscores",
    ),
  postfix: z.string().trim().max(80).optional(),
  base_url: z.string().trim().max(500).optional(),
  network_id: z.number({ message: "Network is required" }).int().positive(),
  payout_model: payoutModelEnum,
  payout_cpa: z.number().nonnegative().optional(),
  payout_revshare: z.number().min(0).max(100).optional(),
  sales_pages: z.array(salesPageSchema).max(10).default([]),
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
};

function applyPayoutRefinement(
  data: {
    payout_model?: "cpa" | "revshare";
    payout_cpa?: number;
    payout_revshare?: number;
  },
  ctx: z.RefinementCtx,
) {
  if (data.payout_model === "cpa") {
    if (data.payout_cpa == null || data.payout_cpa <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payout_cpa"],
        message: "CPA payout amount is required and must be greater than 0",
      });
    }
  } else if (data.payout_model === "revshare") {
    if (data.payout_revshare == null || data.payout_revshare <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payout_revshare"],
        message:
          "Revshare percentage is required and must be greater than 0",
      });
    }
  }
}

export const offerCreateSchema = z
  .object(baseOfferShape)
  .superRefine((data, ctx) => applyPayoutRefinement(data, ctx));

export const offerUpdateSchema = z
  .object(baseOfferShape)
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  })
  // When payout_model is included in an update, apply the conditional check
  // against whatever payout values are also being set.
  .superRefine((data, ctx) => {
    if (data.payout_model !== undefined) {
      applyPayoutRefinement(data, ctx);
    }
  });

export type SalesPage = z.infer<typeof salesPageSchema>;

// Output types — what API code sees after parsing (with defaults applied).
export type OfferCreateInput = z.infer<typeof offerCreateSchema>;
export type OfferUpdateInput = z.infer<typeof offerUpdateSchema>;

// Input type — what form code uses with react-hook-form. Optional fields with
// schema-level defaults (like sales_pages) appear as optional here, matching
// what zodResolver wires up at the form layer.
export type OfferFormValues = z.input<typeof offerCreateSchema>;
