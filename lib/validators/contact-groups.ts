import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Contact Group validators. Renamed from segment-groups in step 6.5b.
// Same shape; the conceptual change (folders-for-segments → tags-on-contacts)
// is invisible at this layer.

/**
 * Max length of a contact_group_id. The column is unbounded `text`; drip intake
 * mints `drip:<org uuid>:<partner-tag>` (lib/drip/groups.ts), already 42 chars
 * before the name, so the old max(40) refused every drip group's own id.
 */
export const CONTACT_GROUP_ID_MAX = 100;

export const contactGroupCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  contact_group_id: z
    .string()
    .trim()
    .min(1, "contact_group_id is required")
    .max(CONTACT_GROUP_ID_MAX)
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
  // Partner attribution link (migration 0201, ruling R1). null = not a partner
  // entry. Changing it needs partner_keys.manage (Q9); on a drip partner×tag
  // group and on a system group the route refuses it (F3 / C4).
  partner_id: z.number().int().positive().nullable().optional(),
  // Line-type gate (migration 0218). false = this group's voip / unknown
  // contacts are kept out of every campaign audience and drip routing. Omitted
  // on create ⇒ the column default (true); the form always sends both.
  allow_voip: z.boolean().optional(),
  allow_unknown: z.boolean().optional(),
});

/** The four lifecycle override columns, shared by the form, the PATCH route and the preview. */
export const LIFECYCLE_OVERRIDE_KEYS = [
  "freeze_after_messages",
  "freeze_cadence_days",
  "suppress_after_days",
  "suppress_min_freeze_messages",
] as const;
export type LifecycleOverrideKey = (typeof LIFECYCLE_OVERRIDE_KEYS)[number];

// contact_group_id is immutable: not validated on edit, and stripped (Zod drops
// unknown keys) from a PATCH body that carries it. Validating it here refused
// to save any group whose id the create rules would not mint today.
export const contactGroupEditFormSchema = contactGroupCreateSchema.omit({
  contact_group_id: true,
});

export const contactGroupUpdateSchema = contactGroupEditFormSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type ContactGroupCreateInput = z.infer<typeof contactGroupCreateSchema>;
export type ContactGroupUpdateInput = z.infer<typeof contactGroupUpdateSchema>;
export type ContactGroupFormValues = z.input<typeof contactGroupCreateSchema>;
