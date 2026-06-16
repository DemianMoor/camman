import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { resolveProviderApiKey } from "@/lib/sends/provider-credential";

// THROWAWAY DIAGNOSTIC — read-only TextHub delivery-report lookup for specific
// already-sent messages. NOT pipeline code: no poller, no migration, no schema
// change. Run: npx tsx scripts/probe-texthub-status.ts [leadPrefix...]
//
// CONFIRMED CONTRACT (swagger "Get delivery report", verified live 2026-06-16):
//   GET https://api.texthub.com/v2/?api_key=<key>&dlr=true&id=<message_id>
//     - dlr=true   selects the "Get SMS Delivery Receipt" operation
//     - id         = the message id TextHub returned on send (our
//                    stage_sends.texthub_message_id) — NOT lead_id / number /
//                    message_id (those all 404 "A message with that ID does not
//                    exist"). This was the discovery: round 1 tried the id as
//                    the dlr VALUE (?dlr=<id>) and 404'd; the id is a SEPARATE
//                    `id` param.
//   200 body (delivered):
//     {"response":"Message delivery success","message":"<sms text>",
//      "phone":"+1...","sender_id":"63109","sent_on":"YYYY-MM-DD HH:MM:SS",
//      "dlr":1,"delivered_on":"YYYY-MM-DD HH:MM:SS"}
//   404 body (unknown id): {"response":"A message with that ID does not exist"}
//
//   Verdict field: `dlr` (int) — per the DeliveryReceiptResponse schema:
//     1 = success    (delivered_on set)
//     2 = failed     (failed_on set)
//     4 / 8 = queued
//     16 = rejected  (rejected_on set)
//     0 = unknown
//   `response` is the human-readable mirror. Timestamps are provider-local (~ET).
//
// NOTE: a SEND that TextHub rejects at submit time never gets an id, so it can't
// be DLR-looked-up at all — only accepted messages have an id to query. A
// non-success DLR (2/16) is therefore a post-acceptance carrier outcome.

// dlr code → label (from the swagger DeliveryReceiptResponse enum).
const DLR_LABEL: Record<number, string> = {
  0: "UNKNOWN",
  1: "DELIVERED (success)",
  2: "FAILED",
  4: "QUEUED",
  8: "QUEUED",
  16: "REJECTED",
};

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const TIMEOUT_MS = 15000;

// Messages to look up (truncated prefixes; matched against stage_sends.lead_id).
// Override via argv.
const DEFAULT_LEAD_PREFIXES = ["b5af1211", "1ebef3fe"];

// Build the delivery-report URL. Returns the real URL + a redacted form safe to
// print (the api_key value is never logged).
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
  const { url, redacted } = buildDlrUrl(apiKey, messageId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let parsed: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { redacted, httpStatus: res.status, rawBody, parsed, error: null as string | null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      redacted,
      httpStatus: 0,
      rawBody: null,
      parsed: null as Record<string, unknown> | null,
      error: aborted ? "timeout" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

type SendRow = {
  org_id: string;
  lead_id: string | null;
  texthub_message_id: string | null;
  phone: string;
  status: string;
  last_error: string | null;
  sent_at: string | null;
  provider_id: number | null;
  brand_id: number | null;
  provider_name: string | null;
};

async function main() {
  const prefixes = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_LEAD_PREFIXES;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    for (const prefix of prefixes) {
      console.log("\n" + "=".repeat(78));
      console.log(`LEAD prefix: ${prefix}`);
      console.log("=".repeat(78));

      const rows = (await db.execute(sql`
        SELECT
          ss.org_id::text        AS org_id,
          ss.lead_id             AS lead_id,
          ss.texthub_message_id  AS texthub_message_id,
          ss.phone               AS phone,
          ss.status              AS status,
          ss.last_error          AS last_error,
          ss.sent_at             AS sent_at,
          cs.sms_provider_id     AS provider_id,
          c.brand_id             AS brand_id,
          p.name                 AS provider_name
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN campaigns c        ON c.id  = ss.campaign_id
        LEFT JOIN sms_providers p ON p.id = cs.sms_provider_id
        WHERE ss.lead_id LIKE ${prefix + "%"}
        ORDER BY ss.created_at DESC
        LIMIT 1
      `)) as unknown as SendRow[];

      const row = rows[0];
      if (!row) {
        console.log(`  No stage_sends row with lead_id LIKE '${prefix}%'.`);
        continue;
      }

      console.log("Stored record (our DB):");
      console.log(`  lead_id            : ${row.lead_id}`);
      console.log(`  texthub_message_id : ${row.texthub_message_id ?? "(null)"}`);
      console.log(`  phone              : ${row.phone}`);
      console.log(`  our status         : ${row.status}`);
      console.log(`  last_error         : ${row.last_error ?? "(none)"}`);
      console.log(`  sent_at (UTC)      : ${row.sent_at ?? "(null)"}`);
      console.log(`  provider           : ${row.provider_name ?? "(none)"} (#${row.provider_id ?? "?"})`);

      if (!row.texthub_message_id) {
        console.log("  No TextHub message id stored — this send never received one (rejected before assignment), so it cannot be DLR-looked-up.");
        continue;
      }
      if (row.provider_id == null) {
        console.log("  Stage has no provider — cannot resolve api_key.");
        continue;
      }
      const apiKey = await resolveProviderApiKey(db, {
        orgId: row.org_id,
        providerId: row.provider_id,
        brandId: row.brand_id,
      });
      if (!apiKey) {
        console.log("  Could not resolve api_key for this provider/brand.");
        continue;
      }

      const r = await getDeliveryReport(apiKey, row.texthub_message_id);
      console.log(`\n  GET delivery report  (?dlr=true&id=${row.texthub_message_id})`);
      console.log(`    URL (redacted): ${r.redacted}`);
      if (r.error) {
        console.log(`    -> ${r.error}`);
        continue;
      }
      console.log(`    HTTP ${r.httpStatus}`);
      console.log(`    RAW BODY: ${r.rawBody ?? "(empty)"}`);
      if (r.parsed) {
        const p = r.parsed;
        const dlr = p.dlr;
        const verdict =
          dlr == null
            ? "(no dlr field)"
            : (DLR_LABEL[Number(dlr)] ?? `dlr=${String(dlr)} (unmapped)`);
        console.log(`    PARSED FIELDS:`);
        console.log(`      response     : ${String(p.response ?? "")}`);
        console.log(`      dlr (verdict): ${String(dlr ?? "")}  -> ${verdict}`);
        console.log(`      sent_on      : ${String(p.sent_on ?? "")}`);
        console.log(`      delivered_on : ${String(p.delivered_on ?? "(none)")}`);
        console.log(`      failed_on    : ${String(p.failed_on ?? "(none)")}`);
        console.log(`      rejected_on  : ${String(p.rejected_on ?? "(none)")}`);
        console.log(`      phone        : ${String(p.phone ?? "")}`);
        console.log(`      sender_id    : ${String(p.sender_id ?? "")}`);
      }
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("probe-texthub-status crashed:", err);
  process.exit(1);
});
