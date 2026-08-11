import "./_env-preload";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { resolveKeyForStage } from "@/lib/sends/provider-credential";

// READ-ONLY. The decisive test for "is TextHub's per-number delivery report
// REAL?": poll the same message ids twice, minutes apart, and see whether the
// verdict actually moves. A live report transitions QUEUED -> DELIVERED/FAILED
// as the carrier reports back. A synthetic one is frozen from the moment of
// submission and never changes.
//
// Also measures the delivery lag against OUR OWN stage_sends.sent_at (true UTC)
// rather than against TextHub's `sent_on`, because those two fields are NOT in
// the same timezone (see the offset column) — comparing them to each other
// manufactures a fake ~5h lag.
//
//   npx tsx scripts/probe-texthub-dlr-transition.ts --n 12 --wait 240
//
// No writes, no sends. Costs nothing.

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const TIMEOUT_MS = 15000;
const GAP_MS = 150;

const DLR_LABEL: Record<number, string> = {
  0: "UNKNOWN", 1: "DELIVERED", 2: "FAILED", 4: "QUEUED", 8: "QUEUED", 16: "REJECTED",
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type SendRow = {
  org_id: string; phone: string; sent_at: string; message_id: string;
  provider_id: number; provider_key: string; provider_phone_id: number | null;
  sender: string | null; brand_id: number | null;
};

type Report = {
  httpStatus: number; dlr: number | null; verdict: string;
  sentOn: string | null; doneOn: string | null; raw: string | null;
};

async function getReport(apiKey: string, messageId: string): Promise<Report> {
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
      httpStatus: res.status,
      dlr,
      verdict: dlr == null ? "NO_DLR" : (DLR_LABEL[dlr] ?? `dlr=${dlr}`),
      sentOn: p.sent_on == null ? null : String(p.sent_on),
      // TextHub returns the literal string "0" for an unset timestamp.
      doneOn: doneRaw && doneRaw !== "0" ? doneRaw : null,
      raw,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { httpStatus: 0, dlr: null, verdict: aborted ? "TIMEOUT" : "NETERR", sentOn: null, doneOn: null, raw: null };
  } finally {
    clearTimeout(timer);
  }
}

const parseTh = (s: string | null) =>
  s ? Date.parse(s.replace(" ", "T") + "Z") : NaN; // naive-as-UTC; offset handled by caller
const maskPhone = (p: string | null) => {
  if (!p) return "(none)";
  const d = String(p).replace(/\D/g, "");
  return d.length >= 4 ? `…${d.slice(-4)}` : "…";
};

