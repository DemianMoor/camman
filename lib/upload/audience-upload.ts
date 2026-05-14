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
  groups_applied: number;
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
  // get the row back (whether newly inserted or pre-existing).
  const resolved: ResolvedContact[] = [];
  for (let i = 0; i < dedupedValid.length; i += CONTACT_UPSERT_CHUNK) {
    const chunk = dedupedValid.slice(i, i + CONTACT_UPSERT_CHUNK).map((v) => ({
      org_id: orgId,
      phone_number: v.normalized,
    }));
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

  // Tag resolved contacts with the requested groups (idempotent).
  let groups_applied = 0;
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
  };
}
