// P4 Task 2: the SQL twins of the tag normalizers must agree with the TS
// registry on EVERY value — a drift means the preview/preflight skip counts
// describe a different audience than the per-recipient render sends to.
// Evaluated against the preview DB (pure SELECTs over a VALUES list, no rows).
//   node scripts/with-preview-env.mjs npx tsx scripts/test-tag-sql-parity.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { TAGS } from "@/lib/messages/tags";
import { firstNameCleanLengthSql, tagMissingSql } from "@/lib/messages/tag-sql";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const FIRST_NAMES = [
  "Jose", " José ", "josé", "JOSE", "Ægir", "æsa", "李雷", "Ana李", "Zoë", "Björk", "Ştefan", "Ștefan", "Nguyễn", "Łukasz", "Øyvind",
  "Straße", "Þór", "Ðorđe", "O’Neil", "O'Neil", "Mary-Jane", "Mary–Jane", "Jean Paul", "  jean   paul ", "Jean\tPaul", "Ana Maria",
  "N/A", "n/a", "UNKNOWN", "none", "-", "", "   ", "Jo3", "J", "J.", "Al", "A.J.", "Bob 😀", "😀", "😀😀Bo",
  "Abcdefghijklmno", "Abcdefghijklmnop", "Maximilianjohnx", "Maximilianjohnxy", "  Abcdefghijklmno  ",
  "dr. smith", "MCDONALD", "mcdonald", "o'brien-smith", "Ĳsbrand", "ǅemal", "Привет", "Ἀλέξανδρος", "Chloé", "Renée", "François",
  "Ñoño", "Åsa", "Çelik", "Ölaf", "x", "--", "''", "a b",
];
const ZIPS = ["12345", " 12345 ", "12345-6789", "123456789", "1234", "123456", "1234a", "", "00501", "12345-678", "abcde", "12345 6789", "０１２３４"];
const STATES = ["TX", "tx", " Tx ", "Texas", "texas", "new  york", "New York", "new\tyork", "ZZ", "", "District of Columbia", "D.C.", "Calif", "PR", "puerto rico", "  ca  ", "Wyoming"];

async function main() {
  const corpusSize = FIRST_NAMES.length + ZIPS.length + STATES.length;
  bar(`corpus ≥ 60 values (${corpusSize})`, corpusSize >= 60);

  // One row per value; the other two columns NULL. A fake contact_attributes alias `ca`.
  const rows = [
    ...FIRST_NAMES.map((v) => ({ first_name: v, zip: null as string | null, state: null as string | null })),
    ...ZIPS.map((v) => ({ first_name: null as string | null, zip: v, state: null as string | null })),
    ...STATES.map((v) => ({ first_name: null as string | null, zip: null as string | null, state: v })),
  ];
  const values = sql.join(rows.map((r, i) => sql`(${i}::int, ${r.first_name}::text, ${r.zip}::text, ${r.state}::text)`), sql`, `);
  const out = (await db.execute(sql`
    SELECT i,
      ${tagMissingSql("first_name", "ca")} AS fn_missing,
      ${firstNameCleanLengthSql("ca")} AS fn_len,
      ${tagMissingSql("zip", "ca")} AS zip_missing,
      ${tagMissingSql("state", "ca")} AS state_missing
    FROM (VALUES ${values}) ca(i, first_name, zip, state)
    ORDER BY i
  `)) as unknown as { i: number; fn_missing: boolean; fn_len: number | null; zip_missing: boolean; state_missing: boolean }[];

  const diffs: string[] = [];
  rows.forEach((r, idx) => {
    const o = out[idx];
    if (r.first_name !== null) {
      const ts = TAGS.first_name.normalize(r.first_name);
      if ((ts === null) !== o.fn_missing) diffs.push(`first_name ${JSON.stringify(r.first_name)}: ts=${JSON.stringify(ts)} sqlMissing=${o.fn_missing}`);
      if (ts !== null && ts.length !== Number(o.fn_len)) diffs.push(`first_name ${JSON.stringify(r.first_name)}: ts len ${ts.length} sql len ${o.fn_len}`);
    }
    if (r.zip !== null) {
      const ts = TAGS.zip.normalize(r.zip);
      if ((ts === null) !== o.zip_missing) diffs.push(`zip ${JSON.stringify(r.zip)}: ts=${JSON.stringify(ts)} sqlMissing=${o.zip_missing}`);
    }
    if (r.state !== null) {
      const ts = TAGS.state.normalize(r.state);
      if ((ts === null) !== o.state_missing) diffs.push(`state ${JSON.stringify(r.state)}: ts=${JSON.stringify(ts)} sqlMissing=${o.state_missing}`);
    }
  });
  bar(`P1 missing-ness parity on all ${rows.length} values; clean length parity on every valid first name`, diffs.length === 0, diffs.join(" | "));

  // A NULL attribute (no contact_attributes row at all) is missing for every contact tag.
  const nul = (await db.execute(sql`
    SELECT ${tagMissingSql("first_name", "ca")} AS a, ${tagMissingSql("zip", "ca")} AS b, ${tagMissingSql("state", "ca")} AS c
    FROM (VALUES (NULL::text, NULL::text, NULL::text)) ca(first_name, zip, state)
  `)) as unknown as { a: boolean; b: boolean; c: boolean }[];
  bar("P2 NULL (no attributes row) ⇒ missing for first_name, zip, state", nul[0].a === true && nul[0].b === true && nul[0].c === true, JSON.stringify(nul[0]));

  const validNames = FIRST_NAMES.filter((v) => TAGS.first_name.normalize(v) !== null).length;
  bar(`P3 corpus exercises both sides (valid first names ${validNames}, missing ${FIRST_NAMES.length - validNames})`, validNames >= 15 && FIRST_NAMES.length - validNames >= 15);

  await pgConn.end({ timeout: 5 });
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await pgConn.end({ timeout: 5 }); process.exit(1); });
