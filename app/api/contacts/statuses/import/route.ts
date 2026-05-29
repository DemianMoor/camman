import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts, opt_outs } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  CONTACT_STATUS_PRIORITY,
  mapContactStatus,
  type ContactStatusReason,
} from "@/lib/imports/contact-status";
import { can } from "@/lib/permissions";
import { validatePhone } from "@/lib/phone-validation";
import { contactStatusImportSchema } from "@/lib/validators/contacts";

const CHUNK_SIZE = 1000;
const SAMPLE_LIMIT = 20;

export type ContactStatusImportSummary = {
  // Total rows received (after the client dropped fully-empty rows).
  submitted: number;
  // Rows with a valid phone AND a recognized status — the import candidates
  // before per-phone dedup.
  recognized: number;
  // Rows dropped because the phone didn't parse.
  invalid_phone: number;
  // Rows dropped because the status text wasn't recognized (or was blank).
  unknown_status: number;
  // Candidates collapsed because the same phone appeared more than once;
  // the highest-priority status (opt_out > suppressed > scrubbed) was kept.
  duplicates_in_input: number;
  // Distinct contacts that gained at least one NEW status from this import.
  contacts_affected: number;
  // opt_outs rows actually inserted.
  applied: number;
  // (contact, reason) pairs skipped because that status was already set —
  // makes re-running the same file a no-op rather than appending duplicates.
  already_set: number;
  by_reason: Record<ContactStatusReason, number>;
  invalid_samples: { input: string; error: string }[];
  skipped_samples: { input: string; error: string }[];
};

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Writing suppression/opt-out records is the operator+ "opt_outs.upload"
  // action — same gate as the dedicated opt-outs upload.
  if (!can(role, "opt_outs.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = contactStatusImportSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const { rows, source } = parsed.data;

  // 1. Classify each row: map status → reason, validate phone. Collapse to a
  //    single reason per normalized phone (highest priority wins).
  const byPhone = new Map<string, ContactStatusReason>();
  const invalid_samples: { input: string; error: string }[] = [];
  const skipped_samples: { input: string; error: string }[] = [];
  let recognized = 0;
  let invalid_phone = 0;
  let unknown_status = 0;
  let duplicates_in_input = 0;

  for (const row of rows) {
    const reason = mapContactStatus(row.status);
    if (reason === null) {
      unknown_status++;
      if (skipped_samples.length < SAMPLE_LIMIT) {
        skipped_samples.push({
          input: `${row.phone} — "${row.status}"`,
          error: "Unrecognized status",
        });
      }
      continue;
    }
    const phoneResult = validatePhone(row.phone);
    if (!phoneResult.valid || !phoneResult.normalized) {
      invalid_phone++;
      if (invalid_samples.length < SAMPLE_LIMIT) {
        invalid_samples.push({
          input: row.phone,
          error: phoneResult.error ?? "Invalid phone number",
        });
      }
      continue;
    }
    recognized++;
    const normalized = phoneResult.normalized;
    const existing = byPhone.get(normalized);
    if (existing === undefined) {
      byPhone.set(normalized, reason);
    } else {
      duplicates_in_input++;
      if (
        CONTACT_STATUS_PRIORITY[reason] > CONTACT_STATUS_PRIORITY[existing]
      ) {
        byPhone.set(normalized, reason);
      }
    }
  }

  const by_reason: Record<ContactStatusReason, number> = {
    opt_out: 0,
    suppressed: 0,
    scrubbed: 0,
  };

  // Nothing to apply — return early with the classification summary.
  if (byPhone.size === 0) {
    const summary: ContactStatusImportSummary = {
      submitted: rows.length,
      recognized,
      invalid_phone,
      unknown_status,
      duplicates_in_input,
      contacts_affected: 0,
      applied: 0,
      already_set: 0,
      by_reason,
      invalid_samples,
      skipped_samples,
    };
    return NextResponse.json(summary, { status: 201 });
  }

  // 2. Upsert contacts so every phone resolves to a contact_id. ON CONFLICT
  //    DO UPDATE returns the row whether it pre-existed or was just inserted.
  const phoneList = Array.from(byPhone.keys());
  const contactIdByPhone = new Map<string, string>();
  for (let i = 0; i < phoneList.length; i += CHUNK_SIZE) {
    const chunk = phoneList.slice(i, i + CHUNK_SIZE);
    const upserted = await db
      .insert(contacts)
      .values(chunk.map((phone_number) => ({ org_id: orgId, phone_number })))
      .onConflictDoUpdate({
        target: [contacts.org_id, contacts.phone_number],
        set: { updated_at: drizzleSql`now()` },
      })
      .returning({ id: contacts.id, phone_number: contacts.phone_number });
    for (const r of upserted) contactIdByPhone.set(r.phone_number, r.id);
  }

  // Desired (contact_id, reason) pairs.
  type Desired = { contact_id: string; phone_number: string; reason: ContactStatusReason };
  const desired: Desired[] = [];
  for (const [phone, reason] of byPhone) {
    const contact_id = contactIdByPhone.get(phone);
    if (contact_id) desired.push({ contact_id, phone_number: phone, reason });
  }

  // 3. Skip (contact, reason) pairs that already exist so re-importing the
  //    same file is a no-op (opt_outs is append-only — no unique constraint to
  //    ON CONFLICT against, so we pre-query the existing pairs).
  const desiredContactIds = Array.from(
    new Set(desired.map((d) => d.contact_id)),
  );
  const existingPairs = new Set<string>();
  for (let i = 0; i < desiredContactIds.length; i += CHUNK_SIZE) {
    const chunk = desiredContactIds.slice(i, i + CHUNK_SIZE);
    const rowsExisting = await db
      .select({
        contact_id: opt_outs.contact_id,
        reason: opt_outs.reason,
      })
      .from(opt_outs)
      .where(
        and(eq(opt_outs.org_id, orgId), inArray(opt_outs.contact_id, chunk)),
      );
    for (const r of rowsExisting) {
      existingPairs.add(`${r.contact_id}|${r.reason}`);
    }
  }

  const toInsert = desired.filter(
    (d) => !existingPairs.has(`${d.contact_id}|${d.reason}`),
  );
  const already_set = desired.length - toInsert.length;

  // 4. Insert the new opt_outs rows (universal — no opt_out_brands junction).
  let applied = 0;
  const affectedContactIds = new Set<string>();
  if (toInsert.length > 0) {
    await db.transaction(async (tx) => {
      for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
        const chunk = toInsert.slice(i, i + CHUNK_SIZE);
        const inserted = await tx
          .insert(opt_outs)
          .values(
            chunk.map((d) => ({
              org_id: orgId,
              contact_id: d.contact_id,
              phone_number: d.phone_number,
              reason: d.reason,
              source: source ?? "status_import",
            })),
          )
          .returning({ contact_id: opt_outs.contact_id });
        applied += inserted.length;
        for (const d of chunk) {
          by_reason[d.reason]++;
          affectedContactIds.add(d.contact_id);
        }
      }
    });
  }

  const summary: ContactStatusImportSummary = {
    submitted: rows.length,
    recognized,
    invalid_phone,
    unknown_status,
    duplicates_in_input,
    contacts_affected: affectedContactIds.size,
    applied,
    already_set,
    by_reason,
    invalid_samples,
    skipped_samples,
  };

  return NextResponse.json(summary, { status: 201 });
}
