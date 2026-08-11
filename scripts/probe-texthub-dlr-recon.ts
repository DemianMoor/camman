import "./_env-preload";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { resolveKeyForStage } from "@/lib/sends/provider-credential";

// READ-ONLY DIAGNOSTIC — does TextHub's per-message delivery report actually
// resolve now? (They claim they "enabled" it.) No writes, no sends, no schema
// change. Costs nothing: the DLR lookup is a plain GET against messages we
// already sent.
//
//   npx tsx scripts/probe-texthub-dlr-recon.ts                 # inventory only
//   npx tsx scripts/probe-texthub-dlr-recon.ts --probe 30      # + live lookups
//   npx tsx scripts/probe-texthub-dlr-recon.ts --probe 30 --days 3
//   npx tsx scripts/probe-texthub-dlr-recon.ts --probe 90 --hours 2   # one send window
//
// CONTRACT (swagger "Get delivery report", first verified live 2026-06-16 by
// scripts/probe-texthub-status.ts):
//   GET https://api.texthub.com/v2/?api_key=<key>&dlr=true&id=<message_id>
//     `id` = the id TextHub returned on send (stage_sends.texthub_message_id).
//     NOT lead_id / number / message_id — those 404.
//   200: {"response","message","phone","sender_id","sent_on","dlr",
//         "delivered_on"|"failed_on"|"rejected_on"}
//   404: {"response":"A message with that ID does not exist"}
//
// KEY RESOLUTION (why this probe does NOT reuse probe-texthub-status.ts):
// that script calls the deprecated resolveProviderApiKey, which reads the
// PLAINTEXT api_key column only and is account-blind. Post-0110 the key lives
// encrypted and a provider can hold N accounts; querying account A for a
// message id minted by account B returns the same 404 as "DLR is broken".
// This probe resolves number -> account -> key via resolveKeyForStage, so a
// 404 means what it says.

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const TIMEOUT_MS = 15000;
const REQUEST_GAP_MS = 150; // gentle, sequential — this is someone's live API

