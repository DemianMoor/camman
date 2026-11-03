// 0230: "Allow first name on page" + GET /api/public/first-name.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-page-first-name.ts
// DB    D.*  real lookupPageFirstName on the preview DB, rolled back
// FAIL  F.*  fail-open: a throwing / hanging lookup answers null
// ROUTE R.*  the route handler: shape, CORS, no-store, rate limit
// SRC   S.*  /r/ and the send pipeline never touch it; the name is never logged
import "./_env-preload";
import "./_require-preview-db"; // MUST be second
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";

import { db, sql as pgConn } from "@/db/client";
import {
  lookupPageFirstName,
  lookupPageFirstNameFailOpen,
  PAGE_FIRST_NAME_BUDGET_MS,
  PAGE_FIRST_NAME_ORIGINS,
} from "@/lib/links/page-first-name";
import { GET, OPTIONS } from "@/app/api/public/first-name/route";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const ROLLBACK = Symbol("rollback");

async function dbParts() {
  console.log("D — preview DB (rolled back)");
  try {
    await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT ss.id, ss.org_id, ss.stage_id, ss.contact_id
        FROM stage_sends ss
        WHERE ss.status = 'sent'
        ORDER BY (ss.link_id IS NOT NULL) DESC, ss.created_at DESC LIMIT 1
      `)) as unknown as { id: string; org_id: string; stage_id: number; contact_id: string }[];
      const s = rows[0];
      if (!s) { bar("D0 preview has a sent stage_sends row", false); throw ROLLBACK; }
      // Preview's sent rows are manual-mode (no link): attach any link, in-tx.
      await tx.execute(sql`UPDATE stage_sends SET link_id = NULL WHERE id = ${s.id}::uuid`);
      await tx.execute(sql`UPDATE campaign_stages SET allow_first_name_on_page = true WHERE id = ${s.stage_id}`);
      await tx.execute(sql`
        INSERT INTO contact_attributes (contact_id, org_id, first_name) VALUES (${s.contact_id}, ${s.org_id}, 'maria')
        ON CONFLICT (contact_id) DO UPDATE SET first_name = EXCLUDED.first_name`);
      await tx.execute(sql`UPDATE stage_sends SET sent_at = now() - interval '1 day' WHERE id = ${s.id}::uuid`);
      bar("D0 manual-mode send (no tracked link, so no sub_id1) ⇒ null", (await lookupPageFirstName(tx, s.id)) === null);
      await tx.execute(sql`UPDATE stage_sends SET link_id = (SELECT max(id) FROM links) WHERE id = ${s.id}::uuid`);
      const setName = (n: string | null) => tx.execute(sql`
        INSERT INTO contact_attributes (contact_id, org_id, first_name)
        VALUES (${s.contact_id}, ${s.org_id}, ${n})
        ON CONFLICT (contact_id) DO UPDATE SET first_name = EXCLUDED.first_name
      `);
      const sentDaysAgo = (d: number) => tx.execute(sql`
        UPDATE stage_sends SET sent_at = now() - make_interval(days => ${d}::int) WHERE id = ${s.id}::uuid`);
      const look = (t: string | null = s.id) => lookupPageFirstName(tx, t);

      await tx.execute(sql`UPDATE campaign_stages SET allow_first_name_on_page = false WHERE id = ${s.stage_id}`);
      await setName("maria");
      await sentDaysAgo(1);
      bar("D1 box unticked ⇒ null", (await look()) === null);

      await tx.execute(sql`UPDATE campaign_stages SET allow_first_name_on_page = true WHERE id = ${s.stage_id}`);
      bar("D2 ticked + sent 1 day ago + 'maria' ⇒ 'Maria' (tag normalization)", (await look()) === "Maria");
      bar("D3 upper-case token works the same", (await look(s.id.toUpperCase())) === "Maria");

      await sentDaysAgo(13);
      bar("D4 sent 13 days ago ⇒ still inside the 14-day window", (await look()) === "Maria");
      await sentDaysAgo(15);
      bar("D5 sent 15 days ago ⇒ null", (await look()) === null);
      await sentDaysAgo(1);

      await tx.execute(sql`UPDATE stage_sends SET status = 'failed' WHERE id = ${s.id}::uuid`);
      bar("D6 not status 'sent' ⇒ null", (await look()) === null);
      await tx.execute(sql`UPDATE stage_sends SET status = 'sent' WHERE id = ${s.id}::uuid`);

      for (const junk of ["n/a", "Unknown", "J0hn", "Ana李", "  ", null]) {
        await setName(junk);
        bar(`D7 unusable name ${JSON.stringify(junk)} ⇒ null`, (await look()) === null);
      }
      await setName("  mary-JANE  ");
      bar("D8 'mary-JANE' ⇒ 'Mary-Jane'", (await look()) === "Mary-Jane");

      await tx.execute(sql`DELETE FROM contact_attributes WHERE contact_id = ${s.contact_id}`);
      bar("D9 no attributes row ⇒ null", (await look()) === null);
      await setName("maria");

      for (const t of [randomUUID(), "not-a-uuid", "", "1", `${s.id}x`, null]) {
        bar(`D10 bad token ${JSON.stringify(t)} ⇒ null`, (await look(t)) === null);
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

async function failOpen() {
  console.log("F — fail-open");
  bar("F1 rejected lookup ⇒ null", (await lookupPageFirstNameFailOpen(() => Promise.reject(new Error("boom")))) === null);
  bar("F2 synchronously throwing lookup ⇒ null", (await lookupPageFirstNameFailOpen(() => { throw new Error("x"); })) === null);
  const t0 = Date.now();
  const hung = await lookupPageFirstNameFailOpen(() => new Promise(() => {}));
  const waited = Date.now() - t0;
  bar(`F3 hanging lookup ⇒ null within the ${PAGE_FIRST_NAME_BUDGET_MS}ms budget`, hung === null && waited < PAGE_FIRST_NAME_BUDGET_MS + 150, `${waited}ms`);
}

const req = (t: string, origin?: string, ip = "198.51.100.7") =>
  new NextRequest(`https://go.guidekn.com/api/public/first-name?t=${encodeURIComponent(t)}`, {
    headers: { ...(origin ? { origin } : {}), "x-real-ip": ip },
  });

