import "server-only";

import { getOrgMembership, getUser } from "@/lib/auth/helpers";
import { getEntityName, type EntityKind } from "@/lib/entity-name";

/**
 * Title text for an entity detail route: the record's name, or `fallback` when
 * the id is malformed, the row is gone, the name is blank, the caller has no
 * session/org, or the row belongs to another org.
 *
 * Safe to call from generateMetadata — it never throws and never redirects
 * (which is why it uses getUser()/getOrgMembership() rather than
 * requireOrgMembership()). Both helpers are already React.cache'd and are
 * called by the protected layout on every request, so resolving the org here
 * adds no query: the only new one is the name lookup itself.
 */
export async function entityTitle(
  kind: EntityKind,
  rawId: string,
  fallback: string,
): Promise<string> {
  const id = Number(rawId);
  // Bail before touching auth or the DB on a non-numeric segment.
  if (!Number.isInteger(id) || id <= 0) return fallback;
  try {
    const user = await getUser();
    if (!user) return fallback;
    const membership = await getOrgMembership(user.id);
    if (!membership) return fallback;
    return (await getEntityName(kind, id, membership.org_id)) ?? fallback;
  } catch {
    return fallback;
  }
}