// dlr code -> label (swagger DeliveryReceiptResponse enum).
const DLR_LABEL: Record<number, string> = {
  0: "UNKNOWN",
  1: "DELIVERED",
  2: "FAILED",
  4: "QUEUED",
  8: "QUEUED",
  16: "REJECTED",
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type SendRow = {
  send_id: string;
  org_id: string;
  phone: string;
  our_status: string;
  sent_at: string | null;
  message_id: string;
  provider_id: number;
  provider_key: string;
  provider_name: string;
  provider_phone_id: number | null;
  brand_id: number | null;
};

function buildDlrUrl(apiKey: string, messageId: string) {
  const url = new URL(`${TEXTHUB_BASE_URL}/`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("dlr", "true");
  url.searchParams.set("id", messageId);
  const redacted = url
    .toString()
    .replace(encodeURIComponent(apiKey), "***REDACTED***");
  return { url: url.toString(), redacted };
}

async function getDeliveryReport(apiKey: string, messageId: string) {
  const { url } = buildDlrUrl(apiKey, messageId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const rawBody = await res.text().catch(() => null);
    let parsed: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { httpStatus: res.status, rawBody, parsed, error: null as string | null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      httpStatus: 0,
      rawBody: null,
      parsed: null as Record<string, unknown> | null,
      error: aborted ? "timeout" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Last 4 digits only — never print a full recipient number to a console log.
function maskPhone(p: string | null | undefined): string {
  if (!p) return "(none)";
  const d = String(p).replace(/\D/g, "");
  return d.length >= 4 ? `…${d.slice(-4)}` : "…";
}

async function main() {
  // --hours wins over --days, so a single evening's send window can be isolated
  // from the rest of the day's traffic.
  const days = Number(arg("days") ?? 7);
  const hours = arg("hours") != null ? Number(arg("hours")) : days * 24;
  const windowLabel = arg("hours") != null ? `${hours} hour(s)` : `${days} day(s)`;
  const probeN = process.argv.includes("--probe")
    ? Number(arg("probe") ?? 25)
    : 0;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    // ---------- Inventory ----------
    console.log("=".repeat(78));
    console.log(`TextHub sends with a stored message id — last ${windowLabel}`);
    console.log("=".repeat(78));

    const inv = (await db.execute(sql`
      SELECT
        p.sms_provider_id                              AS provider_key,
        p.name                                         AS provider_name,
        date_trunc('day', ss.sent_at AT TIME ZONE 'America/New_York')::date::text AS day_et,
        count(*)::int                                  AS n,
        count(*) FILTER (WHERE ss.texthub_message_id IS NOT NULL)::int AS with_id
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN sms_providers   p  ON p.id  = cs.sms_provider_id
      WHERE p.sms_provider_id IN ('txh', 'txh2')
        AND ss.sent_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3
      ORDER BY 3 DESC, 1
    `)) as unknown as {
      provider_key: string; provider_name: string; day_et: string;
      n: number; with_id: number;
    }[];

    if (inv.length === 0) {
      console.log(`  No TextHub sends in the last ${windowLabel}.`);
    } else {
      console.log("  day (ET)    provider        sends   with message id");
      for (const r of inv) {
        console.log(
          `  ${r.day_et}  ${r.provider_key.padEnd(6)} ${String(r.provider_name).slice(0, 8).padEnd(8)} ` +
          `${String(r.n).padStart(6)}   ${String(r.with_id).padStart(6)}`,
        );
      }
    }

    // Sender x our-status breakdown. The DLR verdict turns out to depend on the
    // SENDER (short code vs toll-free), so the sample has to be read per sender
    // — an aggregate across all three hides the split entirely.
    const senders = (await db.execute(sql`
      SELECT p.sms_provider_id AS provider_key, cs.provider_phone_id AS phone_id,
             ph.phone_number AS sender, ss.status AS our_status,
             count(*)::int AS n, max(ss.sent_at)::text AS last_sent
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN sms_providers   p  ON p.id  = cs.sms_provider_id
      LEFT JOIN provider_phones ph ON ph.id = cs.provider_phone_id
      WHERE p.sms_provider_id IN ('txh','txh2')
        AND ss.sent_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1,2,3,4 ORDER BY 1,2,4
    `)) as unknown as {
      provider_key: string; phone_id: number | null; sender: string | null;
      our_status: string; n: number; last_sent: string;
    }[];
    console.log("\n  BY SENDER x OUR STATUS:");
    console.log("    prov  ph#   sender          status      count   last sent (UTC)");
    for (const r of senders) {
      console.log(
        `    ${r.provider_key.padEnd(5)} ${String(r.phone_id ?? "-").padStart(4)}  ` +
        `${(r.sender ?? "(none)").padEnd(14)} ${r.our_status.padEnd(10)} ` +
        `${String(r.n).padStart(6)}   ${r.last_sent.slice(0, 19)}`,
      );
    }

    if (probeN <= 0) {
      console.log("\n(inventory only — pass --probe N to run live DLR lookups)");
      return;
    }

    // ---------- Sample ----------
    // Spread the sample across recency AND across sender numbers/accounts so a
    // single misconfigured phone can't masquerade as "DLR is broken".
    const rows = (await db.execute(sql`
      WITH candidates AS (
        SELECT
          ss.id::text            AS send_id,
          ss.org_id::text        AS org_id,
          ss.phone               AS phone,
          ss.status              AS our_status,
          ss.sent_at::text       AS sent_at,
          ss.texthub_message_id  AS message_id,
          cs.sms_provider_id     AS provider_id,
          cs.provider_phone_id   AS provider_phone_id,
          p.sms_provider_id      AS provider_key,
          p.name                 AS provider_name,
          c.brand_id             AS brand_id,
          -- Stratify by our own verdict too, so the sample is guaranteed to
          -- include sends WE recorded as failed/filtered. If TextHub reports
          -- those as DELIVERED as well, the report carries no information.
          row_number() OVER (
            PARTITION BY cs.sms_provider_id, cs.provider_phone_id, ss.status
            ORDER BY ss.sent_at DESC
          ) AS rn
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN campaigns       c  ON c.id  = ss.campaign_id
        JOIN sms_providers   p  ON p.id  = cs.sms_provider_id
        WHERE p.sms_provider_id IN ('txh', 'txh2')
          AND ss.texthub_message_id IS NOT NULL
          AND ss.sent_at >= now() - (${hours} || ' hours')::interval
      )
      SELECT * FROM candidates
      ORDER BY rn, sent_at DESC
      LIMIT ${probeN}
    `)) as unknown as SendRow[];

    console.log("\n" + "=".repeat(78));
    console.log(`Live DLR lookups — ${rows.length} message(s)`);
    console.log("=".repeat(78));

    if (rows.length === 0) {
      console.log("  Nothing to probe.");
      return;
    }

    const keyCache = new Map<string, string | null>();
    const tally = new Map<string, number>();
    const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
    const phoneTally = new Map<string, string[]>();
    const lagSamples: number[] = [];
    let phoneMatches = 0;
    let phoneChecked = 0;

    for (const r of rows) {
      const cacheKey = `${r.org_id}:${r.provider_id}:${r.brand_id}:${r.provider_phone_id}`;
      if (!keyCache.has(cacheKey)) {
        keyCache.set(
          cacheKey,
          await resolveKeyForStage(db, {
            orgId: r.org_id,
            providerId: r.provider_id,
            brandId: r.brand_id,
            providerPhoneId: r.provider_phone_id,
          }),
        );
      }
      const apiKey = keyCache.get(cacheKey) ?? null;
      if (!apiKey) {
        console.log(`  [${r.provider_key}] phone#${r.provider_phone_id ?? "-"} ${maskPhone(r.phone)} — NO KEY RESOLVED (skipped)`);
        bump("no_key");
        continue;
      }

      const res = await getDeliveryReport(apiKey, r.message_id);
      await new Promise((ok) => setTimeout(ok, REQUEST_GAP_MS));

      if (res.error) {
        console.log(`  [${r.provider_key}] ${maskPhone(r.phone)} id=${r.message_id} -> ${res.error}`);
        bump(`transport:${res.error}`);
        continue;
      }
      const p = res.parsed;
      const dlrRaw = p?.dlr;
      const verdict =
        res.httpStatus === 404
          ? "HTTP404_NO_SUCH_ID"
          : dlrRaw == null
            ? "NO_DLR_FIELD"
            : (DLR_LABEL[Number(dlrRaw)] ?? `dlr=${String(dlrRaw)}(unmapped)`);
      bump(verdict);

      // Per-number proof: the report must be about the number we sent to.
      const reported = p?.phone == null ? null : String(p.phone);
      if (reported) {
        phoneChecked++;
        const a = reported.replace(/\D/g, "").slice(-10);
        const b = String(r.phone).replace(/\D/g, "").slice(-10);
        if (a === b) phoneMatches++;
      }

      // The decisive check. Compare TextHub's OWN two timestamps against each
      // other — internally consistent, so no timezone guess is involved. A real
      // carrier receipt lands seconds-to-minutes AFTER submission and varies per
      // recipient. lag == 0 for every number in a batch means the "delivered"
      // stamp is just the submit time echoed back, i.e. synthetic.
      const sentOn = p?.sent_on == null ? null : String(p.sent_on);
      const doneOn =
        String(p?.delivered_on ?? p?.failed_on ?? p?.rejected_on ?? "") || null;
      let lag: number | null = null;
      if (sentOn && doneOn) {
        const a = Date.parse(sentOn.replace(" ", "T") + "Z");
        const b = Date.parse(doneOn.replace(" ", "T") + "Z");
        if (Number.isFinite(a) && Number.isFinite(b)) lag = (b - a) / 1000;
      }
      if (lag != null) {
        lagSamples.push(lag);
        bump(lag === 0 ? "lag:ZERO(synthetic?)" : "lag:nonzero");
      }
      const perPhone = `ph#${r.provider_phone_id ?? "-"}[${r.provider_key}]`;
      phoneTally.set(perPhone, phoneTally.get(perPhone) ?? []);
      phoneTally.get(perPhone)!.push(`${verdict}/${lag ?? "?"}s`);

      console.log(
        `  [${r.provider_key}] ph#${String(r.provider_phone_id ?? "-").padStart(4)} ${maskPhone(r.phone)} ` +
        `our=${r.our_status.padEnd(9)} HTTP ${String(res.httpStatus).padEnd(3)} ` +
        `dlr=${String(dlrRaw ?? "-").padStart(2)} ${verdict.padEnd(12)} ` +
        `sent_on=${sentOn ?? "-"} done=${doneOn ?? "-"} lag=${lag == null ? "?" : lag + "s"}`,
      );
      if (res.httpStatus !== 200 || dlrRaw == null) {
        console.log(`      raw: ${res.rawBody ?? "(empty)"}`);
      }
    }

    // Control: a syntactically-plausible id that was never minted. If this also
    // returns 200/DELIVERED, the endpoint is not looking anything up.
    const controlKey = [...keyCache.values()].find((k): k is string => !!k);
    if (controlKey) {
      const bogus = "999999999999";
      const ctl = await getDeliveryReport(controlKey, bogus);
      console.log(
        `\n  CONTROL (bogus id=${bogus}): HTTP ${ctl.httpStatus} ${ctl.rawBody ?? "(empty)"}`,
      );
    }

    console.log("\n" + "-".repeat(78));
    console.log("VERDICT TALLY");
    for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
    if (lagSamples.length) {
      const zero = lagSamples.filter((l) => l === 0).length;
      const sorted = [...lagSamples].sort((a, b) => a - b);
      console.log(
        `\n  delivery lag (TextHub sent_on -> done): min=${sorted[0]}s ` +
        `median=${sorted[Math.floor(sorted.length / 2)]}s max=${sorted[sorted.length - 1]}s ` +
        `| exactly 0s: ${zero}/${lagSamples.length}`,
      );
    }
    console.log(
      `\n  per-number match: ${phoneMatches}/${phoneChecked} reports returned the number we sent to`,
    );
    console.log("\n  BY SENDER NUMBER (verdict/lag):");
    for (const [ph, list] of [...phoneTally.entries()].sort()) {
      const counts = new Map<string, number>();
      for (const v of list) counts.set(v, (counts.get(v) ?? 0) + 1);
      const summary = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `${v}×${n}`)
        .join("  ");
      console.log(`    ${ph.padEnd(14)} ${summary}`);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("probe-texthub-dlr-recon crashed:", err);
  process.exit(1);
});