async function main() {
  const perPhone = Number(arg("n") ?? 12);
  const waitSec = Number(arg("wait") ?? 240);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const rows = (await db.execute(sql`
      WITH c AS (
        SELECT
          ss.org_id::text AS org_id, ss.phone,
          to_char(ss.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
          ss.texthub_message_id AS message_id,
          cs.sms_provider_id AS provider_id, cs.provider_phone_id,
          p.sms_provider_id AS provider_key, ph.phone_number AS sender,
          cmp.brand_id,
          row_number() OVER (PARTITION BY cs.provider_phone_id ORDER BY ss.sent_at DESC) AS rn
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN campaigns cmp ON cmp.id = ss.campaign_id
        JOIN sms_providers p ON p.id = cs.sms_provider_id
        LEFT JOIN provider_phones ph ON ph.id = cs.provider_phone_id
        WHERE p.sms_provider_id IN ('txh','txh2')
          AND ss.texthub_message_id IS NOT NULL
          AND ss.sent_at >= now() - interval '6 hours'
      )
      SELECT * FROM c WHERE rn <= ${perPhone} ORDER BY provider_phone_id, sent_at DESC
    `)) as unknown as SendRow[];

    if (rows.length === 0) { console.log("No recent TextHub sends to probe."); return; }

    const keyCache = new Map<string, string | null>();
    const keyFor = async (r: SendRow) => {
      const k = `${r.org_id}:${r.provider_id}:${r.brand_id}:${r.provider_phone_id}`;
      if (!keyCache.has(k)) {
        keyCache.set(k, await resolveKeyForStage(db, {
          orgId: r.org_id, providerId: r.provider_id,
          brandId: r.brand_id, providerPhoneId: r.provider_phone_id,
        }));
      }
      return keyCache.get(k) ?? null;
    };

    const pass = async (label: string) => {
      console.log(`\n===== PASS ${label} (${new Date().toISOString()}) =====`);
      const out = new Map<string, Report>();
      for (const r of rows) {
        const key = await keyFor(r);
        if (!key) continue;
        out.set(r.message_id, await getReport(key, r.message_id));
        await new Promise((ok) => setTimeout(ok, GAP_MS));
      }
      return out;
    };

    const p1 = await pass("1");

    // Timezone offset: TextHub `sent_on` vs OUR sent_at (true UTC). Reported per
    // sender so a mixed-zone response can't be mistaken for a delivery lag.
    console.log("\n  sent_on timezone offset vs our UTC sent_at:");
    const offsets = new Map<string, number[]>();
    for (const r of rows) {
      const rep = p1.get(r.message_id);
      if (!rep?.sentOn) continue;
      const off = (parseTh(rep.sentOn) - Date.parse(r.sent_at)) / 3600000;
      const k = `ph#${r.provider_phone_id}(${r.sender ?? "?"})`;
      offsets.set(k, [...(offsets.get(k) ?? []), off]);
    }
    for (const [k, v] of offsets) {
      const avg = v.reduce((a, b) => a + b, 0) / v.length;
      console.log(`    ${k.padEnd(26)} ${avg.toFixed(2)}h  (n=${v.length})`);
    }

    console.log(`\n  waiting ${waitSec}s for the carrier to report back...`);
    await new Promise((ok) => setTimeout(ok, waitSec * 1000));

    const p2 = await pass("2");

    console.log("\n" + "=".repeat(78));
    console.log("TRANSITIONS (pass 1 -> pass 2)");
    console.log("=".repeat(78));
    const byPhone = new Map<string, { changed: number; total: number; frozenAtSubmit: number; lags: number[] }>();

    for (const r of rows) {
      const a = p1.get(r.message_id), b = p2.get(r.message_id);
      if (!a || !b) continue;
      const k = `ph#${r.provider_phone_id}(${r.sender ?? "?"})[${r.provider_key}]`;
      const agg = byPhone.get(k) ?? { changed: 0, total: 0, frozenAtSubmit: 0, lags: [] };
      agg.total++;
      const moved = a.verdict !== b.verdict || a.doneOn !== b.doneOn;
      if (moved) agg.changed++;
      // "Frozen at submit" = the delivered stamp IS the submit stamp, to the second.
      if (b.doneOn && b.sentOn && b.doneOn === b.sentOn) agg.frozenAtSubmit++;
      // True lag: TextHub's done stamp (UTC) minus OUR sent_at (UTC).
      if (b.doneOn) {
        const lag = (parseTh(b.doneOn) - Date.parse(r.sent_at)) / 1000;
        agg.lags.push(lag);
      }
      byPhone.set(k, agg);

      if (moved) {
        console.log(
          `  MOVED ${maskPhone(r.phone)} [${k}] ${a.verdict}(${a.doneOn ?? "-"}) -> ${b.verdict}(${b.doneOn ?? "-"})`,
        );
      }
    }

    console.log("\n  PER SENDER:");
    for (const [k, v] of byPhone) {
      const sorted = [...v.lags].sort((a, b) => a - b);
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      console.log(
        `    ${k.padEnd(34)} moved ${v.changed}/${v.total}  ` +
        `done==sent_on ${v.frozenAtSubmit}/${v.total}  ` +
        `median lag vs our send: ${med == null ? "?" : Math.round(med) + "s"}`,
      );
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error("probe crashed:", e); process.exit(1); });
