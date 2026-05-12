import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

export const STAGE_STATUSES = [
  "draft",
  "pending",
  "sent",
  "success",
  "cancelled",
  "failed",
  "archived",
] as const;

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Date must be YYYY-MM-DD",
});

// Every optional field accepts both undefined (key omitted) and null
// (key sent with explicit null), matching campaigns.ts. Forms typically
// JSON.stringify null fields rather than omitting them.
const stageBaseSchema = z.object({
  label: z
    .union([z.string().trim().max(120), z.literal("")])
    .nullable()
    .optional(),
  creative_id: z.number().int().positive().nullable().optional(),
  sms_provider_id: z.number().int().positive().nullable().optional(),
  provider_phone_id: z.number().int().positive().nullable().optional(),
  sales_page_label: z
    .union([z.string().trim().max(80), z.literal("")])
    .nullable()
    .optional(),
  stop_text: z.string().trim().min(1).max(80).default("Stop to END"),
  include_clickers: z.boolean().default(false),
  exclude_clickers: z.boolean().default(false),
  include_no_status: z.boolean().default(true),
  scheduled_date: dateStringSchema.nullable().optional(),
  notes: z
    .union([z.string().trim().max(2000), z.literal("")])
    .nullable()
    .optional(),
});

export const stageCreateSchema = stageBaseSchema.refine(
  (d) => !(d.include_clickers && d.exclude_clickers),
  {
    path: ["include_clickers"],
    message: "include_clickers and exclude_clickers can't both be true",
  },
);

export const stageUpdateSchema = stageBaseSchema
  .partial()
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  })
  .refine(
    (d) => !(d.include_clickers === true && d.exclude_clickers === true),
    {
      path: ["include_clickers"],
      message: "include_clickers and exclude_clickers can't both be true",
    },
  );

// Note: `archived` transitions go through the dedicated archive endpoint,
// not this one — same pattern as creatives.
export const stageStatusChangeSchema = z.object({
  status: z.enum([
    "draft",
    "pending",
    "sent",
    "success",
    "cancelled",
    "failed",
  ]),
});

export type StageCreateInput = z.infer<typeof stageCreateSchema>;
export type StageUpdateInput = z.infer<typeof stageUpdateSchema>;
export type StageStatus = (typeof STAGE_STATUSES)[number];
