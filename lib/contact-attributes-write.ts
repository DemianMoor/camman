// The ONE write path from a CSV into contact_attributes. Shared by the Import
// attributes dialog (/api/contacts/import-attributes) and the phone-upload
// routes (/api/contacts/upload, /api/contact-groups/[id]/contacts/add), so
// normalization (incl. the ZIP leading-zero restore) and the column list cannot
// drift between them.
//
// `mode` is REQUIRED (CLAUDE.md §11b spirit — it decides whose data survives):
//   overwrite  — a non-empty CSV value replaces the stored one (Import attributes).
//   fill_empty — a CSV value only lands where the stored value is empty; a
//                stored non-empty value is never touched (phone uploads).
// In both modes an empty CSV cell never blanks a stored value.
import { and, eq, inArray, sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { normalizeAttributeValue, type UploadAttributes } from "@/lib/contact-attributes";
import { validatePhone } from "@/lib/phone-validation";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AttributeValues = Record<string, string | boolean | null>;
export type AttributeWriteMode = "overwrite" | "fill_empty";

// Static column list (never user input), in VALUES order, with its SQL type.
const COLUMNS = [
  ["first_name", "text"], ["last_name", "text"], ["address", "text"],
  ["state", "text"], ["zip", "text"], ["country", "text"], ["email", "text"],
  ["gender", "text"], ["income_band", "text"],
  ["kids", "boolean"], ["married", "boolean"], ["dob", "date"],
  ["interest_tag", "text"], ["partner_slug", "text"],
] as const;

const CHUNK = 500;

/**
 * Upsert one contact_attributes row per contact. Returns the number of rows
 * inserted or changed. In fill_empty mode a contact whose stored values already
 * cover every CSV value is left untouched (no updated_at bump, not counted).
 */
export async function upsertContactAttributes(
  dbc: DbOrTx,
  orgId: string,
  rows: { contactId: string; values: AttributeValues }[],
  opts: { mode: AttributeWriteMode; source: string },
): Promise<number> {
  const colList = sql.raw(COLUMNS.map(([c]) => c).join(", "));
  // Stored "" counts as empty for text columns, so fill_empty can fill it.
  const stored = (c: string, t: string) => (t === "text" ? `NULLIF(ca.${c}, '')` : `ca.${c}`);
  const sets =
    opts.mode === "overwrite"
      ? [...COLUMNS.map(([c]) => `${c} = COALESCE(EXCLUDED.${c}, ca.${c})`), "source = EXCLUDED.source"]
      : [...COLUMNS.map(([c, t]) => `${c} = COALESCE(${stored(c, t)}, EXCLUDED.${c})`), "source = COALESCE(ca.source, EXCLUDED.source)"];
  const onlyIfFills =
    opts.mode === "fill_empty"
      ? sql.raw(`WHERE ${COLUMNS.map(([c, t]) => `(${stored(c, t)} IS NULL AND EXCLUDED.${c} IS NOT NULL)`).join(" OR ")}`)
      : sql``;

  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const values = rows.slice(i, i + CHUNK).map(({ contactId, values: v }) => {
      const cols = COLUMNS.map(([c, t]) => sql`${v[c] === undefined ? null : v[c]}::${sql.raw(t)}`);
      return sql`(${contactId}::uuid, ${orgId}::uuid, ${sql.join(cols, sql`, `)}, ${opts.source}::text)`;
    });
    const res = (await dbc.execute(sql`
      INSERT INTO contact_attributes AS ca (contact_id, org_id, ${colList}, source)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (contact_id) DO UPDATE SET ${sql.raw(sets.join(", "))}, updated_at = now()
      ${onlyIfFills}
      RETURNING contact_id
    `)) as unknown as { contact_id: string }[];
    written += res.length;
  }
  return written;
}

/**
 * Phone-upload attributes → contact_attributes, fill-empty only. Call AFTER the
 * contacts are upserted: rows whose phone does not resolve to a contact in this
 * org are skipped (never created here). Duplicate phones: last row wins, the
 * same rule as the Import attributes dialog.
 */
export async function writeUploadAttributes(
  dbc: DbOrTx,
  orgId: string,
  input: UploadAttributes,
): Promise<{ written: number; values_ignored: number }> {
  const byPhone = new Map<string, AttributeValues>();
  let valuesIgnored = 0;
  for (const [phoneRaw, ...cells] of input.rows) {
    const p = validatePhone(phoneRaw ?? "");
    if (!p.valid || !p.normalized) continue; // already reported as an invalid phone
    const values: AttributeValues = {};
    input.fields.forEach((field, i) => {
      const before = cells[i];
      const after = normalizeAttributeValue(field, before);
      if (after === null && (before ?? "").trim() !== "") valuesIgnored++;
      if (after !== null) values[field] = after;
    });
    if (Object.keys(values).length > 0) byPhone.set(p.normalized, values);
  }

  const phones = [...byPhone.keys()];
  const found: { id: string; phone_number: string }[] = [];
  for (let i = 0; i < phones.length; i += 1000) {
    found.push(
      ...(await dbc
        .select({ id: contacts.id, phone_number: contacts.phone_number })
        .from(contacts)
        .where(and(eq(contacts.org_id, orgId), inArray(contacts.phone_number, phones.slice(i, i + 1000))))),
    );
  }

  const written = await upsertContactAttributes(
    dbc,
    orgId,
    found.map((c) => ({ contactId: c.id, values: byPhone.get(c.phone_number) ?? {} })),
    { mode: "fill_empty", source: "contact_upload" },
  );
  return { written, values_ignored: valuesIgnored };
}
