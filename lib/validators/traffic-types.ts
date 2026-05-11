import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Traffic Type validators. Mirror of routing-types — same shape, different
// entity. Kept as separate files so each entity's schema can evolve
// independently without coupling.

export const trafficTypeCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  traffic_type_id: z
    .string()
    .trim()
    .min(1, "traffic_type_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "traffic_type_id may only contain letters, digits, hyphens, and underscores",
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

export const trafficTypeUpdateSchema = trafficTypeCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type TrafficTypeCreateInput = z.infer<typeof trafficTypeCreateSchema>;
export type TrafficTypeUpdateInput = z.infer<typeof trafficTypeUpdateSchema>;
export type TrafficTypeFormValues = z.input<typeof trafficTypeCreateSchema>;
