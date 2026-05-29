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
  // opt_out_count is the count of DISTINCT contacts with any opt_outs row
  // — i.e. "total contacts excluded from future audiences", regardless of
  // why they were excluded. The per-reason breakdown follows.
  opt_out_count: number;
  // Per-reason breakdown of opt_outs rows (NOT distinct contacts — a
  // contact opted-out under multiple reasons would be double-counted
  // across these buckets). The unique-contact total is opt_out_count.
  opt_out_count_by_reason: {
    opt_out: number;
    scrubbed: number;
    bounced: number;
    suppressed: number;
  };
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

  const [activeRow, archivedRow, optOutRow, optOutByReason, optInRow, clickerRow] =
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
          opt_out: drizzleSql<number>`count(*) filter (where ${opt_outs.reason} = 'opt_out')::int`,
          scrubbed: drizzleSql<number>`count(*) filter (where ${opt_outs.reason} = 'scrubbed')::int`,
          bounced: drizzleSql<number>`count(*) filter (where ${opt_outs.reason} = 'bounced')::int`,
          suppressed: drizzleSql<number>`count(*) filter (where ${opt_outs.reason} = 'suppressed')::int`,
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
    opt_out_count_by_reason: {
      opt_out: optOutByReason[0]?.opt_out ?? 0,
      scrubbed: optOutByReason[0]?.scrubbed ?? 0,
      bounced: optOutByReason[0]?.bounced ?? 0,
      suppressed: optOutByReason[0]?.suppressed ?? 0,
    },
    opt_in_count: optInRow[0]?.count ?? 0,
    clicker_count: clickerRow[0]?.count ?? 0,
  };
  return NextResponse.json(stats);
}
