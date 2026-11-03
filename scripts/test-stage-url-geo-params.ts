// 0229: per-stage "Add ZIP / State to URL" — appended by the /r/ redirect.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-stage-url-geo-params.ts
// PURE  P.*  appendGeoParams / previewLandingUrl (normalization, omit, no dupes)
// FAIL  F.*  fail-open: a throwing / hanging lookup redirects exactly as today
// DB    D.*  real lookupGeoParams + resolveAndLogClick on the preview DB, rolled back
// SRC   S.*  the minted destination is never touched
import "./_env-preload";
import "./_require-preview-db"; // MUST be second
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  appendGeoParams,
  GEO_LOOKUP_BUDGET_MS,
  lookupGeoParamsFailOpen,
  NO_GEO,
  previewLandingUrl,
} from "@/lib/links/geo-params";
import { lookupGeoParams, resolveAndLogClick, type DbOrTx } from "@/lib/links/resolve-click";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const ROLLBACK = Symbol("rollback");

const DEST = "https://www.guidekn.com/lp/aca?sub_id3=5_14296_110326_1_s1_c42";
const TODAY = `${DEST}&sub_id1=777`; // what main's resolver returns for send_token 777

function pure() {
  console.log("P — appendGeoParams / previewLandingUrl (pure)");
  bar("P1 both ⇒ &zip=…&st=…&sub_id7=…&sub_id8=… after sub_id1", appendGeoParams(TODAY, { zip: "75201", state: "TX" }) === `${TODAY}&zip=75201&st=TX&sub_id7=75201&sub_id8=TX`);
  bar("P2 none ⇒ byte-identical", appendGeoParams(TODAY, NO_GEO) === TODAY);
  bar("P3 ZIP+4 ⇒ 5 digits", appendGeoParams(TODAY, { zip: "75201-1234", state: null }) === `${TODAY}&zip=75201&sub_id7=75201`);
  bar("P4 invalid zip omitted, state kept", appendGeoParams(TODAY, { zip: "7520", state: "tx" }) === `${TODAY}&st=TX&sub_id8=TX`);
  bar("P5 state name ⇒ USPS code", appendGeoParams(TODAY, { zip: null, state: "new york" }) === `${TODAY}&st=NY&sub_id8=NY`);
  bar("P6 junk / non-US state omitted", appendGeoParams(TODAY, { zip: "n/a", state: "Ontario" }) === TODAY);
  const hand = `${DEST}&zip=10001&sub_id1=777`;
  bar("P7 hand-edited URL already carrying zip ⇒ not appended twice", appendGeoParams(hand, { zip: "75201", state: "TX" }) === `${hand}&st=TX&sub_id7=75201&sub_id8=TX`);
  const hand7 = `${DEST}&sub_id7=keep&sub_id1=777`;
  bar("P7b hand-edited URL already carrying sub_id7 ⇒ kept, not appended twice", appendGeoParams(hand7, { zip: "75201", state: "TX" }) === `${hand7}&zip=75201&st=TX&sub_id8=TX`);
  bar("P8 preview shows the sub_id1 placeholder + samples",
    previewLandingUrl(DEST, { zip: true, state: true }) === `${DEST}&sub_id1=<recipient id>&zip=75201&st=TX&sub_id7=75201&sub_id8=TX`,
    previewLandingUrl(DEST, { zip: true, state: true }));
  bar("P9 preview, state only", previewLandingUrl(DEST, { zip: false, state: true }) === `${DEST}&sub_id1=<recipient id>&st=TX&sub_id8=TX`);
  bar("P10 preview, empty destination ⇒ empty", previewLandingUrl("  ", { zip: true, state: true }) === "");
}

// A dbc that answers the code lookup with one link row and accepts the clicks
// insert — the geo lookup goes through deps, so nothing else reaches it.
function fakeDb(): DbOrTx {
  let calls = 0;
  return {
    execute: async () => (calls++ === 0
      ? [{ link_id: 1, org_id: "00000000-0000-0000-0000-000000000000", destination_url: DEST, send_token: "777", stage_id: 9, contact_id: "c" }]
      : []),
  } as unknown as DbOrTx;
}

