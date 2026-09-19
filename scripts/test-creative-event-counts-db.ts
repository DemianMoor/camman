import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { computeCreativeMetrics, type CreativeMetricsRow } from "@/lib/creatives/metrics-cache";

// Phase 5 Task 7: /creatives gains one per-event COUNT column per event type,
// immediately right of "Checkout Rate" — the column whose numerator is
// keitaro_type = 'lead', which is a free registration on one of this account's
// networks and a paid purchase on two others, on a table creatives are RANKED by.
//
// PREVIEW DB ONLY, inside a transaction that ALWAYS rolls back:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-creative-event-counts-db.ts
//
// ── WHY THIS IS A NEW FILE AND NOT MORE BARS IN test-creatives-list-metrics.ts ─
// ⭐ The Phase 5 plan said that script "already exercises computeCreativeMetrics".
// IT DOES NOT. It signs in through Supabase with .env.local — PRODUCTION — and
// fetches a RUNNING DEV SERVER over HTTP (scripts/test-creatives-list-metrics.ts
// :1-3, :56-84). Bolting these bars onto it would have pointed the fixtures at
// production and, worse, tested nothing: the aggregate under test is behind a
// 15-minute in-memory cache, so the response it reads can predate the query by a
// quarter of an hour. This file follows the execution model every OTHER Phase 5
// DB bar uses (scripts/test-stage-event-columns-db.ts, test-event-columns-db.ts):
// the preview allowlist, real fixtures, one rolled-back transaction, and
// computeCreativeMetrics() called DIRECTLY — with the transaction handed to it,
// which is why it now takes a connection.
//
// ── WHY THE FIXTURE IS ONE-SIDED ────────────────────────────────────────────
// No bar below expects a 0 that today's database would hand it for free. Every
// expected zero belongs to a creative that shares this fixture with creatives
// carrying real numbers, and every expected number is a sum of at least two rows
// so that "it read one row and stopped" fails.

/** The org the fixtures hang off. Real, pre-existing, and named here so the query stays org-scoped. */
const ORG_ID = "ad37fb88-497f-4cd1-89d1-bd3dfec1ddbc"; // CamMan Demo (preview)
/** Every fixture row carries this in its tracking id. Nothing else writes it; the rollback bar counts it. */
const PROBE = "p5-task7-creative-events";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}

type Exec = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The four-field tally the stage-day column stores. /creatives reads only `n` from it. */
const tally = (n: number) => ({ n, pending_n: 0, revenue: 0, pending_revenue: 0 });

async function insertCreative(tx: Exec, text: string): Promise<number> {
  const rows = (await tx.execute(sql`
    INSERT INTO creatives (org_id, slug, text, status)
    VALUES (${ORG_ID}::uuid, ${`${PROBE}-${text}`}, ${`fixture ${text}`}, ${"active"})
    RETURNING id
  `)) as unknown as { id: number }[];
  return Number(rows[0].id);
}

async function insertStage(
  tx: Exec,
  args: {
    campaignId: number;
    creativeId: number;
    stageNumber: number;
    ageDays: number;
    checkouts: number;
    manualSales: number;
  },
): Promise<number> {
  const rows = (await tx.execute(sql`
    INSERT INTO campaign_stages
      (org_id, campaign_id, stage_number, creative_id, created_at,
       checkout_click_count, sales_count)
    VALUES
      (${ORG_ID}::uuid, ${args.campaignId}, ${args.stageNumber}, ${args.creativeId},
       now() - (${args.ageDays} || ' days')::interval,
       ${args.checkouts}, ${args.manualSales})
    RETURNING id
  `)) as unknown as { id: number }[];
  return Number(rows[0].id);
}

