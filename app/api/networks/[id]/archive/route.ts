import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const networkId = parseId(id);
  if (networkId === null) {
    return apiError(400, "Invalid network id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // Archiving is allowed even when offers reference this network; the FK is
  // ON DELETE SET NULL, not a strict constraint on archival.
  const updated = await db
    .update(affiliate_networks)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(affiliate_networks.id, networkId),
        eq(affiliate_networks.org_id, orgId),
        eq(affiliate_networks.status, "active"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: affiliate_networks.status })
    .from(affiliate_networks)
    .where(
      and(
        eq(affiliate_networks.id, networkId),
        eq(affiliate_networks.org_id, orgId),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Network not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "network",
    });
  }
  return apiError(
    409,
    "Network is already archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_archived" },
  );
}
