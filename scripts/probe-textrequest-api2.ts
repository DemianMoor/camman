import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decryptCredentialKey } from "@/lib/sends/provider-credential";

// READ-ONLY RECON round 2 — Text Request API v3. Round 1
// (probe-textrequest-api.ts) established the envelope + resource paths; this
// round pins the contracts Phase 3b/4 actually depend on:
//   - messages: ordering, whether ANY date/direction filter is honored, paging
//   - single-message lookup (a cheaper DLR reconcile than paging the list)
//   - contacts: is a server-side opted-out / suppressed filter honored?
// GETs only. Never prints the api key.
//
// Run: npx tsx scripts/probe-textrequest-api2.ts [dashboardId]

const BASE = process.env.TEXTREQUEST_API_BASE_URL ?? "https://api.textrequest.com/api/v3";
const TIMEOUT_MS = 20000;

interface Envelope {
  items: Record<string, unknown>[];
  meta: { page?: number; page_size?: number; total_items?: number } | null;
}

async function get(apiKey: string, path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => null);
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, raw, parsed };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: 0, raw: aborted ? "timeout" : "network error", parsed: null as unknown };
  } finally {
    clearTimeout(timer);
  }
}

function envelope(parsed: unknown): Envelope {
  const o = (parsed ?? {}) as Record<string, unknown>;
  return {
    items: Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [],
    meta: (o.meta as Envelope["meta"]) ?? null,
  };
}

// Compact one-line message digest so an ordering/filter probe is readable.
function digest(items: Record<string, unknown>[]): string {
  if (items.length === 0) return "(empty)";
  return items
    .map((m) => `${String(m.message_direction ?? "?")} ${String(m.message_timestamp_utc ?? "?")}`)
    .join(" | ");
}

async function probeMessages(apiKey: string, did: string, label: string, qs: string) {
  const r = await get(apiKey, `/dashboards/${did}/messages${qs}`);
  const e = envelope(r.parsed);
  console.log(
    `  ${label.padEnd(34)} HTTP ${r.status} total=${e.meta?.total_items ?? "?"} page=${
      e.meta?.page ?? "?"
    } size=${e.meta?.page_size ?? "?"} n=${e.items.length}\n      ${digest(e.items)}`,
  );
  return e;
}

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const database = drizzle(client);
  const rows = (await database.execute(sql`
    SELECT pc.api_key, pc.api_key_encrypted
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.sms_provider_id = 'txr'
    ORDER BY pc.id LIMIT 1
  `)) as unknown as { api_key: string | null; api_key_encrypted: string | null }[];
  const apiKey = rows[0] ? decryptCredentialKey(rows[0]) : null;
  await client.end();
  if (!apiKey) {
    console.error("no usable txr key");
    process.exit(1);
  }

  const did = process.argv[2] ?? "68093";
  console.log(`Dashboard ${did} · base ${BASE}\n`);

  // --- 1. Ordering + paging -------------------------------------------------
  console.log("MESSAGES — ordering / paging");
  const first = await probeMessages(apiKey, did, "page_size=5 (default order)", "?page_size=5");
  const total = first.meta?.total_items ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / 5) - 1);
  await probeMessages(apiKey, did, `page=${lastPage}&page_size=5 (tail)`, `?page=${lastPage}&page_size=5`);
  await probeMessages(apiKey, did, "page_size=500 (max?)", "?page_size=500");

  // --- 2. Does ANY sort param work? ----------------------------------------
  console.log("\nMESSAGES — sort params (do any change the order?)");
  for (const qs of [
    "?page_size=3&sort=desc",
    "?page_size=3&order=desc",
    "?page_size=3&sort_dir=desc",
    "?page_size=3&sort_by=message_timestamp_utc&sort_dir=desc",
    "?page_size=3&orderBy=message_timestamp_utc%20desc",
  ]) {
    await probeMessages(apiKey, did, qs.replace("?page_size=3&", ""), qs);
  }

  // --- 3. Does ANY date/direction filter work? ------------------------------
  console.log("\nMESSAGES — date / direction filters (do any narrow the set?)");
  for (const qs of [
    "?page_size=5&start=2026-07-25&end=2026-07-26",
    "?page_size=5&start_utc=2026-07-25T00:00:00Z&end_utc=2026-07-26T00:00:00Z",
    "?page_size=5&startDate=2026-07-25&endDate=2026-07-26",
    "?page_size=5&from=2026-07-25&to=2026-07-26",
    "?page_size=5&since=2026-07-25T00:00:00Z",
    "?page_size=5&message_direction=R",
    "?page_size=5&direction=R",
  ]) {
    await probeMessages(apiKey, did, qs.replace("?page_size=5&", ""), qs);
  }

  // --- 4. Single-message lookup (ideal DLR reconcile backstop) --------------
  console.log("\nSINGLE MESSAGE lookup");
  const sample = first.items.find((m) => typeof m.message_id === "string");
  const mid = sample?.message_id as string | undefined;
  if (!mid) {
    console.log("  (no message_id available to probe)");
  } else {
    for (const p of [
      `/dashboards/${did}/messages/${mid}`,
      `/messages/${mid}`,
      `/dashboards/${did}/messages?message_id=${mid}`,
    ]) {
      const r = await get(apiKey, p);
      const body = r.raw && r.raw.length > 700 ? `${r.raw.slice(0, 700)}…` : r.raw;
      console.log(`  GET ${p}\n      HTTP ${r.status} ${body}`);
    }
  }

  // --- 5. Contacts: server-side opt-out filter? -----------------------------
  console.log("\nCONTACTS — opt-out / suppressed filters");
  for (const qs of [
    "?page_size=3",
    "?page_size=3&has_opted_out=true",
    "?page_size=3&is_suppressed=true",
    "?page_size=3&opted_out=true",
    "?page_size=3&suppressed=true",
  ]) {
    const r = await get(apiKey, `/dashboards/${did}/contacts${qs}`);
    const e = envelope(r.parsed);
    const flags = e.items
      .map(
        (c) =>
          `${String(c.phone_number)}[sup=${String(c.is_suppressed)},out=${String(
            c.opted_out_utc,
          )},blk=${String(c.is_blocked)}]`,
      )
      .join(" ");
    console.log(
      `  ${qs.replace("?page_size=3&", "").padEnd(24)} HTTP ${r.status} total=${
        e.meta?.total_items ?? "?"
      } n=${e.items.length}\n      ${flags || "(empty)"}`,
    );
  }

  // --- 6. Single-contact lookup (send-time / on-demand opt-out check) -------
  console.log("\nSINGLE CONTACT lookup");
  const cphone = "18262062523"; // owner test number (Personal Numbers group)
  for (const p of [
    `/dashboards/${did}/contacts/${cphone}`,
    `/dashboards/${did}/contacts?phone_number=${cphone}`,
    `/dashboards/${did}/contacts?search=${cphone}`,
  ]) {
    const r = await get(apiKey, p);
    const body = r.raw && r.raw.length > 900 ? `${r.raw.slice(0, 900)}…` : r.raw;
    console.log(`  GET ${p}\n      HTTP ${r.status} ${body}`);
  }

  // --- 7. Hooks on the sending dashboard -----------------------------------
  console.log("\nHOOKS");
  const h = await get(apiKey, `/dashboards/${did}/hooks`);
  console.log(`  GET /dashboards/${did}/hooks → HTTP ${h.status} ${h.raw}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
