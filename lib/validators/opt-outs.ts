import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

// Max rows for the timestamped attribution import. ~5MB / ~30 bytes per row.
const MAX_IMPORT_ENTRIES = 250_000;

// One row of the timestamped attribution import: a number plus when it replied
// STOP. `received_at` is a naive wall-clock or an ISO-8601 string with offset;
// naive values are interpreted in the request's `timezone`.
const optOutImportEntrySchema = z.object({
  phone: z.string().trim().min(1),
  received_at: z.string().trim().min(1),
});

// Opt-outs MUST be scoped to at least one brand. Optionally scoped to providers.
// Two mutually-inclusive input modes:
//   - `phones`  — plain list, suppression only (existing behavior).
//   - `entries` + `timezone` — timestamped rows that additionally get mapped to
//     the campaign/stage that sent to the number (see importOptOutsWithAttribution).
// Exactly one of the two must be supplied.
export const optOutUploadSchema = z
  .object({
    phones: z
      .string()
      .min(1, "Phones field is required")
      .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)")
      .optional(),
    entries: z
      .array(optOutImportEntrySchema)
      .max(MAX_IMPORT_ENTRIES, "Too many rows (max 250,000)")
      .optional(),
    // IANA zone for interpreting naive timestamps in `entries`. Required with
    // `entries`; ignored otherwise.
    timezone: z.string().trim().min(1).max(64).optional(),
    brand_ids: z
      .array(z.number().int().positive())
      .min(1, "Select at least one brand"),
    provider_ids: z.array(z.number().int().positive()).default([]),
    source: z.string().trim().max(100).optional(),
    // Optional: tag every uploaded contact with these contact groups too.
    // The upload pipeline applies them after contacts are upserted.
    assign_to_group_ids: z
      .array(z.number().int().positive())
      .max(50, "At most 50 groups per upload")
      .optional(),
  })
  .refine(
    (v) => Boolean(v.phones) !== Boolean(v.entries && v.entries.length > 0),
    { message: "Provide either phones or entries, not both", path: ["phones"] },
  )
  .refine((v) => !v.entries || v.entries.length === 0 || Boolean(v.timezone), {
    message: "timezone is required when importing timestamped entries",
    path: ["timezone"],
  });

export const optOutBulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const optOutBulkDeleteByBrandSchema = z.object({
  brand_id: z.number().int().positive(),
});

export type OptOutUploadInput = z.infer<typeof optOutUploadSchema>;
