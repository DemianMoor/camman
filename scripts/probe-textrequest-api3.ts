import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decryptCredentialKey } from "@/lib/sends/provider-credential";

// READ-ONLY RECON round 3 — verify the DOCUMENTED query params actually filter.
// Rounds 1-2 guessed param names (start/end/startDate) which the API silently
// IGNORED; the OpenAPI spec (www.textrequest.com/dist/swagger/apiv3docs.json)
// names them start_date / end_date, and documents a rich contacts filter set
// (has_opted_out, is_suppressed, contact_phone_number, …). Silent-ignore is the
// dangerous failure mode here: a poll that thinks it asked for "today" but got
// "everything" looks fine until the account has 500K messages. So: prove each
// param CHANGES the result set before the poller depends on it.
//
// Run: npx tsx scripts/probe-textrequest-api3.ts [dashboardId]

const BASE = process.env.TEXTREQUEST_API_BASE_URL ?? "https://api.textrequest.com/api/v3";

async function get(apiKey: string, path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const items = Array.isArray(parsed?.items) ? (parsed!.items as Record<string, unknown>[]) : [];
    const meta = (parsed?.meta ?? null) as { total_items?: number } | null;
    return { status: res.status, items, total: meta?.total_items ?? null, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const database = drizzle(client);
  const rows = (await database.execute(sql`
    SELECT pc.api_key, pc.api_key_encrypted
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.sms_provider_id = 'txr' ORDER BY pc.id LIMIT 1
  `)) as unknown as { api_key: string | null; api_key_encrypted: string | null }[];
  const apiKey = rows[0] ? decryptCredentialKey(rows[0]) : null;
  await client.end();
  if (!apiKey) {
    console.error("no usable txr key");
    process.exit(1);
  }
  const did = process.argv[2] ?? "68093";

  console.log(`Dashboard ${did}\n\nMESSAGES — documented start_date / end_date`);
  for (const qs of [
    "?page_size=20",
    "?page_size=20&start_date=2026-07-25T00:00:00Z&end_date=2026-07-26T00:00:00Z",
    "?page_size=20&start_date=2026-07-25&end_date=2026-07-26",
    "?page_size=20&start_date=2026-07-24T00:00:00Z&end_date=2026-07-25T00:00:00Z",
    "?page_size=20&start_date=2026-07-25T00:00:00Z&end_date=2026-07-26T00:00:00Z&message_direction=R",
    "?page_size=20&start_date=2030-01-01T00:00:00Z&end_date=2030-01-02T00:00:00Z",
  ]) {
    const r = await get(apiKey, `/dashboards/${did}/messages${qs}`);
    console.log(
      `  ${qs.replace("?page_size=20", "").padEnd(78) || "(no filter)".padEnd(78)} HTTP ${r.status} total=${r.total} n=${
        r.items.length
      }  ${r.items.map((m) => `${m.message_direction}@${m.message_timestamp_utc}`).join(" ")}`,
    );
  }

  console.log("\nCONTACTS — documented filters");
  for (const qs of [
    "?page_size=20",
    "?page_size=20&has_opted_out=true",
    "?page_size=20&has_opted_out=false",
    "?page_size=20&is_suppressed=false",
    "?page_size=20&contact_phone_number=18262062523",
    "?page_size=20&contact_phone_number=19999999999",
  ]) {
    const r = await get(apiKey, `/dashboards/${did}/contacts${qs}`);
    console.log(
      `  ${qs.replace("?page_size=20", "").padEnd(46) || "(no filter)".padEnd(46)} HTTP ${r.status} total=${
        r.total
      } n=${r.items.length}  ${r.items.map((c) => `${c.phone_number}[out=${c.opted_out_utc}]`).join(" ")}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
