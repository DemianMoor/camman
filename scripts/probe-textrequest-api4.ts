import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decryptCredentialKey } from "@/lib/sends/provider-credential";

// READ-ONLY RECON round 4 — is the contacts collection's recency filter honored?
// The Phase 4 opt-out backstop polls `has_opted_out=true`, but Text Request
// exposes no ordering and no opted-out-date filter, so an unfiltered sweep would
// re-read EVERY opted-out contact the account has ever had, forever. If
// `last_message_received_after` narrows server-side, the sweep can stay bounded.
//
// Parse test: a far-FUTURE bound must return 0 rows. TR silently IGNORES unknown
// params (proven in rounds 1-2), so "0 rows" means parsed-and-applied while
// "all rows" means ignored.
//
// Run: npx tsx scripts/probe-textrequest-api4.ts [dashboardId]

const BASE = process.env.TEXTREQUEST_API_BASE_URL ?? "https://api.textrequest.com/api/v3";

async function get(apiKey: string, path: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  const raw = await res.text().catch(() => "");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const meta = (parsed?.meta ?? null) as { total_items?: number } | null;
  const items = Array.isArray(parsed?.items) ? (parsed!.items as Record<string, unknown>[]) : [];
  return { status: res.status, total: meta?.total_items ?? null, n: items.length };
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

  console.log(`Dashboard ${did} — contacts recency filters (0 rows = param honored)\n`);
  for (const qs of [
    "?page_size=5",
    "?page_size=5&last_message_received_after=2030-01-01T00:00:00Z",
    "?page_size=5&last_message_received_after=2020-01-01T00:00:00Z",
    "?page_size=5&last_message_timestamp_after_utc=2030-01-01T00:00:00Z",
    "?page_size=5&contact_created_after=2030-01-01T00:00:00Z",
    "?page_size=5&has_opted_out=true&last_message_received_after=2020-01-01T00:00:00Z",
  ]) {
    const r = await get(apiKey, `/dashboards/${did}/contacts${qs}`);
    console.log(`  ${qs.replace("?page_size=5", "").padEnd(64) || "(no filter)".padEnd(64)} HTTP ${r.status} total=${r.total} n=${r.n}`);
  }

  // Same question for the messages endpoint's inbound sweep (Phase 4 signal 3b):
  // confirm message_direction=R composes with the documented date window.
  console.log("\nmessages — inbound-only sweep composes with the date window");
  for (const qs of [
    "?page_size=5&message_direction=R",
    "?page_size=5&message_direction=R&start_date=2026-07-24T00:00:00Z&end_date=2026-07-26T00:00:00Z",
    "?page_size=5&message_direction=R&start_date=2030-01-01T00:00:00Z&end_date=2030-01-02T00:00:00Z",
  ]) {
    const r = await get(apiKey, `/dashboards/${did}/messages${qs}`);
    console.log(`  ${qs.replace("?page_size=5&", "").padEnd(64)} HTTP ${r.status} total=${r.total} n=${r.n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
