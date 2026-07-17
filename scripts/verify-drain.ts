import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  ceilingBreached,
  countSentSince,
  resolve24hCap,
  resolveMinuteCap,
  resolvePacingCap,
  resolveSendsPerSecond,
  shouldTripFailureSpike,
} from "@/lib/sends/circuit-breakers";
import { decideDrainAuth, runStageDrain, type Sender } from "@/lib/sends/drain";
import { isSuppressedStatus } from "@/lib/sends/texthub";

// Verifies the real-send drain WITHOUT a real TextHub call (injected sender)
// and WITHOUT persisting (rolled-back tx): both gates (send_approved +
// SEND_ENABLED), claim→sent / claim→failed transitions, texthub_message_id
// capture, stuck-in-'sending' is never auto-retried, the between-batch
// kill-switch halt — AND the circuit breakers (0058): provider_paused refusal,
// the structural per-contact dedup index, soft 24h/minute ceilings (stop without
// pausing), the mid-run pause kill, and the failure-spike pause latch + audit
// event.
//
// Run: npx tsx scripts/verify-drain.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const okSender: Sender = async () => ({
  ok: true,
  messageId: "TH-msg-1",
  response: "queued",
  providerStatus: null,
  suppressed: false,
  rawBody: '{"response":"queued","id":"TH-msg-1"}',
  error: null,
  status: 200,
  timedOut: false,
});
const failSender: Sender = async () => ({
  ok: false,
  messageId: null,
  response: null,
  providerStatus: null,
  suppressed: false,
  rawBody: '{"error":"boom"}',
  error: "boom",
  status: 500,
  timedOut: false,
});
// TextHub's verbatim suppression envelope (confirmed live 2026-06-16).
const suppressedSender: Sender = async () => ({
  ok: false,
  messageId: null,
  response: "Error occured, unsubscribed the phone number",
  providerStatus: "Suppressed",
  suppressed: true,
  rawBody:
    '{"response":"Error occured, unsubscribed the phone number","status":"Suppressed"}',
  error: "Error occured, unsubscribed the phone number",
  status: 404,
  timedOut: false,
});

