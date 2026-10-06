import { and, eq, inArray } from "drizzle-orm";

import { event_types } from "@/db/schema";
import type { Executor } from "@/lib/conversions/ingest";

// True when every id is an ACTIVE event type of this org. event_types.id is a
// global serial and the FK has no org_id, so an id from another org would pass
// the FK — this is the check that keeps a rule inside its tenant (CLAUDE.md §3).
export async function eventTypesBelongToOrg(
  ex: Executor,
  orgId: string,
  ids: readonly number[],
): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const found = await ex
    .select({ id: event_types.id })
    .from(event_types)
    .where(
      and(
        eq(event_types.org_id, orgId),
        eq(event_types.status, "active"),
        inArray(event_types.id, unique),
      ),
    );
  return found.length === unique.length;
}
