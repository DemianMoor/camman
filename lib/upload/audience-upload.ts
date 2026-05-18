import "server-only";

import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";
import { contact_contact_groups, contact_groups, contacts } from "@/db/schema";
import { validatePhonesBatch } from "@/lib/phone-validation";

export type AudienceUploadSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
  // Total new (contact, group) memberships created across the upload.
  // A contact tagged with 3 groups it didn't have yet contributes 3 here.
  groups_applied: number;
  // Number of *already-existing* contacts that gained at least one new
  // group membership from this upload. A duplicate-in-DB phone uploaded
  // with groups it already had does NOT count; brand-new contacts being
  // tagged for the first time do NOT count (they're in `inserted`).
  updated_contacts: number;
};

export type ResolvedContact = {
  contact_id: string;
  phone_number: string;
};

export interface AudienceUploadConfig {
  orgId: string;
  rawPhones: string;
  // Called with the (contact_id, phone_number) pairs after contacts are
  // upserted. Should perform the entity-specific insert(s) and return the
  // count of entity rows it actually inserted.
  insertEntities: (rows: ResolvedContact[]) => Promise<number>;
  // Optional: tag every resolved contact with these contact groups.
  // Caller is responsible for verifying these IDs are owned by orgId.
  assignToGroupIds?: number[];
}

const CONTACT_UPSERT_CHUNK = 1000;
const INVALID_SAMPLE_LIMIT = 20;

// Shared parse → validate → upsert-contacts → invoke entity insert pipeline.
// Reused by /api/opt-outs/upload, /api/opt-ins/upload, /api/clickers/upload.
// For audience-engagement entities, `duplicates_in_db` doesn't apply (opt-outs
// etc. are append-only — multiple records can exist for the same contact over
// time), so it's reported as 0. `inserted` always equals the count of entity
// rows the caller inserted.
export async function processAudienceUpload(
  config: AudienceUploadConfig,
): Promise<AudienceUploadSummary> {
  const { orgId, rawPhones, insertEntities, assignToGroupIds } = config;

  // Resolve & verify groups up front so a bad group ID rejects the upload
  // before we do any contact work.
  const requestedGroupIds = Array.from(new Set(assignToGroupIds ?? []));
  if (requestedGroupIds.length > 0) {
    const ownedGroups = await db
      .select({ id: contact_groups.id })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          inArray(contact_groups.id, requestedGroupIds),
        ),
      );
    if (ownedGroups.length !== requestedGroupIds.length) {
      throw new Error(
        "One or more assign_to_group_ids do not belong to your organization",
      );
    }
  }

  // Parse — split by newline / comma / semicolon; trim; drop empties.
  const rawLines = rawPhones
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const submitted = rawLines.length;

  const { valid, invalid } = validatePhonesBatch(rawLines);

  // Dedupe valid by normalized E.164.
  const seen = new Set<string>();
  const dedupedValid: typeof valid = [];
  let duplicates_in_input = 0;
  for (const v of valid) {
    if (seen.has(v.normalized)) {
      duplicates_in_input++;
    } else {
      seen.add(v.normalized);
      dedupedValid.push(v);
    }
  }

  // Upsert contacts. ON CONFLICT (org_id, phone_number) DO UPDATE so we always
  // get the row back (whether newly inserted or pre-existing). Per chunk,
  // pre-query which phones already exist so we can later distinguish
  // duplicates from brand-new contacts when reporting `updated_contacts`.
  const resolved: ResolvedContact[] = [];
  const existingContactIds = new Set<string>();
  for (let i = 0; i < dedupedValid.length; i += CONTACT_UPSERT_CHUNK) {
    const chunk = dedupedValid.slice(i, i + CONTACT_UPSERT_CHUNK).map((v) => ({
      org_id: orgId,
      phone_number: v.normalized,
    }));
    const chunkPhones = chunk.map((c) => c.phone_number);
    const existingRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(
        and(
          eq(contacts.org_id, orgId),
          inArray(contacts.phone_number, chunkPhones),
        ),
      );
    for (const e of existingRows) existingContactIds.add(e.id);

    const upserted = await db
      .insert(contacts)
      .values(chunk)
      .onConflictDoUpdate({
        target: [contacts.org_id, contacts.phone_number],
        set: { updated_at: drizzleSql`now()` },
      })
      .returning({
        id: contacts.id,
        phone_number: contacts.phone_number,
      });
    for (const row of upserted) {
      resolved.push({ contact_id: row.id, phone_number: row.phone_number });
    }
  }

  const inserted = await insertEntities(resolved);

  // Tag resolved contacts with the requested groups (idempotent). Track
  // which existing contacts gained at least one new membership so we can
  // report `updated_contacts` — the set is bounded by existingContactIds,
  // so a brand-new contact tagged for the first time is NOT counted as
  // "updated" (it's already in `inserted`).
  let groups_applied = 0;
  const updatedContactIds = new Set<string>();
  if (requestedGroupIds.length > 0 && resolved.length > 0) {
    for (let i = 0; i < resolved.length; i += CONTACT_UPSERT_CHUNK) {
      const chunk = resolved.slice(i, i + CONTACT_UPSERT_CHUNK);
      for (const groupId of requestedGroupIds) {
        const tagged = await db
          .insert(contact_contact_groups)
          .values(
            chunk.map((c) => ({
              contact_id: c.contact_id,
              contact_group_id: groupId,
              org_id: orgId,
            })),
          )
          .onConflictDoNothing()
          .returning({ contact_id: contact_contact_groups.contact_id });
        groups_applied += tagged.length;
        for (const t of tagged) {
          if (existingContactIds.has(t.contact_id)) {
            updatedContactIds.add(t.contact_id);
          }
        }
      }
    }
  }

  return {
    submitted,
    valid: valid.length,
    invalid: invalid.length,
    duplicates_in_input,
    duplicates_in_db: 0,
    inserted,
    invalid_samples: invalid.slice(0, INVALID_SAMPLE_LIMIT),
    groups_applied,
    updated_contacts: updatedContactIds.size,
  };
}
