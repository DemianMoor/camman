// READ-ONLY plan measurement for the batched contact-engagement recount
// (plan approved 2026-10-21). Runs EXPLAIN (ANALYZE, BUFFERS) inside a READ ONLY
// transaction — nothing is written, not even a temp table.
//
// What it measures, per sampled 50K-contact batch (first / middle / last id range):
//   facts   — the sends read of lib/engagement/refresh.ts phase 3 (count / first /
//             last per contact) restricted to the batch's contact range
//   offers  — phase 4 (per contact × offer × campaign)
//   clicks  — phase 2 (human clicks per contact), planner's choice
//   clicks* — the same with hash joins off, i.e. links_contact_id_idx →
//             clicks_link_id_idx probes, to show the per-batch path without a
//             full clicks scan
// These are the reads batching changes; thresholds / evaluate / write are per
// contact either way. --full also times the CURRENT single-pass reads (no contact
// range) — the comparator for "batched total no slower than today's single pass".
//
// Weight: a batch reads tens of MB with the 0220 index and ~1 GB without it;
// --full reads ~5 GB (the nightly job's own read). Anything heavy belongs in the
// quiet window, 05:00–06:00 UTC (docs/07-conventions.md, heavy prod verification).
//
//   npx tsx scripts/measure-engagement-batch-plans.ts            # 3 sampled batches
//   npx tsx scripts/measure-engagement-batch-plans.ts --full     # + single-pass reads
//   … --org <uuid> --batch 50000 --samples 3
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const FULL = process.argv.includes("--full");
const BATCH = Number(arg("--batch") ?? 50_000);
const SAMPLES = Number(arg("--samples") ?? 3);
const HUMAN = `ck.classification = 'human' AND ck.scored_at IS NOT NULL`; // lib/reporting/counted-clickers.ts HUMAN_CLICK

function sessionUrl(raw: string): string {
  const u = new URL(raw);
  if (u.port === "6543") u.port = "5432";
  u.searchParams.delete("prepare");
  return u.toString();
}

type Node = Record<string, unknown> & { Plans?: Node[] };
type Measured = { ms: number; readMB: number; hitMB: number; scans: string[] };

