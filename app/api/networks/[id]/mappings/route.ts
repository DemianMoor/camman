import { and, asc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  affiliate_networks,
  conversion_event_mappings,
  event_types,
} from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { eventTypesBelongToOrg } from "@/lib/conversions/network-mappings";
import { can } from "@/lib/permissions";
import { mappingRuleCreateSchema } from "@/lib/validators/conversion-mappings";

// Network-level conversion mapping rules (conversion_event_mappings rows with
// affiliate_network_id set). Offer-level rules are not managed here.

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function networkInOrg(networkId: number, orgId: string) {
  const rows = await db
    .select({ id: affiliate_networks.id })
    .from(affiliate_networks)
    .where(
      and(
        eq(affiliate_networks.id, networkId),
        eq(affiliate_networks.org_id, orgId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({
    route: "networks/[id]/mappings",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const networkId = parseId(id);
  if (networkId === null) {
    return apiError(400, "Invalid network id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }
  if (!(await networkInOrg(networkId, orgId))) {
    return apiError(404, "Network not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "network",
    });
  }

  const rows = await db
    .select({
      id: conversion_event_mappings.id,
      keitaro_type: conversion_event_mappings.keitaro_type,
      event_type_id: conversion_event_mappings.event_type_id,
      event_type_label: event_types.label,
      conversion_status: conversion_event_mappings.conversion_status,
      created_at: conversion_event_mappings.created_at,
    })
    .from(conversion_event_mappings)
    .leftJoin(
      event_types,
      and(
        eq(event_types.id, conversion_event_mappings.event_type_id),
        eq(event_types.org_id, conversion_event_mappings.org_id),
      ),
    )
    .where(
      and(
        eq(conversion_event_mappings.org_id, orgId),
        eq(conversion_event_mappings.affiliate_network_id, networkId),
        eq(conversion_event_mappings.status, "active"),
      ),
    )
    .orderBy(asc(conversion_event_mappings.id));

  return NextResponse.json({ data: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({
    route: "networks/[id]/mappings",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const networkId = parseId(id);
  if (networkId === null) {
    return apiError(400, "Invalid network id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = mappingRuleCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  if (!(await networkInOrg(networkId, orgId))) {
    return apiError(404, "Network not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "network",
    });
  }
  if (!(await eventTypesBelongToOrg(db, orgId, [parsed.data.event_type_id]))) {
    return apiError(400, "Unknown event type", API_ERROR_CODES.VALIDATION, {
      field: "event_type_id",
    });
  }

  try {
    const [created] = await db
      .insert(conversion_event_mappings)
      .values({
        org_id: orgId,
        affiliate_network_id: networkId,
        keitaro_type: parsed.data.keitaro_type,
        event_type_id: parsed.data.event_type_id,
        conversion_status: parsed.data.conversion_status,
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "This network already has an active rule for that Keitaro type",
        API_ERROR_CODES.DUPLICATE,
        { field: "keitaro_type" },
      );
    }
    throw err;
  }
}
