// Verifies migration 0108 added creatives.allow_multi_segment (boolean, NOT
// NULL, default false). Schema-only check (information_schema) — no writes
// to the shared prod creatives table. Run AFTER the migration is applied.
// Run: npx tsx scripts/test-creatives-allow-multi-segment-column.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const col = await sql`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'creatives' AND column_name = 'allow_multi_segment'
  `;
  check("column exists", col.length === 1, JSON.stringify(col));
  check("type is boolean", col[0]?.data_type === "boolean");
  check("NOT NULL", col[0]?.is_nullable === "NO");
  check("default is false", (col[0]?.column_default ?? "").toLowerCase().startsWith("false"));
  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
