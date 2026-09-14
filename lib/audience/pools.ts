import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  poolCounts,
  REST_BUCKETS,
  type HistogramsByGroup,
  type OfferHistograms,
  type PoolCounts,
} from "@/lib/audience/pool-math";

// "How many contacts could still be sent offer X?" — the rollup behind
// GET /api/audience/pools. Spec:
// docs/superpowers/specs/2026-09-14-operator-api-pools-creative-design.md
//
// ⚠️ REST IS MEASURED FROM THE LAST MESSAGE ACTUALLY SENT, of ANY offer — not
// from campaign creation like fresh-counts. That is the question a strategy
// decision asks ("when did this person last hear from us"), and it is why this
// rollup reads stage_sends, which fresh-counts deliberately avoids.
//
// ⚠️ ONE ORG-WIDE PASS COVERS EVERY OFFER. "Rested" needs each contact's last
// send of any offer, so the stage_sends scan is org-wide whatever the offer
// count; grouping it by (contact, offer) in the same pass makes every offer free.
// Measured 2026-09-14 on prod: 40.2s at default work_mem (31.2s at 128MB) for 40
// offers × 12 active groups × 32 rest buckets = 4,170 aggregate rows. Default
// work_mem is kept on purpose: this database also runs the send drain.
//
// ⚠️ THE BLOB HOLDS ONLY GROUP ids / NAMES, OFFER ids AND INTEGERS. No contact
// ids, no phone numbers — nothing to strip at the response boundary.

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const POOLS_ROLLUP_KEY = "audience_pools";

export const POOLS_DEFINITION =
  "eligible = not archived and not opted out; received = at least one sent message of this offer; rested = the contact's last sent message of ANY offer was at least rest_days before computed_at, or never messaged; human click = a counted human clicker on this offer; converted = a tracker conversion on this offer's messages";

export interface PoolsSnapshot {
  version: 1;
  /** Active contact groups at compute time; a group with no eligible contact reports zeros. */
  groups: { id: number; name: string }[];
  /** Eligible contacts per rest bucket, per group id and "total". */
  base: HistogramsByGroup;
  /** Per offer id — only offers with at least one sent message. */
  offers: Record<string, OfferHistograms>;
}

interface AggRow {
  kind: "base" | "offer" | "snapshot";
  offer_id: number | null;
  group_id: number | null;
  bucket: number | null;
  n: number;
  not_clicked: number;
  non_buyers: number;
  snapshot_at: string | null;
}

const emptyHistogram = () => Array.from({ length: REST_BUCKETS }, () => 0);

function addTo(map: HistogramsByGroup, key: string, bucket: number, n: number) {
  (map[key] ??= emptyHistogram())[bucket] += n;
}

/**
 * Compute the pool histograms for one org. Read-only. Takes a db handle so the
 * verification can run it inside a REPEATABLE READ transaction next to an
 * independent recount.
 *
 * ⚠️ `MATERIALIZED` is load-bearing: `last_pair`, `eligible`, `memb` and
 * `offer_rows` are each read by two branches, and inlined the planner would
 * repeat the stage_sends scan per branch.
 */
