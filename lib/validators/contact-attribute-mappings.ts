import { z } from "zod";

import { ATTRIBUTE_FIELD_KEYS } from "@/lib/contact-attributes";

// Saved column → field mappings for attribute CSV imports (migration 0149).
//
// Shape: { "<csv column header>": "<contact_attributes field>" }.
//
// Only the FIELD side is constrained. The column side is whatever the partner's
// spreadsheet happens to be called — constraining it would be meaningless, and a
// DB CHECK over JSONB keys could not express it anyway.
//
// ⚠️ `phone` is a legal mapping TARGET here even though it is not a
// contact_attributes column: an attribute CSV must identify WHICH contact each
// row belongs to, and phone is the identity (email deliberately is not unique —
// partners share addresses). A mapping without a phone column can never be
// applied, so the refinement below rejects it at the boundary rather than
// letting an operator save a template that always fails.
export const PHONE_TARGET = "phone";
const TARGETS = [PHONE_TARGET, ...ATTRIBUTE_FIELD_KEYS] as const;

const mappingObject = z
  .record(z.string().min(1).max(256), z.enum(TARGETS as unknown as [string, ...string[]]))
  .refine((m) => Object.keys(m).length > 0, {
    message: "Map at least one column",
  })
  .refine((m) => Object.values(m).includes(PHONE_TARGET), {
    message: "One column must be mapped to Phone — it identifies the contact",
  })
  .refine(
    (m) => {
      // A field mapped twice is ambiguous: two columns would race to write the
      // same attribute and the winner would depend on object key order.
      const targets = Object.values(m);
      return new Set(targets).size === targets.length;
    },
    { message: "Each field can be mapped from only one column" },
  );

export const contactAttributeMappingCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mapping: mappingObject,
  is_default: z.boolean().optional(),
});

export const contactAttributeMappingUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  mapping: mappingObject.optional(),
  is_default: z.boolean().optional(),
});

export type ContactAttributeMappingInput = z.infer<
  typeof contactAttributeMappingCreateSchema
>;
