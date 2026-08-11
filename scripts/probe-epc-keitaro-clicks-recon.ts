import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon for the EPC-unification brief §2 Q1: can Keitaro return
// per-click rows carrying the per-recipient id, for LANDING (visit) clicks?
// Read-only API reads + read-only DB reads. Never writes anything.
//
//   K1 does clicks/log return landing (gk-lp-visits) rows, with sub_id_1?
//   K2 which extra columns exist (bot flag? uniqueness flag? sub_id_3?)
//   K3 volume + latency for one day -> cost of an all-time pull
//   K4 THE MERGE TEST: match Keitaro landing clicks to CamMan clicks per
//      recipient and populate the brief's precedence table with real numbers
//
// Run: npx tsx scripts/probe-epc-keitaro-clicks-recon.ts [YYYY-MM-DD]

const DAY = process.argv[2] ?? "2026-08-09";
const BASE = (process.env.KEITARO_API_URL ?? "https://admin.gdkn.org").replace(/\/+$/, "");
const KEY = process.env.KEITARO_API_KEY?.trim() ?? "";
const VISIT_CAMPAIGN = "gk-lp-visits";
const RANGE = { from: `${DAY} 00:00:00`, to: `${DAY} 23:59:59`, timezone: "America/New_York" };

type Row = Record<string, unknown>;