export async function computeAudiencePools(
  dbc: DbOrTx,
  orgId: string,
): Promise<{ snapshot: PoolsSnapshot; snapshotAt: string }> {
  const groups = (await dbc.execute(sql`
    SELECT id, name FROM contact_groups
    WHERE org_id = ${orgId}::uuid AND status = 'active'
    ORDER BY name
  `)) as unknown as { id: number; name: string }[];

  const rows = (await dbc.execute(sql`
    WITH last_pair AS MATERIALIZED (
      SELECT ss.contact_id, c.offer_id, max(ss.sent_at) AS last_sent,
             bool_or(ss.converted_at IS NOT NULL) AS converted
      FROM stage_sends ss
      JOIN campaigns c ON c.id = ss.campaign_id
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
      GROUP BY 1, 2
    ),
    last_any AS MATERIALIZED (
      SELECT contact_id, max(last_sent) AS last_sent FROM last_pair GROUP BY 1
    ),
    clicked AS MATERIALIZED (
      SELECT DISTINCT cc.contact_id, c.offer_id
      FROM counted_clickers cc
      JOIN campaigns c ON c.id = cc.campaign_id
      WHERE cc.org_id = ${orgId}::uuid
    ),
    eligible AS MATERIALIZED (
      SELECT ct.id,
             -- least() ignores NULL, so a never-messaged contact lands in 31.
             least(31, floor(extract(epoch FROM (now() - la.last_sent)) / 86400))::int AS bucket
      FROM contacts ct
      LEFT JOIN last_any la ON la.contact_id = ct.id
      WHERE ct.org_id = ${orgId}::uuid
        AND ct.is_archived = false
        AND NOT EXISTS (
          SELECT 1 FROM opt_outs o
          WHERE o.org_id = ${orgId}::uuid AND o.contact_id = ct.id
        )
    ),
    memb AS MATERIALIZED (
      SELECT e.id, e.bucket, j.contact_group_id AS group_id
      FROM eligible e
      JOIN contact_contact_groups j ON j.contact_id = e.id
      JOIN contact_groups g ON g.id = j.contact_group_id
        AND g.org_id = ${orgId}::uuid AND g.status = 'active'
    ),
    offer_rows AS MATERIALIZED (
      SELECT lp.offer_id, lp.contact_id, lp.converted,
             (ck.contact_id IS NOT NULL) AS clicked
      FROM last_pair lp
      LEFT JOIN clicked ck ON ck.contact_id = lp.contact_id AND ck.offer_id = lp.offer_id
      WHERE lp.offer_id IS NOT NULL
    )
    SELECT 'base' AS kind, NULL::int AS offer_id, group_id, bucket,
           count(*)::int AS n, 0 AS not_clicked, 0 AS non_buyers, NULL::text AS snapshot_at
    FROM memb GROUP BY group_id, bucket
    UNION ALL
    SELECT 'base', NULL, NULL, bucket, count(*)::int, 0, 0, NULL
    FROM eligible GROUP BY bucket
    UNION ALL
    SELECT 'offer', o.offer_id, m.group_id, m.bucket, count(*)::int,
           (count(*) FILTER (WHERE NOT o.clicked AND NOT o.converted))::int,
           (count(*) FILTER (WHERE o.clicked AND NOT o.converted))::int,
           NULL
    FROM offer_rows o JOIN memb m ON m.id = o.contact_id
    GROUP BY o.offer_id, m.group_id, m.bucket
    UNION ALL
    SELECT 'offer', o.offer_id, NULL, e.bucket, count(*)::int,
           (count(*) FILTER (WHERE NOT o.clicked AND NOT o.converted))::int,
           (count(*) FILTER (WHERE o.clicked AND NOT o.converted))::int,
           NULL
    FROM offer_rows o JOIN eligible e ON e.id = o.contact_id
    GROUP BY o.offer_id, e.bucket
    UNION ALL
    SELECT 'snapshot', NULL, NULL, NULL, 0, 0, 0,
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  `)) as unknown as AggRow[];

  const snapshot: PoolsSnapshot = {
    version: 1,
    groups: groups.map((g) => ({ id: Number(g.id), name: g.name })),
    base: {},
    offers: {},
  };
  let snapshotAt: string | null = null;
  for (const r of rows) {
    if (r.kind === "snapshot") {
      snapshotAt = r.snapshot_at;
      continue;
    }
    const key = r.group_id == null ? "total" : String(r.group_id);
    const bucket = Number(r.bucket);
    if (r.kind === "base") {
      addTo(snapshot.base, key, bucket, Number(r.n));
      continue;
    }
    const offer = (snapshot.offers[String(r.offer_id)] ??= {
      received: {},
      received_not_clicked: {},
      clickers_non_buyers: {},
    });
    addTo(offer.received, key, bucket, Number(r.n));
    addTo(offer.received_not_clicked, key, bucket, Number(r.not_clicked));
    addTo(offer.clickers_non_buyers, key, bucket, Number(r.non_buyers));
  }
  if (!snapshotAt) throw new Error("audience pools: the snapshot row is missing");
  return { snapshot, snapshotAt };
}

