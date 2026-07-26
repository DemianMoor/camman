import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon: where does the messages-per-second (MPS) rate actually live,
// and is it persisted? Answers "is the MPS bug a write bug or a display bug?".
// SELECT only — no writes.
//
// Run: npx tsx scripts/probe-provider-mps-recon.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) =>
    (await d.execute(query)) as unknown as T[];

  // 1. Every column on both tables — so no MPS-ish column is missed.
  const cols = await q<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('sms_providers', 'provider_phones')
    ORDER BY table_name, ordinal_position`);

  console.log("=== 1. COLUMNS ===");
  for (const t of ["sms_providers", "provider_phones"]) {
    console.log(`\n-- ${t} --`);
    for (const r of cols.filter((x) => x.table_name === t)) {
      const mps = /second|rate|mps|throttle|speed/i.test(r.column_name)
        ? "   <== MPS-ISH"
        : "";
      console.log(
        `  ${r.column_name.padEnd(28)} ${r.data_type.padEnd(26)} null=${r.is_nullable.padEnd(3)} default=${r.column_default ?? "-"}${mps}`,
      );
    }
  }

  // 2a. Provider-level rows + every volume cap (there is no per-second column
  //     at this level post-migration 0074 — confirm that from section 1).
  const providers = await q<{
    id: number;
    sms_provider_id: string;
    name: string;
    status: string;
    supports_api_send: boolean;
    max_sends_per_run: number | null;
    max_sends_per_minute: number | null;
    max_sends_per_24h: number | null;
  }>(sql`
    SELECT id, sms_provider_id, name, status, supports_api_send,
           max_sends_per_run, max_sends_per_minute, max_sends_per_24h
    FROM sms_providers
    ORDER BY id`);

  console.log("\n=== 2a. PROVIDERS (sms_providers) ===");
  console.log(
    "id  key    name                      status    api_send  per_run  per_min  per_24h",
  );
  for (const p of providers) {
    console.log(
      `${String(p.id).padEnd(4)}${(p.sms_provider_id ?? "").padEnd(7)}${(p.name ?? "").slice(0, 25).padEnd(26)}${(p.status ?? "").padEnd(10)}${String(p.supports_api_send).padEnd(10)}${String(p.max_sends_per_run ?? "-").padEnd(9)}${String(p.max_sends_per_minute ?? "-").padEnd(9)}${String(p.max_sends_per_24h ?? "-")}`,
    );
  }

  // 2b. Phone-level rows — the level the drain actually paces from.
  const phones = await q<{
    id: number;
    phone_number: string;
    number_type: string;
    status: string;
    provider_id: number;
    provider_key: string | null;
    provider_name: string | null;
    max_sends_per_second: number | null;
    dashboard_id: string | null;
    credential_id: number | null;
    created_at: string;
  }>(sql`
    SELECT pp.id, pp.phone_number, pp.number_type, pp.status,
           pp.provider_id, p.sms_provider_id AS provider_key, p.name AS provider_name,
           pp.max_sends_per_second, pp.dashboard_id, pp.credential_id,
           pp.created_at::text AS created_at
    FROM provider_phones pp
    LEFT JOIN sms_providers p ON p.id = pp.provider_id
    ORDER BY pp.provider_id, pp.id`);

  console.log("\n=== 2b. PROVIDER PHONES (provider_phones) ===");
  console.log(
    "id   number           type        status     prov(key)        MPS     dashboard_id  cred  created_at",
  );
  for (const r of phones) {
    console.log(
      `${String(r.id).padEnd(5)}${(r.phone_number ?? "").padEnd(17)}${(r.number_type ?? "").padEnd(12)}${(r.status ?? "").padEnd(11)}${`${r.provider_id}(${r.provider_key ?? "?"})`.padEnd(17)}${String(r.max_sends_per_second ?? "NULL").padEnd(8)}${String(r.dashboard_id ?? "-").padEnd(14)}${String(r.credential_id ?? "-").padEnd(6)}${r.created_at}`,
    );
  }

  const set = phones.filter((p) => p.max_sends_per_second != null).length;
  console.log(
    `\nphones total=${phones.length} · max_sends_per_second SET on ${set} · NULL (⇒ default 10/s) on ${phones.length - set}`,
  );

  // 3. Verdict input: is anything persisted at all?
  console.log(
    `\nVERDICT: ${set > 0 ? "PERSISTED — at least one phone has a stored MPS ⇒ the write path works (at least on create); the bug is on read/display or on the edit patch" : "NOT PERSISTED — every phone is NULL ⇒ WRITE BUG, pacing is running on the 10/s default"}`,
  );

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
