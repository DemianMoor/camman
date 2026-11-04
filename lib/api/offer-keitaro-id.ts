import { and, eq, ne } from "drizzle-orm";

import { db } from "@/db/client";
import { offers } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * True when another offer in the SAME org (any status, archived included)
 * already carries this Keitaro offer id. Matches what ingest counts
 * (lib/conversions/ingest.ts: every offers row, no status filter), and the
 * partial unique index offers_org_keitaro_offer_id_uniq. Another org using the
 * same id is deliberately NOT reported: that would leak another tenant.
 */
export async function keitaroOfferIdTaken(
  tx: Tx,
  orgId: string,
  keitaroOfferId: number,
  excludeOfferId?: number,
): Promise<boolean> {
  const rows = await tx
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.org_id, orgId),
        eq(offers.keitaro_offer_id, keitaroOfferId),
        excludeOfferId === undefined ? undefined : ne(offers.id, excludeOfferId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** SQLSTATE 23505 on the Keitaro-id unique index (the race the pre-check can lose). */
export function isKeitaroIdViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: unknown;
    constraint_name?: unknown;
    cause?: { code?: unknown; constraint_name?: unknown };
  };
  const code = e.code ?? e.cause?.code;
  const name = e.constraint_name ?? e.cause?.constraint_name;
  return code === "23505" && name === "offers_org_keitaro_offer_id_uniq";
}

export const KEITARO_ID_DUPLICATE_MESSAGE =
  "Another offer in this organization already uses this Keitaro offer ID";
