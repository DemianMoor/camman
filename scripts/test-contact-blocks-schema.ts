// Migration 0237 (contact blocks) — schema bars. Spec V1 + the DB-level half of
// V2 (docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md).
// The helper-level D2 interaction table (lib/contacts/blocks.ts) is PR 2's bar.
//
//   T  the messaging_status trigger derives, for every transition:
//        blocked_at / archived_at set ⇒ 'blocked' (outranks landline),
//        landline ⇒ 'not_applicable', else 'eligible' — and clearing restores.
//   C  constraints: block_reason needs blocked_at and vice versa; 'deleted' is
//      never a contacts.block_reason; messaging_status accepts 'blocked'.
//   L  ledger: one ACTIVE row per (org, phone); a released row frees the slot;
//      the reason CHECK rejects 'opt_out' (dropped, D8); no FK to contacts.
//   I  lead_intake_daily / hourly have the `blocked` counter; the two partial
//      contacts indexes exist and are valid.
//
// Committed fixture on the PREVIEW DB, torn down by id.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-contact-blocks-schema.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];
const rejects = async (q: ReturnType<typeof sql>) => {
  try { await db.execute(q); return false; } catch { return true; }
};

async function main() {
  const sfx = Date.now().toString().slice(-7);
  const made = { contacts: [] as string[], blocks: [] as number[] };
  try {
    const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
    const mk = async (i: number, lineType: string) => {
      const c = await one<{ id: string; ms: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type)
        VALUES (${orgId}, ${`+1912${sfx}${i}`}, ${lineType}) RETURNING id, messaging_status AS ms`);
      made.contacts.push(c.id);
      return c;
    };
    const ms = async (id: string) =>
      (await one<{ ms: string }>(sql`SELECT messaging_status AS ms FROM contacts WHERE id = ${id}`)).ms;
    const set = (id: string, frag: ReturnType<typeof sql>) =>
      db.execute(sql`UPDATE contacts SET ${frag} WHERE id = ${id}`);

    console.log("PART T — trigger derivation");
    const mobile = await mk(1, "mobile");
    const land = await mk(2, "landline");
    bar("T1 insert: mobile ⇒ eligible, landline ⇒ not_applicable", mobile.ms === "eligible" && land.ms === "not_applicable", `${mobile.ms}/${land.ms}`);

    const steps: [string, string, ReturnType<typeof sql>, string][] = [
      ["T2 block mobile", mobile.id, sql`blocked_at = now(), block_reason = 'manual'`, "blocked"],
      ["T3 unblock mobile", mobile.id, sql`blocked_at = NULL, block_reason = NULL`, "eligible"],
      ["T4 delete (archive) mobile", mobile.id, sql`archived_at = now()`, "blocked"],
      ["T5 restore mobile", mobile.id, sql`archived_at = NULL`, "eligible"],
      ["T6 block landline (blocked outranks not_applicable)", land.id, sql`blocked_at = now(), block_reason = 'provider_list'`, "blocked"],
      ["T7 also archive the blocked landline", land.id, sql`archived_at = now()`, "blocked"],
      ["T8 unblock, still archived", land.id, sql`blocked_at = NULL, block_reason = NULL`, "blocked"],
      ["T9 restore landline ⇒ back to not_applicable", land.id, sql`archived_at = NULL`, "not_applicable"],
      ["T10 lookup turns mobile into landline", mobile.id, sql`line_type = 'landline'`, "not_applicable"],
      ["T11 …and back", mobile.id, sql`line_type = 'mobile'`, "eligible"],
      ["T12 a direct write of messaging_status is overridden", mobile.id, sql`messaging_status = 'not_applicable'`, "eligible"],
    ];
    for (const [name, id, frag, want] of steps) {
      await set(id, frag);
      const got = await ms(id);
      bar(name, got === want, `${got}`);
    }

    console.log("\nPART C — contacts constraints");
    bar("C1 block_reason without blocked_at is rejected", await rejects(sql`UPDATE contacts SET block_reason = 'manual' WHERE id = ${mobile.id}`));
    bar("C2 blocked_at without block_reason is rejected", await rejects(sql`UPDATE contacts SET blocked_at = now() WHERE id = ${mobile.id}`));
    bar("C3 'deleted' is never a contacts.block_reason", await rejects(sql`UPDATE contacts SET blocked_at = now(), block_reason = 'deleted' WHERE id = ${mobile.id}`));
    bar("C4 an unknown block_reason is rejected", await rejects(sql`UPDATE contacts SET blocked_at = now(), block_reason = 'opt_out' WHERE id = ${mobile.id}`));
    bar("C5 the contact is still eligible after the rejected writes", (await ms(mobile.id)) === "eligible");

    console.log("\nPART L — contact_blocks ledger");
    const phone = `+1913${sfx}1`;
    const a = await one<{ id: number }>(sql`
      INSERT INTO contact_blocks (org_id, phone_number, reason, source) VALUES (${orgId}, ${phone}, 'manual', 'test') RETURNING id`);
    made.blocks.push(a.id);
    bar("L1 a second ACTIVE row for the same phone is rejected",
      await rejects(sql`INSERT INTO contact_blocks (org_id, phone_number, reason) VALUES (${orgId}, ${phone}, 'deleted')`));
    await db.execute(sql`UPDATE contact_blocks SET released_at = now() WHERE id = ${a.id}`);
    const b = await one<{ id: number }>(sql`
      INSERT INTO contact_blocks (org_id, phone_number, reason) VALUES (${orgId}, ${phone}, 'deleted') RETURNING id`);
    made.blocks.push(b.id);
    bar("L2 after release, a new active row is accepted (history kept)", !!b.id);
    bar("L3 reason 'opt_out' is rejected (D8)",
      await rejects(sql`INSERT INTO contact_blocks (org_id, phone_number, reason) VALUES (${orgId}, ${`+1913${sfx}2`}, 'opt_out')`));
    const fk = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'public.contact_blocks'::regclass AND confrelid = 'public.contacts'::regclass`);
    bar("L4 contact_blocks has no FK to contacts", fk.n === 0, `${fk.n}`);

    console.log("\nPART I — counters + indexes");
    const cols = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'blocked'
        AND table_name IN ('lead_intake_daily', 'lead_intake_hourly')`);
    bar("I1 lead_intake_daily / hourly have `blocked`", cols.n === 2, `${cols.n}/2`);
    const idx = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('contacts_org_blocked_idx', 'contacts_org_archived_idx', 'contact_blocks_org_phone_active_uniq')
        AND i.indisvalid`);
    bar("I2 the partial contacts indexes and the active-row unique index are valid", idx.n === 3, `${idx.n}/3`);
  } finally {
    for (const id of made.blocks) await db.execute(sql`DELETE FROM contact_blocks WHERE id = ${id}`);
    for (const id of made.contacts) await db.execute(sql`DELETE FROM contacts WHERE id = ${id}`);
    const left = await one<{ c: number; b: number }>(sql`
      SELECT (SELECT count(*) FROM contacts WHERE phone_number LIKE ${`+1912${sfx}%`})::int AS c,
             (SELECT count(*) FROM contact_blocks WHERE phone_number LIKE ${`+1913${sfx}%`})::int AS b`);
    console.log(`\nTeardown: ${left.c + left.b} row(s) left`);
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
