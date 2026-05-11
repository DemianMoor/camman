import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Affiliate Network validators.
//
// - name: human-readable display name (1–120 chars)
// - network_id: external/human-friendly identifier (slug-safe, unique)
// - url: optional homepage URL; permissive for now
// - avatar_url: must be a full URL if provided
// - color: 6-char hex with leading '#' if provided
//
// Optional string fields accept empty strings (form defaults) and are
// normalized to NULL at the API boundary via nullIfEmpty.

export const networkCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  network_id: z
    .string()
    .trim()
    .min(1, "network_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "network_id may only contain letters, digits, hyphens, and underscores",
    ),
  url: z.string().trim().max(500).optional(),
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

export const networkUpdateSchema = networkCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type NetworkCreateInput = z.infer<typeof networkCreateSchema>;
export type NetworkUpdateInput = z.infer<typeof networkUpdateSchema>;
