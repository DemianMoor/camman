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
  // Required: every contact upload must tag with at least one contact
  // group. Enforced at the schema layer so direct API hits can't bypass
  // the UI requirement. The opt-outs / opt-ins / clickers upload
  // endpoints still treat their own assign_to_group_ids as optional —
  // this requirement is specific to contacts.
  assign_to_group_ids: z
    .array(z.number().int().positive())
    .min(1, "Select at least one contact group")
    .max(50, "At most 50 groups per upload"),
});

// List-query schema is just a shape marker for the parseListParams output plus
// the future segment_id filter (accepted-and-ignored in 6.1).
export const contactListQuerySchema = z.object({
  segment_id: z.number().int().positive().optional(),
});

// Bulk status import on the Contacts screen. Each row carries a raw phone and a
// raw status string; the smart reader (lib/imports/contact-status.ts) maps the
// status to a reason server-side, so the client doesn't fork the mapping. Rows
// whose phone is invalid OR whose status is unrecognized are skipped & reported
// rather than rejecting the whole upload. 50k-row ceiling keeps a single import
// inside one transaction's reasonable bound (matches the contacts upload scale).
const MAX_STATUS_IMPORT_ROWS = 50_000;

export const contactStatusImportSchema = z.object({
  rows: z
    .array(
      z.object({
        phone: z.string().max(64),
        status: z.string().max(200),
      }),
    )
    .min(1, "At least one row is required")
    .max(
      MAX_STATUS_IMPORT_ROWS,
      `At most ${MAX_STATUS_IMPORT_ROWS.toLocaleString()} rows per import`,
    ),
  // Optional free-text audit source recorded on every opt_outs row created.
  source: z.string().trim().max(100).optional(),
});

export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;
export type ContactBulkUploadInput = z.infer<typeof contactBulkUploadSchema>;
export type ContactStatusImportInput = z.infer<
  typeof contactStatusImportSchema
>;
