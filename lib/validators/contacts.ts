import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// Contacts: phone-only entity in 6.1. Single-record creation is not supported;
// all contacts come in via /api/contacts/upload (the bulk-upload endpoint).

// PATCH endpoint only allows toggling is_archived. Use the dedicated
// archive/restore POST endpoints in the UI — this schema exists for
// completeness in case future fields are added.
export const contactUpdateSchema = z
  .object({
    is_archived: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

// 5MB ceiling on the raw textarea. Roughly 500k phones at ~15 chars each.
// Server-side defense; client-side enforces the same limit.
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export const contactBulkUploadSchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
  // Optional: assign uploaded contacts directly to a single segment.
  assign_to_segment_id: z.number().int().positive().nullable().optional(),
  // Optional: tag every uploaded contact with these contact groups.
  // Replaces the old assign_to_segment_group_id (removed in 0031 — groups
  // are now applied to contacts directly, not through segment membership).
  assign_to_group_ids: z
    .array(z.number().int().positive())
    .max(50, "At most 50 groups per upload")
    .optional(),
});

// List-query schema is just a shape marker for the parseListParams output plus
// the future segment_id filter (accepted-and-ignored in 6.1).
export const contactListQuerySchema = z.object({
  segment_id: z.number().int().positive().optional(),
});

export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;
export type ContactBulkUploadInput = z.infer<typeof contactBulkUploadSchema>;
