import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const TEXT_MAX = 1600; // ~10 GSM-7 segments — a sane upper bound

export const CREATIVE_STATUSES = [
  "draft",
  "pending",
  "ready",
  "paused",
  "archived",
] as const;

export const creativeCreateSchema = z.object({
  offer_id: z.number().int().positive(),
  sms_provider_id: z.number().int().positive().nullable().optional(),
  brand_id: z.number().int().positive().nullable().optional(),
  text: z
    .string()
    .min(1, "Message text is required")
    .max(TEXT_MAX, `Message text must be at most ${TEXT_MAX} characters`),
  creative_id: z
    .union([
      z
        .string()
        .trim()
        .max(80)
        .regex(
          /^[A-Za-z0-9_-]+$/,
          "creative_id may only contain letters, digits, hyphens, and underscores",
        ),
      z.literal(""),
    ])
    .optional(),
  status: z.enum(["draft", "pending"]).optional(),
});

export const creativeUpdateSchema = z
  .object({
    offer_id: z.number().int().positive().optional(),
    sms_provider_id: z.number().int().positive().nullable().optional(),
    brand_id: z.number().int().positive().nullable().optional(),
    text: z.string().min(1).max(TEXT_MAX).optional(),
    creative_id: z
      .union([
        z
          .string()
          .trim()
          .max(80)
          .regex(/^[A-Za-z0-9_-]+$/),
        z.literal(""),
      ])
      .optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export const creativeStatusChangeSchema = z.object({
  status: z.enum(["draft", "pending", "ready", "paused"]),
});

export type CreativeCreateInput = z.infer<typeof creativeCreateSchema>;
export type CreativeUpdateInput = z.infer<typeof creativeUpdateSchema>;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];
