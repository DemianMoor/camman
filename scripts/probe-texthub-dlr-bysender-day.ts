import "./_env-preload";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { resolveKeyForStage } from "@/lib/sends/provider-credential";

// READ-ONLY. Does a short code EVER return a delivery verdict other than
// "delivered"? Samples K messages per (sender x ET day) over N days and reports
// the verdict + lag distribution per cell.
//
//   npx tsx scripts/probe-texthub-dlr-bysender-day.ts --per-cell 50 --days 7
//
// WHY PER-CELL, NOT A FLAT SAMPLE: a flat "newest N" sample is dominated by
// whichever sender ran the biggest recent campaign, which is how a per-route
// difference stays invisible. Stratifying by (sender, day) also dates any
// behavior change — e.g. whether TextHub "enabling" DLR moved the short codes
// at all, or only the toll-free.
//
// THE DECISIVE STATISTIC is the non-delivered count per sender. Any real SMS
// route produces failures (dead numbers, disconnects, carrier blocks). A sender
// returning dlr=1 across thousands with ZERO exceptions is not reporting; it is
// echoing submission. Lag (delivered_on - sent_on) separates the two cleanly:
// a real receipt lands after submission, an echo lands at exactly 0s.

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const TIMEOUT_MS = 15000;
const GAP_MS = 120;

