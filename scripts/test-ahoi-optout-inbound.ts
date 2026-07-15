// processAhoiInboundOptOut: keyword match -> normalize -> cross-channel
// dedup -> contact upsert -> opt_outs write -> attribution. Mirrors
// lib/sends/poll-opt-outs.ts's TextHub logic exactly (reused, not forked) —
// this test proves Ahoi's version produces the same shape of result.
// Rolled-back transaction.
// Run: npx tsx scripts/test-ahoi-optout-inbound.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { processAhoiInboundOptOut } from "@/lib/sends/ahoi-optout";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;

      // Valid 10-digit NANP numbers (area 315, exchange 586) — Section 4
      // normalizes source_number via ahoiSourceToE164 (real libphonenumber
      // validation), so fixtures MUST be genuinely valid or they'd short-
      // circuit to invalid_phone. ph(i) -> "3155861000"+i, e164(i) -> "+1"+ph(i).
      const ph = (i: number) => "315586" + (1000 + i).toString();
      const e164 = (i: number) => "+1" + ph(i);

      async function mkEvent(channel: "webhook" | "cdr", srcNum: string, message: string) {
        return one<{ id: string }>(sql`
          INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
          VALUES (${orgId}, ${channel}, ${srcNum}, ${message}, ${channel === "webhook" ? "POST" : "poll"}, now())
          RETURNING id`);
      }

      // ---- Case A: non-STOP message -> ignored, no writes. ----
      const evA = await mkEvent("webhook", ph(0), "Hello there");
      const rA = await processAhoiInboundOptOut(tx, {
        eventId: evA.id, orgId, sourceNumber: ph(0), message: "Hello there",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check("non-STOP -> ignored", rA.kind === "ignored", JSON.stringify(rA));
      const rowA = await one<{ result: string }>(sql`SELECT result FROM ahoi_inbound_events WHERE id = ${evA.id}`);
      check("event row marked result='ignored'", rowA.result === "ignored");

      // ---- Case B: STOP for a MATCHED (pre-existing) contact -> suppressed + attributed. ----
      const phoneB = e164(1);
      const contactB = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phoneB}) RETURNING id`);
      const campB = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode) VALUES (${orgId}, ${"optout-camp-" + sfx}, ${"optout"}, 'active', 'manual') RETURNING id`);
      const stageB = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text, inbound_opt_out_count, opt_out_count)
        VALUES (${orgId}, ${campB.id}, 1, 'STOP', 0, 0) RETURNING id`);
      const sendB = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id, status, sent_at)
        VALUES (${orgId}, ${campB.id}, ${stageB.id}, ${contactB.id}, ${phoneB}, 'hi', ${"s-b-" + sfx}, 'sent', now())
        RETURNING id`);
      const evB = await mkEvent("webhook", ph(1), "STOP");
      const rB = await processAhoiInboundOptOut(tx, {
        eventId: evB.id, orgId, sourceNumber: ph(1), message: "STOP",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check("matched STOP -> suppressed", rB.kind === "suppressed" && rB.contactId === contactB.id, JSON.stringify(rB));
      check("matched STOP -> attributed to the one in-window send", rB.kind === "suppressed" && rB.attributed === true, JSON.stringify(rB));
      const ooB = await tx.execute(sql`SELECT * FROM opt_outs WHERE contact_id = ${contactB.id} AND source = 'ahoi_inbound_webhook'`);
      check("opt_outs row written with source='ahoi_inbound_webhook'", (ooB as unknown[]).length === 1);
      const attrB = await tx.execute(sql`SELECT * FROM opt_out_attributions WHERE stage_send_id = ${sendB.id}`);
      check("opt_out_attributions row written", (attrB as unknown[]).length === 1);
      const stageRowB = await one<{ opt_out_count: number }>(sql`SELECT opt_out_count FROM campaign_stages WHERE id = ${stageB.id}`);
      check("campaign_stages.opt_out_count bumped to 1", Number(stageRowB.opt_out_count) === 1, JSON.stringify(stageRowB));

      // ---- Case C: STOP for an UNMATCHED number -> contact materialized (E.164), suppressed, unattributed (no send in window). ----
      const digitsC = ph(2);
      const preC = await tx.execute(sql`SELECT 1 FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + digitsC}`);
      check("(fixture sanity) no pre-existing contact for case C", (preC as unknown[]).length === 0);
      const evC = await mkEvent("webhook", digitsC, "Stop please");
      const rC = await processAhoiInboundOptOut(tx, {
        eventId: evC.id, orgId, sourceNumber: digitsC, message: "Stop please",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check("unmatched STOP -> suppressed", rC.kind === "suppressed", JSON.stringify(rC));
      check("unmatched STOP -> unattributed (no send in window)", rC.kind === "suppressed" && rC.attributed === false, JSON.stringify(rC));
      const contactC = (await tx.execute(sql`SELECT id FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + digitsC}`)) as unknown as { id: string }[];
      check("contact upserted in E.164 form", contactC.length === 1);
      check(
        "returned contactId matches the newly upserted contact",
        rC.kind === "suppressed" && rC.contactId === contactC[0].id,
      );

      // ---- Case D: invalid source number -> invalid_phone, no writes. ----
      const evD = await mkEvent("webhook", "123", "STOP");
      const rD = await processAhoiInboundOptOut(tx, {
        eventId: evD.id, orgId, sourceNumber: "123", message: "STOP",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check("garbage source number -> invalid_phone", rD.kind === "invalid_phone", JSON.stringify(rD));

      // ---- Case E: CARRY 1 — the SAME STOP arrives again via CDR shortly
      // after, in the CDR's representation ("STOP - 1") -> deduped against
      // case B's webhook "STOP" via message normalization. ----
      const evE = await mkEvent("cdr", ph(1), "STOP - 1");
      const rE = await processAhoiInboundOptOut(tx, {
        eventId: evE.id, orgId, sourceNumber: ph(1), message: "STOP - 1",
        optOutSource: "ahoi_cdr", receivedAt: new Date(),
      });
      check("cross-channel repeat (CDR 'STOP - 1' vs webhook 'STOP') -> duplicate (CARRY 1)", rE.kind === "duplicate" && rE.contactId === contactB.id, JSON.stringify(rE));
      const evERow = await one<{ result: string }>(sql`SELECT result FROM ahoi_inbound_events WHERE id = ${evE.id}`);
      check("duplicate event row marked result='duplicate'", evERow.result === "duplicate", JSON.stringify(evERow));
      const ooCountB = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ${contactB.id}`);
      check("still exactly ONE opt_outs row for the contact (no double-write)", Number(ooCountB.n) === 1, JSON.stringify(ooCountB));
      const attrCountB = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_out_attributions WHERE stage_send_id = ${sendB.id}`);
      check("still exactly ONE attribution (no double-count, CARRY 1)", Number(attrCountB.n) === 1, JSON.stringify(attrCountB));
      const stageRowB2 = await one<{ opt_out_count: number }>(sql`SELECT opt_out_count FROM campaign_stages WHERE id = ${stageB.id}`);
      check("stage opt_out_count still 1, not double-bumped", Number(stageRowB2.opt_out_count) === 1, JSON.stringify(stageRowB2));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
