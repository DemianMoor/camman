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
  // Lifecycle overrides (migration 0187). null = inherit the org default. The
  // ranges mirror contact_groups_lifecycle_overrides_check; a contact in several
  // groups takes the STRICTEST value across its active ones, which is resolved
  // in lib/engagement/thresholds-sql.ts, not here.
  freeze_after_messages: z.number().int().min(1).max(1000).nullable().optional(),
  freeze_cadence_days: z.number().int().min(1).max(365).nullable().optional(),
  suppress_after_days: z.number().int().min(1).max(730).nullable().optional(),
  suppress_min_freeze_messages: z.number().int().min(1).max(100).nullable().optional(),
});

/** The four lifecycle override columns, shared by the form, the PATCH route and the preview. */
export const LIFECYCLE_OVERRIDE_KEYS = [
  "freeze_after_messages",
  "freeze_cadence_days",
  "suppress_after_days",
  "suppress_min_freeze_messages",
] as const;
export type LifecycleOverrideKey = (typeof LIFECYCLE_OVERRIDE_KEYS)[number];

export const contactGroupUpdateSchema = contactGroupCreateSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type ContactGroupCreateInput = z.infer<typeof contactGroupCreateSchema>;
export type ContactGroupUpdateInput = z.infer<typeof contactGroupUpdateSchema>;
export type ContactGroupFormValues = z.input<typeof contactGroupCreateSchema>;
