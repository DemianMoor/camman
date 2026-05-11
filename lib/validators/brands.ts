import { z } from "zod";

// Brand validators.
//
// Optional fields accept empty strings (`""`) so they round-trip cleanly with
// form inputs that default to `""`. The API layer normalizes `""` → null before
// writing to the DB so we don't store empty strings as values.
//
// - name: human-readable display name (1–120 chars)
// - brand_id: external/human-friendly identifier (slug-safe, unique per org+global)
// - short_link_base: permissive for now (any non-empty string up to 200 chars);
//   we'll tighten URL/domain validation in a later step once requirements settle.
// - avatar_url: must be a full URL if provided
// - color: 6-char hex with leading '#' if provided

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
  short_link_base: z.string().trim().max(200).optional(),
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
});

export const brandUpdateSchema = brandCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type BrandCreateInput = z.infer<typeof brandCreateSchema>;
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;

// Empty strings from form inputs should map to NULL in the DB.
export function nullIfEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
