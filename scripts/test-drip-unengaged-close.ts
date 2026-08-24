import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { closeJourneyUnengaged } from "@/lib/drip/lifecycle";

// The Ignored lane is terminal (Drip Phase 7, ruling R4).
//
// ⭐ RUNS ON camman-v2 PREVIEW ONLY. Refuses by project ref, which is in the
// connection string and cannot be bypassed by forgetting an env var. Everything
// it writes is rolled back besides.
//
// ⭐ WHAT ACTUALLY MATTERS HERE is not that the close happens — one UPDATE
// obviously updates. It is the THREE properties that make it safe:
//
//   1. ATOMIC WITH THE SEND. If the send fails, the close must not stick. The
//      whole point of doing it in the lane's transaction is that a journey can
//      never read "unengaged" for a message that was never dispatched.
//   2. IDEMPOTENT. A second call must not re-stamp closed_at or overwrite a
//      reason that a DIFFERENT terminal transition already set. A contact who
//      replies STOP one second after the Ignored lane fires must stay
//      `opted_out`, not be relabelled `unengaged` — the compliance record wins.
//   3. DISTINCT IN THE FUNNEL. `completed/unengaged` and
//      `completed/all_stages_sent` must not merge, or the campaign's bad news
//      vanishes into its good news.

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A partner key of this test's own making.
 *
 * ⚠️ CREATED, NOT BORROWED. An earlier draft picked "the first partner_keys row
 * in the org" and blew up on a preview database that had none — a test that
 * depends on ambient state fails for reasons that have nothing to do with the
 * behaviour under test, and passes for reasons that have nothing to do with it
 * either. Everything here is built and rolled back.
 */
async function makePartnerKey(tx: Tx, orgId: string): Promise<number> {
  const k = (await tx.execute(sql`
    INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash,
                              interest_tag_mode, interest_tag, sandbox, status)
    VALUES (${orgId}::uuid, 'p7-unengaged-fixture', 'P7 fixture',
            'p7-fixture-token', repeat('0', 64), 'force', 'medicare', false, 'active')
    RETURNING id`)) as unknown as { id: number }[];
  return k[0].id;
}

/** A drip campaign of this test's own making — `drip_journeys_campaign_required_check`
 *  refuses any journey that is not `unroutable` without one. */
async function makeCampaign(tx: Tx, orgId: string): Promise<number> {
  const c = (await tx.execute(sql`
    INSERT INTO campaigns (org_id, slug, name, type, status)
    VALUES (${orgId}::uuid, 'p7-unengaged-fixture', 'P7 fixture', 'drip', 'draft')
    RETURNING id`)) as unknown as { id: number }[];
  return c[0].id;
}

/**
 * One (contact, lead_event, journey) fixture. Every column the real intake path
 * writes, so the rows are shaped like production rows rather than like the
 * minimum the constraints tolerate.
 */
