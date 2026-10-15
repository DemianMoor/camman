// scripts/test-drip-hourly-room-guard.ts — PURE (no DB). Part of `npm run check:guards`.
// G1 (spec 2026-10-14 O4): every hour count lives in lib/drip/hourly-room.ts; no other lib/drip
// file may re-derive sent-in-hour / assigned / queued / pendingFresh.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

// Count-anchored (independent of FILTER / variable naming). `[^;`]` keeps a match inside one SQL template;
// the (?!min\() guard stops a count(*) column from pairing with a later min(...) FILTER column.
const IN_STMT = String.raw`(?:(?!\bmin\()[^;\x60])*?`;
export const HOUR_COUNT_SHAPES: { name: string; re: RegExp }[] = [
  { name: "assigned/queued count", re: new RegExp(String.raw`count\(\*\)${IN_STMT}hour_start\s*(=|<)\s*\$\{`, "s") },
  { name: "sent-in-hour count", re: new RegExp(String.raw`count\(\*\)${IN_STMT}first_send_at\s*(>=|>|BETWEEN)\s*\$\{`, "s") },
  { name: "pendingFresh count", re: new RegExp(String.raw`count\(\*\)${IN_STMT}routed_at\s*>=\s*\$\{${IN_STMT}(inWindow|etMin|window_start_min|window_end_min|routedInWindowSql)`, "s") },
];

// Single-statement exemptions (the statement is dropped before scanning). Each names ONE statement and why.
const EXEMPT_STATEMENTS = [
  { file: "funnel.ts", marker: "j.first_send_at >= ${dayStart}",
    why: "funnel 'today' panel: first sends in the ET DAY bucket, not an hour count" },
];

const strip = (file: string, src: string) => {
  const ex = EXEMPT_STATEMENTS.filter((e) => e.file === file);
  return ex.length === 0 ? src : src.split("`").filter((seg) => !ex.some((e) => seg.includes(e.marker))).join("`");
};
export const offenders = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([f]) => f !== "hourly-room.ts")
    .filter(([f, src]) => HOUR_COUNT_SHAPES.some(({ re }) => re.test(strip(f, src))))
    .map(([f]) => f);

const dir = join(process.cwd(), "lib", "drip");
const real: Record<string, string> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) real[f] = readFileSync(join(dir, f), "utf8");

bar("G1a real tree: only hourly-room.ts derives hour counts", offenders(real).length === 0, offenders(real).join(","));
bar("G1b every shape matches hourly-room.ts (guard is aimed at the right code)",
  HOUR_COUNT_SHAPES.every(({ re }) => re.test(real["hourly-room.ts"])));
bar("G1c exempted statement exists and is the only reason funnel.ts passes",
  real["funnel.ts"].includes(EXEMPT_STATEMENTS[0].marker) &&
  HOUR_COUNT_SHAPES.some(({ re }) => re.test(real["funnel.ts"])));

const mutate = (code: string) => offenders({ ...real, "mut.ts": code }).includes("mut.ts");
const muts: [string, string][] = [
  ["plain count of hour_start = H", "sql`SELECT count(*) FROM drip_journeys WHERE campaign_id = ${c} AND hour_start = ${h}`"],
  ["FILTER with = ANY(ids) AND hour_start = H", "sql`SELECT count(*) FILTER (WHERE j.campaign_id = ANY(${ids}) AND j.hour_start = ${h}) FROM drip_journeys j`"],
  ["queued count hour_start < H", "sql`SELECT count(*) FROM drip_journeys WHERE hour_start < ${h}`"],
  ["first_send_at count with ${start}", "sql`SELECT count(*) FROM drip_journeys WHERE first_send_at >= ${start} AND first_send_at < ${end}`"],
  ["first_send_at BETWEEN", "sql`SELECT count(*) FROM drip_journeys WHERE first_send_at BETWEEN ${a} AND ${b}`"],
  ["pendingFresh count with window predicate", "sql`SELECT count(*) FROM drip_journeys j WHERE j.routed_at >= ${h} AND (${inWindow})`"],
  ["pendingFresh count with window minutes", "sql`SELECT count(*) FROM drip_journeys j WHERE j.routed_at >= ${h} AND ${etMin} >= ${w.window_start_min}`"],
];
for (const [n, code] of muts) bar(`G1 red on: ${n}`, mutate(code));
bar("G1 green on a non-count assign UPDATE", !mutate("sql`UPDATE drip_journeys SET hour_start = ${h} WHERE routed_at >= ${h} AND (${inWindow})`"));
bar("G1 red when the day-bucket exemption is not used (same count, other marker)",
  mutate("sql`SELECT count(*) FROM drip_journeys j WHERE j.first_send_at >= ${hourStart}`"));

console.log(fail === 0 ? "All checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
