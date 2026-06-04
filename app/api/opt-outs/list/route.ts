import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  opt_out_brands,
  opt_out_providers,
  opt_outs,
  sms_providers,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  phone_number: opt_outs.phone_number,
  created_at: opt_outs.created_at,
  source: opt_outs.source,
} as const;

type BrandInfo = { id: number; name: string; color: string | null };
type ProviderInfo = { id: number; name: string; color: string | null };

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "opt_outs.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const brandFilter = sp.get("brand_id");
  const brandFilterNum =
    brandFilter !== null && /^\d+$/.test(brandFilter) ? Number(brandFilter) : null;
  const providerFilterRaw = sp.get("provider_id");
  const providerFilterIds = providerFilterRaw
    ? providerFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
    : [];

  const conditions = [eq(opt_outs.org_id, orgId)];
  if (params.search) {
    conditions.push(ilike(opt_outs.phone_number, `%${params.search}%`));
  }
  if (brandFilterNum !== null) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_out_brands)
          .where(
            and(
              eq(opt_out_brands.opt_out_id, opt_outs.id),
              eq(opt_out_brands.brand_id, brandFilterNum),
            ),
          ),
      ),
    );
  }
  if (providerFilterIds.length > 0) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_out_providers)
          .where(
            and(
              eq(opt_out_providers.opt_out_id, opt_outs.id),
              inArray(opt_out_providers.provider_id, providerFilterIds),
            ),
          ),
      ),
    );
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? opt_outs.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [pageRows, countRows] = await Promise.all([
    db
      .select()
      .from(opt_outs)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(opt_outs)
      .where(where),
  ]);

  // Fetch joined brands/providers for the rows on this page (two small queries
  // are simpler than a single GROUP BY with array_agg).
  const ids = pageRows.map((r) => r.id);
  let brandsByOptOut = new Map<number, BrandInfo[]>();
  let providersByOptOut = new Map<number, ProviderInfo[]>();
  if (ids.length > 0) {
    const brandJoinRows = await db
      .select({
        opt_out_id: opt_out_brands.opt_out_id,
        id: brands.id,
        name: brands.name,
        color: brands.color,
      })
      .from(opt_out_brands)
      .innerJoin(brands, eq(brands.id, opt_out_brands.brand_id))
      .where(inArray(opt_out_brands.opt_out_id, ids));
    brandsByOptOut = brandJoinRows.reduce((acc, row) => {
      const list = acc.get(row.opt_out_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      acc.set(row.opt_out_id, list);
      return acc;
    }, new Map<number, BrandInfo[]>());

    const providerJoinRows = await db
      .select({
        opt_out_id: opt_out_providers.opt_out_id,
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      })
      .from(opt_out_providers)
      .innerJoin(
        sms_providers,
        eq(sms_providers.id, opt_out_providers.provider_id),
      )
      .where(inArray(opt_out_providers.opt_out_id, ids));
    providersByOptOut = providerJoinRows.reduce((acc, row) => {
      const list = acc.get(row.opt_out_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      acc.set(row.opt_out_id, list);
      return acc;
    }, new Map<number, ProviderInfo[]>());
  }

  // Derive what sent the contact the message they opted out of: the most recent
  // stage that actually SENT to the contact (via stage_sends) at/before the
  // opt-out. From that stage we surface the campaign, the SMS provider, and the
  // sending number (provider_phone). Same attribution as the "Inbound STOPs"
  // metric. Only resolves for contacts sent through the API send pipeline;
  // others get nulls.
  type CampaignRef = {
    id: number;
    name: string | null;
    human_id: string | null;
    tracking_id: string | null;
  };
  type Attribution = {
    campaign: CampaignRef | null;
    send_provider: { id: number; name: string; color: string | null } | null;
    sending_number: string | null;
  };
  let attributionByOptOut = new Map<number, Attribution>();
  if (ids.length > 0) {
    const attrRows = (await db.execute(drizzleSql`
      SELECT oo.id AS opt_out_id,
             c.id AS campaign_id, c.name AS campaign_name,
             c.human_id AS human_id, c.tracking_id AS tracking_id,
             p.id AS provider_id, p.name AS provider_name, p.color AS provider_color,
             pp.phone_number AS sending_number
      FROM opt_outs oo
      LEFT JOIN LATERAL (
        SELECT ss.campaign_id, ss.stage_id
        FROM stage_sends ss
        WHERE ss.contact_id = oo.contact_id AND ss.org_id = ${orgId}
          AND ss.status = 'sent' AND ss.sent_at <= oo.created_at
        ORDER BY ss.sent_at DESC, ss.id DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN campaigns c
        ON c.id = latest.campaign_id AND c.org_id = ${orgId}
      LEFT JOIN campaign_stages cs
        ON cs.id = latest.stage_id AND cs.org_id = ${orgId}
      LEFT JOIN sms_providers p
        ON p.id = cs.sms_provider_id AND p.org_id = ${orgId}
      LEFT JOIN provider_phones pp ON pp.id = cs.provider_phone_id
      WHERE oo.id IN (${drizzleSql.raw(ids.join(","))}) AND oo.org_id = ${orgId}
    `)) as unknown as {
      opt_out_id: number;
      campaign_id: number | null;
      campaign_name: string | null;
      human_id: string | null;
      tracking_id: string | null;
      provider_id: number | null;
      provider_name: string | null;
      provider_color: string | null;
      sending_number: string | null;
    }[];
    attributionByOptOut = new Map(
      attrRows.map((r) => [
        Number(r.opt_out_id),
        {
          campaign:
            r.campaign_id != null
              ? {
                  id: Number(r.campaign_id),
                  name: r.campaign_name,
                  human_id: r.human_id,
                  tracking_id: r.tracking_id,
                }
              : null,
          send_provider:
            r.provider_id != null && r.provider_name != null
              ? {
                  id: Number(r.provider_id),
                  name: r.provider_name,
                  color: r.provider_color,
                }
              : null,
          sending_number: r.sending_number,
        },
      ]),
    );
  }

  const data = pageRows.map((r) => {
    const attr = attributionByOptOut.get(r.id);
    return {
      ...r,
      brands: brandsByOptOut.get(r.id) ?? [],
      providers: providersByOptOut.get(r.id) ?? [],
      campaign: attr?.campaign ?? null,
      send_provider: attr?.send_provider ?? null,
      sending_number: attr?.sending_number ?? null,
    };
  });

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
