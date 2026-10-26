import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  ATTRIBUTE_FIELD_KEYS,
  normalizeAttributeValue,
  type AttributeField,
} from "@/lib/contact-attributes";
import { upsertContactAttributes } from "@/lib/contact-attributes-write";
import { can } from "@/lib/permissions";
import { validatePhone } from "@/lib/phone-validation";
import { PHONE_TARGET } from "@/lib/validators/contact-attribute-mappings";

// Attribute CSV import (Drip Phase 1, item 1c).
//
// ⚠️ THIS UPDATES EXISTING CONTACTS ONLY — it never creates one. An attribute
// row is meaningless without a contact, and creating contacts here would make a
// mis-mapped column silently grow the audience. Rows whose phone is not already
// in the org are reported as `unmatched`, not inserted. Adding contacts remains
// the job of the audience upload flows.
//
// Deliberately a SEPARATE endpoint from PhoneUploadForm's upload paths rather
// than a new mode on the shared uploader. Four live flows (contacts, opt-outs,
// opt-ins, clickers) go through that component; attribute import has different
// semantics (update, never insert) and would have meant risking all four for no
// shared behaviour.
//
// `dry_run: true` returns exactly what a commit would do, without writing.

export const maxDuration = 60;

const MAX_ROWS = 50_000;

const bodySchema = z.object({
  dry_run: z.boolean().optional(),
  // { "<csv column header>": "<target field or 'phone'>" }
  mapping: z.record(z.string().min(1), z.string().min(1)),
  // Parsed client-side with papaparse (already a dependency) so the server
  // never has to hold the raw file.
  rows: z.array(z.record(z.string(), z.string().nullable())).max(MAX_ROWS),
  source: z.string().max(64).optional(),
});

interface RowIssue {
  row: number;
  reason: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "contacts.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { mapping, rows, dry_run: dryRun = false } = parsed.data;
  const source = parsed.data.source ?? "csv_upload";

  // Which column carries the phone, and which columns carry which fields.
  const phoneColumn = Object.entries(mapping).find(([, t]) => t === PHONE_TARGET)?.[0];
  if (!phoneColumn) {
    return apiError(
      400,
      "One column must be mapped to Phone — it identifies the contact",
      API_ERROR_CODES.VALIDATION,
      { field: "mapping" },
    );
  }
  const fieldColumns = Object.entries(mapping).filter(
    ([, t]) => t !== PHONE_TARGET && (ATTRIBUTE_FIELD_KEYS as readonly string[]).includes(t),
  ) as [string, AttributeField][];
  if (fieldColumns.length === 0) {
    return apiError(400, "Map at least one attribute column", API_ERROR_CODES.VALIDATION, {
      field: "mapping",
    });
  }

  // ── Normalize every row up front, collecting issues per row ────────────────
  const issues: RowIssue[] = [];
  const byPhone = new Map<string, Record<string, string | boolean | null>>();
  let invalidPhone = 0;
  let normalizedOut = 0;

  rows.forEach((raw, i) => {
    const rowNo = i + 2; // 1-based + header line, so it matches the spreadsheet
    const phoneRaw = raw[phoneColumn] ?? "";
    const p = validatePhone(phoneRaw);
    if (!p.valid || !p.normalized) {
      invalidPhone++;
      if (issues.length < 50) issues.push({ row: rowNo, reason: `unreadable phone "${phoneRaw}"` });
      return;
    }
    const values: Record<string, string | boolean | null> = {};
    for (const [col, field] of fieldColumns) {
      const before = raw[col];
      const after = normalizeAttributeValue(field, before);
      // A non-empty cell that normalizes to NULL is a real signal, not noise:
      // it is where 1970-01-01, "50-75k" and "F" go to die. Surfacing it in the
      // preview is the only way an operator learns their column needs cleaning.
      if (after === null && (before ?? "").trim() !== "") {
        normalizedOut++;
        if (issues.length < 50) {
          issues.push({ row: rowNo, reason: `${field}: "${String(before).slice(0, 40)}" not recognized → ignored` });
        }
      }
      if (after !== null) values[field] = after;
    }
    // Last row wins for a duplicated phone — same rule as the audience uploads.
    if (Object.keys(values).length > 0) byPhone.set(p.normalized, values);
  });

  const phones = [...byPhone.keys()];
  if (phones.length === 0) {
    return NextResponse.json({
      dry_run: dryRun,
      total_rows: rows.length,
      matched: 0,
      unmatched: 0,
      invalid_phone: invalidPhone,
      normalized_out: normalizedOut,
      written: 0,
      issues,
    });
  }

  // ── Which of those phones exist in THIS org? ──────────────────────────────
  const phoneLiteral = sql.join(
    phones.map((p) => sql`${p}`),
    sql`, `,
  );
  const found = (await db.execute(sql`
    SELECT id, phone_number FROM contacts
    WHERE org_id = ${orgId}::uuid AND phone_number IN (${phoneLiteral})
  `)) as unknown as { id: string; phone_number: string }[];

  const matched = found.length;
  const unmatched = phones.length - matched;

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      total_rows: rows.length,
      matched,
      unmatched,
      invalid_phone: invalidPhone,
      normalized_out: normalizedOut,
      written: 0,
      issues,
    });
  }

  // ── Commit: upsert one attributes row per matched contact ─────────────────
  // Only the MAPPED fields are written. An unmapped field keeps whatever it had
  // — a CSV that carries no `state` column must not blank the state we already
  // know, which a blanket overwrite would do.
  const written = await upsertContactAttributes(
    db,
    orgId,
    found.map((c) => ({ contactId: c.id, values: byPhone.get(c.phone_number) ?? {} })),
    { mode: "overwrite", source },
  );

  return NextResponse.json({
    dry_run: false,
    total_rows: rows.length,
    matched,
    unmatched,
    invalid_phone: invalidPhone,
    normalized_out: normalizedOut,
    written,
    issues,
  });
}
