// Proves the delivery query's received_at bound changes NO number.
//
// lib/reporting/delivery.ts bounds every DLR source by
// `received_at >= window start − DLR_EARLY_ARRIVAL_MARGIN` instead of
// aggregating the whole receipt history (2026-09-22). That is only safe while no
// receipt is written more than the margin BEFORE its send's sent_at — true when
// measured (worst: tls −14.3 s), but it is a property of provider behaviour, not
// of the code. This script checks it the only way that cannot be fooled: it runs
// the UNBOUNDED reference and the live query over the same windows, inside ONE
// REPEATABLE READ snapshot (receipts arrive continuously; two separate reads
// would differ for reasons that have nothing to do with the bound), and diffs
// every (stage, phone) row.
//
// ⚠️ It PRINTS ITS INPUT SCOPE, and a window with zero rows is a FAILURE, not a
// pass — a diff of two empty sets proves nothing.
//
// Read-only. Run: npx tsx scripts/verify-delivery-received-bound.ts
// Slow by design: the reference is the old full-history aggregation (~10–30 s
// per window on prod).

import "./_env-preload";

import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  DLR_SOURCES,
  queryDeliveryByStage,
  type DbOrTx,
  type DeliveryQueryBounds,
  type DeliveryStageRow,
} from "@/lib/reporting/delivery";

