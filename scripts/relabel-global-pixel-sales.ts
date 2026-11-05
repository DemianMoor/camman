// One-time relabel (owner ruling 2026-11-05): the Affiliati GLOBAL pixel's
// "sales" on offers 170/171 were form submits, so they become Lead.
//
//   dry run (default, read-only):
//     npx tsx --conditions=react-server scripts/relabel-global-pixel-sales.ts
//   apply (ATTENDED ONLY — the owner's "go now" within 30 min, CLAUDE.md §14):
//     npx tsx --conditions=react-server scripts/relabel-global-pixel-sales.ts --apply --ids <ids from the dry run>
//   verify after the next Keitaro poll (read-only):
//     npx tsx --conditions=react-server scripts/relabel-global-pixel-sales.ts --verify --ids <same ids>
//
// Candidates: approved/pending Purchase rows stored under 170/171 whose Keitaro
// type is `sale` and whose raw params do NOT carry our marker (from=<network code>).
//
// --apply refuses unless --ids equals the candidate list EXACTLY (no drift since
// the dry run). Order is load-bearing:
//   1. DB first: event_type_id → the org's `lead` type, updated_at bumped. The
//      event type is locked once set, so the later re-poll then agrees instead
//      of raising a type conflict.
//   2. Keitaro re-post per row on the Affiliati network template: same subid +
//      tid, status=lead, payout = the ORIGINAL raw payout (e.g. 1.4165, not the
//      rounded revenue). No `from` — these are global-pixel conversions.
// Revenue is unchanged (Lead counts revenue); only the type moves.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";

const ORG = "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERIFY = args.includes("--verify");
const idsArg = args.includes("--ids") ? args[args.indexOf("--ids") + 1] ?? "" : "";
const wantIds = idsArg
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)
  .sort((a, b) => a - b);

type Row = {
  id: number;
  offer_id: number;
  tid: string | null;
  subid: string | null;
  raw_payout: string | null;
  revenue: string;
  status: string;
  etype: string | null;
  ktype: string;
  conflict: number | null;
  occurred_et: string;
};

const select = (where: ReturnType<typeof sql>) => sql`
  SELECT ce.id::int AS id, ce.offer_id, ce.tid, ce.keitaro_click_subid AS subid,
         ce.raw_params->>'payout' AS raw_payout, ce.revenue::text AS revenue, ce.status,
         et.key AS etype, ce.keitaro_type AS ktype, ce.conflicting_event_type_id AS conflict,
         to_char(ce.occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS occurred_et
  FROM conversion_events ce
  LEFT JOIN event_types et ON et.id = ce.event_type_id
  JOIN offers o ON o.id = ce.offer_id
  LEFT JOIN affiliate_networks n ON n.id = o.network_id
  WHERE ce.org_id = ${ORG}::uuid AND ${where}
  ORDER BY ce.id`;

const CANDIDATES = sql`ce.offer_id IN (170, 171)
  AND et.key = 'purchase' AND ce.status IN ('approved', 'pending') AND ce.keitaro_type = 'sale'
  AND lower(trim(coalesce(ce.raw_params->>'from', ''))) IS DISTINCT FROM lower(trim(n.network_id))`;

const print = (rows: Row[]) => {
  for (const r of rows) {
    console.log(
      `  ${r.id}  offer ${r.offer_id}  ${r.occurred_et} ET  tid ${r.tid}  subid ${r.subid}  ${r.etype}/${r.status}  ` +
        `keitaro ${r.ktype}  revenue ${r.revenue}  raw payout ${r.raw_payout}${r.conflict ? `  CONFLICT→${r.conflict}` : ""}`,
    );
  }
  const total = rows.reduce((a, r) => a + Number(r.revenue), 0);
  console.log(`  ${rows.length} row(s), $${total.toFixed(2)}`);
};

