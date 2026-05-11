import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Routing Type validators. Brands-shape with `description` instead of
// short_link_base, and no avatar.

export const routingTypeCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  routing_type_id: z
    .string()
    .trim()
    .min(1, "routing_type_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "routing_type_id may only contain letters, digits, hyphens, and underscores",
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

export const routingTypeUpdateSchema = routingTypeCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type RoutingTypeCreateInput = z.infer<typeof routingTypeCreateSchema>;
export type RoutingTypeUpdateInput = z.infer<typeof routingTypeUpdateSchema>;
export type RoutingTypeFormValues = z.input<typeof routingTypeCreateSchema>;
