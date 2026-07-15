// Layer 3: classifyAhoiDlrOptOut (pure, G4 defensive — empty allowlist by
// default) + processAhoiDlrOptOut (contact match on DESTINATION — opposite
// of inbound events, where source is the recipient). Rolled-back transaction.
// Run: npx tsx scripts/test-ahoi-dlr-optout.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  AHOI_KNOWN_OPTOUT_DLR_CODES,
  classifyAhoiDlrOptOut,
  processAhoiDlrOptOut,
} from "@/lib/sends/ahoi-dlr-optout";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ---- Pure classifier tests ----
check(
  "G4/O1: production allowlist is EMPTY today (no confirmed Ahoi opt-out DLR code observed)",
  AHOI_KNOWN_OPTOUT_DLR_CODES.size === 0,
);
check(
  "doc-inferred 'rejected'/error=600 is NOT classified as opt-out by default (defensive)",
  classifyAhoiDlrOptOut({ sendStatus: "rejected", error: "600", smppCode: null }) === false,
);
check(
  "delivered status is never opt-out regardless of error code",
  classifyAhoiDlrOptOut({ sendStatus: "delivered", error: "999-test-optout", smppCode: null }, new Set(["999-test-optout"])) === false,
);
check(
  "with an INJECTED known code (test seam), a matching rejected DLR IS classified as opt-out",
  classifyAhoiDlrOptOut({ sendStatus: "rejected", error: "999-test-optout", smppCode: null }, new Set(["999-test-optout"])) === true,
);
check(
  "matches on smpp_code too, not just error",
  classifyAhoiDlrOptOut({ sendStatus: "rejected", error: null, smppCode: "999-test-optout" }, new Set(["999-test-optout"])) === true,
);
check(
  "case/whitespace-insensitive match",
  classifyAhoiDlrOptOut({ sendStatus: "rejected", error: "  999-TEST-optout  ", smppCode: null }, new Set(["999-test-optout"])) === true,
);

// ---- DB-backed processAhoiDlrOptOut ----
async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const testCodes = new Set(["999-test-optout"]);
      // Valid 10-digit NANP numbers (area 315, exchange 586) — Layer 3
      // normalizes destinationNumber via ahoiSourceToE164.
      const ph = (i: number) => "315586" + (1000 + i).toString();

      // Case 1: rejected + a recognized (INJECTED) code, no send in window -> suppressed, unattributed.
      const digitsA = ph(0);
      const rA = await processAhoiDlrOptOut(tx, {
        orgId, destinationNumber: digitsA, sendStatus: "rejected", error: "999-test-optout", smppCode: null,
        receivedAt: new Date(), knownCodes: testCodes,
      });
      check("recognized opt-out code -> suppressed", rA.kind === "suppressed", JSON.stringify(rA));
      check("no matching send -> unattributed", rA.kind === "suppressed" && rA.attributed === false, JSON.stringify(rA));
      const contactA = await tx.execute(sql`SELECT id FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + digitsA}`);
      check("contact upserted from the DLR's DESTINATION field (recipient, not our own number)", (contactA as unknown[]).length === 1);
      const ooA = await tx.execute(sql`
        SELECT * FROM opt_outs WHERE contact_id = ${(contactA as unknown as { id: string }[])[0]?.id} AND source = 'ahoi_dlr_optout'`);
      check("opt_outs row written with source='ahoi_dlr_optout'", (ooA as unknown[]).length === 1);

      // Case 2: rejected but UNRECOGNIZED code (default empty allowlist) -> not_opt_out, no writes.
      const digitsB = ph(1);
      const rB = await processAhoiDlrOptOut(tx, {
        orgId, destinationNumber: digitsB, sendStatus: "rejected", error: "600", smppCode: null,
        receivedAt: new Date(),
      });
      check("unrecognized reject code (prod default) -> not_opt_out", rB.kind === "not_opt_out", JSON.stringify(rB));
      const noContactB = await tx.execute(sql`SELECT 1 FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + digitsB}`);
      check("no contact created for a non-opt-out reject", (noContactB as unknown[]).length === 0);

      // Case 3: delivered (not rejected) -> not_opt_out, even with a code that WOULD match if rejected.
      const rC = await processAhoiDlrOptOut(tx, {
        orgId, destinationNumber: ph(2), sendStatus: "delivered", error: "999-test-optout", smppCode: null,
        receivedAt: new Date(), knownCodes: testCodes,
      });
      check("delivered status never classifies as opt-out", rC.kind === "not_opt_out", JSON.stringify(rC));

      // Case 4: recognized code + a real matching send in window -> attributed.
      const digitsD = ph(3);
      const phoneD = "+1" + digitsD;
      const contactD = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phoneD}) RETURNING id`);
      const campD = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode) VALUES (${orgId}, ${"dlroptout-camp-" + sfx}, ${"dlroptout"}, 'active', 'manual') RETURNING id`);
      const stageD = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text, inbound_opt_out_count, opt_out_count)
        VALUES (${orgId}, ${campD.id}, 1, 'STOP', 0, 0) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id, status, sent_at)
        VALUES (${orgId}, ${campD.id}, ${stageD.id}, ${contactD.id}, ${phoneD}, 'hi', ${"s-d-" + sfx}, 'sent', now())`);
      const rD = await processAhoiDlrOptOut(tx, {
        orgId, destinationNumber: digitsD, sendStatus: "rejected", error: "999-test-optout", smppCode: null,
        receivedAt: new Date(), knownCodes: testCodes,
      });
      check("recognized code + a real matching send -> attributed", rD.kind === "suppressed" && rD.attributed === true, JSON.stringify(rD));
      const stageRowD = await one<{ opt_out_count: number }>(sql`SELECT opt_out_count FROM campaign_stages WHERE id = ${stageD.id}`);
      check("stage opt_out_count bumped", Number(stageRowD.opt_out_count) === 1, JSON.stringify(stageRowD));

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