async function failOpen() {
  console.log("F — fail-open");
  const rej = await lookupGeoParamsFailOpen(() => Promise.reject(new Error("boom")));
  bar("F1 rejected lookup ⇒ NO_GEO", rej === NO_GEO);
  const syncThrow = await lookupGeoParamsFailOpen(() => { throw new Error("sync boom"); });
  bar("F2 synchronously throwing lookup ⇒ NO_GEO", syncThrow === NO_GEO);
  const t0 = Date.now();
  const slow = await lookupGeoParamsFailOpen(() => new Promise(() => {}));
  const waited = Date.now() - t0;
  bar(`F3 hanging lookup ⇒ NO_GEO within the ${GEO_LOOKUP_BUDGET_MS}ms budget`, slow === NO_GEO && waited < GEO_LOOKUP_BUDGET_MS + 100, `${waited}ms`);

  const thrown = await resolveAndLogClick(fakeDb(), { code: "x" }, {
    lookupGeo: async () => { throw new Error("forced lookup failure"); },
  });
  bar("F4 resolveAndLogClick with a THROWING lookup still redirects, byte-identical to today",
    thrown?.destinationUrl === TODAY, thrown?.destinationUrl);
  const t1 = Date.now();
  const hung = await resolveAndLogClick(fakeDb(), { code: "x" }, { lookupGeo: () => new Promise(() => {}) });
  const hungMs = Date.now() - t1;
  bar("F5 resolveAndLogClick with a HANGING lookup redirects as today, inside the budget",
    hung?.destinationUrl === TODAY && hungMs < GEO_LOOKUP_BUDGET_MS + 100, `${hungMs}ms`);
  const empty = await resolveAndLogClick(fakeDb(), { code: "x" }, { lookupGeo: async () => NO_GEO });
  bar("F6 empty lookup ⇒ as today", empty?.destinationUrl === TODAY);
  const both = await resolveAndLogClick(fakeDb(), { code: "x" }, { lookupGeo: async () => ({ zip: "75201", state: "Texas" }) });
  bar("F7 ticked + data ⇒ …&sub_id1=777&zip=75201&st=TX&sub_id7=75201&sub_id8=TX", both?.destinationUrl === `${TODAY}&zip=75201&st=TX&sub_id7=75201&sub_id8=TX`, both?.destinationUrl);
}

async function dbParts() {
  console.log("D — preview DB (rolled back)");
  try {
    await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT l.code, l.org_id, l.stage_id, l.contact_id, l.send_token, d.url
        FROM links l JOIN link_destinations d ON d.id = l.destination_id
        ORDER BY l.id DESC LIMIT 1
      `)) as unknown as { code: string; org_id: string; stage_id: number; contact_id: string; send_token: string; url: string }[];
      const l = rows[0];
      if (!l) { bar("D0 preview has a link to test with", false); throw ROLLBACK; }
      const today = `${l.url}${l.url.includes("?") ? "&" : "?"}sub_id1=${encodeURIComponent(l.send_token)}`;

      const off = await lookupGeoParams(tx, l.org_id, Number(l.stage_id), l.contact_id);
      bar("D1 flags off (default) ⇒ lookup returns nothing to append", off.zip === null && off.state === null);
      const r0 = await resolveAndLogClick(tx, { code: l.code });
      bar("D2 flags off ⇒ redirect byte-identical to today", r0?.destinationUrl === today, r0?.destinationUrl);

      await tx.execute(sql`UPDATE campaign_stages SET url_add_zip = true, url_add_state = true WHERE id = ${l.stage_id}`);
      await tx.execute(sql`
        INSERT INTO contact_attributes (contact_id, org_id, zip, state)
        VALUES (${l.contact_id}, ${l.org_id}, '75201-0001', 'Texas')
        ON CONFLICT (contact_id) DO UPDATE SET zip = EXCLUDED.zip, state = EXCLUDED.state
      `);
      const r1 = await resolveAndLogClick(tx, { code: l.code });
      bar("D3 both ticked ⇒ …&sub_id1=…&zip=75201&st=TX&sub_id7=75201&sub_id8=TX", r1?.destinationUrl === `${today}&zip=75201&st=TX&sub_id7=75201&sub_id8=TX`, r1?.destinationUrl);

      await tx.execute(sql`UPDATE contact_attributes SET zip = NULL, state = 'XX' WHERE contact_id = ${l.contact_id}`);
      const r2 = await resolveAndLogClick(tx, { code: l.code });
      bar("D4 ticked but missing/invalid values ⇒ params omitted, still redirects", r2?.destinationUrl === today, r2?.destinationUrl);

      const minted = (await tx.execute(sql`SELECT d.url FROM links l JOIN link_destinations d ON d.id = l.destination_id WHERE l.code = ${l.code}`)) as unknown as { url: string }[];
      bar("D5 the minted link_destinations URL is unchanged", minted[0]?.url === l.url);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

function source() {
  console.log("S — source guards");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of ["lib/links/mint-link.ts", "lib/drip/mint.ts", "lib/landing-page-url.ts", "lib/sends/kickoff.ts"]) {
    const code = strip(readFileSync(f, "utf8"));
    bar(`S1 ${f} never appends zip/st (minted URL untouched)`, !/url_add_|geo-params|appendGeoParams/.test(code));
  }
  const rc = strip(readFileSync("lib/links/resolve-click.ts", "utf8"));
  const mainLookup = rc.slice(rc.indexOf("FROM links l"), rc.indexOf("LIMIT 1"));
  bar("S2 the code lookup itself does not join stage flags / attributes (fail-open lives in a separate statement)",
    !/campaign_stages|contact_attributes/.test(mainLookup));
  bar("S3 the geo lookup goes through lookupGeoParamsFailOpen", /lookupGeoParamsFailOpen\(/.test(rc));
}

async function main() {
  pure();
  await failOpen();
  await dbParts();
  source();
  await pgConn.end();
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
