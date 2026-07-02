// Verifies the contacts-list capped count: fast, and correct semantics
// (exact under the cap, capped+approx over it). Compares against the true count.
// Read-only.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const CAP = 10000;
const RUNS = 5;
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  try {
    const org = (await pg`SELECT org_id FROM contacts GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`)[0]
      .org_id as string;

    // True count (the old expensive query) for comparison.
    const trueCount = (await pg`
      SELECT count(*)::int AS n FROM contacts WHERE org_id = ${org} AND is_archived = false`)[0].n as number;

    // Capped count (new query shape) + timing.
    const times: number[] = [];
    let capped = 0;
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      capped = (await pg`
        SELECT count(*)::int AS n FROM (
          SELECT 1 FROM contacts WHERE org_id = ${org} AND is_archived = false LIMIT ${CAP + 1}
        ) t`)[0].n as number;
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const approx = capped > CAP;
    const shown = approx ? CAP : capped;
    console.log(`true count:        ${trueCount}`);
    console.log(`capped count:      ${capped}  -> display "${shown}${approx ? "+" : ""}"`);
    console.log(`capped query time: ${med(times).toFixed(1)} ms (was ~670ms for the exact count)`);
    const ok = approx ? trueCount > CAP : capped === trueCount;
    console.log(ok ? "semantics ✅" : "semantics ❌");
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
