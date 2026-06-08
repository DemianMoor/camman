import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  campaigns,
  contact_contact_groups,
  contact_groups,
  contacts,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { validatePhonesBatch } from "@/lib/phone-validation";
import { contactBulkUploadSchema } from "@/lib/validators/contacts";

const CHUNK_SIZE = 1000;
const INVALID_SAMPLE_LIMIT = 20;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

type UploadResultSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
  groups_applied: number;
  updated_contacts: number;
};

// Upload a CSV / pasted list of phones straight onto a campaign: upsert the
// contacts, tag them with the selected contact group(s), and ensure those
// groups are part of the campaign's audience. The audience snapshot is frozen
// at activation (see lib/audience-snapshot.ts), so this is only allowed while
// the campaign is still a draft — the same lock the PATCH route enforces for
// audience_contact_group_ids.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Needs both: upserting contacts (contacts.upload) and mutating the
  // campaign's audience (campaigns.update).
  if (!can(role, "contacts.upload") || !can(role, "campaigns.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam } = await params;
  const campaignId = parseId(cIdParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = contactBulkUploadSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Load the campaign (org-scoped) and gate on draft status — the audience is
  // immutable once the campaign has been activated.
  const campaignRow = await db
    .select({
      status: campaigns.status,
      audience_contact_group_ids: campaigns.audience_contact_group_ids,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRow[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  if (campaignRow[0].status !== "draft") {
    return apiError(
      400,
      "Contacts can only be uploaded while the campaign is a draft — its audience is frozen once activated",
      API_ERROR_CODES.VALIDATION,
      { reason: "audience_locked_after_draft" },
    );
  }

  // Verify the requested groups belong to this org BEFORE touching contacts,
  // so a bad group id rejects the upload before any write.
  const requestedGroupIds = Array.from(
    new Set(parsed.data.assign_to_group_ids),
  );
  const validGroups = await db
    .select({ id: contact_groups.id })
    .from(contact_groups)
    .where(
      and(
        eq(contact_groups.org_id, orgId),
        inArray(contact_groups.id, requestedGroupIds),
      ),
    );
  if (validGroups.length !== requestedGroupIds.length) {
    return apiError(
      400,
      "One or more assign_to_group_ids do not belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "assign_to_group_ids" },
    );
  }

  // Parse — split by newline / comma / semicolon; trim; drop empties.
  const rawLines = parsed.data.phones
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const submitted = rawLines.length;

  const { valid, invalid } = validatePhonesBatch(rawLines);

  // Dedupe valid by normalized E.164, preserving first occurrence.
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

  // Upsert contacts, resolving every row to an id (new or pre-existing). Track
  // which ids were already in the DB so we can report new vs. updated below.
  let inserted_count = 0;
  const resolvedContactIds: string[] = [];
  const existingContactIds = new Set<string>();
  for (let i = 0; i < dedupedValid.length; i += CHUNK_SIZE) {
    const chunk = dedupedValid.slice(i, i + CHUNK_SIZE).map((v) => ({
      org_id: orgId,
      phone_number: v.normalized,
    }));
    const chunkPhones = chunk.map((c) => c.phone_number);
    const existing = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(
        and(
          eq(contacts.org_id, orgId),
          inArray(contacts.phone_number, chunkPhones),
        ),
      );
    const existingPhoneSet = new Set(existing.map((e) => e.phone_number));
    for (const e of existing) existingContactIds.add(e.id);

    const upserted = await db
      .insert(contacts)
      .values(chunk)
      .onConflictDoUpdate({
        target: [contacts.org_id, contacts.phone_number],
        set: { updated_at: drizzleSql`now()` },
      })
      .returning({ id: contacts.id, phone_number: contacts.phone_number });

    for (const row of upserted) {
      resolvedContactIds.push(row.id);
      if (!existingPhoneSet.has(row.phone_number)) inserted_count++;
    }
  }

  // Tag every resolved contact with the requested groups (idempotent via the
  // (contact_id, contact_group_id) PK). RETURNING gives only newly created
  // memberships, which is how we tally groups_applied / updated_contacts.
  let groups_applied = 0;
  const updatedContactIds = new Set<string>();
  if (resolvedContactIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const groupId of requestedGroupIds) {
        for (let i = 0; i < resolvedContactIds.length; i += CHUNK_SIZE) {
          const chunk = resolvedContactIds.slice(i, i + CHUNK_SIZE);
          const tagged = await tx
            .insert(contact_contact_groups)
            .values(
              chunk.map((cid) => ({
                contact_id: cid,
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
    });
  }

  // Wire the selected groups into the campaign's audience so the upload
  // actually lands in THIS campaign. Union with the existing set; only write
  // when something new is added.
  const currentGroupIds = campaignRow[0].audience_contact_group_ids ?? [];
  const mergedGroupIds = Array.from(
    new Set([...currentGroupIds, ...requestedGroupIds]),
  );
  if (mergedGroupIds.length !== currentGroupIds.length) {
    await db
      .update(campaigns)
      .set({ audience_contact_group_ids: mergedGroupIds })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)));
  }

  const summary: UploadResultSummary = {
    submitted,
    valid: valid.length,
    invalid: invalid.length,
    duplicates_in_input,
    duplicates_in_db: dedupedValid.length - inserted_count,
    inserted: inserted_count,
    invalid_samples: invalid.slice(0, INVALID_SAMPLE_LIMIT),
    groups_applied,
    updated_contacts: updatedContactIds.size,
  };

  return NextResponse.json(summary, { status: 201 });
}