/** Recompute and store the rollup for one org. */
export async function refreshAudiencePools(orgId: string): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  const { snapshot, snapshotAt } = await computeAudiencePools(db, orgId);
  const durationMs = Date.now() - startedAt;

  await db.execute(sql`
    INSERT INTO operator_rollups (org_id, rollup_key, data, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${POOLS_ROLLUP_KEY}, ${JSON.stringify(snapshot)}::jsonb,
            ${snapshotAt}::timestamptz, ${durationMs}, now())
    ON CONFLICT (org_id, rollup_key) DO UPDATE
      SET data = EXCLUDED.data,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = now()
  `);
  return { durationMs };
}

export interface AudiencePoolRow extends PoolCounts {
  group_name: string;
}

export interface AudiencePools {
  offer_id: number;
  offer_name: string;
  rest_days: number;
  data: AudiencePoolRow[];
  totals: PoolCounts;
  computed_at: string;
  stale_seconds: number;
  definition: string;
}

export type AudiencePoolsResult =
  | { status: "ok"; pools: AudiencePools }
  | { status: "offer_not_found" }
  | { status: "rollup_not_ready" }
  | { status: "offer_not_in_rollup_yet" };

/** Read one offer's pools from the stored rollup. */
export async function readAudiencePools(
  orgId: string,
  offerId: number,
  restDays: number,
): Promise<AudiencePoolsResult> {
  const offer = (await db.execute(sql`
    SELECT id, name FROM offers WHERE org_id = ${orgId}::uuid AND id = ${offerId}
  `)) as unknown as { id: number; name: string }[];
  if (!offer[0]) return { status: "offer_not_found" };

  // Only the requested offer's histograms leave the database.
  const stored = (await db.execute(sql`
    SELECT data->'groups' AS groups,
           data->'base' AS base,
           data->'offers'->${String(offerId)}::text AS offer,
           to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at
    FROM operator_rollups
    WHERE org_id = ${orgId}::uuid AND rollup_key = ${POOLS_ROLLUP_KEY}
      AND data IS NOT NULL AND computed_at IS NOT NULL
  `)) as unknown as {
    groups: PoolsSnapshot["groups"];
    base: HistogramsByGroup;
    offer: OfferHistograms | null;
    computed_at: string;
  }[];
  const row = stored[0];
  if (!row) return { status: "rollup_not_ready" };

  if (row.offer == null) {
    // Absent from the snapshot. Exact when the offer has never sent (every
    // received set is empty); otherwise its first send came after the snapshot.
    const sent = (await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM stage_sends ss
        JOIN campaigns c ON c.id = ss.campaign_id
        WHERE ss.org_id = ${orgId}::uuid AND c.org_id = ${orgId}::uuid
          AND c.offer_id = ${offerId} AND ss.status = 'sent'
      ) AS sent
    `)) as unknown as { sent: boolean }[];
    if (sent[0]?.sent) return { status: "offer_not_in_rollup_yet" };
  }

  const offerHistograms = row.offer ?? undefined;
  const data = row.groups
    .map((g) => ({
      group_name: g.name,
      ...poolCounts(row.base, offerHistograms, String(g.id), restDays),
    }))
    .sort(
      (a, b) =>
        b.group_total_eligible - a.group_total_eligible || a.group_name.localeCompare(b.group_name),
    );

  return {
    status: "ok",
    pools: {
      offer_id: Number(offer[0].id),
      offer_name: offer[0].name,
      rest_days: restDays,
      data,
      totals: poolCounts(row.base, offerHistograms, "total", restDays),
      computed_at: row.computed_at,
      stale_seconds: Math.max(0, Math.round((Date.now() - Date.parse(row.computed_at)) / 1000)),
      definition: POOLS_DEFINITION,
    },
  };
}
