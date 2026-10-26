// CSV upload of contact_attributes fields on the phone-upload screens
// (ClickUp 1amdve28hz7).
//   PURE  P.*  scanCsvAttributes / guessAttributeField / uploadAttributesSchema
//   DB    D.*  writeUploadAttributes + upsertContactAttributes on the preview DB,
//              and a tagged stage rendering the uploaded first name at
//              materialization (kickoffStageSend), inside a rolled-back tx
//              + the post-insert stats bump (D7)
//   SRC   S.*  both routes write attributes only when the request carries them;
//              both screens opt in; Import attributes keeps overwrite semantics
//   node scripts/with-preview-env.mjs npx tsx scripts/test-upload-attributes.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";

import { refuseIfPhonesInUse } from "./_fictional-phones";

// `server-only` throws under tsx and libphonenumber-js mis-resolves its
// metadata there (fine in Next.js), so both are stubbed the way
// scripts/test-lookup-uploads.ts does: US numbers → E.164. App modules load via
// dynamic import AFTER the stubs. validatePhone itself is not under test here.
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch { /* noop */ }
try {
  const lp = req.resolve("libphonenumber-js");
  const stubParse = (input: string) => {
    const d = String(input).replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
    if (!/^\d{10}$/.test(d)) return null;
    return { number: `+1${d}`, country: "US", countryCallingCode: "1", nationalNumber: d, isValid: () => true, isPossible: () => true };
  };
  // @ts-expect-error minimal module stub
  req.cache[lp] = { id: lp, filename: lp, loaded: true, exports: { parsePhoneNumberFromString: stubParse } };
} catch { /* noop */ }

let db: typeof import("@/db/client").db;
let pgConn!: typeof import("@/db/client").sql;
let guessAttributeField: typeof import("@/lib/contact-attributes").guessAttributeField;
let scanCsvAttributes: typeof import("@/lib/contact-attributes").scanCsvAttributes;
let upsertContactAttributes: typeof import("@/lib/contact-attributes-write").upsertContactAttributes;
let writeUploadAttributes: typeof import("@/lib/contact-attributes-write").writeUploadAttributes;
let kickoffStageSend: typeof import("@/lib/sends/kickoff").kickoffStageSend;
let bumpContactOrgStats: typeof import("@/lib/contact-stats").bumpContactOrgStats;
let contactBulkUploadSchema: typeof import("@/lib/validators/contacts").contactBulkUploadSchema;
async function load() {
  ({ db, sql: pgConn } = await import("@/db/client"));
  ({ guessAttributeField, scanCsvAttributes } = await import("@/lib/contact-attributes"));
  ({ upsertContactAttributes, writeUploadAttributes } = await import("@/lib/contact-attributes-write"));
  ({ kickoffStageSend } = await import("@/lib/sends/kickoff"));
  ({ contactBulkUploadSchema } = await import("@/lib/validators/contacts"));
  ({ bumpContactOrgStats } = await import("@/lib/contact-stats"));
}

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  String(input).includes("api.telegram.org")
    ? new Response(JSON.stringify({ ok: true }), { status: 200 })
    : realFetch(input, init)) as typeof fetch;

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const ROLLBACK = Symbol("rollback");

function pure() {
  console.log("P — CSV scan + schema (pure)");
  const phoneOnly = scanCsvAttributes(["phone"], [["+12127450001"], ["+12127450002"]], 0);
  bar("P1 phone-only CSV ⇒ attributes null, nothing recognized or ignored (body stays phone-only)",
    phoneOnly.attributes === null && phoneOnly.recognized.length === 0 && phoneOnly.ignored.length === 0, JSON.stringify(phoneOnly));

  const scan = scanCsvAttributes(
    ["Phone", "First Name", "ZIP", "State", "city", "notes", "first_name"],
    [["+12127450001", "Ann", "2134", "MA", "Boston", "x", "dup"], ["+12127450002", "", "", "", "NYC", "", ""], ["", "Nobody", "", "", "", "", ""]],
    0,
  );
  bar("P2 First Name / ZIP / State recognized by header",
    JSON.stringify(scan.recognized) === JSON.stringify([
      { column: "First Name", field: "first_name" }, { column: "ZIP", field: "zip" }, { column: "State", field: "state" },
    ]), JSON.stringify(scan.recognized));
  bar("P3 city, notes and a second first_name column are listed as ignored, not dropped silently",
    JSON.stringify(scan.ignored) === JSON.stringify(["city", "notes", "first_name"]), JSON.stringify(scan.ignored));
  bar("P4 rows are [phone, ...fields]; rows with no attribute value or no phone are not sent",
    JSON.stringify(scan.attributes) === JSON.stringify({ fields: ["first_name", "zip", "state"], rows: [["+12127450001", "Ann", "2134", "MA"]] }),
    JSON.stringify(scan.attributes));
  bar("P5 guess is the Import attributes one (field or label, case/punctuation-insensitive)",
    guessAttributeField("ZIP code") === "zip" && guessAttributeField("last-name") === "last_name" &&
      guessAttributeField("E-mail") === "email" && guessAttributeField("city") === null);

  const base = { phones: "+12127450001", assign_to_group_ids: [1] };
  const p0 = contactBulkUploadSchema.safeParse(base);
  bar("P6 phone-only body parses with no attributes", p0.success && p0.data.attributes === undefined);
  const bad1 = contactBulkUploadSchema.safeParse({ ...base, attributes: { fields: ["first_name"], rows: [["+12127450001"]] } });
  const bad2 = contactBulkUploadSchema.safeParse({ ...base, attributes: { fields: ["city"], rows: [["+12127450001", "Boston"]] } });
  const bad3 = contactBulkUploadSchema.safeParse({ ...base, attributes: { fields: ["zip", "zip"], rows: [["+12127450001", "1", "2"]] } });
  bar("P7 schema rejects a short row, an unknown field (city) and a duplicate field", !bad1.success && !bad2.success && !bad3.success);
}

