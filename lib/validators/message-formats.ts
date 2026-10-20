import { z } from "zod";

// Message format request shapes (0216). Template grammar is checked by
// lib/messages/format-admin.ts (validateTemplate), which returns the precise
// reason (unknown_token / missing_block) — Zod only bounds the strings.

const name = z.string().trim().min(1, "Name is required").max(80);
// Not trimmed: leading/trailing spaces are literal template text.
const template = z.string().min(1, "Template is required").max(1000);

export const messageFormatCreateSchema = z.object({ name, template }).strict();

export const messageFormatUpdateSchema = z
  .object({ name: name.optional(), template: template.optional(), is_enabled: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
