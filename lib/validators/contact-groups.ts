import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Contact Group validators. Renamed from segment-groups in step 6.5b.
// Same shape; the conceptual change (folders-for-segments → tags-on-contacts)
// is invisible at this layer.

export const contactGroupCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  contact_group_id: z
    .string()
    .trim()
    .min(1, "contact_group_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "contact_group_id may only contain letters, digits, hyphens, and underscores",
    ),
  description: z.string().trim().max(500).optional(),
  color: z
    .union([
      z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "color must be a 6-char hex like #1A2B3C"),
      z.literal(""),
    ])
    .optional(),
});

export const contactGroupUpdateSchema = contactGroupCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type ContactGroupCreateInput = z.infer<typeof contactGroupCreateSchema>;
export type ContactGroupUpdateInput = z.infer<typeof contactGroupUpdateSchema>;
export type ContactGroupFormValues = z.input<typeof contactGroupCreateSchema>;
