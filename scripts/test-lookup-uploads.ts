import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { createRequire } from "node:module";

import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";

// Phase 5 backend tests: csv_import precedence + coercions, preview dedupe.
// DB-level; teardown deletes only the rows this run inserted, by key.
//
// ⚠️ PREVIEW-ONLY, AND IT WRITES. `.env.local` IS PRODUCTION. Run it as:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-lookup-uploads.ts
// The `_require-preview-db` import above is the refusal; it runs before
// db/client is evaluated. (Until 2026-09-22 this file loaded `.env.local` with
// dotenv and reached db/client only through a dynamic import, which
// `check:guards` could not see — so a bare run wrote to production.)
//
// ⭐ NO TELNYX HTTP, AND NEVER THE PRODUCTION KEY (2026-09-22). previewLookup
// calls telnyxBalance(), a real GET https://api.telnyx.com/v2/balance, and
// `_env-preload` loads `.env.local`, whose TELNYX_API_KEY is the PRODUCTION
// key. Until this date every run sent that key to Telnyx, while this comment
// said "No Telnyx HTTP". Now, before any lib/telnyx module loads:
//   • TELNYX_API_KEY is overwritten with a fake key (client.ts reads it on every
//     call), and TELNYX_API_URL is dropped so the client uses its default host;
//   • fetch is wrapped: GET api.telnyx.com/v2/balance carrying the fake key gets
//     canned JSON. Any other Telnyx request is recorded and throws, and a bar
//     fails the run. Requests to other hosts pass through (this run makes none).
// A bar asserts the balance previewLookup returned is the canned one, so the
// mock is provably the path taken.
//
// ⭐ CLEANUP BY KEY, NEVER BY A SHARED NUMBER (2026-09-22). phone_lookups is
// global (PK = phone) and importCsvLookups UPSERTS on phone. The numbers used
// to be fixed (+12122000001…) and teardown deleted by them, so a real row with
// one of those numbers would have been overwritten and then deleted. Now the
// numbers come from _fictional-phones, the run refuses to start if any is in
// use (phone_lookups, lookup_queue, and contacts, which the import's sync
// writes), and teardown deletes only the phone_lookups keys this run inserted.
// carrier_classify_queue is never reached: every carrier string below is
// mapped, and a landline is not classified.
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch { /* noop */ }
// libphonenumber-js mis-resolves its metadata under tsx (works fine in Next.js). Our
// test numbers are already E.164, so stub parsePhoneNumberFromString for a US +1 form
// — validatePhone itself is exercised by the app at runtime, not the point here.
try {
  const lp = req.resolve("libphonenumber-js");
  const stubParse = (input: string) => {
    const m = /^\+?1?(\d{10})$/.exec(String(input).replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^1(\d{10})$/, "$1"));
    if (!m) return null;
    const nat = m[1];
    return { number: `+1${nat}`, country: "US", countryCallingCode: "1", nationalNumber: nat, isValid: () => true };
  };
  // @ts-expect-error minimal module stub
  req.cache[lp] = { id: lp, filename: lp, loaded: true, exports: { parsePhoneNumberFromString: stubParse } };
} catch { /* noop */ }

// ── the Telnyx mock ─────────────────────────────────────────────────────────────
const FAKE_TELNYX_KEY = "test-not-a-real-telnyx-key";
process.env.TELNYX_API_KEY = FAKE_TELNYX_KEY;
delete process.env.TELNYX_API_URL;
const CANNED_BALANCE = 4242.42;
const telnyxRequests: string[] = [];
const unexpectedTelnyx: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!/(^|\.)telnyx\.com$/i.test(url.hostname)) return realFetch(input, init);
  const call = `${init?.method ?? "GET"} ${url.host}${url.pathname}`;
  telnyxRequests.push(call);
  if (call === "GET api.telnyx.com/v2/balance" && new Headers(init?.headers).get("authorization") === `Bearer ${FAKE_TELNYX_KEY}`) {
    return Response.json({ data: { available_credit: String(CANNED_BALANCE), balance: String(CANNED_BALANCE), currency: "USD" } });
  }
  unexpectedTelnyx.push(call);
  throw new Error(`test-lookup-uploads: unexpected Telnyx request ${call}`);
}) as typeof fetch;

