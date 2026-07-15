// GO-LIVE HARNESS (spec §6, CARRY 4, guardrail G7) — the hard blocker before
// SEND_ENABLED can flip for Ahoi. Proves, deterministically and with NO real
// Ahoi network call, that:
//   (a) all 3 opt-out layers correctly write opt_outs + suppress a contact
//   (b) the unmatched-number path materializes a contact then suppresses it
//   (c) a subsequent send to each suppressed contact is BLOCKED at the REAL
//       production preflight (kickoffStageSend, not a reimplementation)
//   (d) POSITIVE CONTROL: a non-opted-out contact still sends
// Layer 3 uses an INJECTED test opt-out code (knownCodes seam) — see
// processAhoiDlrOptOut's own comment for why: no real Ahoi opt-out DLR
// signature has ever been observed (O1), so there is no real code to test
// against; this harness proves the PIPELINE, not a specific wire code.
//
// Rolled-back transaction — nothing survives the run. Re-runnable in CI.
//
// SECOND GATE (not automatable, do not skip): before flipping SEND_ENABLED,
// ALSO complete the real-STOP smoke test — send one real message to a phone
// you control via the live Ahoi send path, physically reply STOP from that
// phone, and confirm (a) the reply reaches the PRODUCTION inbound webhook
// URL (portal-registered, not localhost) and (b) the resulting opt_outs row
// appears with source='ahoi_inbound_webhook'. This validates the wire
// (portal config, DNS, prod URL reachability) in a way no synthetic test
// can — go-live requires BOTH this harness green AND that smoke test signed
// off (spec §6).
//
// Run: npx tsx scripts/test-ahoi-optout-golive-harness.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { processAhoiInboundOptOut } from "@/lib/sends/ahoi-optout";
import { processAhoiDlrOptOut } from "@/lib/sends/ahoi-dlr-optout";
import { kickoffStageSend } from "@/lib/sends/kickoff";

