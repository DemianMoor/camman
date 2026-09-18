import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { parseEventMap } from "@/lib/reporting/event-columns";

// Migration 0185: keitaro_stage_results gains `events jsonb` (the per-event-type
// breakdown, keyed by event_types.key) and `unmapped_conversions int`.
//
// PREVIEW DB ONLY, inside a transaction that ALWAYS rolls back:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-stage-event-columns-db.ts
//
// The refusal is the `_require-preview-db` import above — an ALLOWLIST, and early
// enough that nothing can query ahead of it. Deliberately NOT a hand-copied
// `if (DATABASE_URL.includes(<prod ref>))` test: that is a denylist, it passes
// every target nobody thought of, and scripts/test-preview-db-guard.ts rejects a
// re-copied project-ref literal outside the helper for exactly that reason.
//
// ⭐ S13–S15 ARE THE POINT OF THIS SUITE, not S1–S7. The catalog bars say the
// column is there; the round-trip bars say what comes BACK through it — the thing
// parseEventMap() (lib/reporting/event-columns.ts) had to be written against
// before the column existed. They pin the measured fact: postgres-js JSON.parses
// a jsonb column, so an int and a numeric(12,4) INSIDE jsonb_build_object both
// arrive as JS NUMBERS, exact at both ends of the scale — while a TOP-LEVEL
// numeric column on the SAME ROW arrives as a STRING. Both of the parser's
// branches are live, and that is now measured against the real column instead of
// asserted against a hand-built object.

/** 1234567.8901 — 7 integer digits + 4 decimals, near the widest numeric(12,4) holds. */
const BIG_MONEY = 1234567.8901;
/** 0.0001 — one unit in the last place. A cent silently rounded away is the failure mode. */
const SMALL_MONEY = 0.0001;
/** The probe row's stage_tracking_id. Nothing else writes it; S17 counts it outside the transaction. */
const PROBE_TRACKING_ID = "p5-task2-events-probe";
/** The migration under test, read off disk and replayed by S8 so the bar tests the FILE, not a copy of it. */
const MIGRATION_FILE = "db/migrations/0185_stage_event_breakdown.sql";
/** S8/S8b's fixture table. Created and dropped with the transaction; nothing outside it ever sees it. */
const PROBE_TABLE = "p5_task2_pre_0185_probe";

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

interface CatalogRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

