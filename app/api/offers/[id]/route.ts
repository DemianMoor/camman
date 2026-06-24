import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks, offer_payouts, offers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { nullIfEmpty, offerUpdateSchema } from "@/lib/validators/offers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const offerId = parseId(id);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: offers.id,
      offer_id: offers.offer_id,
      org_id: offers.org_id,
      name: offers.name,
      postfix: offers.postfix,
      base_url: offers.base_url,
      network_id: offers.network_id,
      payout_model: offers.payout_model,
      payout_cpa: offers.payout_cpa,
      payout_revshare: offers.payout_revshare,
      sales_pages: offers.sales_pages,
      avatar_url: offers.avatar_url,
      color: offers.color,
      status: offers.status,
      archived_at: offers.archived_at,
      created_at: offers.created_at,
      network: {
        id: affiliate_networks.id,
        name: affiliate_networks.name,
        avatar_url: affiliate_networks.avatar_url,
        color: affiliate_networks.color,
      },
    })
    .from(offers)
    .leftJoin(affiliate_networks, eq(offers.network_id, affiliate_networks.id))
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "offer",
    });
  }
  const out = {
    ...row,
    network: row.network && row.network.id !== null ? row.network : null,
  };
  return NextResponse.json(out);
}

const NULLABLE_OPTIONAL_STRING = new Set([
  "postfix",
  "base_url",
  "avatar_url",
  "color",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const offerId = parseId(id);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = offerUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (NULLABLE_OPTIONAL_STRING.has(k)) {
      updates[k] = nullIfEmpty(v as string);
    } else if (k === "payout_cpa" || k === "payout_revshare") {
      // Drizzle accepts string for numeric columns; preserve precision.
      updates[k] = v == null ? null : String(v);
    } else {
      updates[k] = v;
    }
  }

  // If network_id is being changed, verify the new network belongs to the
  // caller's org. DB-level FK + RLS aren't enough — the Drizzle connection
  // uses the privileged role.
  if (typeof updates.network_id === "number") {
    const networkRows = await db
      .select({ id: affiliate_networks.id })
      .from(affiliate_networks)
      .where(
        and(
          eq(affiliate_networks.id, updates.network_id),
          eq(affiliate_networks.org_id, orgId),
        ),
      )
      .limit(1);
    if (networkRows.length === 0) {
      return apiError(400, "Network not found", API_ERROR_CODES.VALIDATION, {
        field: "network_id",
      });
    }
  }

  // If payout_model is being changed, clear the unused payout column so we don't
  // leave a stale value behind.
  if (typeof updates.payout_model === "string") {
    if (updates.payout_model === "cpa") {
      if (updates.payout_revshare === undefined) updates.payout_revshare = null;
    } else if (updates.payout_model === "revshare") {
      if (updates.payout_cpa === undefined) updates.payout_cpa = null;
    }
  }

  // Read the current CPA so we can tell whether this PATCH actually changes it.
  // A real change is recorded as offer_payouts history (close current row, open a
  // new one) rather than silently overwriting — offers.payout_cpa is only a cache.
  const currentRows = await db
    .select({ payout_cpa: offers.payout_cpa })
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);
  if (!currentRows[0]) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "offer",
    });
  }
  const oldCpa = currentRows[0].payout_cpa;
  const cpaInUpdate = Object.prototype.hasOwnProperty.call(
    updates,
    "payout_cpa",
  );
  const newCpa = cpaInUpdate ? (updates.payout_cpa as string | null) : oldCpa;
  // Compare numerically so "60" vs "60.0000" isn't seen as a change.
  const cpaChanged =
    cpaInUpdate &&
    (oldCpa == null || newCpa == null
      ? oldCpa !== newCpa
      : Number(oldCpa) !== Number(newCpa));

  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(offers)
        .set(updates)
        .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
        .returning();
      if (!row) return null;

      if (cpaChanged) {
        // Close the current open history row...
        await tx
          .update(offer_payouts)
          .set({ effective_to: sql`now()` })
          .where(
            and(
              eq(offer_payouts.offer_id, offerId),
              isNull(offer_payouts.effective_to),
            ),
          );
        // ...and open a new current row when there's still a CPA (a switch to
        // revshare clears it — close the old row, open none).
        if (newCpa != null) {
          await tx.insert(offer_payouts).values({
            org_id: orgId,
            offer_id: offerId,
            payout_cpa: newCpa,
            effective_from: sql`now()`,
            effective_to: null,
          });
        }
      }
      return row;
    });

    if (!updated) {
      return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "offer",
      });
    }
    return NextResponse.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "An offer with this offer_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "offer_id" },
      );
    }
    throw err;
  }
}
