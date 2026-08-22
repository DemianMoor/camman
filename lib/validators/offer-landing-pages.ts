import { z } from "zod";

// Landing pages for an offer (Drip P1 1b, migration 0150).
//
// Mirrors the DB CHECKs exactly, so an invalid row is rejected at the boundary
// with a readable message rather than surfacing as a Postgres check_violation.

// ⚠️ Lowercase alphanumerics only — the canonical /lp/<slug> shape. An
// UNDERSCORE is the exact signature of the tracking-id-glued-into-the-path bug
// migration 0094 exists to stop (…/lp/knd8_62_…), so it is rejected here too.
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+$/, "Slug must be lowercase letters and digits only (no dashes or underscores)");

const externalUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "External URL must start with http:// or https://");

const base = {
  title: z.string().trim().min(1).max(160),
  is_default: z.boolean().optional(),
  status: z.enum(["active", "disabled"]).optional(),
};

export const offerLandingPageCreateSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("slug"), slug: slugSchema, external_url: z.undefined().optional(), ...base }),
    z.object({ kind: z.literal("external_url"), external_url: externalUrlSchema, slug: z.undefined().optional(), ...base }),
  ]);

export const offerLandingPageUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  slug: slugSchema.optional(),
  external_url: externalUrlSchema.optional(),
  is_default: z.boolean().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});
