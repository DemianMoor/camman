import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  sql as drizzleSql,
} from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  clickers,
  contacts,
  opt_ins,
  opt_outs,
  segment_contacts,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

const SORT_COLUMNS = {
  phone_number: contacts.phone_number,
  created_at: contacts.created_at,
} as const;

const VALID_VIEWS = new Set([
  "active",
  "archived",
  "opt_outs",
  "opt_ins",
  "clickers",
] as const);

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const rawView = sp.get("view") ?? "active";
  const view = (VALID_VIEWS as Set<string>).has(rawView) ? rawView : "active";
  const segmentIdRaw = sp.get("segment_id");
  const segmentId =
    segmentIdRaw && /^\d+$/.test(segmentIdRaw) ? Number(segmentIdRaw) : null;

  const conditions = [eq(contacts.org_id, orgId)];
  if (segmentId !== null) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(segment_contacts)
          .where(
            and(
              eq(segment_contacts.contact_id, contacts.id),
              eq(segment_contacts.segment_id, segmentId),
              eq(segment_contacts.org_id, orgId),
            ),
          ),
      ),
    );
  }
  if (params.search) {
    conditions.push(ilike(contacts.phone_number, `%${params.search}%`));
  }
  if (view === "active") {
    conditions.push(eq(contacts.is_archived, false));
  } else if (view === "archived") {
    conditions.push(eq(contacts.is_archived, true));
  } else if (view === "opt_outs") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_outs)
          .where(
            and(
              eq(opt_outs.contact_id, contacts.id),
              eq(opt_outs.org_id, orgId),
            ),
          ),
      ),
    );
  } else if (view === "opt_ins") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_ins)
          .where(
            and(
              eq(opt_ins.contact_id, contacts.id),
              eq(opt_ins.org_id, orgId),
            ),
          ),
      ),
    );
  } else if (view === "clickers") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(clickers)
          .where(
            and(
              eq(clickers.contact_id, contacts.id),
              eq(clickers.org_id, orgId),
            ),
          ),
      ),
    );
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? contacts.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const rowSource = chunkedQuery({
    fetchChunk: (offset, limit) =>
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(orderFn(sortColumn))
        .limit(limit)
        .offset(offset),
  });

  return streamCsvResponse({
    filename: buildExportFilename("contacts"),
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "country", label: "Country" },
      { key: "is_archived", label: "Archived" },
      { key: "created_at", label: "Created At" },
    ],
    rowSource,
    rowMapper: (row) => {
      const parsed = parsePhoneNumberFromString(row.phone_number);
      return {
        phone_number: formatPhoneForExport(row.phone_number),
        country: parsed?.country ?? "",
        is_archived: row.is_archived ? "Yes" : "No",
        created_at: row.created_at,
      };
    },
  });
}
