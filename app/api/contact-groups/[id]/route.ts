import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contact_groups, partner_attribution_recalcs, partners } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { loadLifecycleSettings } from "@/lib/engagement/settings-io";
import {
  contactGroupUpdateSchema,
  LIFECYCLE_OVERRIDE_KEYS,
  nullIfEmpty,
} from "@/lib/validators/contact-groups";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["description", "color"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contact_groups.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const sid = parseId(id);
  if (sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(contact_groups)
    .where(and(eq(contact_groups.id, sid), eq(contact_groups.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact_group",
    });
  }
  // The org thresholds ride along so the edit form can show "Effective: N"
  // beside each override without a second round trip; the partner's name
  // (migration 0201) for the header badge likewise.
  const partnerName =
    rows[0].partner_id === null
      ? null
      : ((await db
          .select({ name: partners.name })
          .from(partners)
          .where(and(eq(partners.id, rows[0].partner_id), eq(partners.org_id, orgId)))
          .limit(1))[0]?.name ?? null);
  return NextResponse.json({
    ...rows[0],
    partner_name: partnerName,
    org_thresholds: await loadLifecycleSettings(db, orgId),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "contact_groups.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const sid = parseId(id);
  if (sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = contactGroupUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // The lifecycle overrides are governed by their own permission, checked only
  // when one of them is actually in the payload — otherwise a plain rename by
  // someone with contact_groups.update but not lifecycle.configure would 403.
  // An explicit null passes through the loop below as null ("inherit"), which is
  // exactly what clearing a field must store.
  const touchesLifecycle = LIFECYCLE_OVERRIDE_KEYS.some((k) => k in parsed.data);
  if (touchesLifecycle && !can(role, "lifecycle.configure")) {
    return apiError(
      403,
      "Changing lifecycle overrides needs the lifecycle permission.",
      API_ERROR_CODES.FORBIDDEN,
    );
  }

  // The partner link (migration 0201) moves money between partner reports, so
  // it is governed by partner_keys.manage (ruling Q9), checked only when it is
  // in the payload — same shape as the lifecycle gate above.
  const touchesPartner = "partner_id" in parsed.data;
  if (touchesPartner && !can(role, "partner_keys.manage")) {
    return apiError(
      403,
      "Changing a group's partner needs the partner management permission.",
      API_ERROR_CODES.FORBIDDEN,
    );
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  type PatchOutcome =
    | { kind: "ok"; row: typeof contact_groups.$inferSelect }
    | { kind: "not_found" }
    | { kind: "partner_not_found" }
    | { kind: "conflict"; code: "drip_group" | "system_group" | "partner_archived" };

  try {
    const outcome: PatchOutcome = await db.transaction(async (tx): Promise<PatchOutcome> => {
      const existing = await tx
        .select({
          id: contact_groups.id,
          contact_group_id: contact_groups.contact_group_id,
          system_role: contact_groups.system_role,
          partner_id: contact_groups.partner_id,
        })
        .from(contact_groups)
        .where(and(eq(contact_groups.id, sid), eq(contact_groups.org_id, orgId)))
        .limit(1);
      if (!existing[0]) return { kind: "not_found" };

      if (touchesPartner) {
        // Owner fix F3: on a drip partner×tag group ONLY the pipeline sets the
        // link (ensurePartnerTagGroup, 0201's backfill) — even an unchanged
        // value is refused, so the screen cannot be mistaken for the source.
        if (existing[0].contact_group_id.startsWith("drip:")) {
          return { kind: "conflict", code: "drip_group" };
        }
        // Ruling C4: a system group is a pipeline artifact, never a partner entry.
        if (existing[0].system_role !== null) {
          return { kind: "conflict", code: "system_group" };
        }
        const next = parsed.data.partner_id ?? null;
        if (next !== null) {
          const p = await tx
            .select({ id: partners.id, status: partners.status })
            .from(partners)
            .where(and(eq(partners.id, next), eq(partners.org_id, orgId)))
            .limit(1);
          if (!p[0]) return { kind: "partner_not_found" };
          if (p[0].status !== "active") return { kind: "conflict", code: "partner_archived" };
        }
        const prev = existing[0].partner_id;
        if (prev !== next) {
          // Ruling Q12: a link change only ENQUEUES the recalculation; Phase 3's
          // cron consumes the row. Same transaction as the link itself.
          await tx.insert(partner_attribution_recalcs).values({
            org_id: orgId,
            contact_group_id: sid,
            requested_by: user.id,
            reason: prev === null ? "link" : next === null ? "unlink" : "relink",
          });
        }
      }

      const rows = await tx
        .update(contact_groups)
        .set(updates)
        .where(and(eq(contact_groups.id, sid), eq(contact_groups.org_id, orgId)))
        .returning();
      return rows[0] ? { kind: "ok", row: rows[0] } : { kind: "not_found" };
    });

    if (outcome.kind === "partner_not_found") {
      return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
    }
    if (outcome.kind === "conflict") {
      const messages = {
        drip_group: "This group's partner is set by the drip pipeline from the partner key and cannot be changed here.",
        system_group: "A system group cannot be linked to a partner.",
        partner_archived: "Cannot link a group to an archived partner.",
      } as const;
      return apiError(409, messages[outcome.code], API_ERROR_CODES.CONFLICT, { code: outcome.code });
    }
    if (outcome.kind === "not_found") {
      return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "contact_group",
      });
    }
    return NextResponse.json(outcome.row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A contact group with this contact_group_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "contact_group_id" },
      );
    }
    throw err;
  }
}