async function main() {
  if (process.env.TELNYX_API_KEY !== FAKE_TELNYX_KEY) {
    throw new Error("TELNYX_API_KEY is not the fake test key; refusing to load lib/telnyx");
  }
  const { importCsvLookups } = await import("@/lib/telnyx/csv-import");
  const { previewLookup } = await import("@/lib/telnyx/preview");
  const { pgArray } = await import("@/lib/telnyx/pg-array");
  const { db } = await import("@/db/client");
  const { sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✓ ${m}`);
    else { failures++; console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  };

  const [mob, noCarr, land, garbage, telnyx] = fictionalPhones(5);
  const P = { mob, noCarr, land, garbage, telnyx };
  const all = Object.values(P);
  // Before the first write: nothing real can be overwritten or deleted.
  await refuseIfPhonesInUse(db, all);
  const inserted: string[] = []; // phone_lookups PKs THIS run inserted

  try {
    // seed a telnyx row for the precedence test
    const seeded = await db.execute<{ phone: string }>(sql`
      INSERT INTO phone_lookups (phone, line_type, carrier_norm, source, lookup_status)
      VALUES (${P.telnyx}, 'mobile', 'T-Mobile', 'telnyx', 'complete') RETURNING phone`);
    inserted.push(...seeded.map((r) => r.phone));

    console.log("\ncsv_import coercions + precedence:");
    const r = await importCsvLookups([
      { phone: P.mob, line_type: "mobile", carrier: "Verizon Wireless" },
      { phone: P.noCarr, line_type: "mobile" }, // type without carrier
      { phone: P.land, line_type: "landline", carrier: "Pacific Bell" },
      { phone: P.garbage, line_type: "banana" }, // garbage line_type
      { phone: P.telnyx, line_type: "voip", carrier: "Sinch" }, // must NOT overwrite telnyx
    ]);
    // None of these existed (refuseIfPhonesInUse), so the upsert INSERTED them.
    inserted.push(P.mob, P.noCarr, P.land, P.garbage);

    const look = async (phone: string) =>
      (await db.execute<{ line_type: string; carrier_norm: string; source: string }>(sql`
        SELECT line_type, carrier_norm, source FROM phone_lookups WHERE phone = ${phone}`))[0];

    eq((await look(P.mob)), { line_type: "mobile", carrier_norm: "Verizon", source: "csv_import" }, "mobile+Verizon → csv_import Verizon");
    eq((await look(P.noCarr)).carrier_norm, "Unknown", "type WITHOUT carrier → carrier_norm Unknown");
    eq((await look(P.land)).carrier_norm, "Unknown", "landline → carrier_norm Unknown (not carrier-segmented)");
    eq((await look(P.garbage)).line_type, "unknown", "garbage line_type → 'unknown' (not rejected)");
    eq((await look(P.telnyx)), { line_type: "mobile", carrier_norm: "T-Mobile", source: "telnyx" }, "csv_import NEVER overwrites an existing telnyx row");
    eq(r.skipped_telnyx, 1, "skipped_telnyx counts the protected telnyx row");
    eq(r.written, 4, "written = the 4 non-telnyx rows");
    eq(r.contacts_synced, 0, "no contact carries a test number, so the sync touched none");

    console.log("\npreview dedupe:");
    const prev = await previewLookup([P.mob, P.mob, "not-a-phone"]);
    eq(prev.rows_in_file, 3, "rows_in_file counts raw lines");
    eq(prev.unique_numbers, 1, "same-file duplicates collapse to unique_numbers");
    eq(prev.invalid, 1, "invalid counted");
    eq(prev.cached, 1, "P.mob now cached (we wrote it above) → 1 cached");
    eq(prev.new_lookups, 0, "cached ⇒ 0 new lookups");

    console.log("\nTelnyx is mocked (no HTTP, no production key):");
    eq([prev.balance_usd, prev.balance_error], [CANNED_BALANCE, null], "the balance previewLookup returned is the canned one: the mock answered, and the request carried the fake key");
    eq(telnyxRequests, ["GET api.telnyx.com/v2/balance"], "exactly one Telnyx request was attempted: the balance GET");
    eq(unexpectedTelnyx, [], "no other Telnyx request (each would have thrown)");
  } finally {
    // teardown: the exact phone_lookups keys inserted above — never by a number
    // someone else might hold.
    if (inserted.length) {
      await db.execute(sql`DELETE FROM phone_lookups WHERE phone = ANY(${pgArray(inserted, "text")})`);
    }
    const left = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM phone_lookups WHERE phone = ANY(${pgArray(all, "text")})`);
    console.log(`\nteardown: ${left[0].n} phone_lookups row(s) from this run left behind (expected 0)`);
    if (left[0].n !== 0) failures++;
    await raw.end({ timeout: 5 });
  }

  console.log(failures === 0 ? "\nAll Phase 5 backend tests passed ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
