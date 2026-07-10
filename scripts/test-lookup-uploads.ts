// Phase 5 backend tests: csv_import precedence + coercions, backfill sampling,
// preview dedupe. DB-level, test rows cleaned up in finally. No Telnyx HTTP.
// Run: npx tsx scripts/test-lookup-uploads.ts
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
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

async function main() {
  const { importCsvLookups } = await import("@/lib/telnyx/csv-import");
  const { previewLookup } = await import("@/lib/telnyx/preview");
  const { previewBackfill, runBackfill } = await import("@/lib/telnyx/backfill");
  const { pgArray } = await import("@/lib/telnyx/pg-array");
  const { db } = await import("@/db/client");
  const { sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✓ ${m}`);
    else { failures++; console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  };

  const P = { mob: "+12122000001", noCarr: "+12122000002", land: "+12122000003", garbage: "+12122000004", telnyx: "+12122000005" };
  const all = Object.values(P);
  const batchIds: string[] = [];

  try {
    // precondition: none of the test phones are real contacts (so sync touches nothing)
    const collide = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM contacts WHERE phone_number = ANY(${pgArray(all, "text")})`);
    if (collide[0].n !== "0") throw new Error("test phones collide with real contacts — pick others");

    // seed a telnyx row for the precedence test
    await db.execute(sql`
      INSERT INTO phone_lookups (phone, line_type, carrier_norm, source, lookup_status)
      VALUES (${P.telnyx}, 'mobile', 'T-Mobile', 'telnyx', 'complete')`);

    console.log("\ncsv_import coercions + precedence:");
    const r = await importCsvLookups([
      { phone: P.mob, line_type: "mobile", carrier: "Verizon Wireless" },
      { phone: P.noCarr, line_type: "mobile" }, // type without carrier
      { phone: P.land, line_type: "landline", carrier: "Pacific Bell" },
      { phone: P.garbage, line_type: "banana" }, // garbage line_type
      { phone: P.telnyx, line_type: "voip", carrier: "Sinch" }, // must NOT overwrite telnyx
    ]);

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

    console.log("\npreview dedupe:");
    const prev = await previewLookup([P.mob, P.mob, "not-a-phone"]);
    eq(prev.rows_in_file, 3, "rows_in_file counts raw lines");
    eq(prev.unique_numbers, 1, "same-file duplicates collapse to unique_numbers");
    eq(prev.invalid, 1, "invalid counted");
    eq(prev.cached, 1, "P.mob now cached (we wrote it above) → 1 cached");
    eq(prev.new_lookups, 0, "cached ⇒ 0 new lookups");

    console.log("\nbackfill preview + sampled run:");
    const org = await db.execute<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
    const bp = await previewBackfill(org[0].id, 500);
    eq(bp.to_run, Math.min(500, bp.distinct_phones_needing), "to_run = min(sampleLimit, needing)");
    eq(bp.eta_days, bp.daily_cap > 0 ? Math.ceil(bp.to_run / bp.daily_cap) : 0, "eta_days = ceil(to_run / daily_cap)");
    console.log(`  · needing=${bp.distinct_phones_needing} archived_excluded=${bp.archived_excluded} to_run=${bp.to_run} eta=${bp.eta_days}d`);
    const run = await runBackfill(org[0].id, 2);
    batchIds.push(run.batchId);
    eq(run.enqueued <= 2, true, "sampled backfill enqueues ≤ sampleLimit (random sample, not first-N)");
  } finally {
    // Deleting the batch cascades its lookup_queue rows (the 2 sampled real phones).
    if (batchIds.length) await db.execute(sql`DELETE FROM lookup_batches WHERE id = ANY(${pgArray(batchIds, "uuid")})`);
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone = ANY(${pgArray(all, "text")})`);
    await raw.end({ timeout: 5 });
  }

  console.log(failures === 0 ? "\nAll Phase 5 backend tests passed ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
