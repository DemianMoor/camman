// scripts/test-contact-zip.ts — P3: zip as a lead field + contact_attributes.zip (0217).
// Pure part + preview DB part (rolled back).
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-contact-zip.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { ATTRIBUTE_FIELD_KEYS, normalizeAttributeValue } from "@/lib/contact-attributes";
import { normalizeLead, upsertLeadAttributes } from "@/lib/drip/enrichment";
import { canonicalFieldKey, LEAD_FIELD_KEYS } from "@/lib/intake/fields";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
class Rollback extends Error {}

async function main() {
  console.log("Pure");
  bar("Z1 zip is an intake field and a contact attribute", LEAD_FIELD_KEYS.includes("zip") && (ATTRIBUTE_FIELD_KEYS as readonly string[]).includes("zip"));
  bar("Z2 aliases: zip_code / zipcode / postal_code / postal / ZIP → zip",
    ["zip_code", "zipcode", "postal_code", "postal", "ZIP", "Zip Code"].every((k) => canonicalFieldKey(k) === "zip"));
  bar("Z3 a partner field_mapping wins (\"post\" mapped to zip)", canonicalFieldKey("post", { post: "zip" }) === "zip");
  bar("Z4 normalizeLead stores zip TRIMMED, not normalized (spec A4 normalizes at render)",
    normalizeLead({ phone: "+12025550199", zip: " 02134-1234 " }, {}).zip === "02134-1234");
  bar("Z5 normalizeLead omits an empty zip (COALESCE never blanks a known value)",
    !("zip" in normalizeLead({ phone: "+12025550199", zip: "  " }, {})));
  bar("Z6 CSV import: zip cell trimmed", normalizeAttributeValue("zip", " 02134 ") === "02134");
  // Owner 2026-10-20: a zip that lost its leading zero (JSON number, or a CSV / string cell of 3-4 digits) is left-padded.
  const z = (v: unknown) => normalizeLead({ phone: "+12025550199", zip: v }, {}).zip;
  bar("Z8 JSON number 2134 → \"02134\"", z(2134) === "02134", JSON.stringify(z(2134)));
  bar("Z9 JSON number 12345 → \"12345\" (unchanged)", z(12345) === "12345", JSON.stringify(z(12345)));
  bar("Z10 JSON number 501 → \"00501\" (3 digits padded)", z(501) === "00501", JSON.stringify(z(501)));
  bar("Z11 string \"2134\" padded the same way; ZIP+4 and letters untouched",
    z("2134") === "02134" && z("02134-1234") === "02134-1234" && z("ABC12") === "ABC12" && z(21) === "21", JSON.stringify([z("2134"), z("02134-1234"), z("ABC12"), z(21)]));
  bar("Z12 CSV import pads a 4-digit cell", normalizeAttributeValue("zip", "2134") === "02134");

  console.log(`\nPreview DB (${requirePreviewDb().label}, rolled back)`);
  try {
    await db.transaction(async (tx) => {
      const org = ((await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[])[0].id;
      const c = ((await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${org}::uuid, ${"+1904" + Date.now().toString().slice(-7)}) RETURNING id`)) as unknown as { id: string }[])[0].id;
      await upsertLeadAttributes(tx, { contactId: c, orgId: org, normalized: { zip: "02134", state: "TX" }, interestTag: "aca", partnerSlug: "t" });
      await upsertLeadAttributes(tx, { contactId: c, orgId: org, normalized: { first_name: "Ann" }, interestTag: "aca", partnerSlug: "t" });
      const row = ((await tx.execute(sql`SELECT zip, state, first_name FROM contact_attributes WHERE contact_id = ${c}::uuid`)) as unknown as { zip: string | null; state: string | null; first_name: string | null }[])[0];
      bar("Z7 enrichment upsert writes zip; a later lead without zip keeps it (COALESCE)",
        row?.zip === "02134" && row.state === "TX" && row.first_name === "Ann", JSON.stringify(row));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL GREEN (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
