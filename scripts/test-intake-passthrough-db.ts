import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { insertLeadEvent } from "@/lib/drip/enrichment";
import { captureLeads, leadResponseEntries, prepareLead } from "@/lib/intake/capture";
import { partnerKeyUpdateSchema } from "@/lib/validators/partner-keys";
import { createPartnerWithKey } from "./_partner-fixture";

// Passthrough capture, end to end through the intake write path (I1-I7).
//
// Preview DB only, ONE transaction, rolled back. runEnrichmentBatch is NOT
// driven here: it claims the oldest org's leads off the shared preview DB, which
// cannot be confined to fixture rows. I2 instead exercises insertLeadEvent, the
// exact statement runEnrichmentBatch calls, on a fixture inbox row.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const AT = new Date("2026-10-30T12:00:00Z");
const PHONE = "+15555550101";

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0]?.id;
      if (!orgId) throw new Error("no organization in the preview database");

      const mk = async (slug: string, fields: string[]) => {
        const f = await createPartnerWithKey(tx, { orgId, slug, sandbox: true });
        await tx.execute(sql`UPDATE partner_keys SET passthrough_fields = ${JSON.stringify(fields)}::jsonb WHERE id = ${f.keyId}`);
        return {
          keyId: f.keyId, slug,
          key: {
            field_mapping: {}, interest_tag_mode: "default" as const, interest_tag: null,
            sandbox: true, passthrough_fields: fields,
          },
        };
      };
      const capture = async (k: Awaited<ReturnType<typeof mk>>, payloads: unknown[]) => {
        const prepared = payloads.map((p) => prepareLead(p, k.key, AT));
        const results = await captureLeads(tx, {
          orgId, partnerKeyId: k.keyId, partnerSlug: k.slug, sandbox: true, leads: prepared, receivedAt: AT,
        });
        return { prepared, results };
      };
      const inbox = async (id: string) =>
        ((await tx.execute(sql`SELECT raw, partner_data, status FROM lead_inbox WHERE id = ${id}::uuid`)) as unknown as
          { raw: Record<string, unknown>; partner_data: Record<string, string> | null; status: string }[])[0];

      // I1
      console.log("\nI1 whitelisted fields land in partner_data; raw is untouched:");
      const a = await mk("pt-a", ["list_id", "relay_lead_id"]);
      const r1 = await capture(a, [{ phone: PHONE, list_id: "L1", relay_lead_id: "R1", reference_id: "x" }]);
      const row1 = await inbox(r1.results[0].id);
      check("partner_data", row1.partner_data, { list_id: "L1", relay_lead_id: "R1" });
      check("raw still carries reference_id", row1.raw.reference_id, "x");

      // I2
      console.log("\nI2 the enrichment ledger insert carries partner_data:");
      const c = (await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${PHONE}) RETURNING id`)) as unknown as { id: string }[];
      const full = ((await tx.execute(sql`
        SELECT id, partner_key_id, partner_slug, interest_tag, received_at, sandbox, partner_data
        FROM lead_inbox WHERE id = ${r1.results[0].id}::uuid`)) as unknown as Parameters<typeof insertLeadEvent>[2][])[0];
      await insertLeadEvent(tx, orgId, full, c[0].id, "mobile");
      const ev = (await tx.execute(sql`SELECT partner_data FROM lead_events WHERE inbox_id = ${r1.results[0].id}::uuid`)) as unknown as { partner_data: unknown }[];
      check("lead_events.partner_data equals the inbox value", ev[0]?.partner_data, row1.partner_data);

      // I3
      console.log("\nI3 duplicate keeps the first value:");
      const r3 = await capture(a, [{ phone: PHONE, list_id: "L1", relay_lead_id: "R2" }]);
      check("duplicate", r3.results[0].duplicate, true);
      check("same row", r3.results[0].id, r1.results[0].id);
      check("stored data still R1", (await inbox(r1.results[0].id)).partner_data, { list_id: "L1", relay_lead_id: "R1" });

      // I4
      console.log("\nI4 oversize value: lead received, warning reported:");
      const b = await mk("pt-b", ["list_id"]);
      const r4 = await capture(b, [{ phone: "+15555550102", list_id: "x".repeat(257) }]);
      check("status received", r4.results[0].status, "received");
      check("warning in response entry", leadResponseEntries(r4.results, r4.prepared)[0].warnings,
        ["list_id: value longer than 256 characters"]);
      check("partner_data NULL (value dropped)", (await inbox(r4.results[0].id)).partner_data, null);

      // I5
      console.log("\nI5 empty whitelist: NULL partner_data, response shape unchanged:");
      const e = await mk("pt-e", []);
      const r5 = await capture(e, [
        { phone: "+15555550103", list_id: "L1" },
        { phone: "+1555", list_id: "L1" },
      ]);
      check("partner_data NULL", (await inbox(r5.results[0].id)).partner_data, null);
      const entries = leadResponseEntries(r5.results, r5.prepared);
      check("ok lead keys exactly id,status,duplicate", Object.keys(entries[0]), ["id", "status", "duplicate"]);
      check("rejected lead keys: error added, no warnings", Object.keys(entries[1]), ["id", "status", "duplicate", "error"]);

      // I6
      console.log("\nI6 PATCH validator rejects a built-in field name:");
      const p6 = partnerKeyUpdateSchema.safeParse({ passthrough_fields: ["zip"] });
      check("rejected", p6.success, false);
      check("message names the built-in field", !p6.success && p6.error.issues[0]?.message, "zip is already a built-in field");
      check("valid list accepted", partnerKeyUpdateSchema.safeParse({ passthrough_fields: ["list_id"] }).success, true);

      // I7
      console.log("\nI7 rejected lead still stores partner_data:");
      const r7 = await capture(a, [{ phone: "+1555", list_id: "L7", relay_lead_id: "R7" }]);
      const row7 = await inbox(r7.results[0].id);
      check("status rejected", row7.status, "rejected");
      check("partner_data stored", row7.partner_data, { list_id: "L7", relay_lead_id: "R7" });

      throw new Error("ROLLBACK");
    });
  } catch (err) {
    if ((err as Error).message !== "ROLLBACK") throw err;
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
