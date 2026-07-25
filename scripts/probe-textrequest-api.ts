import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decryptCredentialKey } from "@/lib/sends/provider-credential";

// READ-ONLY RECON — Text Request API v3 shape discovery for Phase 3b (messages
// poll + webhook health) and Phase 4 (opt-out intake). GETs only: no send, no
// POST/PUT/DELETE, no spend, no DB writes. The published docs page
// (www.textrequest.com/api/v3) renders client-side and yields nothing to a
// fetcher, so the live API is the contract source of truth (same posture as the
// Ahoi Phase 0 recon).
//
// Run: npx tsx scripts/probe-textrequest-api.ts
//
// Never prints the api key. Response bodies (the operator's own account data)
// print truncated so field names are discoverable without dumping the account.

const BASE = process.env.TEXTREQUEST_API_BASE_URL ?? "https://api.textrequest.com/api/v3";
const TIMEOUT_MS = 20000;
const BODY_PRINT_LIMIT = 2000;

async function get(apiKey: string, path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    let raw: string | null = null;
    try {
      raw = await res.text();
    } catch {
      raw = null;
    }
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, raw, parsed, error: null as string | null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      status: 0,
      raw: null as string | null,
      parsed: null as unknown,
      error: aborted ? "timeout" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function describe(parsed: unknown): string {
  if (parsed === null) return "(non-JSON or empty)";
  if (Array.isArray(parsed)) {
    return `array(${parsed.length}) item keys: ${
      parsed[0] && typeof parsed[0] === "object"
        ? Object.keys(parsed[0] as object).join(", ")
        : typeof parsed[0]
    }`;
  }
  if (typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const lines = [`object keys: ${Object.keys(o).join(", ")}`];
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) {
        lines.push(
          `  .${k} = array(${v.length})${
            v[0] && typeof v[0] === "object" ? ` item keys: ${Object.keys(v[0] as object).join(", ")}` : ""
          }`,
        );
      }
    }
    return lines.join("\n");
  }
  return `scalar(${typeof parsed})`;
}

async function probe(apiKey: string, label: string, path: string) {
  const r = await get(apiKey, path);
  console.log(`\n── ${label}`);
  console.log(`   GET ${path}`);
  console.log(`   HTTP ${r.status}${r.error ? ` (${r.error})` : ""}`);
  if (r.parsed !== null) console.log(`   ${describe(r.parsed).replace(/\n/g, "\n   ")}`);
  if (r.raw) {
    const body = r.raw.length > BODY_PRINT_LIMIT ? `${r.raw.slice(0, BODY_PRINT_LIMIT)}…[truncated]` : r.raw;
    console.log(`   body: ${body}`);
  }
  return r;
}

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const database = drizzle(client);

  const rows = (await database.execute(sql`
    SELECT pc.id, pc.org_id, pc.label, pc.api_key, pc.api_key_encrypted, pc.inbound_webhook_token
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.sms_provider_id = 'txr'
    ORDER BY pc.id
  `)) as unknown as {
    id: number;
    org_id: string;
    label: string | null;
    api_key: string | null;
    api_key_encrypted: string | null;
    inbound_webhook_token: string | null;
  }[];

  if (rows.length === 0) {
    console.error("No txr credentials found — nothing to probe.");
    await client.end();
    return;
  }

  const cred = rows[0]!;
  const apiKey = decryptCredentialKey(cred);
  if (!apiKey) {
    console.error(`Credential ${cred.id} has no usable key (check PROVIDER_CREDENTIALS_KEY).`);
    await client.end();
    return;
  }
  console.log(
    `Text Request credential ${cred.id} (${cred.label ?? "no label"}) — webhook token ${
      cred.inbound_webhook_token ? "present" : "MISSING"
    }`,
  );
  console.log(`Base: ${BASE}`);

  // 1. Dashboards (already used by the healthcheck) — confirms ids for the rest.
  const dash = await probe(apiKey, "dashboards", "/dashboards");
  const dashWrapped = dash.parsed as Record<string, unknown> | null;
  const dashArr = Array.isArray(dash.parsed)
    ? (dash.parsed as Record<string, unknown>[])
    : ((dashWrapped?.items ?? dashWrapped?.data) as Record<string, unknown>[] | undefined) ?? [];
  const dashboardIds = dashArr
    .map((d) => d.id ?? d.dashboard_id)
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
    .map(String);
  console.log(`\n   dashboard ids: ${dashboardIds.join(", ") || "(none parsed)"}`);

  const did = dashboardIds[0];
  if (!did) {
    await client.end();
    return;
  }

  // 2. Phase 3b — messages listing / reconciliation backstop. Probe the bare
  //    path first, then paging + date-window params to learn what it honors.
  await probe(apiKey, "messages (bare)", `/dashboards/${did}/messages`);
  await probe(apiKey, "messages (limit)", `/dashboards/${did}/messages?limit=3`);
  await probe(apiKey, "messages (page+size)", `/dashboards/${did}/messages?page=1&page_size=3`);
  await probe(apiKey, "messages (date window)", `/dashboards/${did}/messages?start=2026-07-24&end=2026-07-25`);
  await probe(apiKey, "messages (inbound filter?)", `/dashboards/${did}/messages?direction=in&limit=3`);

  // 3. Phase 3b — account webhook (hook) registration + health.
  await probe(apiKey, "hooks (dashboard-scoped)", `/dashboards/${did}/hooks`);
  await probe(apiKey, "hooks (account-level)", `/hooks`);

  // 4. Phase 4 — opt-out signals: contacts + the opted-out filter.
  await probe(apiKey, "contacts (bare)", `/contacts?limit=3`);
  await probe(apiKey, "contacts (opted out)", `/contacts?has_opted_out=true&limit=3`);
  await probe(apiKey, "contacts (dashboard-scoped)", `/dashboards/${did}/contacts?limit=3`);

  // 5. Conversations — the other place TR exposes inbound replies.
  await probe(apiKey, "conversations", `/dashboards/${did}/conversations?limit=3`);

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
