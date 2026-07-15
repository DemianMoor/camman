// DLR reconcile: match provider_uuid -> stage_sends (matched vs unmatched
// multi-segment-extra), and the reject-rate -> circuit-breaker signal.
// Rolled-back transaction — no data survives the run.
// Run: npx tsx scripts/test-ahoi-dlr-reconcile.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  captureAhoiDlrEvent,
  reconcileAhoiDlrEvent,
} from "@/lib/sends/ahoi-dlr";
import {
  ahoiDlrRejectSpikeThreshold,
  ahoiDlrRejectWindowSeconds,
  countAhoiDlrRejectsSince,
  latchPause,
} from "@/lib/sends/circuit-breakers";

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

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"dlrrec-" + sfx}, ${orgId}, ${"dlrrec"}, true) RETURNING id`);
      const providerId = prov.id;
      // ahoi_dlr_events.credential_id FKs to provider_credentials.id — a
      // literal placeholder like 0 would violate that constraint, so seed a
      // real (rolled-back) credential row per provider instead.
      const cred1 = await one<{ id: number }>(sql`
        INSERT INTO provider_credentials (org_id, provider_id, api_key)
        VALUES (${orgId}, ${providerId}, ${"test-key-" + sfx}) RETURNING id`);

      const contact = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx}) RETURNING id`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"dlrrec-camp-" + sfx}, ${"dlrrec"}, 'active', 'manual') RETURNING id`);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
        VALUES (${orgId}, ${camp.id}, 1, 'STOP') RETURNING id`);
      const stageSend = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id)
        VALUES (${orgId}, ${camp.id}, ${stage.id}, ${contact.id}, ${"+1555" + sfx}, 'hi', ${"s-match-" + sfx})
        RETURNING id`);

      // Case 1: DLR uuid matches a real stage_sends.texthub_message_id.
      const ev1 = await captureAhoiDlrEvent(tx, {
        orgId, credentialId: cred1.id, providerId, method: "POST",
        query: {}, headers: {}, rawBody: null,
        fields: { source: "3158359592", destination: "5642155963" },
        parsed: { providerUuid: "s-match-" + sfx, sendStatus: "delivered", status: "delivered", smppStatus: "DELIVRD", smppCode: null, error: "000" },
      });
      const r1 = await reconcileAhoiDlrEvent(tx, {
        eventId: ev1.id, orgId, providerId, providerUuid: "s-match-" + sfx, sendStatus: "delivered",
      });
      check("matched DLR -> result=matched", r1.result === "matched");
      check("matched DLR -> matchedStageSendId set", r1.matchedStageSendId === stageSend.id);

      // Case 2: numeric-uuid multi-segment extra -> no match, NOT an error.
      const ev2 = await captureAhoiDlrEvent(tx, {
        orgId, credentialId: cred1.id, providerId, method: "POST",
        query: {}, headers: {}, rawBody: null,
        fields: {},
        parsed: { providerUuid: "4131784060328527222", sendStatus: "delivered", status: "delivered", smppStatus: "DELIVRD", smppCode: null, error: "000" },
      });
      const r2 = await reconcileAhoiDlrEvent(tx, {
        eventId: ev2.id, orgId, providerId, providerUuid: "4131784060328527222", sendStatus: "delivered",
      });
      check("numeric-uuid extra -> result=unmatched (not an error)", r2.result === "unmatched");
      check("unmatched -> matchedStageSendId null", r2.matchedStageSendId === null);

      // ---- Case 3: DLR reject-rate breaker (below/at threshold) ----
      const THRESHOLD = ahoiDlrRejectSpikeThreshold();
      const WINDOW = ahoiDlrRejectWindowSeconds();

      async function pushReject(tag: string) {
        const ev = await captureAhoiDlrEvent(tx, {
          orgId, credentialId: cred1.id, providerId, method: "POST",
          query: {}, headers: {}, rawBody: null, fields: {},
          parsed: { providerUuid: `rej-${sfx}-${tag}`, sendStatus: "rejected", status: "rejected", smppStatus: null, smppCode: null, error: "600" },
        });
        return reconcileAhoiDlrEvent(tx, {
          eventId: ev.id, orgId, providerId, providerUuid: `rej-${sfx}-${tag}`, sendStatus: "rejected",
        });
      }

      // NO-DOUBLE-COUNT (disjointness): the DLR reject counter reads ONLY
      // ahoi_dlr_events rows with send_status='rejected'. 'delivered' DLRs — and,
      // critically, the send-time failure-spike breaker's rows (send_attempts /
      // stage_sends) — never inflate it. Insert 3 'delivered' DLRs -> reject
      // count stays 0. This is the structural proof the two breakers can't
      // double-count the same failure: they read entirely disjoint tables.
      for (let i = 0; i < 3; i++) {
        const ev = await captureAhoiDlrEvent(tx, {
          orgId, credentialId: cred1.id, providerId, method: "POST",
          query: {}, headers: {}, rawBody: null, fields: {},
          parsed: { providerUuid: `del-${sfx}-${i}`, sendStatus: "delivered", status: "delivered", smppStatus: "DELIVRD", smppCode: null, error: "000" },
        });
        await reconcileAhoiDlrEvent(tx, { eventId: ev.id, orgId, providerId, providerUuid: `del-${sfx}-${i}`, sendStatus: "delivered" });
      }
      check(
        "delivered DLRs do NOT count toward the reject signal (disjoint from the send-time breaker)",
        (await countAhoiDlrRejectsSince(tx, providerId, WINDOW)) === 0,
      );

      // Below threshold -> no premature trip.
      let last: Awaited<ReturnType<typeof reconcileAhoiDlrEvent>> | undefined;
      for (let i = 0; i < THRESHOLD - 1; i++) last = await pushReject(`a${i}`);
      check(`${THRESHOLD - 1} rejects (below threshold) -> NOT paused`, last?.pausedNow === false);
      const notYet = await one<{ send_paused: boolean }>(sql`SELECT send_paused FROM sms_providers WHERE id = ${providerId}`);
      check("still not paused below threshold", notYet.send_paused === false);

      // The threshold-th reject -> latches the pause.
      const trip = await pushReject(`a${THRESHOLD - 1}`);
      check(`the ${THRESHOLD}th reject in-window -> latches the pause`, trip.pausedNow === true, JSON.stringify(trip));
      const paused = await one<{ send_paused: boolean; send_paused_reason: string }>(
        sql`SELECT send_paused, send_paused_reason FROM sms_providers WHERE id = ${providerId}`);
      check("sms_providers.send_paused = true", paused.send_paused === true);
      check("reason mentions dlr_reject_spike", (paused.send_paused_reason ?? "").includes("dlr_reject_spike"), paused.send_paused_reason);

      // SINGLE-COUNT: a further reject after the pause is already latched
      // returns pausedNow=false and does NOT append a second 'paused' event —
      // proving the pause is counted once even though both the send-time
      // breaker and this DLR breaker call the same latchPause.
      const again = await pushReject("after");
      check("further reject after pause -> pausedNow=false (idempotent latch)", again.pausedNow === false);
      const evCount1 = await one<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM send_circuit_events WHERE provider_id = ${providerId} AND event = 'paused'`);
      check("exactly ONE 'paused' event for this provider (single count)", evCount1.n === 1, JSON.stringify(evCount1));

      // ---- Case 4: ADDITIVE COMPOSITION across the two breakers ----
      // A SECOND provider is pre-paused by the send-time breaker (simulated via
      // latchPause with a failure_spike reason). The DLR breaker must COMPOSE,
      // not fight it: rejects on this provider find it already paused, return
      // pausedNow=false, and never overwrite the reason or add a 2nd pause
      // event. The two signals share one latch additively — neither cancels the
      // other, neither double-latches.
      const prov2 = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"dlrrec2-" + sfx}, ${orgId}, ${"dlrrec2"}, true) RETURNING id`);
      const cred2 = await one<{ id: number }>(sql`
        INSERT INTO provider_credentials (org_id, provider_id, api_key)
        VALUES (${orgId}, ${prov2.id}, ${"test-key2-" + sfx}) RETURNING id`);
      const preLatched = await latchPause(tx, { providerId: prov2.id, orgId, reason: "failure_spike: 10 consecutive send failures" });
      check("send-time breaker latches provider 2", preLatched === true);
      let r4: Awaited<ReturnType<typeof reconcileAhoiDlrEvent>> | undefined;
      for (let i = 0; i < THRESHOLD; i++) {
        const ev = await captureAhoiDlrEvent(tx, {
          orgId, credentialId: cred2.id, providerId: prov2.id, method: "POST",
          query: {}, headers: {}, rawBody: null, fields: {},
          parsed: { providerUuid: `rej2-${sfx}-${i}`, sendStatus: "rejected", status: "rejected", smppStatus: null, smppCode: null, error: "600" },
        });
        r4 = await reconcileAhoiDlrEvent(tx, { eventId: ev.id, orgId, providerId: prov2.id, providerUuid: `rej2-${sfx}-${i}`, sendStatus: "rejected" });
      }
      check("DLR breaker composes with an already-latched pause (pausedNow=false)", r4!.pausedNow === false);
      const p2 = await one<{ send_paused_reason: string }>(sql`SELECT send_paused_reason FROM sms_providers WHERE id = ${prov2.id}`);
      check("send-time breaker's reason is NOT overwritten by the DLR breaker", (p2.send_paused_reason ?? "").includes("failure_spike"), p2.send_paused_reason);
      const evCount2 = await one<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM send_circuit_events WHERE provider_id = ${prov2.id} AND event = 'paused'`);
      check("still exactly ONE 'paused' event for provider 2 (no double-latch across breakers)", evCount2.n === 1, JSON.stringify(evCount2));

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
