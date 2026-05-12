import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_contacts, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { segmentOverlapsSchema } from "@/lib/validators/segments";

type OverlapEntry = { segment_ids: number[]; count: number };

// Builds the list of non-empty subsets we'll compute counts for. Capped to
// keep query cost bounded:
//   singletons (N), pairs (C(N,2)), triples (C(N,3)), and the full N-way.
// For N ≤ 3 the triples == full N-way, so dedupe; for N ≤ 2 there's no triple.
function buildSubsets(ids: number[]): number[][] {
  const subsets: number[][] = [];
  const N = ids.length;

  // singletons
  for (const id of ids) subsets.push([id]);

  // pairs
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) subsets.push([ids[i], ids[j]]);
  }

  // triples
  if (N >= 3) {
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        for (let k = j + 1; k < N; k++) {
          subsets.push([ids[i], ids[j], ids[k]]);
        }
      }
    }
  }

  // full N-way (only if N >= 4 — otherwise it's a duplicate of a triple/pair/single)
  if (N >= 4) subsets.push([...ids]);

  return subsets;
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = segmentOverlapsSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const ids = Array.from(new Set(parsed.data.segment_ids)).sort((a, b) => a - b);
  if (ids.length < 2) {
    return apiError(
      400,
      "Provide at least 2 distinct segment_ids",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Confirm all segments belong to this org.
  const validRows = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.org_id, orgId), inArray(segments.id, ids)));
  if (validRows.length !== ids.length) {
    return apiError(
      400,
      "One or more segment_ids do not belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "segment_ids" },
    );
  }

  const subsets = buildSubsets(ids);

  // Strategy: a single CTE that builds per-contact bitmask membership across
  // the selected segments, then COUNTs against each subset's required bitmask.
  // With N ≤ 15, a smallint fits easily and Postgres handles this in one pass.
  //
  // bit_or aggregation: for each contact, OR together the bits of every
  // segment they belong to. Then for each subset S, count contacts whose
  // membership bitmask has all bits in S set (bitmask & S_mask = S_mask).
  const bitOfId = new Map<number, number>();
  ids.forEach((id, i) => bitOfId.set(id, 1 << i));

  // Build a SQL CASE expression that maps each segment id → its bit.
  const caseFragments = ids.map(
    (id) => drizzleSql`when ${segment_contacts.segment_id} = ${id} then ${bitOfId.get(id)!}`,
  );
  const caseExpr = drizzleSql`case ${drizzleSql.join(caseFragments, drizzleSql.raw(" "))} else 0 end`;

  const memberships = await db
    .select({
      contact_id: segment_contacts.contact_id,
      mask: drizzleSql<number>`bit_or(${caseExpr})::int`,
    })
    .from(segment_contacts)
    .where(
      and(
        eq(segment_contacts.org_id, orgId),
        inArray(segment_contacts.segment_id, ids),
      ),
    )
    .groupBy(segment_contacts.contact_id);

  // Compute each subset's count in JS — cheap, since we already materialized
  // the per-contact mask.
  const overlaps: OverlapEntry[] = subsets.map((subset) => {
    const subsetMask = subset.reduce((acc, id) => acc | bitOfId.get(id)!, 0);
    let count = 0;
    for (const m of memberships) {
      if ((m.mask & subsetMask) === subsetMask) count++;
    }
    return { segment_ids: subset, count };
  });

  return NextResponse.json({ overlaps });
}
