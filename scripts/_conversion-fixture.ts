import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { db } from "../db/client";

// Shared fixture for the DB test scripts: seed ONE conversion_events row for a
// seeded stage_sends row, so a test that used to write
// `stage_sends.sale_status = 'lead'` seeds the ledger the readers now read.
//
// Resolves the org's event type by key (0181 seeds `purchase` + `registration`
// into every org). keitaro_event_id is a random UUID so the global unique index
// can never collide across runs; every caller runs inside a rolled-back
// transaction or deletes its own rows.
export type FixtureExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SeedConversionEvent {
  orgId: string;
  stageSendId?: string | null;
  contactId?: string | null;
  campaignId?: number | null;
  stageId?: number | null;
  offerId?: number | null;
  /**
   * 0181's seeded keys. Omit for an UNMAPPED row (NULL event_type_id). Unmapped
   * comes in two shapes and both must be seedable, because both count as
   * NOTHING everywhere and only one of them is obvious:
   *   omit `status` too   -> NULL type + NULL status (no mapping rule matched)
   *   pass `status`       -> NULL type + a real status, which is what a
   *                          "status transition only" mapping rule produces
   *                          (lib/conversions/build-rows.ts:5-7,140 — the rule
   *                          carries eventTypeId null and keeps the row's
   *                          existing event type, which may be none).
   */
  eventKey?: "purchase" | "registration";
  /**
   * Defaults to "approved" for a mapped row, and to NULL for an unmapped one.
   *
   * Pass `null` EXPLICITLY for the third unmapped shape: a row whose event TYPE
   * is mapped (so it is a purchase-type row) but whose STATUS is not. That row
   * counts as nothing everywhere — and it is the one shape that tells
   * `AND pe.status IS NOT NULL` apart from its absence, in `lib/campaign-tier.ts`
   * and in both inline copies in `lib/drip/lifecycle.ts`.
   */
  status?: "pending" | "approved" | "rejected" | null;
  revenue?: number;
  /** The raw Keitaro conversion type, for the stage-day projection's filters. */
  keitaroType?: string;
}

export async function seedConversionEvent(
  dbc: FixtureExecutor,
  e: SeedConversionEvent,
): Promise<number> {
  const eventTypeId = e.eventKey
    ? Number(
        (
          (await dbc.execute(sql`
            SELECT id FROM event_types WHERE org_id = ${e.orgId}::uuid AND key = ${e.eventKey}
          `)) as unknown as { id: number }[]
        )[0]?.id,
      )
    : null;
  if (e.eventKey && !Number.isFinite(eventTypeId)) {
    throw new Error(`event type '${e.eventKey}' is not seeded for org ${e.orgId} (migration 0181)`);
  }
  const type = e.keitaroType ?? (e.eventKey === "registration" ? "registration" : "lead");
  const rows = (await dbc.execute(sql`
    INSERT INTO conversion_events
      (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
       occurred_at, last_postback_at, stage_send_id, contact_id, campaign_id, stage_id, offer_id)
    VALUES (${e.orgId}::uuid, ${`fixture-${randomUUID()}`}, ${type}, ${type},
            ${eventTypeId},
            ${e.status !== undefined ? e.status : (e.eventKey ? "approved" : null)},
            ${(e.revenue ?? 0).toFixed(4)}::numeric,
            now(), now(), ${e.stageSendId ?? null}::uuid, ${e.contactId ?? null}::uuid,
            ${e.campaignId ?? null}::int, ${e.stageId ?? null}::int, ${e.offerId ?? null}::int)
    RETURNING id
  `)) as unknown as { id: number }[];
  return Number(rows[0].id);
}
