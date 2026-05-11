import { z } from "zod";

// Brand validators.
//
// - name: human-readable display name (1–120 chars)
// - brand_id: external/human-friendly identifier (slug-safe, unique per org+global)
// - short_link_base: permissive for now (any non-empty string up to 200 chars);
//   we'll tighten URL/domain validation in a later step once requirements settle.
// - avatar_url: must be a full URL if provided
// - color: 6-char hex with leading '#' if provided

const optionalEmptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

export const brandCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  brand_id: z
    .string()
    .trim()
    .min(1, "brand_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "brand_id may only contain letters, digits, hyphens, and underscores",
    ),
  short_link_base: z.preprocess(
    optionalEmptyToUndefined,
    z.string().trim().max(200).optional(),
  ),
  avatar_url: z.preprocess(
    optionalEmptyToUndefined,
    z.string().url("avatar_url must be a valid URL").optional(),
  ),
  color: z.preprocess(
    optionalEmptyToUndefined,
    z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "color must be a 6-char hex like #1A2B3C")
      .optional(),
  ),
});

export const brandUpdateSchema = brandCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type BrandCreateInput = z.infer<typeof brandCreateSchema>;
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;