async function insertResult(
  tx: Exec,
  args: {
    campaignId: number;
    stageId: number;
    dayOffset: number;
    sales: number;
    revenue: number;
    unmapped: number;
    events: Record<string, ReturnType<typeof tally>>;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO keitaro_stage_results
      (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
       sales, revenue, unmapped_conversions, events)
    VALUES
      (${ORG_ID}::uuid, ${args.campaignId}, ${args.stageId},
       ${`${PROBE}-s${args.stageId}`},
       current_date - (${args.dayOffset} || ' days')::interval,
       ${args.sales}, ${String(args.revenue)}, ${args.unmapped},
       ${JSON.stringify(args.events)}::jsonb)
  `);
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  try {
    // ⭐ A DELTA, TAKEN OUTSIDE THE TRANSACTION. "no row carries this tracking
    // id" is the WORLD's state, not this probe's effect — it would keep passing
    // the day a committed probe left one behind.
    const probeRows = async () =>
      Number(
        (
          (await db.execute(sql`
            SELECT count(*)::int AS n FROM keitaro_stage_results
             WHERE stage_tracking_id LIKE ${`${PROBE}%`}
          `)) as unknown as { n: number }[]
        )[0]?.n ?? -1,
      );
    const probeBefore = await probeRows();

    let rolledBack = false;
    try {
      await db.transaction(async (tx) => {
        const camp = (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name)
          VALUES (${ORG_ID}::uuid, ${`${PROBE}-campaign`}, ${"P5 task 7 fixture"})
          RETURNING id
        `)) as unknown as { id: number }[];
        const campaignId = Number(camp[0].id);

        // ── CR_A: counts that have to be SUMMED — across two stage-days of one
        // stage, and across two stages — plus a THIRD stage 40 days old whose
        // conversions must not appear anywhere.
        const crA = await insertCreative(tx, "a-summed");
        const s1 = await insertStage(tx, {
          campaignId, creativeId: crA, stageNumber: 1, ageDays: 2, checkouts: 5, manualSales: 3,
        });
        await insertResult(tx, {
          campaignId, stageId: s1, dayOffset: 0, sales: 1, revenue: 30, unmapped: 2,
          events: { registration: tally(4), purchase: tally(1) },
        });
        await insertResult(tx, {
          campaignId, stageId: s1, dayOffset: 1, sales: 0, revenue: 12, unmapped: 0,
          events: { registration: tally(2) },
        });
        const s2 = await insertStage(tx, {
          campaignId, creativeId: crA, stageNumber: 2, ageDays: 10, checkouts: 4, manualSales: 0,
        });
        await insertResult(tx, {
          campaignId, stageId: s2, dayOffset: 0, sales: 2, revenue: 0, unmapped: 0,
          // ⭐ `deposit` is in NO event_types row on this database. The rollup
          // must not know any key by name.
          events: { registration: tally(1), deposit: tally(2) },
        });
        const s3old = await insertStage(tx, {
          campaignId, creativeId: crA, stageNumber: 3, ageDays: 40, checkouts: 100, manualSales: 50,
        });
        await insertResult(tx, {
          campaignId, stageId: s3old, dayOffset: 0, sales: 40, revenue: 999, unmapped: 9,
          events: { registration: tally(4) },
        });

        // ── CR_B: real conversions, EMPTY breakdown. Its row has to survive.
        const crB = await insertCreative(tx, "b-empty-breakdown");
        const s4 = await insertStage(tx, {
          campaignId, creativeId: crB, stageNumber: 4, ageDays: 3, checkouts: 7, manualSales: 0,
        });
        await insertResult(tx, {
          campaignId, stageId: s4, dayOffset: 0, sales: 3, revenue: 15, unmapped: 0, events: {},
        });

        // ── CR_C: activity, but ALL of it older than 30 days. The row is driven
        // by the LIFETIME aggregates, so it keeps its all-time columns while
        // every 30-day figure — the new counts included — reads zero.
        const crC = await insertCreative(tx, "c-idle-30-days");
        const s5 = await insertStage(tx, {
          campaignId, creativeId: crC, stageNumber: 5, ageDays: 45, checkouts: 11, manualSales: 0,
        });
        await insertResult(tx, {
          campaignId, stageId: s5, dayOffset: 0, sales: 6, revenue: 20, unmapped: 0,
          events: { registration: tally(6) },
        });

        // ── THE READER UNDER TEST, on this transaction's connection ───────────
        const rows = await computeCreativeMetrics(ORG_ID, tx);
        const byId = new Map<number, CreativeMetricsRow>(rows.map((r) => [r.creative_id, r]));
        const a = byId.get(crA);
        const b = byId.get(crB);
        const c = byId.get(crC);
        console.log(`  rows: ${rows.length} for the org`);
        console.log(`  A: ${JSON.stringify(a)}`);
        console.log(`  B: ${JSON.stringify(b)}`);
        console.log(`  C: ${JSON.stringify(c)}\n`);

        check(
          "C1 ⭐ a creative's per-event count sums across its stage-days AND its stages (4 + 2 + 1)",
          a?.events.registration === 7,
          JSON.stringify(a?.events),
        );
        check(
          "C2 ⭐ a creative with conversions but an EMPTY breakdown keeps its row and reads {} — an inner join would lose it",
          b !== undefined && Object.keys(b.events).length === 0 && b.sales === 3,
          `row=${b !== undefined} events=${JSON.stringify(b?.events)} sales=${b?.sales}`,
        );
        check(
          "C3 ⭐ the counts honour the SAME 30-day window as Checkout Rate — the 40-day-old stage's 4 registrations are excluded (7, not 11), exactly as its 100 checkouts are (9, not 109)",
          a?.events.registration === 7 && a?.checkouts === 9,
          `registrations=${a?.events.registration} (40d-old stage holds 4) checkouts=${a?.checkouts} (40d-old stage holds 100)`,
        );
        check(
          "C4 ⭐ a THIRD event type appears with no code change — `deposit` is in NO event_types row on this database",
          a?.events.deposit === 2,
          JSON.stringify(a?.events),
        );
        check(
          "C5 ⭐ the existing checkouts / sales / payout figures are UNCHANGED by this task — a fan-out through the new join would multiply them",
          a?.checkouts === 9 && a?.sales === 5 && Number(a?.payout) === 42,
          `checkouts=${a?.checkouts} (want 9) sales=${a?.sales} (want 5) payout=${a?.payout} (want 42)`,
        );
        check(
          "C6 ⭐ the residual travels WITH the counts and shares their window — 2 in-window strays, not the 11 that include the 40-day-old stage's 9",
          a?.unmapped === 2 && b?.unmapped === 0,
          `A=${a?.unmapped} (want 2) B=${b?.unmapped} (want 0)`,
        );
        check(
          "C7 ⭐ a creative idle 30+ days keeps its row and its LIFETIME columns, and its 30-day event counts read {} — the two windows do not fight",
          c !== undefined &&
            c.lifetime_sales === 6 &&
            Number(c.lifetime_payout) === 20 &&
            c.checkouts === 0 &&
            Object.keys(c.events).length === 0,
          `row=${c !== undefined} lifetime_sales=${c?.lifetime_sales} lifetime_payout=${c?.lifetime_payout} checkouts=${c?.checkouts} events=${JSON.stringify(c?.events)}`,
        );
        // ⭐ EVERY ROW OWNS ITS MAP. The zero row used to be a module-level
        // constant spread into every creative; with an object on it, one
        // consumer's mutation would silently have become everyone's.
        const maps = rows.map((r) => r.events);
        check(
          `C8 ⭐ no two creatives share one events object — the zero row is built fresh, never a shared constant (${rows.length} rows)`,
          rows.length >= 3 && new Set(maps).size === rows.length,
          `${rows.length} rows, ${new Set(maps).size} distinct objects`,
        );

        // ── ⭐ ONE MALFORMED ROW MUST NOT TAKE THE WHOLE ORG'S NUMBERS WITH IT ─
        //
        // jsonb_each RAISES 22023 on a jsonb scalar or array, and the error is
        // not scoped to the row: it kills the statement, so every creative on
        // the page reads nothing. `events` is `jsonb NOT NULL DEFAULT '{}'` with
        // NO CHECK constraint (0185) — object-ness is a convention of the
        // writer, not a guarantee of the database. Measured, not imagined: a
        // hand-written fixture stored a JSON STRING and the creatives list
        // 22023'd on the spot.
        //
        // Inserted LAST and asserted with its own call, so the bars above are
        // evaluated against a clean fixture and this one tests exactly the
        // malformed case. One-sided: the well-formed counts must still be right
        // WITH the bad row present, so "it survived by returning nothing" fails.
        const sBad = await insertStage(tx, {
          campaignId, creativeId: crB, stageNumber: 6, ageDays: 1, checkouts: 0, manualSales: 0,
        });
        await tx.execute(sql`
          INSERT INTO keitaro_stage_results
            (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
             sales, revenue, unmapped_conversions, events)
          VALUES
            (${ORG_ID}::uuid, ${campaignId}, ${sBad}, ${`${PROBE}-bad`}, current_date,
             0, ${"0"}, 0, ${'"not an object"'}::jsonb)
        `);
        let after: CreativeMetricsRow[] | null = null;
        let raised = "";
        try {
          after = await computeCreativeMetrics(ORG_ID, tx);
        } catch (e) {
          raised = (e as { cause?: { code?: string } })?.cause?.code ?? String(e);
        }
        const aAfter = after?.find((r) => r.creative_id === crA);
        check(
          "C11 ⭐ a stage-day row whose events is NOT an object is ignored, not fatal — jsonb_each raises 22023 statement-wide, which would blank every number on the page",
          raised === "" && aAfter?.events.registration === 7 && aAfter?.events.deposit === 2,
          raised !== ""
            ? `query raised ${raised}`
            : `registration=${aAfter?.events.registration} deposit=${aAfter?.events.deposit}`,
        );

        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) rolledBack = true;
      else throw e;
    }
    check("C9 the fixture transaction rolled back", rolledBack);
    const probeAfter = await probeRows();
    check(
      "C10 ⭐ and the DB agrees: the probe-row count OUTSIDE the tx is exactly what it was before",
      probeBefore >= 0 && probeAfter === probeBefore,
      `probe rows before=${probeBefore} after=${probeAfter}`,
    );

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    // ALWAYS, not on the success path: the red runs this script is designed to
    // take throw out of db.transaction(), and closing the pool only after the
    // bars would hang the process exactly when it is least convenient.
    await pgConn.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
