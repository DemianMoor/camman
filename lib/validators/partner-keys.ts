import { z } from "zod";

import { LEAD_FIELD_KEYS } from "@/lib/intake/fields";

// Partner-key management validators — Drip Phase 2.
//
// ⚠️ `token` and `secret_hash` appear in NEITHER schema. They are minted
// server-side and are not user-supplied at any point: accepting a caller-chosen
// token would let someone pick a guessable one, and accepting a hash would let
// them set a secret nobody ever generated. Rotation is its own endpoint.

const slug = z
  .string()
  .trim()
  .min(2, "Partner slug must be at least 2 characters")
  .max(64)
  // Lowercase alphanumerics plus underscore/hyphen. The slug is stamped onto
  // every lead and will be a report dimension in Phase 7, so it has to stay
  // stable and comparable — free text would fragment the reporting.
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, _ and - only");

// field_mapping maps a PARTNER's field name -> one of OUR canonical fields. The
// target is validated against LEAD_FIELD_KEYS so a typo cannot create a mapping
// that silently matches nothing at intake.
const fieldMapping = z
  .record(z.string().trim().min(1), z.enum(LEAD_FIELD_KEYS as [string, ...string[]]))
  .refine((m) => Object.keys(m).length <= 100, "Too many mapped fields (max 100)");

const shared = {
  name: z.string().trim().min(1, "Name is required").max(200),
  interest_tag_mode: z.enum(["force", "default"]),
  interest_tag: z.string().trim().max(64).nullable().optional(),
  field_mapping: fieldMapping.optional(),
  sandbox: z.boolean().optional(),
  rate_per_sec: z.number().int().positive().max(10000).optional(),
  rate_per_day: z.number().int().positive().max(10_000_000).optional(),
  max_payload_bytes: z.number().int().min(1024).max(4_194_304).optional(),
  status: z.enum(["active", "disabled"]).optional(),
};

// Mirrors the DB CHECK partner_keys_force_needs_tag_check. Enforced in both
// places deliberately: the CHECK is the guarantee, this is the good error
// message. 'force' with no tag would stamp NULL onto every lead.
const forceNeedsTag = (
  v: { interest_tag_mode?: string; interest_tag?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (v.interest_tag_mode === "force" && !v.interest_tag?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["interest_tag"],
      message: "An interest tag is required when the mode is 'force'",
    });
  }
};

export const partnerKeyCreateSchema = z
  .object({
    partner_slug: slug,
    ...shared,
    interest_tag_mode: shared.interest_tag_mode.default("default"),
  })
  .superRefine(forceNeedsTag);

// partner_slug is NOT updatable: it is stamped onto every lead already captured
// (lead_inbox.partner_slug is denormalized precisely so provenance survives),
// so renaming it would make historical leads disagree with the key they came
// from. Create a new key instead.
export const partnerKeyUpdateSchema = z
  .object(shared)
  .partial()
  .superRefine((v, ctx) => {
    if (v.interest_tag_mode === "force" && v.interest_tag !== undefined) forceNeedsTag(v, ctx);
  });

export type PartnerKeyCreateInput = z.infer<typeof partnerKeyCreateSchema>;
export type PartnerKeyUpdateInput = z.infer<typeof partnerKeyUpdateSchema>;
