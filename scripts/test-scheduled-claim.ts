// At-most-once verification for the scheduled-send stage claim.
//
// Proves the exact claim primitive used by lib/sends/scheduled.ts and the manual
// drain backfill — `UPDATE … SET sent_at = now() WHERE … AND sent_at IS NULL
// RETURNING id` — yields EXACTLY ONE winner when two ticks race the same row
// concurrently (two separate DB connections). Postgres row-locking serializes
// the UPDATEs; the loser re-evaluates `sent_at IS NULL` (now false) and matches
// 0 rows. Runs on an isolated throwaway table so no real data is touched.
//
// Run: npx tsx scripts/test-scheduled-claim.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const T = "_claim_race_test";
// Two independent connections = two concurrent "ticks".
const a = postgres(url, { prepare: false, max: 1 });
const b = postgres(url, { prepare: false, max: 1 });

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// The claim, parameterized by connection — mirrors the real stage claim shape.
async function claim(conn: postgres.Sql): Promise<boolean> {
  const rows = await conn`
    UPDATE ${conn(T)} SET sent_at = now()
    WHERE id = 1 AND sent_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

async function main() {
  try {
    await a`DROP TABLE IF EXISTS ${a(T)}`;
    await a`CREATE TABLE ${a(T)} (id int PRIMARY KEY, sent_at timestamptz)`;

    const ROUNDS = 10;
    let allExactlyOne = true;
    for (let i = 0; i < ROUNDS; i++) {
      // Reset to the unclaimed state, then race two concurrent claims.
      await a`INSERT INTO ${a(T)} (id, sent_at) VALUES (1, NULL)
              ON CONFLICT (id) DO UPDATE SET sent_at = NULL`;
      const [wonA, wonB] = await Promise.all([claim(a), claim(b)]);
      const winners = (wonA ? 1 : 0) + (wonB ? 1 : 0);
      if (winners !== 1) {
        allExactlyOne = false;
        console.log(`   round ${i}: winners=${winners} (A=${wonA} B=${wonB})`);
      }
    }
    check(`exactly one winner across ${ROUNDS} concurrent races`, allExactlyOne);

    // A third claim on an already-claimed row returns nothing.
    const third = await claim(a);
    check("re-claim of an already-claimed row returns empty", third === false);
  } finally {
    try {
      await a`DROP TABLE IF EXISTS ${a(T)}`;
    } catch {
      /* best-effort cleanup */
    }
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
  }

  console.log(failed === 0 ? "\nAt-most-once claim verified." : `\nFAILED: ${failed} check(s).`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Claim test crashed:", err);
  process.exit(1);
});