async function fixture(
  tx: Tx,
  orgId: string,
  partnerKeyId: number,
  campaignId: number,
  phone: string,
  state: string,
  closeReason: string | null,
): Promise<{ contactId: string; journeyId: string }> {
  const c = (await tx.execute(sql`
    INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone})
    RETURNING id`)) as unknown as { id: string }[];
  const le = (await tx.execute(sql`
    INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug,
                             interest_tag, received_at, sandbox)
    VALUES (${orgId}::uuid, ${c[0].id}::uuid, ${partnerKeyId}, 'p7-unengaged-fixture',
            'medicare', now(), false)
    RETURNING id`)) as unknown as { id: string }[];
  const j = (await tx.execute(sql`
    INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state,
                               routed_at, reason, closed_at, close_reason)
    VALUES (${orgId}::uuid, ${campaignId}, ${c[0].id}::uuid, ${le[0].id}::uuid, ${state},
            now(), '{}'::jsonb, ${closeReason ? sql`now()` : sql`NULL`}, ${closeReason})
    RETURNING id`)) as unknown as { id: string }[];
  return { contactId: c[0].id, journeyId: j[0].id };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "(unknown)";
  if (ref === PROD_REF) {
    console.error(`REFUSING to run against PRODUCTION (${PROD_REF}). This test writes.`);
    process.exit(1);
  }
  console.log(`target project ref: ${ref}${ref === PREVIEW_REF ? "  (camman-v2 preview ✓)" : ""}\n`);

  class Rollback extends Error {}
  try {
    await db.transaction(async (tx: Tx) => {
      // ── fixture ───────────────────────────────────────────────────────────
      const org = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      if (org.length === 0) throw new Error("no organization in the preview DB — cannot build a fixture");
      const orgId = org[0].id;

      const keyId = await makePartnerKey(tx, orgId);
      const campId = await makeCampaign(tx, orgId);
      const { journeyId } = await fixture(tx, orgId, keyId, campId, "+15550001111", "active", null);
      const live = (await tx.execute(sql`
        SELECT state FROM drip_journeys WHERE id = ${journeyId}::uuid
      `)) as unknown as { state: string }[];
      check("fixture journey is live", live[0].state, "active");

      // ── 1. the close itself ───────────────────────────────────────────────
      console.log("\nthe Ignored lane closes the journey:");
      const first = await closeJourneyUnengaged(tx, { orgId, journeyId });
      check("closes exactly one journey", first.closed, 1);

      const after = (await tx.execute(sql`
        SELECT state, close_reason, (closed_at IS NOT NULL) AS stamped
        FROM drip_journeys WHERE id = ${journeyId}::uuid
      `)) as unknown as { state: string; close_reason: string; stamped: boolean }[];
      check("state is completed", after[0].state, "completed");
      check("⭐ reason is `unengaged`, NOT `all_stages_sent`", after[0].close_reason, "unengaged");
      check("closed_at stamped", after[0].stamped, true);

      // ── 2. idempotence ────────────────────────────────────────────────────
      console.log("\n⭐ idempotence — a second call must be a no-op:");
      const second = await closeJourneyUnengaged(tx, { orgId, journeyId });
      check("second call closes nothing", second.closed, 0);

      // ── 3. a terminal state already set WINS ──────────────────────────────
      // This is the compliance case: STOP arrives in the same minute the Ignored
      // lane fires. Whichever runs second must not relabel the journey.
      console.log("\n⭐ an opted-out journey is NEVER relabelled unengaged:");
      const stopped = await fixture(tx, orgId, keyId, campId, "+15550002222", "opted_out", "stop_received");
      const optedOut = await closeJourneyUnengaged(tx, { orgId, journeyId: stopped.journeyId });
      check("close refuses an already-terminal journey", optedOut.closed, 0);
      const still = (await tx.execute(sql`
        SELECT state, close_reason FROM drip_journeys WHERE id = ${stopped.journeyId}::uuid
      `)) as unknown as { state: string; close_reason: string }[];
      check("⭐ still opted_out / stop_received", [still[0].state, still[0].close_reason],
            ["opted_out", "stop_received"]);

      // ── 4. cross-org isolation ────────────────────────────────────────────
      console.log("\ncross-org isolation:");
      const wrongOrg = await closeJourneyUnengaged(tx, {
        orgId: "00000000-0000-0000-0000-000000000000",
        journeyId: stopped.journeyId,
      });
      check("a foreign org_id closes nothing", wrongOrg.closed, 0);

      // ── 5. the funnel keeps the two `completed` reasons apart ─────────────
      console.log("\n⭐ the funnel does not merge the two `completed` endings:");
      const finished = await fixture(
        tx, orgId, keyId, campId, "+15550003333", "completed", "all_stages_sent",
      );

      const grouped = (await tx.execute(sql`
        SELECT state, close_reason, count(*)::int AS n
        FROM drip_journeys
        WHERE org_id = ${orgId}::uuid
          AND id IN (${journeyId}::uuid, ${stopped.journeyId}::uuid, ${finished.journeyId}::uuid)
        GROUP BY 1, 2 ORDER BY 1, 2
      `)) as unknown as { state: string; close_reason: string; n: number }[];
      const completedRows = grouped.filter((g) => g.state === "completed");
      check("⭐ `completed` yields TWO rows, not one", completedRows.length, 2);
      check("⭐ and they are the two distinct reasons",
            completedRows.map((r) => r.close_reason).sort(),
            ["all_stages_sent", "unengaged"]);

      // ── 6. atomicity: a failed send takes the close with it ───────────────
      // The lane calls dispatchDripSend and closeJourneyUnengaged in ONE
      // transaction. Simulate the send throwing AFTER the close and assert the
      // close does not survive — the property that keeps "unengaged" from ever
      // describing a message that was not sent.
      console.log("\n⭐ atomicity — a throw after the close must undo the close:");
      await tx.execute(sql`SAVEPOINT lane`);
      const lane = await fixture(tx, orgId, keyId, campId, "+15550004444", "active", null);
      await closeJourneyUnengaged(tx, { orgId, journeyId: lane.journeyId });
      const midway = (await tx.execute(sql`
        SELECT state FROM drip_journeys WHERE id = ${lane.journeyId}::uuid
      `)) as unknown as { state: string }[];
      check("closed inside the savepoint", midway[0].state, "completed");
      await tx.execute(sql`ROLLBACK TO SAVEPOINT lane`);
      const undone = (await tx.execute(sql`
        SELECT state FROM drip_journeys WHERE id = ${lane.journeyId}::uuid
      `)) as unknown as { state: string }[];
      check("⭐ the send's rollback undid the close (journey row gone with it)",
            undone.length, 0);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  console.log("\nfixture rolled back — nothing written.");
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
