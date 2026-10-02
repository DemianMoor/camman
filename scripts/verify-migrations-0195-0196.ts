import "./_env-preload";

// Window checks for migrations 0195 and 0196 (owner-approved 2026-10-02).
// Each migration is applied ALONE (one drizzle-kit transaction each) by
// running `npm run db:migrate` from the commit that adds it. Run this before
// and after each one; any ✗ means STOP — do not apply the next step.
//
//   npx tsx scripts/verify-migrations-0195-0196.ts --phase=pre195|post195|pre196|post196
//
// pre195   last applied migration is 0194; column default is still 7
// post195  0195 recorded; column default 14; no row changed (count of 7s stable)
// pre196   live CHECK list == 0196's list minus 'texted_in_last_period' (exact, ordered set)
// post196  0196 recorded; live CHECK list == 0196's list exactly
// Read-only.

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const phase = process.argv.find((a) => a.startsWith("--phase="))?.slice(8);
const WHEN = { "0194": 1793318400000, "0195": 1793404800000, "0196": 1793491200000 };
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  if (!["pre195", "post195", "pre196", "post196"].includes(phase ?? "")) {
    console.error("usage: --phase=pre195|post195|pre196|post196");
    process.exit(2);
  }
  const { db } = await import("@/db/client");
  const [last] = (await db.execute(
    sql`select max(created_at)::bigint as w from drizzle.__drizzle_migrations`,
  )) as unknown as { w: string }[];
  const [col] = (await db.execute(sql`
    select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'offer_cooldown_days'`)) as unknown as { column_default: string }[];
  const [chk] = (await db.execute(sql`
    select pg_get_constraintdef(oid) as d from pg_constraint
    where conname = 'segment_rules_rule_type_check'`)) as unknown as { d: string }[];
  const live = [...chk.d.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  const file = readFileSync("db/migrations/0196_segment_rules_texted_in_last_period.sql", "utf8");
  const listed = [...file.split("rule_type IN (")[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  console.log(`phase ${phase}: last applied ${last.w}, default ${col.column_default}, live CHECK ${live.length} values`);

  if (phase === "pre195") {
    bar("last applied migration is 0194", Number(last.w) === WHEN["0194"], last.w);
    bar("offer_cooldown_days default is 7", col.column_default === "7", col.column_default);
  }
  if (phase === "post195") {
    bar("0195 is the last applied migration", Number(last.w) === WHEN["0195"], last.w);
    bar("offer_cooldown_days default is 14", col.column_default === "14", col.column_default);
  }
  if (phase === "pre196") {
    bar("last applied migration is 0195", Number(last.w) === WHEN["0195"], last.w);
    bar("0196 adds exactly one value, 'texted_in_last_period', at the end", listed.at(-1) === "texted_in_last_period" && listed.length === live.length + 1);
    bar("0196's list = the live constraint + 'texted_in_last_period' (exact, same order)", same(live, listed.slice(0, -1)), `${live.length} live vs ${listed.length - 1}`);
  }
  if (phase === "post196") {
    bar("0196 is the last applied migration", Number(last.w) === WHEN["0196"], last.w);
    bar("live constraint == 0196's list exactly", same(live, listed), `${live.length} values`);
  }
  console.log(fail === 0 ? "\nOK" : `\n${fail} check(s) FAILED — STOP.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
