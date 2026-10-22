// scripts/test-zip-backfill.ts — P3 zip backfill core (lib/drip/zip-backfill.ts) on the
// PREVIEW DB, inside one rolled-back transaction, scoped to a fixture org.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-zip-backfill.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { applyZipBackfill, planZipBackfill, withDeadlockRetry } from "@/lib/drip/zip-backfill";
import { createPartnerWithKey } from "./_partner-fixture";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
class Rollback extends Error {}

async function main() {
  console.log("Deadlock retry (pure)");
  let calls = 0;
  const ok = await withDeadlockRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    return "done";
  });
  bar("B7 a page that loses a deadlock (40P01) is retried and succeeds", ok === "done" && calls === 2, `${calls}`);
  let other = 0;
  const err = await withDeadlockRetry(async () => { other++; throw Object.assign(new Error("boom"), { code: "23505" }); }).catch((e: { code?: string }) => e.code);
  bar("B8 any other error is not retried", err === "23505" && other === 1);
  let always = 0;
  const gaveUp = await withDeadlockRetry(async () => { always++; throw Object.assign(new Error("dl"), { cause: { code: "40P01" } }); }).catch(() => "gave up");
  bar("B9 a persistent deadlock (code on .cause, as Drizzle wraps it) gives up after 3 attempts", gaveUp === "gave up" && always === 3, `${always}`);

  console.log(`\nTarget DB: ${requirePreviewDb().label}\n`);
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-7);
      const org = ((await tx.execute(sql`INSERT INTO organizations (name) VALUES (${"zipbf-" + sfx}) RETURNING id`)) as unknown as { id: string }[])[0].id;
      const plain = await createPartnerWithKey(tx, { orgId: org, slug: "zp-" + sfx, token: "tz" + sfx });
      const mapped = await createPartnerWithKey(tx, { orgId: org, slug: "zm-" + sfx, token: "tm" + sfx });
      await tx.execute(sql`UPDATE partner_keys SET field_mapping = '{"Postal_Thing": "zip"}'::jsonb WHERE id = ${mapped.keyId}`);

      let n = 0;
      /** contact + attributes row (zip given) + one inbox lead per raw payload, oldest first. */
      async function contact(zip: string | null, leads: { key: number; slug: string; raw: Record<string, unknown> }[]) {
        n++;
        const c = ((await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${org}::uuid, ${"+1905" + sfx + n}) RETURNING id`)) as unknown as { id: string }[])[0].id;
        await tx.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, zip, source) VALUES (${c}::uuid, ${org}::uuid, ${zip}, 'drip_intake')`);
        let k = 0;
        for (const l of leads) {
          k++;
          const at = new Date(Date.UTC(2026, 9, 1, 10, k)).toISOString();
          const inbox = ((await tx.execute(sql`
            INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, status)
            VALUES (${org}::uuid, ${l.key}, ${l.slug}, ${at}::timestamptz, ${JSON.stringify(l.raw)}::jsonb, 'processed') RETURNING id`)) as unknown as { id: string }[])[0].id;
          await tx.execute(sql`
            INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at, inbox_id)
            VALUES (${org}::uuid, ${c}::uuid, ${l.key}, ${l.slug}, ${at}::timestamptz, ${inbox}::uuid)`);
        }
        return c;
      }
      const P = { key: plain.keyId, slug: "zp-" + sfx };
      const M = { key: mapped.keyId, slug: "zm-" + sfx };
      const a = await contact(null, [{ ...P, raw: { phone: "x", zip: " 02134 " } }]);
      const b = await contact(null, [{ ...M, raw: { phone: "x", Postal_Thing: "10001" } }]);
      const known = await contact("99999", [{ ...P, raw: { phone: "x", zip: "12345" } }]);
      const none = await contact(null, [{ ...P, raw: { phone: "x", state: "TX" } }]);
      const olderHasZip = await contact(null, [{ ...P, raw: { phone: "x", zip: "11111" } }, { ...P, raw: { phone: "x" } }]);
      const numeric = await contact(null, [{ ...P, raw: { phone: "x", zip: 2134 } }]);
      const newerWins = await contact(null, [{ ...P, raw: { phone: "x", zip: "33333" } }, { ...P, raw: { phone: "x", Zip_Code: "22222" } }]);

      const plan = await planZipBackfill(tx, { orgId: org, afterContactId: null, limit: 100, hasZipColumn: true });
      const byId = new Map(plan.candidates.map((x) => [x.contactId, x.zip]));
      bar("B1 plan: zip from raw (trimmed), via partner field_mapping, from the newest lead that HAS one; known zips and zip-less leads excluded",
        plan.candidates.length === 5 && byId.get(numeric) === "02134" && byId.get(a) === "02134" && byId.get(b) === "10001"
          && byId.get(olderHasZip) === "11111" && byId.get(newerWins) === "22222" && !byId.has(known) && !byId.has(none),
        JSON.stringify(plan.candidates));
      bar("B2 plan scans every zip-less contact in the batch (6 of 7; the known one is not scanned)", plan.scanned === 6, `${plan.scanned}`);

      const applied = await applyZipBackfill(tx, plan.candidates);
      const knownAfter = ((await tx.execute(sql`SELECT zip FROM contact_attributes WHERE contact_id = ${known}::uuid`)) as unknown as { zip: string }[])[0].zip;
      bar("B3 apply writes 5 (incl. numeric 2134 → 02134); an already-known zip is never overwritten", applied === 5 && knownAfter === "99999", JSON.stringify({ applied, knownAfter }));

      const again = await planZipBackfill(tx, { orgId: org, afterContactId: null, limit: 100, hasZipColumn: true });
      const reapplied = await applyZipBackfill(tx, plan.candidates);
      bar("B4 idempotent: re-plan finds 0 candidates, re-apply writes 0", again.candidates.length === 0 && reapplied === 0, JSON.stringify({ again: again.candidates.length, reapplied }));

      const page1 = await planZipBackfill(tx, { orgId: org, afterContactId: null, limit: 1, hasZipColumn: true });
      bar("B5 keyset paging: limit 1 returns lastContactId to resume from", page1.scanned === 1 && page1.lastContactId != null);
      // Pre-0219 dry run (prod before the migration): no zip column ⇒ every contact is zip-less.
      const pre = await planZipBackfill(tx, { orgId: org, afterContactId: null, limit: 100, hasZipColumn: false });
      bar("B6 hasZipColumn=false ⇒ plans every contact (the 'known' one too: no column to know it from)",
        pre.scanned === 7 && pre.candidates.length === 6, JSON.stringify({ scanned: pre.scanned, n: pre.candidates.length }));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL GREEN (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
