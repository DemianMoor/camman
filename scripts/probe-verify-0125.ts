import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  console.table((await d.execute(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_name='counted_clickers' ORDER BY ordinal_position
  `)) as unknown as unknown[]);
  console.table((await d.execute(sql`
    SELECT indexname FROM pg_indexes WHERE tablename='counted_clickers' ORDER BY 1
  `)) as unknown as unknown[]);
  console.table((await d.execute(sql`
    SELECT relrowsecurity AS rls_enabled,
           (SELECT count(*)::int FROM pg_policies WHERE tablename='counted_clickers') AS policies
    FROM pg_class WHERE relname='counted_clickers'
  `)) as unknown as unknown[]);
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
