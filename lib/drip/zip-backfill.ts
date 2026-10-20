// Zip backfill core (0217, P3). contact_attributes.zip is new; partners have been
// sending zip all along (pml: ~96% of leads) and enrichment dropped it. This
// recovers it from lead_inbox.raw for contacts whose zip is still NULL.
//
// The value comes from the SAME extraction enrichment uses (normalizeLead:
// built-in aliases + the partner key's field_mapping), so a backfilled zip is
// exactly what a fresh lead would have stored. Per contact, the NEWEST lead that
// carries a zip wins. Only `zip IS NULL` rows are ever written (idempotent; a
// known zip is never overwritten). Run by scripts/backfill-contact-zip.ts.

import { sql } from "drizzle-orm";
import type { db } from "@/db/client";
import { normalizeLead } from "./enrichment";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ZipCandidate {
  contactId: string;
  zip: string;
  partnerSlug: string | null;
}

/**
 * One keyset page of zip-less contacts (ordered by contact_id), with the zip
 * each would get. `scanned` counts the page's contacts; `lastContactId` is the
 * cursor for the next page (null when the page was empty).
 */
export async function planZipBackfill(
  dbc: DbOrTx,
  i: {
    orgId: string | null;
    afterContactId: string | null;
    limit: number;
    /** false = a pre-0217 database (dry run only): no column, so every contact is zip-less. */
    hasZipColumn: boolean;
  },
): Promise<{ candidates: ZipCandidate[]; scanned: number; lastContactId: string | null }> {
  const rows = (await dbc.execute(sql`
    WITH batch AS (
      SELECT ca.contact_id, ca.org_id
      FROM contact_attributes ca
      WHERE ${i.hasZipColumn ? sql`ca.zip IS NULL` : sql`true`}
        AND (${i.orgId}::uuid IS NULL OR ca.org_id = ${i.orgId}::uuid)
        AND (${i.afterContactId}::uuid IS NULL OR ca.contact_id > ${i.afterContactId}::uuid)
      ORDER BY ca.contact_id
      LIMIT ${i.limit}
    )
    SELECT b.contact_id, li.raw, pk.field_mapping, li.partner_slug
    FROM batch b
    LEFT JOIN lead_events le
           ON le.org_id = b.org_id AND le.contact_id = b.contact_id AND le.inbox_id IS NOT NULL
    LEFT JOIN lead_inbox li ON li.id = le.inbox_id
    LEFT JOIN partner_keys pk ON pk.id = li.partner_key_id
    ORDER BY b.contact_id, le.received_at DESC NULLS LAST
  `)) as unknown as {
    contact_id: string;
    raw: Record<string, unknown> | null;
    field_mapping: Record<string, string> | null;
    partner_slug: string | null;
  }[];

  const candidates: ZipCandidate[] = [];
  const seen = new Set<string>();
  let lastContactId: string | null = null;
  for (const r of rows) {
    if (r.contact_id !== lastContactId) {
      lastContactId = r.contact_id;
      seen.add(r.contact_id);
    }
    if (candidates.length > 0 && candidates[candidates.length - 1].contactId === r.contact_id) continue;
    if (!r.raw) continue;
    const zip = normalizeLead(r.raw, r.field_mapping ?? {}).zip;
    if (typeof zip === "string") candidates.push({ contactId: r.contact_id, zip, partnerSlug: r.partner_slug });
  }
  return { candidates, scanned: seen.size, lastContactId };
}

/** Write the planned zips. Only rows still `zip IS NULL` are touched. Returns rows written. */
export async function applyZipBackfill(dbc: DbOrTx, candidates: ZipCandidate[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const payload = JSON.stringify(candidates.map((c) => ({ contact_id: c.contactId, zip: c.zip })));
  const res = (await dbc.execute(sql`
    UPDATE contact_attributes ca
       SET zip = v.zip, updated_at = now()
      FROM jsonb_to_recordset(${payload}::jsonb) AS v(contact_id uuid, zip text)
     WHERE ca.contact_id = v.contact_id AND ca.zip IS NULL
    RETURNING ca.contact_id
  `)) as unknown as unknown[];
  return res.length;
}

/**
 * Run one backfill page, retrying if Postgres aborts it as a deadlock victim
 * (40P01). Live enrichment upserts attributes for up to 200 leads per
 * transaction in arrival order while a page UPDATE locks up to a batch of rows
 * in join order, so a crossing pair can deadlock; the page is idempotent (only
 * zip IS NULL rows), so re-running it is safe. Other errors propagate at once.
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string } };
      const code = err.code ?? err.cause?.code;
      if (code !== "40P01" || n >= attempts) throw e;
    }
  }
}