async function dbTests() {
  console.log("\nD — writes + materialization (preview, rolled back)");
  await db.transaction(async (tx) => {
    const T = tx as unknown as typeof db;
    const one = async <X>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as X[])[0];
    const sfx = String(Date.now()).slice(-4);
    const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
    const phone = (i: number) => `+1212745${sfx.slice(0, 2)}${String(i).padStart(2, "0")}`;
    await refuseIfPhonesInUse(T, [phone(1), phone(2), phone(99)]);
    const mkContact = async (p: string) =>
      (await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${p}) RETURNING id`)).id;
    const attrs = async (id: string) =>
      one<{ first_name: string | null; zip: string | null; state: string | null; last_name: string | null; source: string | null; updated_at: string }>(
        sql`SELECT first_name, zip, state, last_name, source, updated_at::text FROM contact_attributes WHERE contact_id = ${id}::uuid`);

    // D1 new contact, CSV carries name / ZIP (leading zero lost) / state.
    const newId = await mkContact(phone(1));
    const r1 = await writeUploadAttributes(T, orgId, { fields: ["first_name", "zip", "state"], rows: [[phone(1), "Ann", "2134", "MA"]] });
    const a1 = await attrs(newId);
    bar("D1 upload creates the attributes row (ZIP zero restored, source contact_upload)",
      r1.written === 1 && a1?.first_name === "Ann" && a1.zip === "02134" && a1.state === "MA" && a1.source === "contact_upload", JSON.stringify({ r1, a1 }));

    // D2 existing contact with a stored first name: fill empty only.
    const oldId = await mkContact(phone(2));
    await tx.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, first_name, last_name, source) VALUES (${oldId}, ${orgId}, 'Maria', '', 'partner_x')`);
    const r2 = await writeUploadAttributes(T, orgId, { fields: ["first_name", "last_name", "zip"], rows: [[phone(2), "Bob", "Lee", "10001"]] });
    const a2 = await attrs(oldId);
    bar("D2 stored first name NOT overwritten; empty ZIP and blank last name filled; source kept",
      r2.written === 1 && a2?.first_name === "Maria" && a2.last_name === "Lee" && a2.zip === "10001" && a2.source === "partner_x", JSON.stringify({ r2, a2 }));

    // D3 the same upload again changes nothing and is not counted.
    const r3 = await writeUploadAttributes(T, orgId, { fields: ["first_name", "zip"], rows: [[phone(2), "Bob", "99999"]] });
    const a3 = await attrs(oldId);
    // (updated_at can't prove it here — now() is frozen inside the tx; RETURNING
    // returning no row is what proves the DO UPDATE … WHERE skipped it.)
    bar("D3 nothing left to fill ⇒ written 0 (update skipped), ZIP unchanged", r3.written === 0 && a3?.zip === "10001", JSON.stringify({ r3, a3 }));

    // D4 unreadable values are counted; unknown phones / other orgs are never written.
    const r4 = await writeUploadAttributes(T, orgId, { fields: ["dob"], rows: [[phone(1), "not a date"], [phone(99), "1990-01-01"]] });
    const r5 = await writeUploadAttributes(T, "00000000-0000-0000-0000-000000000000", { fields: ["first_name"], rows: [[phone(1), "Evil"]] });
    bar("D4 unreadable DOB counted as ignored; phone without a contact and a foreign org write nothing",
      r4.values_ignored === 1 && r4.written === 0 && r5.written === 0 && (await attrs(newId))?.first_name === "Ann", JSON.stringify({ r4, r5 }));

    // D5 Import attributes keeps overwrite semantics through the shared upsert.
    const w = await upsertContactAttributes(T, orgId, [{ contactId: oldId, values: { first_name: "Mia" } }], { mode: "overwrite", source: "csv_upload" });
    const a5 = await attrs(oldId);
    bar("D5 overwrite mode replaces the stored value and keeps unmapped fields", w === 1 && a5?.first_name === "Mia" && a5.zip === "10001", JSON.stringify(a5));

    // D6 a tagged creative renders the UPLOADED first name at materialization.
    const brand = await one<{ id: number }>(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"ua-" + sfx}, 'Acme') RETURNING id`);
    const cre = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${"uac-" + sfx}, ${orgId}, 'Hi {first_name}, sale today', 'active') RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id) VALUES (${orgId}, ${"ua-" + sfx}, 'ua', 'active', 'manual', ${brand.id}) RETURNING id`);
    const st = await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, short_url, stop_text, include_no_status, include_clickers, exclude_clickers, send_approved, scheduled_at)
      VALUES (${orgId}, ${camp.id}, 1, ${cre.id}, 'https://ex.co/abc', 'Reply STOP to opt out', true, false, false, true, now()) RETURNING id`);
    await tx.execute(sql`
      INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
      VALUES (${orgId}, ${camp.id}, ${newId}, true, false, false)`);
    const k = await kickoffStageSend(T, { orgId, campaignId: camp.id, stageId: st.id });
    const bodies = (await tx.execute(sql`SELECT rendered_text FROM stage_sends WHERE stage_id = ${st.id}`)) as unknown as { rendered_text: string }[];
    bar("D6 tagged stage materializes \"Hi Ann,\" for the uploaded contact",
      k.ok && bodies.length === 1 && bodies[0].rendered_text.includes("Hi Ann,"), JSON.stringify({ k, bodies }));

    // D7 the upload's stats bump (runs after every upload that inserts) must not
    // 500: jsonb_build_object's bound params were untyped (42P18) since 0145.
    let bumpErr = "";
    try { await bumpContactOrgStats(T, orgId, { total: 1 }); } catch (e) { bumpErr = String((e as { cause?: unknown }).cause ?? e); }
    bar("D7 bumpContactOrgStats succeeds (no 42P18 on the jsonb_build_object params)", bumpErr === "", bumpErr);

    throw ROLLBACK;
  }).catch((e) => { if (e !== ROLLBACK) throw e; });
}

function sourceBars() {
  console.log("\nS — source bars");
  const read = (p: string) => readFileSync(p, "utf8");
  const up = read("app/api/contacts/upload/route.ts");
  const grp = read("app/api/contact-groups/[id]/contacts/add/route.ts");
  bar("S1 contacts upload writes attributes only inside `if (parsed.data.attributes)`",
    /if \(parsed\.data\.attributes\) \{\s*const a = await writeUploadAttributes\(/.test(up));
  bar("S2 group add writes attributes only when the request carries them",
    /parsed\.data\.attributes\s*\?\s*await writeUploadAttributes\(/.test(grp) && grp.includes("attributes: uploadAttributesSchema.optional()"));
  bar("S3 both screens opt in with captureAttributes",
    /endpoint="\/api\/contacts\/upload"[\s\S]{0,400}captureAttributes/.test(read("app/(protected)/contacts/page.tsx")) &&
      /contacts\/add`\}[\s\S]{0,400}captureAttributes/.test(read("app/(protected)/contact-groups/[id]/page.tsx")));
  bar("S4 the form adds `attributes` to the body only when captureAttributes and the scan found values",
    /if \(captureAttributes && attributes\) \{\s*body\.attributes = attributes;/.test(read("components/phone-upload-form.tsx")));
  bar("S5 Import attributes still overwrites; uploads fill empty",
    read("app/api/contacts/import-attributes/route.ts").includes(`mode: "overwrite"`) &&
      read("lib/contact-attributes-write.ts").includes(`mode: "fill_empty", source: "contact_upload"`));
  bar("S6 group add returns duplicates_in_db + duplicates_in_input (the shared result screen renders both)",
    grp.includes("duplicates_in_db: contactsAlreadyExisted") && grp.includes("duplicates_in_input: valid.length - dedupedValid.length"));
}

(async () => {
  await load();
  pure();
  await dbTests();
  sourceBars();
  await pgConn.end();
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
