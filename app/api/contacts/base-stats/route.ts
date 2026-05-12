import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

export type ContactBaseStats = {
  total: number;
  archived: number;
  opt_out_count: number;
  opt_in_count: number;
  clicker_count: number;
};

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const [activeRow, archivedRow] = await Promise.all([
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(contacts)
      .where(and(eq(contacts.org_id, orgId), eq(contacts.is_archived, false))),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(contacts)
      .where(and(eq(contacts.org_id, orgId), eq(contacts.is_archived, true))),
  ]);

  const stats: ContactBaseStats = {
    total: activeRow[0]?.count ?? 0,
    archived: archivedRow[0]?.count ?? 0,
    // TODO(step-6.2): wire up real counts when opt_outs/opt_ins/clickers tables
    // exist. Stable shape now so the UI doesn't change later.
    opt_out_count: 0,
    opt_in_count: 0,
    clicker_count: 0,
  };
  return NextResponse.json(stats);
}
