import {
  and,
  asc,
  desc,
  eq,
  ilike,
  ne,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_phones, sms_providers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { jsonForRole } from "@/lib/authz/redact";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { getDescriptor } from "@/lib/sends/providers/registry";

const SORT_COLUMNS = {
  name: sms_providers.name,
  sms_provider_id: sms_providers.sms_provider_id,
  created_at: sms_providers.created_at,
  status: sms_providers.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "providers/list",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // provider_phones.view, not providers.view: this list is the stage form's
  // ROUTE PICKER feed, and for an operator every provider identity in it is
  // replaced by a route alias before it leaves the process. Requiring
  // providers.view would have made the picker unusable for the one role that
  // most needs it, while granting that permission would have said something
  // about intent that is not true. Every role that holds providers.view also
  // holds provider_phones.view, so nothing widens for anyone else.
  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  const conditions = [eq(sms_providers.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(sms_providers.name, pattern),
        ilike(sms_providers.sms_provider_id, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(sms_providers.status, "active"));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? sms_providers.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  // Phone count per provider: non-archived phones only.
  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: sms_providers.id,
        sms_provider_id: sms_providers.sms_provider_id,
        org_id: sms_providers.org_id,
        name: sms_providers.name,
        short_link_supported: sms_providers.short_link_supported,
        short_link_example: sms_providers.short_link_example,
        avatar_url: sms_providers.avatar_url,
        color: sms_providers.color,
        status: sms_providers.status,
        // Q3 footer chain: the provider-level candidate, plus the connection
        // type so the preview can consult descriptor.appendsOwnOptOut. Both are
        // needed even when no sending number is selected yet, which is why they
        // ride here rather than only on the phones list.
        opt_out_footer: sms_providers.opt_out_footer,
        adapter_code: sms_providers.adapter_code,
        // `appends_own_opt_out` is derived from adapter_code below rather than
        // sent as a registry import: the stage form is a "use client" component
        // and importing lib/sends/providers/registry there would bundle every
        // provider's HTTP client into the browser (the rule R4 established).
        // Surfaced so the stage form can warn when a scheduled time falls
        // outside the provider's auto-send window (see lib/quiet-hours.ts).
        send_window_weekday_start: sms_providers.send_window_weekday_start,
        send_window_weekday_end: sms_providers.send_window_weekday_end,
        send_window_weekend_start: sms_providers.send_window_weekend_start,
        send_window_weekend_end: sms_providers.send_window_weekend_end,
        archived_at: sms_providers.archived_at,
        created_at: sms_providers.created_at,
        phone_count: drizzleSql<number>`count(${provider_phones.id})::int`,
      })
      .from(sms_providers)
      .leftJoin(
        provider_phones,
        and(
          eq(provider_phones.provider_id, sms_providers.id),
          ne(provider_phones.status, "archived"),
        ),
      )
      .where(where)
      .groupBy(sms_providers.id)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(sms_providers)
      .where(where),
  ]);

  // Derive the descriptor flag server-side (see the note on the select above).
  // NULL adapter_code = a custom/manual provider with no adapter, which appends
  // nothing — false, not "unknown".
  const data = rows.map((r) => ({
    ...r,
    appends_own_opt_out:
      (r.adapter_code ? getDescriptor(r.adapter_code)?.appendsOwnOptOut : false) === true,
  }));

  return await jsonForRole(role, orgId, {
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
