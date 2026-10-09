import { z } from "zod";

// The partner ENTITY (migration 0200). The slug is stamped onto every lead the
// partner's keys capture and is a report dimension, so it is immutable after
// creation — the same rule partner_keys.partner_slug always had, which this
// slug now feeds (a new key copies it from its partner).
export const partnerSlugSchema = z
  .string()
  .trim()
  .min(2, "Partner slug must be at least 2 characters")
  .max(64)
  // Lowercase alphanumerics plus underscore/hyphen; mirrors the DB CHECK
  // partners_slug_check. The CHECK is the guarantee, this is the good message.
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, _ and - only");

export const partnerCreateSchema = z.object({
  slug: partnerSlugSchema,
  name: z.string().trim().min(1, "Name is required").max(200),
});

export const partnerUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200).optional(),
    // Whether the partner's signed report shows revenue. Off by default (P7
    // R2): revenue is our margin, not the partner's number. On the PARTNER
    // since 0200 — a key no longer carries it.
    report_show_revenue: z.boolean().optional(),
  })
  .strict();

export type PartnerCreateInput = z.infer<typeof partnerCreateSchema>;
export type PartnerUpdateInput = z.infer<typeof partnerUpdateSchema>;