async function clicksLog(columns: string[], filters: unknown[], timeoutMs = 120_000) {
  const started = Date.now();
  const res = await fetch(`${BASE}/admin_api/v1/clicks/log`, {
    method: "POST",
    headers: { "Api-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ range: RANGE, columns, filters }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const ms = Date.now() - started;
  if (!res.ok) return { ok: false as const, status: res.status, ms, bytes: text.length, body: text.slice(0, 400), rows: [] as Row[] };
  let rows: Row[] = [];
  try {
    const j = JSON.parse(text) as { rows?: Row[] };
    rows = Array.isArray(j.rows) ? j.rows : [];
  } catch { /* fall through */ }
  return { ok: true as const, status: res.status, ms, bytes: text.length, body: "", rows };
}

const str = (r: Row, k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : r[k] == null ? "" : String(r[k]));
const isLanding = (r: Row) => str(r, "campaign").toLowerCase() === VISIT_CAMPAIGN;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  if (!KEY) throw new Error("KEITARO_API_KEY is not set");
  console.log(`Keitaro clicks/log recon — day ${DAY} ET, host ${BASE}\n`);

  // ── K1 ─ baseline: the columns the app already uses, NO sub_id_1 filter ────
  const baseCols = ["event_id", "sub_id_1", "campaign", "campaign_id", "datetime", "is_bot", "is_unique_campaign", "sub_id_3"];
  const all = await clicksLog(baseCols, []);
  if (!all.ok) {
    console.log(`K1 FAILED: HTTP ${all.status} — ${all.body}`);
    return;
  }
  const landing = all.rows.filter(isLanding);
  const offer = all.rows.filter((r) => !isLanding(r));
  const withSub = (rows: Row[]) => rows.filter((r) => UUID_RE.test(str(r, "sub_id_1")));
  console.log("=== K1 clicks/log, unfiltered ===");
  console.table([
    { bucket: "ALL rows", rows: all.rows.length, with_valid_sub_id_1: withSub(all.rows).length },
    { bucket: `landing (${VISIT_CAMPAIGN})`, rows: landing.length, with_valid_sub_id_1: withSub(landing).length },
    { bucket: "offer campaigns", rows: offer.length, with_valid_sub_id_1: withSub(offer).length },
  ]);
  const campaignNames = new Map<string, number>();
  for (const r of all.rows) campaignNames.set(str(r, "campaign") || "(blank)", (campaignNames.get(str(r, "campaign") || "(blank)") ?? 0) + 1);
  console.log("campaigns seen:", [...campaignNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
  console.log("sample landing row:", landing[0] ?? "(none)");

  // ── K2 ─ probe extra columns one at a time (endpoint 400s on unknown names) ─
  console.log("\n=== K2 extra column probe ===");
  const probes = ["sub_id_3", "is_bot", "bot", "is_unique_campaign", "is_unique_global", "ip", "user_agent", "landing_id", "source"];
  const colResults: Row[] = [];
  for (const col of probes) {
    const r = await clicksLog(["event_id", col], [], 30_000);
    colResults.push({
      column: col,
      supported: r.ok,
      sample: r.ok ? String(r.rows[0]?.[col] ?? "(null)").slice(0, 40) : `HTTP ${r.status}`,
    });
  }
  console.table(colResults);

  // ── K3 ─ volume + cost ────────────────────────────────────────────────────
  console.log("\n=== K3 pull cost for one day ===");
  console.table([{ rows: all.rows.length, ms: all.ms, kb: Math.round(all.bytes / 1024), est_days_all_time: 70, est_total_rows: all.rows.length * 70 }]);

  // ── K4 ─ THE MERGE TEST ───────────────────────────────────────────────────
  // Landing clicks are the funnel event the brief wants to count. Match each
  // distinct recipient (sub_id_1 = stage_sends.id) against CamMan's own verdict.
  const kRecipients = [...new Set(withSub(landing).map((r) => str(r, "sub_id_1")))];
  console.log(`\n=== K4 merge test — ${kRecipients.length} distinct Keitaro landing recipients on ${DAY} ===`);

  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) => (await d.execute(query)) as unknown as T[];

  const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
  console.log("Keitaro's own flags on those landing clicks:");
  console.table([
    {
      landing_rows: landing.length,
      is_bot_true: landing.filter((r) => truthy(r.is_bot)).length,
      is_unique_campaign_true: landing.filter((r) => truthy(r.is_unique_campaign)).length,
      distinct_sub_id_1: kRecipients.length,
    },
  ]);

  // One row per id: VALUES (a),(b),(c) — NOT VALUES (a, b, c).
  const idList = sql.join(kRecipients.map((id) => sql`(${id}::uuid)`), sql`, `);
  const verdicts = kRecipients.length
    ? await q<{ bucket: string; recipients: string }>(sql`
        WITH k(id) AS (VALUES ${idList}),
        j AS (
          SELECT k.id,
                 ss.id IS NOT NULL AS has_send,
                 bool_or(c.classification = 'human')            AS any_human,
                 bool_or(c.classification = 'unknown')          AS any_unknown,
                 count(c.id)                                    AS taps
          FROM k
          LEFT JOIN stage_sends ss ON ss.id = k.id
          LEFT JOIN clicks c ON c.link_id = ss.link_id
          GROUP BY k.id, ss.id
        )
        SELECT CASE
                 WHEN NOT has_send            THEN 'no stage_sends row (unmatched id)'
                 WHEN taps = 0                THEN 'row5: no CamMan click row -> Keitaro adds it'
                 WHEN any_human               THEN 'row2: CamMan human -> counted (agree)'
                 WHEN any_unknown             THEN 'row3: CamMan unknown -> Keitaro vouches'
                 ELSE 'row1: CamMan bot/suspect/prefetch -> EXCLUDED despite Keitaro'
               END AS bucket,
               count(*)::text AS recipients
        FROM j GROUP BY 1 ORDER BY 2 DESC
      `)
    : [];
  console.table(verdicts);

  // Reverse direction: CamMan clickers that day with no Keitaro landing click.
  const camman = await q<{ bucket: string; recipients: string }>(sql`
    WITH day AS (
      SELECT ss.id,
             bool_or(c.classification = 'human') AS any_human
      FROM clicks c
      JOIN links l ON l.id = c.link_id
      JOIN stage_sends ss ON ss.link_id = l.id
      WHERE c.clicked_at >= (${DAY} || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'
        AND c.clicked_at <  ((${DAY}::date + 1) || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'
      GROUP BY ss.id
    )
    SELECT CASE WHEN any_human THEN 'CamMan human clickers (day)' ELSE 'CamMan excluded clickers (day)' END AS bucket,
           count(*)::text AS recipients
    FROM day GROUP BY 1
  `);
  console.table(camman);

  const kSet = new Set(kRecipients);
  const cammanHuman = await q<{ id: string }>(sql`
    SELECT DISTINCT ss.id
    FROM clicks c
    JOIN links l ON l.id = c.link_id
    JOIN stage_sends ss ON ss.link_id = l.id
    WHERE c.classification = 'human'
      AND c.clicked_at >= (${DAY} || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'
      AND c.clicked_at <  ((${DAY}::date + 1) || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'
  `);
  const onlyCamman = cammanHuman.filter((r) => !kSet.has(r.id)).length;
  console.log(`\nCamMan human clickers on ${DAY}: ${cammanHuman.length}`);
  console.log(`  of which NOT present in Keitaro landing clicks: ${onlyCamman}`);
  console.log(`  overlap with Keitaro landing: ${cammanHuman.length - onlyCamman}`);

  // ── K5 ─ cross-tab CamMan verdict × Keitaro is_bot, per recipient ─────────
  // The decision-relevant number: CamMan classifies ~92% of taps 'suspect'.
  // Does Keitaro agree those are bots? If not, the brief's "CamMan wins" rule
  // deletes clickers Keitaro considers real.
  if (kRecipients.length) {
    const keitaroSaysHuman = new Set(
      withSub(landing).filter((r) => !truthy(r.is_bot)).map((r) => str(r, "sub_id_1")),
    );
    const rows = await q<{ id: string; verdict: string }>(sql`
      WITH k(id) AS (VALUES ${idList})
      SELECT k.id::text AS id,
             CASE WHEN bool_or(c.classification = 'human') THEN 'human'
                  WHEN count(c.id) = 0 THEN 'no CamMan click'
                  WHEN bool_or(c.classification = 'unknown') THEN 'unknown'
                  WHEN bool_or(c.classification = 'suspect') THEN 'suspect'
                  WHEN bool_or(c.classification = 'bot') THEN 'bot'
                  ELSE 'prefetch' END AS verdict
      FROM k
      LEFT JOIN stage_sends ss ON ss.id = k.id
      LEFT JOIN clicks c ON c.link_id = ss.link_id
      GROUP BY k.id
    `);
    const tab = new Map<string, { keitaro_not_bot: number; keitaro_bot: number }>();
    for (const r of rows) {
      const cell = tab.get(r.verdict) ?? { keitaro_not_bot: 0, keitaro_bot: 0 };
      if (keitaroSaysHuman.has(r.id)) cell.keitaro_not_bot++;
      else cell.keitaro_bot++;
      tab.set(r.verdict, cell);
    }
    console.log("\n=== K5 CamMan verdict × Keitaro is_bot (distinct recipients) ===");
    console.table([...tab.entries()].map(([camman_verdict, v]) => ({ camman_verdict, ...v })));
  }

  // CamMan scoring reasons — what is driving the 'suspect' bucket?
  console.log("\n=== K5b CamMan bot_reasons distribution (all time) ===");
  console.table(
    await q(sql`
      SELECT classification, array_to_string(bot_reasons, '+') AS reasons,
             count(*)::text AS taps
      FROM clicks GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 12
    `),
  );

  // What the aggregate poll recorded for the same day, for cross-check.
  const agg = await q(sql`
    SELECT sum(visit_clicks_clean)::bigint AS visit_clean,
           sum(visit_clicks_raw)::bigint AS visit_raw,
           sum(redirect_clicks_clean)::bigint AS redirect_clean,
           sum(revenue)::numeric(12,2) AS revenue
    FROM keitaro_stage_results WHERE stat_date = ${DAY}
  `);
  console.log("\n=== K4 cross-check: what the aggregate poll stored for that day ===");
  console.table(agg);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
