import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contact_groups } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { getAudienceGroups, getAudienceReport } from "@/lib/reporting/audience-report";

export const dynamic = "force-dynamic";

const MAX_INT4 = 2_147_483_647;

// Read API for the Audience Stats report (/reports/audience, ClickUp 869eydqn0):
// GET ?group_id=<id>. Always returns the picker's group list; the report only
// when a group is named. Gated on campaigns.view, like every /reports tab.
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/audience",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const raw = req.nextUrl.searchParams.get("group_id");
  const groupId = raw == null || raw === "" ? null : Number(raw);
  if (groupId !== null && (!Number.isInteger(groupId) || groupId <= 0 || groupId > MAX_INT4)) {
    return apiError(400, "Invalid group id", API_ERROR_CODES.VALIDATION, { field: "group_id" });
  }

  const groups = await getAudienceGroups(orgId);
  if (groupId === null) {
    return NextResponse.json({ groups, report: null });
  }

  // Org-scoped existence check — the multi-tenancy guard: another org's group
  // id 404s instead of leaking. No status filter: an archived group keeps its
  // report.
  const [group] = await db
    .select({ name: contact_groups.name, status: contact_groups.status })
    .from(contact_groups)
    .where(and(eq(contact_groups.id, groupId), eq(contact_groups.org_id, orgId)))
    .limit(1);
  if (!group) {
    return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact_group",
    });
  }

  const report = await getAudienceReport(orgId, groupId);

  // The bar every offer row's Net RPM is coloured against: this group's own
  // blended cost per 1k sends, from the group total (not a sum of the rows).
  const { groupTotals } = report;
  const breakEvenPer1k =
    groupTotals.sends > 0 ? (groupTotals.cost / groupTotals.sends) * 1000 : null;

  return NextResponse.json({
    groups,
    report: {
      groupId,
      groupName: group.name,
      groupArchived: group.status === "archived",
      ...report,
      breakEvenPer1k,
    },
  });
}