// The shape the live query had before the bound: same sends CTE, same
// per-source fold, same final aggregate — only the received_at predicate is
// absent. Built from DLR_SOURCES so a new source is covered automatically.
async function unboundedReference(
  dbc: DbOrTx,
  orgId: string,
  b: DeliveryQueryBounds,
): Promise<DeliveryStageRow[]> {
  const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;
  const terminal = sql.join(
    Object.values(DLR_SOURCES).map(
      (s) => sql`
        SELECT ${sql.raw(s.key)} AS ss_id,
               bool_or(lower(status) = 'delivered')   AS d,
               bool_or(lower(status) = 'undelivered') AS u
        FROM ${sql.raw(s.table)}
        WHERE lower(status) IN ('delivered', 'undelivered')
          AND ${sql.raw(s.key)} IS NOT NULL
          ${s.filter ? sql`AND ${sql.raw(s.filter)}` : sql``}
        GROUP BY 1`,
    ),
    sql` UNION ALL `,
  );
  const rows = (await dbc.execute(sql`
    WITH sends AS (
      SELECT id, stage_id, provider_phone_id
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid
        AND status = 'sent'
        AND sent_at >= ${ts(b.fromUtc)} AND sent_at < ${ts(b.toExclusiveUtc)}
        ${b.maturedBefore ? sql`AND sent_at < ${ts(b.maturedBefore)}` : sql``}
        ${b.stageIds ? sql`AND stage_id IN (${sql.join(b.stageIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
    ),
    terminal AS (${terminal})
    SELECT s.stage_id, s.provider_phone_id,
           count(*)::int                                                 AS sent,
           count(*) FILTER (WHERE t.d)::int                              AS delivered,
           count(*) FILTER (WHERE t.u AND NOT COALESCE(t.d, false))::int AS undelivered,
           count(*) FILTER (WHERE NOT COALESCE(t.d OR t.u, false))::int  AS no_receipt
    FROM sends s
    LEFT JOIN terminal t ON t.ss_id = s.id
    GROUP BY 1, 2
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    stage_id: Number(r.stage_id),
    provider_phone_id: r.provider_phone_id == null ? null : Number(r.provider_phone_id),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    undelivered: Number(r.undelivered),
    no_receipt: Number(r.no_receipt),
  }));
}

const canonical = (rows: DeliveryStageRow[]) =>
  JSON.stringify(
    [...rows].sort(
      (a, b) => a.stage_id - b.stage_id || (a.provider_phone_id ?? -1) - (b.provider_phone_id ?? -1),
    ),
  );

function etDays(fromDay: string, toDayInclusive: string): DeliveryQueryBounds {
  const next = new Date(Date.parse(`${toDayInclusive}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    fromUtc: fromZonedTime(`${fromDay}T00:00:00`, CAMPAIGN_TIMEZONE),
    toExclusiveUtc: fromZonedTime(`${next}T00:00:00`, CAMPAIGN_TIMEZONE),
  };
}

const dayBefore = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const [{ id: orgId, name }] = (await db.execute(sql`
    SELECT id, name FROM organizations ORDER BY created_at LIMIT 1
  `)) as unknown as { id: string; name: string }[];

  const yesterday = dayBefore(formatInCampaignTimezone(new Date(), "yyyy-MM-dd"), 1);
  const now = new Date();
  const windows: { label: string; b: DeliveryQueryBounds }[] = [
    { label: `1d   ${yesterday}`, b: etDays(yesterday, yesterday) },
    { label: `7d   ${dayBefore(yesterday, 6)}..${yesterday}`, b: etDays(dayBefore(yesterday, 6), yesterday) },
    { label: `14d  ${dayBefore(yesterday, 13)}..${yesterday}`, b: etDays(dayBefore(yesterday, 13), yesterday) },
    // The only stretch with all three DLR sources live at once (tls ran 08-13..21,
    // ahi from 08-20). The recent windows are txr-only, so without this one the
    // tls/ahi branches of the bound would go unexercised.
    { label: "7d   2026-08-15..2026-08-21 (tls+ahi+txr)", b: etDays("2026-08-15", "2026-08-21") },
  ];

  console.log("=".repeat(78));
  console.log("INPUT SCOPE");
  console.log("=".repeat(78));
  console.log(`org          ${name} (${orgId})`);
  console.log(`DLR sources  ${Object.entries(DLR_SOURCES).map(([k, s]) => `${k}=${s.table}`).join(", ")}`);
  console.log(`snapshot     one REPEATABLE READ READ ONLY transaction, opened ${now.toISOString()}`);

  let failed = 0;
  await db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '900s'`);

      // Tripwire-shaped call: rolling hours, matured, restricted to stage ids —
      // the lib/sends/tells-monitors.ts path. Stage ids are whatever sent in the
      // last 24h, so the stageIds branch is exercised on real rows.
      const since = new Date(now.getTime() - 24 * 3_600_000);
      const recentStages = (await tx.execute(sql`
        SELECT DISTINCT stage_id FROM stage_sends
        WHERE org_id = ${orgId}::uuid AND status = 'sent'
          AND sent_at >= ${since.toISOString()}::timestamptz
      `)) as unknown as { stage_id: number }[];
      if (recentStages.length === 0) {
        failed++;
        console.log("\n✗ tripwire shape: no stage sent in the last 24h — stageIds branch NOT exercised");
      } else windows.push({
        label: `24h rolling, matured 10 min, ${recentStages.length} stage ids (tripwire shape)`,
        b: {
          fromUtc: since,
          toExclusiveUtc: now,
          maturedBefore: new Date(now.getTime() - 10 * 60_000),
          stageIds: recentStages.map((r) => Number(r.stage_id)),
        },
      });

      for (const w of windows) {
        let t = Date.now();
        const ref = await unboundedReference(tx, orgId, w.b);
        const refMs = Date.now() - t;
        t = Date.now();
        const live = await queryDeliveryByStage(tx, orgId, w.b);
        const liveMs = Date.now() - t;

        const sum = (rows: DeliveryStageRow[], k: keyof DeliveryStageRow) =>
          rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
        const identical = canonical(ref) === canonical(live);
        const empty = ref.length === 0;
        if (!identical || empty) failed++;
        console.log(`\n${identical && !empty ? "✓" : "✗"} ${w.label}`);
        console.log(
          `    rows ${ref.length} vs ${live.length} | sent ${sum(ref, "sent")} | delivered ${sum(ref, "delivered")} vs ${sum(live, "delivered")}` +
            ` | undelivered ${sum(ref, "undelivered")} vs ${sum(live, "undelivered")} | no_receipt ${sum(ref, "no_receipt")} vs ${sum(live, "no_receipt")}`,
        );
        console.log(`    unbounded ${refMs} ms, bounded ${liveMs} ms (same snapshot, informational)`);
        if (empty) console.log("    ⚠️  ZERO rows in scope — this window proves nothing.");
        if (!identical) {
          const liveByKey = new Map(live.map((r) => [`${r.stage_id}|${r.provider_phone_id}`, JSON.stringify(r)]));
          const diffs = ref.filter((r) => liveByKey.get(`${r.stage_id}|${r.provider_phone_id}`) !== JSON.stringify(r));
          console.log(`    first differing rows (unbounded): ${JSON.stringify(diffs.slice(0, 3))}`);
        }
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  console.log(`\n${failed === 0 ? "✓ bounded == unbounded on every window" : `✗ ${failed} window(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
