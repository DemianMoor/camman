import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Two decision-critical questions the single-day probe left open:
//   H1 across ALL history, does Keitaro ever contribute a click CamMan lacks?
//      (i.e. how often does precedence row 5 actually fire for tracked traffic)
//   H2 what ASNs drive the 90.97% 'suspect' rate? If these are consumer privacy
//      relays (Apple iCloud Private Relay egresses on Cloudflare/Akamai/Fastly),
//      'suspect' is excluding real humans and "CamMan always wins" is wrong.
//
// Run: npx tsx scripts/probe-epc-merge-allhistory.ts

const BASE = (process.env.KEITARO_API_URL ?? "https://admin.gdkn.org").replace(/\/+$/, "");
const KEY = process.env.KEITARO_API_KEY?.trim() ?? "";
const VISIT_CAMPAIGN = "gk-lp-visits";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_DAY = "2026-06-03";
const LAST_DAY = "2026-08-11";

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : r[k] == null ? "" : String(r[k]));

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function landingRecipients(day: string): Promise<{ ids: string[]; rows: number; bot: number }> {
  const res = await fetch(`${BASE}/admin_api/v1/clicks/log`, {
    method: "POST",
    headers: { "Api-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      range: { from: `${day} 00:00:00`, to: `${day} 23:59:59`, timezone: "America/New_York" },
      columns: ["sub_id_1", "campaign", "is_bot"],
      filters: [{ name: "sub_id_1", operator: "NOT_EQUAL", expression: "" }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { ids: [], rows: -1, bot: 0 };
  const j = (await res.json().catch(() => null)) as { rows?: Row[] } | null;
  const rows = Array.isArray(j?.rows) ? j!.rows! : [];
  const landing = rows.filter((r) => str(r, "campaign").toLowerCase() === VISIT_CAMPAIGN);
  const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
  return {
    ids: [...new Set(landing.map((r) => str(r, "sub_id_1")).filter((s) => UUID_RE.test(s)))],
    rows: landing.length,
    bot: landing.filter((r) => truthy(r.is_bot)).length,
  };
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) => {
    let out: T[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as T[];
    });
    return out;
  };

  // ── H1 ─ pull every day, union the recipient ids, then ONE db comparison ───
  const all = new Set<string>();
  let totalRows = 0, totalBot = 0, failed = 0;
  const list = days(FIRST_DAY, LAST_DAY);
  for (const day of list) {
    const r = await landingRecipients(day);
    if (r.rows < 0) { failed++; continue; }
    totalRows += r.rows; totalBot += r.bot;
    for (const id of r.ids) all.add(id);
  }
  console.log(`\n=== H1 Keitaro landing clicks, ${FIRST_DAY}..${LAST_DAY} ===`);
  console.table([{ days: list.length, failed_days: failed, landing_rows: totalRows, is_bot_rows: totalBot, distinct_recipients: all.size }]);

  const ids = [...all];
  const CHUNK = 5000;
  const buckets = new Map<string, number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const idList = sql.join(ids.slice(i, i + CHUNK).map((id) => sql`(${id}::uuid)`), sql`, `);
    const rows = await q<{ bucket: string; n: string }>(sql`
      WITH k(id) AS (VALUES ${idList}),
      j AS (
        SELECT k.id, ss.id IS NOT NULL AS has_send,
               count(c.id) AS taps,
               bool_or(c.classification = 'human')   AS any_human,
               bool_or(c.classification = 'unknown') AS any_unknown
        FROM k
        LEFT JOIN stage_sends ss ON ss.id = k.id
        LEFT JOIN clicks c ON c.link_id = ss.link_id
        GROUP BY k.id, ss.id
      )
      SELECT CASE
               WHEN NOT has_send   THEN 'no stage_sends row (unmatchable)'
               WHEN taps = 0       THEN 'row5: NO CamMan click -> Keitaro ADDS'
               WHEN any_human      THEN 'row2: CamMan human (agree)'
               WHEN any_unknown    THEN 'row3: CamMan unknown -> vouch'
               ELSE 'row1: CamMan excluded, Keitaro saw it'
             END AS bucket, count(*)::text AS n
      FROM j GROUP BY 1
    `);
    for (const r of rows) buckets.set(r.bucket, (buckets.get(r.bucket) ?? 0) + Number(r.n));
  }
  console.log("\n=== H1 precedence table, ALL HISTORY (distinct recipients) ===");
  console.table([...buckets.entries()].map(([bucket, recipients]) => ({ bucket, recipients })));

  // ── H2 ─ what is 'suspect' actually made of? ──────────────────────────────
  console.log("\n=== H2 top ASN orgs among 'suspect' taps (all time) ===");
  console.table(
    await q(sql`
      SELECT coalesce(asn_org, '(null)') AS asn_org, asn,
             count(*)::text AS taps,
             round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_of_suspect
      FROM clicks WHERE classification = 'suspect'
      GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 15
    `),
  );
  console.log("\n=== H2b same for 'human' taps, for contrast ===");
  console.table(
    await q(sql`
      SELECT coalesce(asn_org, '(null)') AS asn_org, count(*)::text AS taps,
             round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_of_human
      FROM clicks WHERE classification = 'human'
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 10
    `),
  );

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
