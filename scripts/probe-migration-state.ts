import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const rows = (await d.execute(sql`
    SELECT id, hash, to_timestamp(created_at/1000)::text AS applied_at
    FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 8
  `)) as unknown as Record<string, unknown>[];
  console.table(rows.map(r => ({ id: r.id, applied_at: r.applied_at, hash: String(r.hash).slice(0, 12) })));
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
