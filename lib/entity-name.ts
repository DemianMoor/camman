import "server-only";

import { cache } from "react";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  campaigns,
  contact_groups,
  offers,
  segments,
  sms_providers,
} from "@/db/schema";

// Org-scoped entity name lookup behind detail-page browser tab titles — see
// docs/07-conventions.md § Browser tab titles.
//
// Deliberately free of auth/Next imports so the tenancy predicate below can be
// exercised directly by scripts/test-entity-title-tenancy.ts. The title-level
// wrapper that resolves the caller's org lives in lib/entity-title.ts.

const ENTITIES = {
  campaign: campaigns,
  segment: segments,
  contact_group: contact_groups,
  sms_provider: sms_providers,
  offer: offers,
} as const;

export type EntityKind = keyof typeof ENTITIES;

/**
 * The name of `kind` #`id`, **scoped to `orgId`**, or null.
 *
 * The `org_id` predicate is load-bearing, not defence-in-depth: without it a
 * caller could put another tenant's entity name in their own browser tab just
 * by guessing a sequential id. Every caller goes through this one function, so
 * there is no per-route SQL to get wrong.
 *
 * Memoized per request via React.cache keyed on (kind, id, orgId), so a
 * layout's generateMetadata and a child page's generateMetadata resolving the
 * same entity cost one query between them, not two.
 */
export const getEntityName = cache(
  async (
    kind: EntityKind,
    id: number,
    orgId: string,
  ): Promise<string | null> => {
    if (!Number.isInteger(id) || id <= 0) return null;
    const table = ENTITIES[kind];
    try {
      const rows = await db
        .select({ name: table.name })
        .from(table)
        .where(and(eq(table.id, id), eq(table.org_id, orgId)))
        .limit(1);
      // campaigns.name is nullable (a draft can be saved unnamed), so an
      // existing row is not a guarantee of a usable title.
      const name = rows[0]?.name?.trim();
      return name ? name : null;
    } catch {
      // A metadata lookup must never take the page down; the caller falls back
      // to the static title.
      return null;
    }
  },
);