async function keitaroTemplate(): Promise<URL> {
  const base = (process.env.KEITARO_API_URL ?? "https://admin.gdkn.org").replace(/\/+$/, "");
  const key = process.env.KEITARO_API_KEY;
  if (!key) throw new Error("KEITARO_API_KEY is not set");
  const res = await fetch(`${base}/admin_api/v1/affiliate_networks`, { headers: { "Api-Key": key } });
  if (!res.ok) throw new Error(`Keitaro affiliate_networks ${res.status}`);
  const nets = (await res.json()) as { id: number; name: string; postback_url: string }[];
  const afl = nets.filter((x) => /affiliati/i.test(x.name));
  if (afl.length !== 1) throw new Error(`expected 1 Affiliati network in Keitaro, found ${afl.length}`);
  return new URL(afl[0].postback_url.split("?")[0]);
}
// Never print the postback key segment.
const redact = (u: string) => u.replace(/(https?:\/\/[^/]+\/)[^/]+(\/postback)/, "$1<key>$2");

async function main() {
  if (VERIFY) {
    if (wantIds.length === 0) throw new Error("--verify needs --ids");
    const rows = (await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return tx.execute(select(sql`ce.id IN ${sql.raw(`(${wantIds.join(",")})`)}`));
    })) as unknown as Row[];
    print(rows);
    const bad = rows.filter((r) => r.etype !== "lead" || r.ktype !== "lead" || r.conflict !== null);
    console.log(
      bad.length === 0 && rows.length === wantIds.length
        ? "\nVERIFIED: every row is Lead in CamMan AND in Keitaro, no type conflict"
        : `\nNOT YET: ${bad.length} row(s) not Lead/lead or conflicted (Keitaro poll runs every 5 min)`,
    );
    return;
  }

  const rows = (await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return tx.execute(select(CANDIDATES));
  })) as unknown as Row[];
  console.log("Candidates (global-pixel sales on 170/171):");
  print(rows);
  console.log(`\nids: ${rows.map((r) => r.id).join(",")}`);
  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply --ids <ids above> on the owner's go.");
    return;
  }

  const haveIds = rows.map((r) => r.id);
  if (haveIds.join(",") !== wantIds.join(",")) {
    throw new Error(`--ids does not match the current candidates (drift). have ${haveIds.join(",")} want ${wantIds.join(",")}`);
  }
  if (rows.some((r) => !r.tid || !r.subid || r.raw_payout === null)) {
    throw new Error("a candidate lacks tid, subid or raw payout — cannot re-post it with its original payout");
  }
  const template = await keitaroTemplate(); // fail BEFORE writing if Keitaro is unreachable

  // 1. DB
  const updated = (await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const res = (await tx.execute(sql`
      UPDATE conversion_events ce
      SET event_type_id = (SELECT id FROM event_types WHERE org_id = ${ORG}::uuid AND key = 'lead'),
          updated_at = now()
      WHERE ce.org_id = ${ORG}::uuid
        AND ce.id IN ${sql.raw(`(${wantIds.join(",")})`)}
        AND ce.event_type_id = (SELECT id FROM event_types WHERE org_id = ${ORG}::uuid AND key = 'purchase')
      RETURNING ce.id`)) as unknown as { id: number }[];
    if (res.length !== wantIds.length) throw new Error(`updated ${res.length} of ${wantIds.length} — rolled back`);
    return res.length;
  })) as number;
  console.log(`\n1. DB: ${updated} row(s) → Lead (committed)`);

  // 2. Keitaro
  console.log("2. Keitaro re-posts:");
  let failures = 0;
  for (const r of rows) {
    const u = new URL(template);
    u.searchParams.set("subid", r.subid!);
    u.searchParams.set("tid", r.tid!);
    u.searchParams.set("status", "lead");
    u.searchParams.set("payout", r.raw_payout!);
    const res = await fetch(u);
    if (!res.ok) failures++;
    console.log(`  ${r.id}  ${res.status}  ${redact(u.toString())}`);
  }
  console.log(
    failures === 0
      ? "\nDONE. After the next 5-min Keitaro poll run --verify with the same ids."
      : `\n${failures} re-post(s) FAILED — the DB rows are already Lead; re-post those tids before verifying.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
