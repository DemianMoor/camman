import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// UTM Tag validators. Tags will be used by future link-building logic; for
// now `value_source` is free-form text — we'll constrain it to a known enum
// when the link-builder lands.

export const utmTagCreateSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  tag_id: z
    .string()
    .trim()
    .min(1, "tag_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "tag_id may only contain letters, digits, hyphens, and underscores",
    ),
  value_source: z
    .string()
    .trim()
    .min(1, "Value source is required")
    .max(100),
  affiliate_network_id: z.number().int().positive().nullable().optional(),
  color: z
    .union([
      z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "color must be a 6-char hex like #1A2B3C"),
      z.literal(""),
    ])
    .optional(),
});

export const utmTagUpdateSchema = utmTagCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type UtmTagCreateInput = z.infer<typeof utmTagCreateSchema>;
export type UtmTagUpdateInput = z.infer<typeof utmTagUpdateSchema>;
export type UtmTagFormValues = z.input<typeof utmTagCreateSchema>;
