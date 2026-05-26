import { z } from "zod";

// Column-name mapping. phone_number is required (we can't import without
// knowing where to find the recipient phone); every other key is optional
// and means "this CSV doesn't carry that signal".
export const mappingColumnsSchema = z.object({
  phone_number: z.string().trim().min(1),
  status: z.string().trim().min(1).optional(),
  is_optout: z.string().trim().min(1).optional(),
  is_clicker: z.string().trim().min(1).optional(),
  cost: z.string().trim().min(1).optional(),
});

// Provider-specific status word lists. Each key is one of our canonical
// outcomes; the array is the strings (case-insensitive at compare time)
// that the provider uses for that outcome. Omit a key to fall back to
// heuristic matching.
export const statusValueMapSchema = z
  .object({
    delivered: z.array(z.string().trim().min(1)).optional(),
    failed: z.array(z.string().trim().min(1)).optional(),
    opt_out: z.array(z.string().trim().min(1)).optional(),
    scrubbed: z.array(z.string().trim().min(1)).optional(),
    bounced: z.array(z.string().trim().min(1)).optional(),
  })
  .optional();

export const mappingCreateSchema = z.object({
  sms_provider_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  is_default: z.boolean().default(false),
  mapping: mappingColumnsSchema,
  status_value_map: statusValueMapSchema,
});

export const mappingUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    is_default: z.boolean().optional(),
    mapping: mappingColumnsSchema.optional(),
    status_value_map: statusValueMapSchema,
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field must be provided",
  });

export type MappingCreateInput = z.infer<typeof mappingCreateSchema>;
export type MappingUpdateInput = z.infer<typeof mappingUpdateSchema>;