const show = (v: unknown) => `${typeof v}:${String(v)}`;

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  try {
    // ⭐ TAKEN BEFORE THE PROBE AND OUTSIDE ITS TRANSACTION. S17 asks whether the
    // probe row survived, and the only honest form of that question is a DELTA.
    // "no row carries this tracking id" is the WORLD's state, not this probe's
    // effect: it would keep passing the day a committed probe left one behind.
    const probeRows = async () =>
      Number(
        (
          (await db.execute(sql`
            SELECT count(*)::int AS n FROM keitaro_stage_results
            WHERE stage_tracking_id = ${PROBE_TRACKING_ID}
          `)) as unknown as { n: number }[]
        )[0]?.n ?? -1,
      );
    const probeBefore = await probeRows();

    let rolledBack = false;
    try {
      await db.transaction(async (tx) => {
        // ── the catalog, printed verbatim: the evidence behind S1–S7 ──────────
        const cols = (await tx.execute(sql`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'keitaro_stage_results'
            AND column_name IN ('events', 'unmapped_conversions')
          ORDER BY column_name
        `)) as unknown as CatalogRow[];
        console.log(`  catalog: ${JSON.stringify(cols)}\n`);
        const byName = new Map(cols.map((c) => [c.column_name, c]));

        const ev = byName.get("events");
        check("S1 ⭐ keitaro_stage_results.events exists", !!ev, JSON.stringify(cols));
        check("S2 events is jsonb", ev?.data_type === "jsonb", ev?.data_type ?? "-");
        check("S3 ⭐ events is NOT NULL", ev?.is_nullable === "NO", ev?.is_nullable ?? "-");
        check(
          "S4 ⭐ events defaults to an empty object, not NULL",
          (ev?.column_default ?? "").includes("'{}'"),
          ev?.column_default ?? "-",
        );

        const um = byName.get("unmapped_conversions");
        check("S5 ⭐ keitaro_stage_results.unmapped_conversions exists", !!um, JSON.stringify(cols));
        check("S6 unmapped_conversions is an integer", um?.data_type === "integer", um?.data_type ?? "-");
        check(
          "S7 ⭐ unmapped_conversions is NOT NULL DEFAULT 0",
          um?.is_nullable === "NO" && (um?.column_default ?? "").startsWith("0"),
          `${um?.is_nullable}/${um?.column_default}`,
        );

        // ── the promise about ROWS THAT ALREADY EXISTED ──────────────────────
        // A row written before the ALTER must read '{}' / 0, not NULL: every
        // reader treats both columns as always-present.
        //
        // ⭐ IT IS ASSERTED AGAINST A FIXTURE, NOT AGAINST THIS DATABASE, AND
        // THAT IS THE POINT. The obvious bar — "no row of keitaro_stage_results
        // is NULL in either column" — is VACUOUSLY TRUE here: the preview table
        // holds 0 rows (printed below), so it would print PASS against a
        // migration that forgot the DEFAULT entirely. The fixture builds the one
        // world-state the claim is about — rows that PREDATE the columns — and
        // then replays the migration's OWN statements, read off disk, over them.
        // Re-typing the DDL here would only test the copy.
        const sweep = (await tx.execute(sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE events IS NULL OR unmapped_conversions IS NULL)::int AS nulls
          FROM keitaro_stage_results
        `)) as unknown as { total: number; nulls: number }[];
        console.log(
          `  live keitaro_stage_results: total=${sweep[0]?.total} rows, NULL in either new column=${sweep[0]?.nulls} (context, NOT a bar — see S8)\n`,
        );

        const migrationSql = readFileSync(join(process.cwd(), MIGRATION_FILE), "utf8");
        const statements = migrationSql
          .split("--> statement-breakpoint")
          .map((s) => s.replace(/public\.keitaro_stage_results/g, PROBE_TABLE))
          .filter((s) => s.trim().length > 0);
        // ⚠️ TEMP … ON COMMIT DROP, not a plain table. Measured the hard way:
        // while red-proving S16/S17 (the mutation that lets the probe COMMIT) an
        // ordinary CREATE TABLE committed too and had to be dropped off camman-v2
        // by hand. A temp table with ON COMMIT DROP cannot survive either exit.
        // The migration's statements are rewritten to the unqualified name, so
        // they resolve to the temp schema ahead of public.
        await tx.execute(
          sql.raw(`CREATE TEMP TABLE ${PROBE_TABLE} (id int primary key, note text) ON COMMIT DROP`),
        );
        await tx.execute(sql.raw(`INSERT INTO ${PROBE_TABLE} (id, note) VALUES (1,'a'),(2,'b'),(3,'c')`));
        for (const s of statements) await tx.execute(sql.raw(s));
        const pre = (await tx.execute(sql.raw(`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE events IS NULL OR unmapped_conversions IS NULL)::int AS nulls,
                 count(*) FILTER (WHERE events::text = '{}' AND unmapped_conversions = 0)::int AS defaulted
          FROM ${PROBE_TABLE}
        `))) as unknown as { total: number; nulls: number; defaulted: number }[];
        check(
          `S8 ⭐ the migration's OWN two statements, replayed over 3 rows that PREDATE them, leave every one reading '{}' and 0 — never NULL`,
          statements.length === 2 &&
            migrationSql.includes("public.keitaro_stage_results") &&
            Number(pre[0]?.total) === 3 &&
            Number(pre[0]?.nulls) === 0 &&
            Number(pre[0]?.defaulted) === 3,
          `statements=${statements.length} total=${pre[0]?.total} nulls=${pre[0]?.nulls} defaulted=${pre[0]?.defaulted}`,
        );
        // Re-runnable, so a `when` bump could re-apply it on preview without a
        // second thought: both statements are ADD COLUMN IF NOT EXISTS.
        // ⚠️ INSIDE A SAVEPOINT (a nested drizzle transaction). A statement that
        // errors POISONS its transaction — every later query returns 25P02 — so
        // catching the error without one would turn "0185 is not re-runnable"
        // into a cascade of crashes in the bars below instead of one red line.
        let reapplyError: string | null = null;
        try {
          await tx.transaction(async (tx2) => {
            for (const s of statements) await tx2.execute(sql.raw(s));
          });
        } catch (e) {
          reapplyError = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
        }
        const again = (await tx.execute(sql.raw(`
          SELECT count(*) FILTER (WHERE events::text = '{}' AND unmapped_conversions = 0)::int AS defaulted
          FROM ${PROBE_TABLE}
        `))) as unknown as { defaulted: number }[];
        check(
          "S8b ⭐ and applying the same file a SECOND time raises nothing and changes nothing (re-runnable)",
          reapplyError === null && Number(again[0]?.defaulted) === 3,
          `error=${reapplyError ?? "none"} defaulted=${again[0]?.defaulted}`,
        );

        // A row written WITHOUT naming the columns gets the defaults.
        const stage = (
          (await tx.execute(sql`
            SELECT cs.id, cs.campaign_id, cs.org_id::text AS org_id
            FROM campaign_stages cs ORDER BY cs.id LIMIT 1
          `)) as unknown as { id: number; campaign_id: number; org_id: string }[]
        )[0];
        if (!stage) throw new Error("no campaign_stages row on the preview DB");
        const org = stage.org_id;
        const w = (await tx.execute(sql`
          INSERT INTO keitaro_stage_results (org_id, campaign_id, stage_id, stage_tracking_id, stat_date)
          VALUES (${org}::uuid, ${stage.campaign_id}::int, ${stage.id}::int, ${PROBE_TRACKING_ID}, '1999-01-01'::date)
          RETURNING id, events::text AS events_text, unmapped_conversions AS unmapped
        `)) as unknown as { id: number; events_text: string; unmapped: number }[];
        check(
          "S9 ⭐ a row inserted without naming the columns reads '{}' and 0",
          w[0]?.events_text === "{}" && Number(w[0]?.unmapped) === 0,
          JSON.stringify(w[0]),
        );
        console.log(`  probe row id=${w[0]?.id} org=${org} stage_id=${stage.id}\n`);

        // ── the shape the projection will write, through the REAL column ──────
        // The money is bound as TEXT (`toFixed(4)`) and cast server-side, so the
        // value under test enters Postgres as an exact decimal and any rounding
        // seen on the way back is the round trip's doing, not the bind's.
        const r = (
          (await tx.execute(sql`
            UPDATE keitaro_stage_results
            SET events = jsonb_build_object(
                  'purchase', jsonb_build_object(
                    'n', 2, 'pending_n', 1,
                    'revenue', (${BIG_MONEY.toFixed(4)})::numeric(12,4),
                    'pending_revenue', (${SMALL_MONEY.toFixed(4)})::numeric(12,4)
                  ),
                  'registration', jsonb_build_object(
                    'n', 40, 'pending_n', 0,
                    'revenue', (0)::numeric(12,4),
                    'pending_revenue', (0)::numeric(12,4)
                  )
                ),
                unmapped_conversions = 3,
                pending_revenue = (${BIG_MONEY.toFixed(4)})::numeric(12,4)
            WHERE org_id = ${org}::uuid AND stage_tracking_id = ${PROBE_TRACKING_ID}
            RETURNING events,
                      events::text AS events_text,
                      (events #>> '{purchase,n}') AS n_text,
                      (events #>> '{purchase,revenue}') AS revenue_text,
                      unmapped_conversions AS unmapped,
                      pending_revenue AS top_level_pending_revenue
          `)) as unknown as {
            events: unknown;
            events_text: string;
            n_text: string;
            revenue_text: string;
            unmapped: number;
            top_level_pending_revenue: unknown;
          }[]
        )[0];

        const raw = (r?.events ?? {}) as Record<string, unknown>;
        const purchase = (raw.purchase ?? {}) as Record<string, unknown>;
        const pN: unknown = purchase.n;
        const pPendingN: unknown = purchase.pending_n;
        const pRevenue: unknown = purchase.revenue;
        const pPendingRevenue: unknown = purchase.pending_revenue;
        const topLevel: unknown = r?.top_level_pending_revenue;
        console.log(`  events::text: ${r?.events_text}`);
        console.log(
          `  through the driver: purchase.n=${show(pN)} purchase.revenue=${show(pRevenue)} purchase.pending_revenue=${show(pPendingRevenue)} · top-level pending_revenue=${show(topLevel)}\n`,
        );

        check("S10 the per-event object round-trips a count", r?.n_text === "2", String(r?.n_text));
        check(
          "S11 ⭐ a numeric inside the object keeps all 4 decimals in a text extraction",
          r?.revenue_text === "1234567.8901",
          String(r?.revenue_text),
        );
        check("S12 unmapped_conversions round-trips", Number(r?.unmapped) === 3, String(r?.unmapped));
        check(
          "S13 ⭐ the driver JSON.parses the column: an int inside the object is a JS NUMBER, not a string",
          typeof pN === "number" && pN === 2 && typeof pPendingN === "number" && pPendingN === 1,
          `n=${show(pN)} pending_n=${show(pPendingN)}`,
        );
        check(
          `S14 ⭐ a numeric(12,4) inside the object survives EXACTLY, as a JS number, at both ends of the scale (${BIG_MONEY} / ${SMALL_MONEY})`,
          typeof pRevenue === "number" &&
            pRevenue === BIG_MONEY &&
            typeof pPendingRevenue === "number" &&
            pPendingRevenue === SMALL_MONEY &&
            (r?.events_text ?? "").includes("1234567.8901") &&
            (r?.events_text ?? "").includes("0.0001"),
          `revenue=${show(pRevenue)} pending_revenue=${show(pPendingRevenue)} text=${r?.events_text}`,
        );
        // ⭐ THE RE-ASSERT OF M5 (scripts/test-event-columns.ts) AGAINST THE REAL
        // COLUMN. ONE row exercises BOTH of parseEventMap's branches: the jsonb
        // hands it numbers, and `pending_revenue` — a top-level numeric(12,4) on
        // that same row, holding the same value — hands it a string. Neither
        // branch is dead, and neither is a guess any more.
        const parsed = parseEventMap(r?.events);
        const fromTopLevel =
          typeof topLevel === "string"
            ? parseEventMap({ purchase: { n: 1, pending_n: 0, revenue: topLevel, pending_revenue: 0 } }).purchase
                ?.revenue
            : null;
        check(
          "S15 ⭐ parseEventMap() of the REAL column reproduces the written tally, and takes the top-level numeric's STRING too",
          JSON.stringify(parsed.purchase) ===
            JSON.stringify({ n: 2, pending_n: 1, revenue: BIG_MONEY, pending_revenue: SMALL_MONEY }) &&
            JSON.stringify(parsed.registration) ===
              JSON.stringify({ n: 40, pending_n: 0, revenue: 0, pending_revenue: 0 }) &&
            typeof topLevel === "string" &&
            fromTopLevel === BIG_MONEY,
          `parsed=${JSON.stringify(parsed)} topLevel=${show(topLevel)} fromTopLevel=${String(fromTopLevel)}`,
        );

        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) rolledBack = true;
      else throw e;
    }
    check("S16 the probe transaction rolled back", rolledBack);
    // ⭐ S16 is bookkeeping — it only proves this process threw. S17 asks the
    // DATABASE, outside the transaction, whether the row it inserted survived.
    // Without it a committed probe would leave a fabricated stage-day row on the
    // preview database and every later run would still print PASS.
    const probeAfter = await probeRows();
    check(
      "S17 ⭐ and the DB agrees: the probe-row count OUTSIDE the tx is exactly what it was before",
      probeBefore >= 0 && probeAfter === probeBefore,
      `probe rows before=${probeBefore} after=${probeAfter}`,
    );

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    // ⚠️ ALWAYS, not on the success path. The run this script is DESIGNED to take
    // first is the red one, where the missing column raises 42703 out of
    // db.transaction(); closing the pool only after the bars would leave the
    // process hanging on an open handle exactly when it is least convenient.
    await pgConn.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
