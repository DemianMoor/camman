import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { previewLifecycleThresholds } from "@/lib/engagement/preview";
import { can } from "@/lib/permissions";

// "What would this threshold change do?" — the same evaluator the job uses, run
// over the STORED facts with the proposed values injected. Writes nothing; the
// transaction only carries the temp tables.
//
// Measured on prod 2026-09-23 over 877,943 contacts: 3.8 s warm, 10.9 s cold.
// It is therefore answered synchronously behind a spinner rather than cached —
// a cache keyed on the proposed values would almost never hit, because every
// edit is a different key. maxDuration leaves ample room above the worst case;
// no statement timeout is raised anywhere for it.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const overrideValue = z.number().int().min(1).max(1000).nullable();

const bodySchema = z.object({
  thresholds: z
    .object({
      hot_days: z.number().int().min(1).max(365),
      warm_days: z.number().int().min(2).max(730),
      freeze_after_messages: z.number().int().min(1).max(1000),
      freeze_cadence_days: z.number().int().min(1).max(365),
      suppress_after_days: z.number().int().min(1).max(730),
      suppress_min_freeze_messages: z.number().int().min(1).max(100),
    })
    .optional(),
  group: z
    .object({
      group_id: z.number().int().positive(),
      overrides: z.object({
        freeze_after_messages: overrideValue.optional(),
        freeze_cadence_days: overrideValue.optional(),
        suppress_after_days: overrideValue.optional(),
        suppress_min_freeze_messages: overrideValue.optional(),
      }),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "lifecycle.configure")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid body",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { thresholds, group } = parsed.data;
  if (thresholds && thresholds.warm_days <= thresholds.hot_days) {
    return apiError(
      400,
      "The warm window must be longer than the hot window.",
      API_ERROR_CODES.VALIDATION,
    );
  }
  // The group being previewed must belong to this org: a preview must never be
  // a cross-tenant probe.
  if (group) {
    const owned = (await db.execute(sql`
      SELECT 1 FROM contact_groups WHERE id = ${group.group_id} AND org_id = ${orgId}::uuid
    `)) as unknown as unknown[];
    if (owned.length === 0) {
      return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND);
    }
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '55s'`);
    return previewLifecycleThresholds(tx, orgId, {
      proposedOrg: thresholds,
      proposedGroup: group ? { groupId: group.group_id, overrides: group.overrides } : undefined,
    });
  });
  return NextResponse.json(result);
}