async function route() {
  console.log("R — route handler");
  const r = await GET(req(randomUUID(), "https://www.guidekn.com"));
  bar("R1 unknown token ⇒ 200 {\"first_name\":null}", r.status === 200 && (await r.text()) === '{"first_name":null}');
  bar("R2 no-store, private", /no-store/.test(r.headers.get("cache-control") ?? "") && /private/.test(r.headers.get("cache-control") ?? ""));
  bar("R3 Vary: Origin", r.headers.get("vary") === "Origin");
  bar("R4 allowed origin echoed", r.headers.get("access-control-allow-origin") === "https://www.guidekn.com");
  for (const o of ["https://evil.com", "http://www.guidekn.com", "https://guidekn.com.evil.com", "https://go.guidekn.com", "null"]) {
    const x = await GET(req(randomUUID(), o));
    bar(`R5 origin ${o} ⇒ no Access-Control-Allow-Origin`, x.headers.get("access-control-allow-origin") === null);
  }
  bar("R6 allow-list is exactly the 4 brands × bare/www", PAGE_FIRST_NAME_ORIGINS.size === 8 &&
    ["guidekn.com", "lumzen.co", "fitsyou.net", "blogcascade.com"].every((d) => PAGE_FIRST_NAME_ORIGINS.has(`https://${d}`) && PAGE_FIRST_NAME_ORIGINS.has(`https://www.${d}`)));
  bar("R7 no credentials header (no cookies)", r.headers.get("access-control-allow-credentials") === null);
  const o = OPTIONS(req("", "https://lumzen.co"));
  bar("R8 OPTIONS ⇒ 204 with CORS for an allowed origin", o.status === 204 && o.headers.get("access-control-allow-origin") === "https://lumzen.co");

  // Rate limit: the 21st request in a burst from one IP gets the same answer,
  // and never reaches the DB (proved by timing: a limited call does no query).
  const ip = "203.0.113.99";
  const bodies = new Set<string>();
  for (let i = 0; i < 20; i++) bodies.add(await (await GET(req(randomUUID(), undefined, ip))).text());
  const t0 = performance.now();
  const limited = await GET(req(randomUUID(), undefined, ip));
  const limitedMs = performance.now() - t0;
  bodies.add(await limited.text());
  bar("R9 over the limit ⇒ same 200 + null body", limited.status === 200 && bodies.size === 1, [...bodies].join(" | "));
  bar("R10 over the limit ⇒ no DB round trip", limitedMs < 5, `${limitedMs.toFixed(2)}ms`);
  const other = await GET(req(randomUUID(), undefined, "203.0.113.100"));
  bar("R11 another IP is unaffected (still queried)", other.status === 200);
}

function source() {
  console.log("S — source guards");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of ["app/r/[code]/route.ts", "lib/links/resolve-click.ts", "lib/links/mint-link.ts", "lib/sends/kickoff.ts", "lib/drip/send-one.ts", "lib/drip/scheduler.ts"]) {
    const code = strip(readFileSync(f, "utf8"));
    bar(`S1 ${f} never touches the first-name lookup`, !/allow_first_name_on_page|page-first-name/.test(code));
  }
  for (const f of ["app/api/public/first-name/route.ts", "lib/links/page-first-name.ts"]) {
    const code = strip(readFileSync(f, "utf8"));
    bar(`S2 ${f} never logs the name or the token`, !/console\.\w+\([^)]*(first_?[nN]ame|token|\bt\b)/.test(code));
  }
}

async function main() {
  await dbParts();
  await failOpen();
  await route();
  source();
  await pgConn.end();
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
