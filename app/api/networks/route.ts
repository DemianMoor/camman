import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks, conversion_event_mappings } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { eventTypesBelongToOrg } from "@/lib/conversions/network-mappings";
import { can } from "@/lib/permissions";
import {
  networkCreateWithMappingsSchema,
  nullIfEmpty,
} from "@/lib/validators/networks";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "networks",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = networkCreateWithMappingsSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Conversion mapping rules arrive with the network (the create form
  // pre-fills the defaults) and are inserted in the same transaction, so a
  // network never exists without the rules the user saw on screen.
  const mappings = parsed.data.mappings ?? [];
  if (
    !(await eventTypesBelongToOrg(
      db,
      orgId,
      mappings.map((m) => m.event_type_id),
    ))
  ) {
    return apiError(400, "Unknown event type", API_ERROR_CODES.VALIDATION, {
      field: "mappings",
    });
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [network] = await tx
        .insert(affiliate_networks)
        .values({
          org_id: orgId,
          name: parsed.data.name,
          network_id: parsed.data.network_id,
          url: nullIfEmpty(parsed.data.url),
          avatar_url: nullIfEmpty(parsed.data.avatar_url),
          color: nullIfEmpty(parsed.data.color),
          status: "active",
        })
        .returning();
      if (mappings.length > 0) {
        await tx.insert(conversion_event_mappings).values(
          mappings.map((m) => ({
            org_id: orgId,
            affiliate_network_id: network.id,
            keitaro_type: m.keitaro_type,
            event_type_id: m.event_type_id,
            conversion_status: m.conversion_status,
            status: "active",
          })),
        );
      }
      return network;
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A network with this network_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "network_id" },
      );
    }
    throw err;
  }
}