const DLR_LABEL: Record<number, string> = {
  0: "UNKNOWN", 1: "DELIVERED", 2: "FAILED", 4: "QUEUED", 8: "QUEUED", 16: "REJECTED",
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type Row = {
  org_id: string; phone: string; sent_at: string; message_id: string;
  provider_id: number; provider_key: string; provider_phone_id: number | null;
  sender: string | null; brand_id: number | null; day_et: string;
};

async function getReport(apiKey: string, messageId: string) {
  const url = new URL(`${TEXTHUB_BASE_URL}/`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("dlr", "true");
  url.searchParams.set("id", messageId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { method: "GET", signal: controller.signal });
    const raw = await res.text().catch(() => null);
    let p: Record<string, unknown> = {};
    if (raw) { try { p = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep raw */ } }
    const dlr = p.dlr == null ? null : Number(p.dlr);
    const doneRaw = String(p.delivered_on ?? p.failed_on ?? p.rejected_on ?? "");
    return {
      http: res.status, dlr,
      verdict: res.status === 404 ? "HTTP404" : dlr == null ? "NO_DLR" : (DLR_LABEL[dlr] ?? `dlr=${dlr}`),
      sentOn: p.sent_on == null ? null : String(p.sent_on),
      doneOn: doneRaw && doneRaw !== "0" ? doneRaw : null,
      raw,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { http: 0, dlr: null, verdict: aborted ? "TIMEOUT" : "NETERR", sentOn: null, doneOn: null, raw: null };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const perCell = Number(arg("per-cell") ?? 50);
  const days = Number(arg("days") ?? 7);

  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const rows = (await db.execute(sql`
      WITH c AS (
        SELECT
          ss.org_id::text AS org_id, ss.phone,
          to_char(ss.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sent_at,
          ss.texthub_message_id AS message_id,
          cs.sms_provider_id AS provider_id, cs.provider_phone_id,
          p.sms_provider_id AS provider_key, ph.phone_number AS sender,
          cmp.brand_id,
          date_trunc('day', ss.sent_at AT TIME ZONE 'America/New_York')::date::text AS day_et,
          row_number() OVER (
            PARTITION BY cs.provider_phone_id,
                         date_trunc('day', ss.sent_at AT TIME ZONE 'America/New_York')
            ORDER BY ss.id
          ) AS rn
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN campaigns cmp ON cmp.id = ss.campaign_id
        JOIN sms_providers p ON p.id = cs.sms_provider_id
        LEFT JOIN provider_phones ph ON ph.id = cs.provider_phone_id
        WHERE p.sms_provider_id IN ('txh','txh2')
          AND ss.texthub_message_id IS NOT NULL
          AND ss.sent_at >= now() - (${days} || ' days')::interval
      )
      SELECT * FROM c WHERE rn <= ${perCell} ORDER BY day_et DESC, provider_phone_id
    `)) as unknown as Row[];

    console.log(`Sampling ${rows.length} message(s): up to ${perCell} per (sender x ET day) over ${days} day(s)\n`);

    const keyCache = new Map<string, string | null>();
    type Cell = { verdicts: Map<string, number>; zeroLag: number; posLag: number[]; n: number };
    const cells = new Map<string, Cell>();
    const bySender = new Map<string, Cell>();
    const oddities: string[] = [];

    const cellOf = (m: Map<string, Cell>, k: string) => {
      if (!m.has(k)) m.set(k, { verdicts: new Map(), zeroLag: 0, posLag: [], n: 0 });
      return m.get(k)!;
    };

    for (const r of rows) {
      const ck = `${r.org_id}:${r.provider_id}:${r.brand_id}:${r.provider_phone_id}`;
      if (!keyCache.has(ck)) {
        keyCache.set(ck, await resolveKeyForStage(db, {
          orgId: r.org_id, providerId: r.provider_id,
          brandId: r.brand_id, providerPhoneId: r.provider_phone_id,
        }));
      }
      const apiKey = keyCache.get(ck);
      if (!apiKey) continue;

      const rep = await getReport(apiKey, r.message_id);
      await new Promise((ok) => setTimeout(ok, GAP_MS));

      const senderLabel = `${r.sender ?? "?"}[${r.provider_key}]`;
      const cell = cellOf(cells, `${r.day_et} ${senderLabel}`);
      const agg = cellOf(bySender, senderLabel);
      for (const c of [cell, agg]) {
        c.n++;
        c.verdicts.set(rep.verdict, (c.verdicts.get(rep.verdict) ?? 0) + 1);
      }

      // Lag measured against OUR sent_at (true UTC). TextHub's own sent_on is
      // UTC-5 while delivered_on is UTC, so differencing their two fields
      // fabricates a ~5h offset.
      if (rep.doneOn) {
        const lag = (Date.parse(rep.doneOn.replace(" ", "T") + "Z") - Date.parse(r.sent_at)) / 1000;
        const zero = rep.sentOn != null && rep.doneOn === rep.sentOn;
        for (const c of [cell, agg]) {
          if (zero) c.zeroLag++; else c.posLag.push(lag);
        }
      }
      // Anything that is not a plain zero-lag delivered is worth seeing verbatim.
      if (rep.verdict !== "DELIVERED" || (rep.sentOn && rep.doneOn !== rep.sentOn)) {
        if (oddities.length < 40) {
          oddities.push(`  ${r.day_et} ${senderLabel} ${rep.verdict} sent_on=${rep.sentOn} done=${rep.doneOn}`);
        }
      }
    }

    const fmt = (c: Cell) =>
      [...c.verdicts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join(" ");

    console.log("PER (ET DAY x SENDER):");
    console.log("  day         sender                verdicts                    zero-lag   real-lag(n, median)");
    for (const [k, c] of [...cells.entries()].sort().reverse()) {
      const [day, ...rest] = k.split(" ");
      const s = [...c.posLag].sort((a, b) => a - b);
      const med = s.length ? `${Math.round(s[Math.floor(s.length / 2)])}s` : "-";
      console.log(
        `  ${day}  ${rest.join(" ").padEnd(20)} ${fmt(c).padEnd(26)} ` +
        `${String(c.zeroLag).padStart(4)}/${String(c.n).padEnd(4)}  ${String(s.length).padStart(4)}  ${med}`,
      );
    }

    console.log("\nPER SENDER (all days):");
    for (const [k, c] of bySender) {
      const nonDelivered = c.n - (c.verdicts.get("DELIVERED") ?? 0);
      const s = [...c.posLag].sort((a, b) => a - b);
      console.log(
        `  ${k.padEnd(22)} n=${String(c.n).padStart(5)}  ${fmt(c).padEnd(30)}\n` +
        `    non-delivered: ${nonDelivered}  |  zero-lag: ${c.zeroLag}/${c.n}  |  ` +
        `real-lag samples: ${s.length}${s.length ? ` (median ${Math.round(s[Math.floor(s.length / 2)])}s)` : ""}`,
      );
    }

    if (oddities.length) {
      console.log("\nNON-ZERO-LAG OR NON-DELIVERED SAMPLES (first 40):");
      for (const o of oddities) console.log(o);
    } else {
      console.log("\nNO EXCEPTIONS FOUND — every sampled message was zero-lag DELIVERED.");
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error("probe crashed:", e); process.exit(1); });