let failed = 0;
let executed = 0;
// Full-run check count = the number of check() call sites below (currently 15).
// If a check is added/removed, update this constant — the completeness guard
// compares against it, so a stale value here fails loud (never silently green).
const EXPECTED_CHECKS = 15;
function check(name: string, cond: boolean, detail = "") {
  executed++;
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");
// Distinct from ROLLBACK: thrown when a precondition for Part 5 (the crux
// preflight-proof block, G7c/G7d) is absent. A SKIPPED run must never be
// reported as a pass — see the completeness guard in main() below.
const SKIPPED = Symbol("skipped");
let skipReason: string | null = null;

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;

      // Valid 10-digit NANP numbers (area 315, exchange 586) — the process
      // functions normalize source/destination via ahoiSourceToE164, so
      // fixtures MUST be genuinely valid. ph(i) -> "3155861000"+i.
      const ph = (i: number) => "315586" + (1000 + i).toString();
      const e164 = (i: number) => "+1" + ph(i);

      // ==== Part 1: Layer 1 (webhook) — matched (pre-existing) contact ====
      const phone1 = e164(1);
      const matchedContact = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone1}) RETURNING id`);
      const ev1 = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, destination_number, message, type, method)
        VALUES (${orgId}, 'webhook', ${ph(1)}, '3158359592', 'STOP', 'sms', 'POST') RETURNING id`);
      const r1 = await processAhoiInboundOptOut(tx, {
        eventId: ev1.id, orgId, sourceNumber: ph(1), message: "STOP",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check("[G7a] Layer 1 (webhook) STOP for a matched contact -> suppressed", r1.kind === "suppressed" && r1.contactId === matchedContact.id, JSON.stringify(r1));
      const oo1 = await tx.execute(sql`SELECT * FROM opt_outs WHERE contact_id = ${matchedContact.id} AND source = 'ahoi_inbound_webhook'`);
      check("Layer 1 wrote an opt_outs row", (oo1 as unknown[]).length === 1);

      // ==== Part 2: Layer 2 (CDR) receives the SAME physical STOP minutes
      // later, in the CDR's "STOP - 1" form -> CARRY 1 must dedup it (message
      // normalization + window), not write a second opt_outs row. ====
      const ev2 = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, destination_number, message, type, method, provider_uuid)
        VALUES (${orgId}, 'cdr', ${ph(1)}, '3158359592', 'STOP - 1', 'sms', 'poll', ${"cdruuid-" + sfx}) RETURNING id`);
      const r2 = await processAhoiInboundOptOut(tx, {
        eventId: ev2.id, orgId, sourceNumber: ph(1), message: "STOP - 1",
        optOutSource: "ahoi_cdr", receivedAt: new Date(),
      });
      check("[G7a] Layer 2 (CDR 'STOP - 1') of the SAME STOP -> deduped as duplicate (CARRY 1)", r2.kind === "duplicate", JSON.stringify(r2));
      const oo2count = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ${matchedContact.id}`);
      check("still exactly ONE opt_outs row for this contact (no cross-channel double-write)", Number(oo2count.n) === 1, JSON.stringify(oo2count));

      // ==== Part 3: Layer 3 (DLR opt-out-error), injected test code ====
      const phone3 = e164(3);
      const matchedContact3 = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone3}) RETURNING id`);
      const testKnownCodes = new Set(["999-test-optout"]);
      const r3 = await processAhoiDlrOptOut(tx, {
        orgId, destinationNumber: ph(3), sendStatus: "rejected", error: "999-test-optout", smppCode: null,
        receivedAt: new Date(), knownCodes: testKnownCodes,
      });
      check("[G7a] Layer 3 (DLR) w/ a recognized (injected) opt-out code -> suppressed", r3.kind === "suppressed" && r3.contactId === matchedContact3.id, JSON.stringify(r3));
      const r3b = await processAhoiDlrOptOut(tx, {
        orgId, destinationNumber: ph(3), sendStatus: "rejected", error: "600", smppCode: null,
        receivedAt: new Date(), // default (empty) production allowlist
      });
      check("Layer 3 w/ the doc-inferred (unconfirmed) 600 code -> NOT classified as opt-out (G4/O1 defensive)", r3b.kind === "not_opt_out", JSON.stringify(r3b));

      // ==== Part 4: unmatched-number path (Layer 1, no pre-existing contact) ====
      const phone4Digits = ph(4);
      const ev4 = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, destination_number, message, type, method)
        VALUES (${orgId}, 'webhook', ${phone4Digits}, '3158359592', 'Stop please', 'sms', 'POST') RETURNING id`);
      const preExisting = await tx.execute(sql`SELECT 1 FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + phone4Digits}`);
      check("(fixture sanity) unmatched number has no pre-existing contact", (preExisting as unknown[]).length === 0);
      const r4 = await processAhoiInboundOptOut(tx, {
        eventId: ev4.id, orgId, sourceNumber: phone4Digits, message: "Stop please",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check("[G7b] unmatched-number STOP -> suppressed (contact materialized)", r4.kind === "suppressed", JSON.stringify(r4));
      const newContactRows = await tx.execute(sql`SELECT id FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + phone4Digits}`);
      check("contact upserted in E.164 form (CARRY 2)", (newContactRows as unknown[]).length === 1);
      const newContactId = (newContactRows as unknown as { id: string }[])[0]!.id;
      check("processAhoiInboundOptOut returned the SAME contactId it just created", r4.kind === "suppressed" && r4.contactId === newContactId);

      // ==== Part 5: PREFLIGHT PROOF via the REAL kickoff path ====
      // Build one Ahoi stage whose audience pool has 3 contacts: the two now-
      // suppressed ones from Parts 1+4, and a CLEAN control contact. Run the
      // ACTUAL production kickoffStageSend (which internally calls
      // enumerateStageRecipients -> stageRecipientsSql, the exact query the
      // real send pipeline uses) and inspect who got a stage_sends row.
      const cleanContact = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${e164(9)}) RETURNING id`);

      const brand = await one<{ id: number }>(sql`
        SELECT b.id FROM brands b JOIN short_domains sd ON sd.brand_id = b.id AND sd.status = 'active'
        WHERE b.org_id = ${orgId} LIMIT 1`);
      if (!brand) {
        skipReason = "need a brand with an active short domain in this org";
        console.log(`SKIP Part 5 (preflight proof): ${skipReason}.`);
        throw SKIPPED;
      }
      const ahoiProv = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahi'`);
      if (!ahoiProv) {
        skipReason = "no seeded 'ahi' provider row (run Section 1's seed)";
        console.log(`SKIP Part 5: ${skipReason}.`);
        throw SKIPPED;
      }
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${ahoiProv.id}, NULL, 'k') ON CONFLICT DO NOTHING`);
      const providerPhone = await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number) VALUES (${orgId}, ${ahoiProv.id}, ${"+1900" + sfx}) RETURNING id`);

      const cre = await one<{ id: number }>(sql`
        INSERT INTO creatives (slug, org_id, text, status) VALUES (${"golive-cre-" + sfx}, ${orgId}, ${"Hi"}, 'active') RETURNING id`);
      const trackingId = `9_99_golive_${sfx}_s1`;
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
        VALUES (${orgId}, ${"golive-camp-" + sfx}, ${"golive"}, 'active', 'tracked', ${brand.id}, ${trackingId}) RETURNING id`);
      const fullUrl = `https://www.guidekn.com/lp/knd?sub_id3=${trackingId}`;
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id, provider_phone_id, send_approved,
           tracking_id, full_url, include_no_status, stop_text, scheduled_at)
        VALUES (${orgId}, ${camp.id}, 1, ${cre.id}, ${ahoiProv.id}, ${providerPhone.id}, true,
           ${trackingId}, ${fullUrl}, true, 'STOP', now())
        RETURNING id`);
      for (const contactId of [matchedContact.id, newContactId, cleanContact.id]) {
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
          VALUES (${orgId}, ${camp.id}, ${contactId}, true, false)`);
      }

      const kickoffRes = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: camp.id, stageId: stage.id });
      check("kickoff succeeds (stage is otherwise well-formed)", kickoffRes.ok, JSON.stringify(kickoffRes));

      const sentRows = (await tx.execute(sql`SELECT contact_id FROM stage_sends WHERE stage_id = ${stage.id}`)) as unknown as { contact_id: string }[];
      const sentSet = new Set(sentRows.map((r) => r.contact_id));
      check("[G7c] Layer-1-suppressed matched contact BLOCKED at the real preflight", !sentSet.has(matchedContact.id));
      check("[G7b+c] unmatched-turned-contact BLOCKED at the real preflight", !sentSet.has(newContactId));
      check("[G7d] POSITIVE CONTROL: non-opted-out contact STILL sends", sentSet.has(cleanContact.id));
      check("exactly 1 of the 3 audience-pool contacts materialized a stage_sends row", sentRows.length === 1, JSON.stringify(sentRows));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK && e !== SKIPPED) throw e;
  }
  await pgConn.end({ timeout: 5 });

  // A skip is NEVER a pass, regardless of how many checks happened to run
  // before the precondition check bailed out.
  if (skipReason) {
    console.log(
      `\nHARNESS SKIPPED — preconditions absent (${skipReason}). ${executed}/${EXPECTED_CHECKS} checks ran before the skip.`,
    );
    console.log("This is NOT a pass. Go-live gate NOT satisfied. Provide the missing precondition and re-run.");
    process.exit(2);
    return;
  }

  if (failed > 0) {
    console.log(`\n${failed}/${executed} FAILED — DO NOT flip SEND_ENABLED for Ahoi.`);
    process.exit(1);
    return;
  }

  // Completeness guard: even with zero failures and no explicit skip, a Part
  // could have short-circuited (e.g. returned early, or an await resolved to
  // something that made a later check unreachable) without every check()
  // call site executing. Refuse to go green unless the FULL run happened.
  if (executed !== EXPECTED_CHECKS) {
    console.log(
      `\nINCOMPLETE RUN: only ${executed}/${EXPECTED_CHECKS} checks executed — a Part was skipped or short-circuited.`,
    );
    console.log("This is NOT a pass. Go-live gate NOT satisfied.");
    process.exit(2);
    return;
  }

  console.log(`\nALL ${executed}/${EXPECTED_CHECKS} CHECKS PASS (rolled back). GO-LIVE HARNESS GREEN.`);
  console.log("Reminder: the real-STOP smoke test (see this file's header comment) is STILL REQUIRED before flipping SEND_ENABLED.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
