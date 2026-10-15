import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hour-overflow-schema.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const cols = (await db.execute(sql`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'org_settings' AND column_name = 'drip_routing_hour_overflow'
  `)) as unknown as { data_type: string; is_nullable: string; column_default: string | null }[];
  const c = cols[0];
  bar("S1 org_settings.drip_routing_hour_overflow exists", !!c);
  bar("S2 boolean NOT NULL DEFAULT false", c?.data_type === "boolean" && c?.is_nullable === "NO" && c?.column_default === "false");
  if (fail) process.exit(1);
  console.log("\nALL GREEN");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
