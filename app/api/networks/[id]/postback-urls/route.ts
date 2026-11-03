import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  buildAdvertiserSpec,
  buildPostbackUrls,
  checkPostbackBase,
} from "@/lib/conversions/postback-urls";
import { can } from "@/lib/permissions";

// The per-event Keitaro postback URLs for one network, plus the advertiser
// spec generated from them. Manager and above only (networks.update): the base
// URL carries Keitaro's postback key, and anyone holding it can post
// conversions. Read-only — nothing is written and Keitaro is not called.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({
    route: "networks/[id]/postback-urls",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const networkId = Number(id);
  if (!Number.isInteger(networkId) || networkId <= 0) {
    return apiError(400, "Invalid network id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const [network] = await db
    .select({ name: affiliate_networks.name, code: affiliate_networks.network_id })
    .from(affiliate_networks)
    .where(and(eq(affiliate_networks.id, networkId), eq(affiliate_networks.org_id, orgId)))
    .limit(1);
  if (!network) {
    return apiError(404, "Network not found", API_ERROR_CODES.NOT_FOUND, { entity: "network" });
  }

  const base = checkPostbackBase(process.env.KEITARO_POSTBACK_URL);
  if (!base.ok) {
    return NextResponse.json({ configured: false, reason: base.reason, urls: [], spec: null });
  }
  const urls = buildPostbackUrls(base.base, network.code);
  return NextResponse.json({
    configured: true,
    urls,
    spec: buildAdvertiserSpec(network.name, urls),
  });
}
