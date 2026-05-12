import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { clickers, contacts, opt_ins, opt_outs } from "@/db/schema";
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

  const [activeRow, archivedRow, optOutRow, optInRow, clickerRow] =
    await Promise.all([
      db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(contacts)
        .where(
          and(eq(contacts.org_id, orgId), eq(contacts.is_archived, false)),
        ),
      db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(contacts)
        .where(
          and(eq(contacts.org_id, orgId), eq(contacts.is_archived, true)),
        ),
      db
        .select({
          count: drizzleSql<number>`count(distinct ${opt_outs.contact_id})::int`,
        })
        .from(opt_outs)
        .where(eq(opt_outs.org_id, orgId)),
      db
        .select({
          count: drizzleSql<number>`count(distinct ${opt_ins.contact_id})::int`,
        })
        .from(opt_ins)
        .where(eq(opt_ins.org_id, orgId)),
      db
        .select({
          count: drizzleSql<number>`count(distinct ${clickers.contact_id})::int`,
        })
        .from(clickers)
        .where(eq(clickers.org_id, orgId)),
    ]);

  const stats: ContactBaseStats = {
    total: activeRow[0]?.count ?? 0,
    archived: archivedRow[0]?.count ?? 0,
    opt_out_count: optOutRow[0]?.count ?? 0,
    opt_in_count: optInRow[0]?.count ?? 0,
    clicker_count: clickerRow[0]?.count ?? 0,
  };
  return NextResponse.json(stats);
}