async function main() {
  const raw = process.env.DATABASE_URL!;
  const pg = postgres(sessionUrl(raw), { prepare: false, max: 1 });
  console.log(`READ-ONLY measurement on ${new URL(raw).hostname} at ${new Date().toISOString()}\n`);
  try {
    const org =
      arg("--org") ??
      ((await pg`SELECT org_id FROM lifecycle_settings WHERE engine_mode = 'write' LIMIT 1`) as unknown as {
        org_id: string;
      }[])[0]?.org_id;
    if (!org) throw new Error("no org with the engagement engine on — pass --org");
    const [{ n }] = (await pg`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${org}::uuid`) as unknown as {
      n: number;
    }[];
    const batches = Math.ceil(n / BATCH);
    const idx = (await pg`
      SELECT indexrelid::regclass::text AS name, indisvalid AS valid FROM pg_index
      WHERE indexrelid::regclass::text = 'stage_sends_org_contact_sent_idx'`) as unknown as { valid: boolean }[];
    console.log(`org ${org}: ${n.toLocaleString()} contacts → ${batches} batches of ${BATCH.toLocaleString()}`);
    console.log(`stage_sends_org_contact_sent_idx: ${idx.length ? (idx[0].valid ? "present, valid" : "present, INVALID") : "absent"}\n`);

    const measure = async (q: string, hashOff = false): Promise<Measured> => {
      await pg.unsafe("BEGIN READ ONLY");
      try {
        await pg.unsafe("SET LOCAL statement_timeout = '600s'");
        if (hashOff) await pg.unsafe("SET LOCAL enable_hashjoin = off");
        const r = (await pg.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`)) as unknown as {
          "QUERY PLAN": { Plan: Node; "Execution Time": number }[];
        }[];
        const top = r[0]["QUERY PLAN"][0];
        const scans: string[] = [];
        const walk = (p: Node) => {
          const t = String(p["Node Type"]);
          if (/Scan/.test(t) && p["Relation Name"] !== "campaigns")
            scans.push(
              `${t} ${p["Index Name"] ?? p["Relation Name"]}` +
                (p["Heap Fetches"] != null ? ` heap_fetches=${p["Heap Fetches"]}` : ""),
            );
          (p.Plans ?? []).forEach(walk);
        };
        walk(top.Plan);
        const mb = (b: unknown) => (Number(b ?? 0) * 8) / 1024;
        return {
          ms: top["Execution Time"],
          readMB: mb(top.Plan["Shared Read Blocks"]),
          hitMB: mb(top.Plan["Shared Hit Blocks"]),
          scans,
        };
      } finally {
        await pg.unsafe("ROLLBACK");
      }
    };

    const facts = (range: string) => `
      SELECT ss.contact_id, count(*), min(ss.sent_at), max(ss.sent_at)
      FROM stage_sends ss
      WHERE ss.org_id = '${org}' AND ss.status = 'sent' AND ss.sent_at <= now() ${range}
      GROUP BY ss.contact_id`;
    const offers = (range: string) => `
      SELECT ss.contact_id, ca.offer_id, ss.campaign_id, min(ss.sent_at), max(ss.sent_at), count(*)
      FROM stage_sends ss JOIN campaigns ca ON ca.id = ss.campaign_id AND ca.org_id = '${org}'
      WHERE ss.org_id = '${org}' AND ss.status = 'sent' AND ss.sent_at <= now() AND ca.offer_id IS NOT NULL ${range}
      GROUP BY 1, 2, 3`;
    const clicks = (range: string) => `
      SELECT l.contact_id, min(ck.clicked_at), max(ck.clicked_at)
      FROM clicks ck JOIN links l ON l.id = ck.link_id
      WHERE ${HUMAN} AND ck.org_id = '${org}' AND ck.clicked_at <= now() AND ck.scored_at <= now() ${range}
      GROUP BY l.contact_id`;
    const fmt = (name: string, m: Measured) =>
      `  ${name.padEnd(8)} ${(m.ms / 1000).toFixed(2).padStart(7)} s  read ${m.readMB.toFixed(0).padStart(5)} MB  hit ${m.hitMB
        .toFixed(0)
        .padStart(5)} MB  ${m.scans.join(" | ")}`;

    const totals = { facts: 0, offers: 0, clicks: 0, clicksNl: 0 };
    const picks = SAMPLES <= 1 ? [0] : Array.from({ length: SAMPLES }, (_, i) => Math.round((i * (batches - 1)) / (SAMPLES - 1)));
    for (const b of picks) {
      const bound = async (k: number) =>
        ((await pg`SELECT id FROM contacts WHERE org_id = ${org}::uuid ORDER BY id OFFSET ${k} LIMIT 1`) as unknown as {
          id: string;
        }[])[0]?.id;
      const lo = await bound(b * BATCH);
      const hi = await bound((b + 1) * BATCH);
      const r = (col: string) => `AND ${col} >= '${lo}'` + (hi ? ` AND ${col} < '${hi}'` : "");
      console.log(`batch ${b + 1}/${batches}  [${lo} .. ${hi ?? "end"})`);
      const f = await measure(facts(r("ss.contact_id")));
      const o = await measure(offers(r("ss.contact_id")));
      const c = await measure(clicks(r("l.contact_id")));
      const cn = await measure(clicks(r("l.contact_id")), true);
      for (const [k, m] of [["facts", f], ["offers", o], ["clicks", c], ["clicks*", cn]] as const) console.log(fmt(k, m));
      totals.facts += f.ms;
      totals.offers += o.ms;
      totals.clicks += c.ms;
      totals.clicksNl += cn.ms;
    }
    const est = (ms: number) => ((ms / picks.length) * batches) / 1000;
    const bestClicks = Math.min(totals.clicks, totals.clicksNl);
    console.log(
      `\nextrapolated batched total (${batches} batches × sampled mean): facts ${est(totals.facts).toFixed(0)} s · ` +
        `offers ${est(totals.offers).toFixed(0)} s · clicks ${est(bestClicks).toFixed(0)} s (better of the two) · ` +
        `sum ${(est(totals.facts) + est(totals.offers) + est(bestClicks)).toFixed(0)} s`,
    );

    if (FULL) {
      console.log(`\nsingle pass (today's shape, no contact range):`);
      const f = await measure(facts(""));
      const o = await measure(offers(""));
      const c = await measure(clicks(""));
      for (const [k, m] of [["facts", f], ["offers", o], ["clicks", c]] as const) console.log(fmt(k, m));
      console.log(`  sum ${((f.ms + o.ms + c.ms) / 1000).toFixed(0)} s`);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