async function main() {
  // Dual-auth gate (pure) — confirm there's NO gap between the cron path and
  // the session path: a request with neither a valid Bearer nor a privileged
  // session must be rejected.
  console.log("Drain dual-auth (no gap):");
  assert(
    decideDrainAuth({ bearerMatches: true, sessionRole: null }).allow,
    "valid CRON_SECRET Bearer → allowed (cron)",
  );
  const noAuth = decideDrainAuth({ bearerMatches: false, sessionRole: null });
  assert(!noAuth.allow && noAuth.status === 401, "no Bearer + no session → 401 (no gap)");
  const operator = decideDrainAuth({ bearerMatches: false, sessionRole: "operator" });
  assert(!operator.allow && operator.status === 403, "operator session (no campaigns.drain) → 403");
  assert(
    decideDrainAuth({ bearerMatches: false, sessionRole: "manager" }).allow,
    "manager session → allowed (session)",
  );
  const viewer = decideDrainAuth({ bearerMatches: false, sessionRole: "viewer" });
  assert(!viewer.allow && viewer.status === 403, "viewer session → 403");

  // Circuit-breaker pure helpers — clamp/default/threshold logic.
  console.log("Circuit-breaker pure helpers:");
  assert(resolvePacingCap(null) === 1000, "null pacing cap → default 1000");
  assert(resolvePacingCap(50) === 50, "pacing cap honors a smaller value");
  assert(resolvePacingCap(9_999_999) === 20000, "pacing cap clamped to ABSOLUTE_MAX 20000");
  assert(resolvePacingCap(0) === 1, "pacing cap floors at 1 (never 0)");
  assert(resolveSendsPerSecond(null) === 10, "null per-second rate → default 10");
  assert(resolveSendsPerSecond(60) === 60, "per-second rate honors a set value (60)");
  assert(resolveSendsPerSecond(0) === 1, "per-second rate floors at 1 (never 0/stall)");
  assert(resolveSendsPerSecond(9_999) === 1000, "per-second rate clamped to ABSOLUTE_MAX 1000");
  assert(resolveMinuteCap(null) === 100, "null minute cap → default 100");
  assert(resolve24hCap(null) === 10000, "null 24h cap → default 10000");
  assert(resolve24hCap(5) === 5, "24h cap honors a set value");
  assert(
    shouldTripFailureSpike(10) && !shouldTripFailureSpike(9),
    "failure spike trips at 10 consecutive, not 9",
  );
  assert(
    ceilingBreached(100, 100) && !ceilingBreached(99, 100),
    "ceiling breached at >= cap",
  );
  // Strict suppression gate: only the structured `status` token "suppressed"
  // (any case) — never the HTTP code, never the free-text response string.
  assert(
    isSuppressedStatus("Suppressed") &&
      isSuppressedStatus("suppressed") &&
      isSuppressedStatus("  SUPPRESSED  ") &&
      !isSuppressedStatus("queued") &&
      !isSuppressedStatus("Error occured, unsubscribed the phone number") &&
      !isSuppressedStatus(null) &&
      !isSuppressedStatus(undefined),
    "isSuppressedStatus matches the status token strictly (not the response text)",
  );

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  let failed = false;

  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      // Throwaway org created INSIDE the rolled-back tx (never committed, so no
      // teardown). CRITICAL: the rate-ceiling breakers count `stage_sends`
      // org-wide, so the drain MUST run under an org with no other traffic. A
      // shared live org whose campaigns send continuously would push
      // countSentSince() over the test caps and make the happy-path + ceiling
      // assertions flap. A dedicated org isolates the counts deterministically.
      const org = await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES ('verify-drain throwaway') RETURNING id
      `);
      const orgId = org.id;

      // Workstream-1 two-switch gate: the drain now also requires the DB master
      // switch (org_settings.sends_enabled). Seed it on inside this rolled-back tx
      // so the default per-org read returns true for every drain call below.
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true
      `);
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name)
        VALUES (${orgId}, ${"vd-brand"}, ${"VD Brand"}) RETURNING id
      `);

      // Mint disposable contacts so multiple SIMULTANEOUS pending rows don't
      // collide on the new (stage_id, contact_id) dedup index.
      let phoneSeq = 0;
      const mkContact = async () =>
        (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${`+1555000${String(phoneSeq++).padStart(4, "0")}`})
          RETURNING id
        `)).id;
      const contact = await mkContact();

      let provSeq = 0;
      const mkProvider = async (caps?: {
        maxRun?: number | null;
        maxMin?: number | null;
        max24?: number | null;
      }) =>
        (await one<{ id: number }>(sql`
          INSERT INTO sms_providers
            (sms_provider_id, org_id, name, supports_api_send, status,
             max_sends_per_run, max_sends_per_minute, max_sends_per_24h)
          VALUES (${`vd-prov-${provSeq++}`}, ${orgId}, ${"VD"}, true, 'active',
                  ${caps?.maxRun ?? null}, ${caps?.maxMin ?? null}, ${caps?.max24 ?? null})
          RETURNING id
        `)).id;
      const addCred = async (providerId: number) =>
        tx.execute(sql`
          INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
          VALUES (${orgId}, ${providerId}, NULL, ${"key"})
        `);

      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
        VALUES (${orgId}, ${"vd-camp"}, ${brand.id}, 'tracked', 'active') RETURNING id
      `);
      let stageSeq = 0;
      const mkStage = async (providerId: number, approved = true) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, sms_provider_id, send_approved)
          VALUES (${orgId}, ${camp.id}, ${stageSeq++}, ${providerId}, ${approved}) RETURNING id
        `)).id;

      const prov = await mkProvider();
      await addCred(prov);
      const stageId = await mkStage(prov, false);

      // Each pending row gets a UNIQUE phone so the drain's global 1-hour
      // send-dedup gate (migration 0090) never fires here — this suite verifies
      // drain mechanics (claim/send/breakers), not dedup. A shared phone would be
      // skipped_duplicate across cases and break the sent/failed assertions.
      let sendPhoneSeq = 0;
      const addPending = async (stage: number, contactId: string, text: string) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
          VALUES (${orgId}, ${camp.id}, ${stage}, ${contactId},
                  ${`+1557000${String(sendPhoneSeq++).padStart(4, "0")}`}, ${text}, 'pending')
        `);
      const statusOf = async (stage: number, predicate: string) =>
        Number((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stage} AND status = ${predicate}`)).n);

      console.log("Gate: not approved");
      await addPending(stageId, contact, "m1");
      const g1 = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => true });
      assert(!g1.ok && g1.reason === "not_approved", "unapproved stage refused");
      assert((await statusOf(stageId, "pending")) === 1, "nothing claimed while unapproved");

      await tx.execute(sql`UPDATE campaign_stages SET send_approved = true WHERE id = ${stageId}`);

      console.log("Gate: SEND_ENABLED off");
      const g2 = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => false });
      assert(!g2.ok && g2.reason === "send_disabled", "kill-switch off refuses");
      assert((await statusOf(stageId, "pending")) === 1, "nothing claimed while disabled");

      console.log("Gate: DB master switch (org_settings.sends_enabled) off");
      const g3 = await runStageDrain(tx, {
        stageId, sendSms: okSender, isEnabled: () => true, isOrgEnabled: async () => false,
      });
      assert(!g3.ok && g3.reason === "send_disabled_org", "DB switch off refuses with distinct reason");
      assert((await statusOf(stageId, "pending")) === 1, "nothing claimed while DB switch off");

      console.log("Happy path (sent + message id):");
      const h = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => true });
      assert(h.ok && h.sent === 1 && h.failed === 0, "1 sent");
      const sentRow = await one<{ status: string; texthub_message_id: string | null; sent_at: string | null; attempts: number }>(
        sql`SELECT status, texthub_message_id, sent_at, attempts FROM stage_sends WHERE stage_id = ${stageId} AND status = 'sent' LIMIT 1`,
      );
      assert(sentRow.texthub_message_id === "TH-msg-1", "texthub_message_id captured");
      assert(sentRow.sent_at !== null && sentRow.attempts === 1, "sent_at set, attempts=1");

      console.log("Evidence: send_attempts row written + classified (WS3):");
      const att = await one<{ classification: string; ok: boolean; raw_body: string | null; request_redacted: string | null; http_status: number }>(
        sql`SELECT sa.classification, sa.ok, sa.raw_body, sa.request_redacted, sa.http_status
            FROM send_attempts sa
            JOIN stage_sends ss ON ss.id = sa.stage_send_id
            WHERE ss.stage_id = ${stageId} ORDER BY sa.id DESC LIMIT 1`,
      );
      assert(att.ok === true && att.classification === "accepted", "accepted attempt classified 'accepted'");
      assert(att.raw_body === '{"response":"queued","id":"TH-msg-1"}', "verbatim raw body persisted");
      assert(att.http_status === 200, "http status persisted");
      assert(att.request_redacted != null && att.request_redacted.includes("api_key=redacted_"), "request stored with the api_key redacted");

      console.log("Failure path:");
      await addPending(stageId, contact, "m2");
      const f = await runStageDrain(tx, { stageId, sendSms: failSender, isEnabled: () => true });
      assert(f.ok && f.failed === 1 && f.sent === 0, "1 failed");
      const failRow = await one<{ last_error: string | null; attempts: number }>(
        sql`SELECT last_error, attempts FROM stage_sends WHERE stage_id = ${stageId} AND status = 'failed' LIMIT 1`,
      );
      assert(failRow.last_error === "boom" && failRow.attempts === 1, "last_error set, attempts=1");

      console.log("Filtered path (TextHub 'Suppressed' → status='filtered', NOT 'failed'):");
      await addPending(stageId, await mkContact(), "m-supp");
      const fl = await runStageDrain(tx, { stageId, sendSms: suppressedSender, isEnabled: () => true });
      assert(fl.ok && fl.filtered === 1 && fl.failed === 0, "1 filtered, 0 failed (suppression split out of failed)");
      assert((await statusOf(stageId, "filtered")) === 1, "row marked status='filtered'");
      const flRow = await one<{ last_error: string | null; status: string }>(
        sql`SELECT last_error, status FROM stage_sends WHERE stage_id = ${stageId} AND status = 'filtered' LIMIT 1`,
      );
      assert(
        flRow.last_error === "Error occured, unsubscribed the phone number",
        "filtered row keeps the verbatim provider message in last_error",
      );
      const flAtt = await one<{ classification: string; raw_body: string | null }>(
        sql`SELECT sa.classification, sa.raw_body FROM send_attempts sa
            JOIN stage_sends ss ON ss.id = sa.stage_send_id
            WHERE ss.stage_id = ${stageId} AND ss.status = 'filtered' ORDER BY sa.id DESC LIMIT 1`,
      );
      assert(
        flAtt.classification === "theirs_rejected" &&
          (flAtt.raw_body ?? "").includes('"status":"Suppressed"'),
        "evidence row still classified theirs_rejected with the verbatim Suppressed envelope",
      );

      console.log("Stuck in 'sending' is never auto-retried:");
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${camp.id}, ${stageId}, ${await mkContact()}, ${"+15555550001"}, ${"stuck"}, 'sending')
      `);
      const s = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => true });
      assert(s.ok && s.processed === 0, "no pending rows → nothing processed");
      assert(s.stuck === 1, "stuck 'sending' row surfaced in stuck count");
      assert((await statusOf(stageId, "sending")) === 1, "stuck row left untouched (not retried)");

      console.log("Between-batch halt (kill-switch flip):");
      const batchStage = await mkStage(prov);
      for (const t of ["b1", "b2", "b3"]) await addPending(batchStage, await mkContact(), t);
      let calls = 0;
      // true for the initial gate + first two batch checks, then off.
      const flip = () => {
        calls++;
        return calls <= 3;
      };
      const hh = await runStageDrain(tx, { stageId: batchStage, sendSms: okSender, isEnabled: flip, batchSize: 1 });
      assert(hh.ok && hh.halted === true, "halted mid-drain when kill-switch flipped");
      assert(hh.sent >= 1 && hh.remaining >= 1, "some sent before halt, some pending left untouched");

      // ── Circuit breakers ───────────────────────────────────────────────────
      console.log("Breaker: provider_paused refusal (latched kill-switch):");
      const pausedProv = await mkProvider();
      await addCred(pausedProv);
      await tx.execute(sql`UPDATE sms_providers SET send_paused = true WHERE id = ${pausedProv}`);
      const pausedStage = await mkStage(pausedProv);
      await addPending(pausedStage, await mkContact(), "p1");
      const pr = await runStageDrain(tx, { stageId: pausedStage, sendSms: okSender, isEnabled: () => true });
      assert(!pr.ok && pr.reason === "provider_paused", "paused provider refuses before claiming");
      assert((await statusOf(pausedStage, "pending")) === 1, "nothing claimed while paused");

      console.log("Breaker #2: dedup index blocks a 2nd live row per (stage, contact):");
      const dupStage = await mkStage(prov);
      const dupContact = await mkContact();
      await addPending(dupStage, dupContact, "d1");
      let violated = false;
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
            VALUES (${orgId}, ${camp.id}, ${dupStage}, ${dupContact}, ${"+15555550000"}, ${"d2"}, 'pending')
          `);
        });
      } catch {
        violated = true;
      }
      assert(violated, "2nd simultaneously-live pending row for same (stage, contact) is rejected");

      console.log("Breaker: soft 24h ceiling stops the run WITHOUT pausing:");
      // The ceiling is now PER-PROVIDER: this fresh provider has 0 of its own
      // sends in the window, so a cap of 2 lets exactly 2 of 5 through before the
      // 24h ceiling trips (independent of any other provider's volume in this org).
      const capProv = await mkProvider({ max24: 2, maxMin: 100_000 });
      await addCred(capProv);
      const capStage = await mkStage(capProv);
      for (let i = 0; i < 5; i++) await addPending(capStage, await mkContact(), `c${i}`);
      const cap = await runStageDrain(tx, { stageId: capStage, sendSms: okSender, isEnabled: () => true, batchSize: 1 });
      assert(cap.ok && cap.sent === 2, "sent exactly up to the 24h ceiling (2 of 5)");
      assert(cap.stopReason === "rate_24h", "stopReason = rate_24h");
      assert(cap.halted === false && cap.pausedNow === false, "soft ceiling does NOT pause");
      assert(cap.remaining === 3, "remaining rows left pending for next tick");
      const stillUnpaused = await one<{ send_paused: boolean }>(sql`SELECT send_paused FROM sms_providers WHERE id = ${capProv}`);
      assert(stillUnpaused.send_paused === false, "provider stays un-paused after a soft ceiling");

      console.log("Breaker: soft per-minute ceiling stops the run WITHOUT pausing:");
      // Fresh provider ⇒ 0 of its own sends this minute, so a cap of 1 lets
      // exactly 1 of 4 through before the per-minute ceiling trips.
      const minProv = await mkProvider({ maxMin: 1, max24: 100_000 });
      await addCred(minProv);
      const minStage = await mkStage(minProv);
      for (let i = 0; i < 4; i++) await addPending(minStage, await mkContact(), `mn${i}`);
      const mn = await runStageDrain(tx, { stageId: minStage, sendSms: okSender, isEnabled: () => true, batchSize: 1 });
      assert(mn.ok && mn.sent === 1 && mn.stopReason === "rate_minute", "per-minute ceiling stops at the cap");
      assert(mn.halted === false && mn.pausedNow === false, "per-minute soft ceiling does NOT pause");

      // ── Regression (ClickUp 869e659t4): per-provider ceiling isolation ────────
      // The incident: a due Ahoi stage never drained because the 24h ceiling
      // counted stage_sends ORG-WIDE (~30k TextHub sends) against Ahoi's own cap.
      // Assert here that one provider's volume can NEVER trip another provider's
      // ceiling — this is the test that would have caught stage 1274.
      console.log("Regression: one provider's volume must NOT trip another provider's ceiling:");
      // Provider A: high caps, sends a baseline of 6 (the "noisy neighbour").
      const provA = await mkProvider({ max24: 100_000, maxMin: 100_000 });
      await addCred(provA);
      const stageA = await mkStage(provA);
      for (let i = 0; i < 6; i++) await addPending(stageA, await mkContact(), `ra${i}`);
      const raDrain = await runStageDrain(tx, { stageId: stageA, sendSms: okSender, isEnabled: () => true });
      assert(raDrain.ok && raDrain.sent === 6, "provider A sent its 6 (baseline org volume)");
      // Provider B: a DIFFERENT provider in the SAME org with a 24h cap of 5. The
      // org-wide 24h count is now 6 (> 5); B's OWN count is 0. Pre-fix this drain
      // tripped rate_24h immediately and sent 0 — the bug. Now B drains all 3.
      const provB = await mkProvider({ max24: 5, maxMin: 100_000 });
      await addCred(provB);
      assert((await countSentSince(tx, orgId, provA, 86_400)) === 6, "countSentSince scopes to provider A (6)");
      assert((await countSentSince(tx, orgId, provB, 86_400)) === 0, "countSentSince scopes to provider B (0), NOT the org-wide 6");
      const stageB = await mkStage(provB);
      for (let i = 0; i < 3; i++) await addPending(stageB, await mkContact(), `rb${i}`);
      const rbDrain = await runStageDrain(tx, { stageId: stageB, sendSms: okSender, isEnabled: () => true, batchSize: 1 });
      assert(rbDrain.ok && rbDrain.sent === 3, "provider B drains all 3 despite org-wide volume exceeding B's cap");
      assert(rbDrain.stopReason === null, "provider B never soft-stops on another provider's volume");

      console.log("Breaker: mid-run pause kill (true mid-invocation):");
      const midProv = await mkProvider();
      await addCred(midProv);
      const midStage = await mkStage(midProv);
      for (const t of ["x1", "x2", "x3"]) await addPending(midStage, await mkContact(), t);
      let sendCalls = 0;
      // Flip the provider's pause on the 2nd send; the NEXT batch's pre-claim
      // re-read must catch it and halt.
      const pausingSender: Sender = async () => {
        sendCalls++;
        if (sendCalls === 2) {
          await tx.execute(sql`UPDATE sms_providers SET send_paused = true WHERE id = ${midProv}`);
        }
        return { ok: true, messageId: "TH-mid", response: "queued", providerStatus: null, suppressed: false, rawBody: '{"id":"TH-mid"}', error: null, status: 200, timedOut: false };
      };
      const mid = await runStageDrain(tx, { stageId: midStage, sendSms: pausingSender, isEnabled: () => true, batchSize: 1 });
      assert(mid.ok && mid.sent === 2, "sent 2 before the concurrent pause took effect");
      assert(mid.halted === true && mid.stopReason === "paused", "halted at next batch on mid-run pause");
      assert(mid.remaining === 1, "1 row left pending (untouched) after the mid-run kill");

      console.log("Breaker: failure-spike latches the pause + writes an audit event:");
      const spikeProv = await mkProvider();
      await addCred(spikeProv);
      const spikeStage = await mkStage(spikeProv);
      for (let i = 0; i < 12; i++) await addPending(spikeStage, await mkContact(), `s${i}`);
      const sp = await runStageDrain(tx, { stageId: spikeStage, sendSms: failSender, isEnabled: () => true });
      assert(sp.ok && sp.failed === 10, "stopped after 10 consecutive failures");
      assert(sp.halted === true && sp.stopReason === "failure_spike" && sp.pausedNow === true, "failure spike latched a pause");
      const spikeState = await one<{ send_paused: boolean; send_paused_reason: string | null }>(
        sql`SELECT send_paused, send_paused_reason FROM sms_providers WHERE id = ${spikeProv}`,
      );
      assert(spikeState.send_paused === true, "provider send_paused = true after the spike");
      assert((spikeState.send_paused_reason ?? "").startsWith("failure_spike"), "pause reason records the spike");
      const evt = await one<{ event: string; actor_user_id: string | null }>(
        sql`SELECT event, actor_user_id FROM send_circuit_events WHERE provider_id = ${spikeProv} ORDER BY id DESC LIMIT 1`,
      );
      assert(evt.event === "paused" && evt.actor_user_id === null, "audit event: auto-trip pause (actor NULL)");
      const reSpike = await runStageDrain(tx, { stageId: spikeStage, sendSms: okSender, isEnabled: () => true });
      assert(!reSpike.ok && reSpike.reason === "provider_paused", "subsequent drains refuse until a human resumes");

      console.log("Throughput: sends within a batch fire concurrently, bounded by `concurrency`:");
      const concProv = await mkProvider();
      await addCred(concProv);
      const concStage = await mkStage(concProv);
      for (let i = 0; i < 6; i++) await addPending(concStage, await mkContact(), `cc${i}`);
      let inFlight = 0;
      let maxInFlight = 0;
      // Track simultaneous in-flight sends: each call holds across a macrotask so
      // a parallelized slice overlaps (serial code would never exceed 1).
      const concSender: Sender = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return { ok: true, messageId: "TH-c", response: "queued", providerStatus: null, suppressed: false, rawBody: '{"id":"TH-c"}', error: null, status: 200, timedOut: false };
      };
      const cc = await runStageDrain(tx, { stageId: concStage, sendSms: concSender, isEnabled: () => true, concurrency: 5 });
      assert(cc.ok && cc.sent === 6, "all 6 sent");
      assert(maxInFlight > 1, `sends overlapped — max in-flight ${maxInFlight} > 1 (not the old serial path)`);
      assert(maxInFlight <= 5, `concurrency bound respected — max in-flight ${maxInFlight} <= 5`);

      console.log("Per-second pacing: rate=3 throttles a 6-send drain to ≥ ~1.6s:");
      const paceProv = await mkProvider();
      await addCred(paceProv);
      const paceStage = await mkStage(paceProv);
      for (let i = 0; i < 6; i++) await addPending(paceStage, await mkContact(), `pp${i}`);
      const t0 = Date.now();
      // rate=3 ⇒ two slices of 3, each paced to ~1s with the instant sender.
      const pc = await runStageDrain(tx, { stageId: paceStage, sendSms: okSender, isEnabled: () => true, concurrency: 3 });
      const elapsed = Date.now() - t0;
      assert(pc.ok && pc.sent === 6, "all 6 sent under pacing");
      assert(elapsed >= 1600, `paced to ~3/sec — 6 sends took ${elapsed}ms (≥1600ms = ≤3/sec)`);

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-drain OK.");
}

main().catch((err) => { console.error("verify-drain crashed:", err); process.exit(1); });
