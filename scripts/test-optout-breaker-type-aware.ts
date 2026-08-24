import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { checkOptOutRateBreaker } from "@/lib/sends/optout-rate-breaker";

// R13 GUARD — the opt-out-rate breaker's type awareness (Drip Phase 5).
//
// ⭐ WHY THIS IS THE MOST IMPORTANT TEST IN PHASE 5.
// checkOptOutRateBreaker has FOUR live callers — every opt-out ingester
// (poll-opt-outs, tells, ahoi, textrequest) — all compliance-critical. Phase 5
// teaches it to skip the latch for DRIP campaigns, whose own per-ET-day monitor
// owns their latch. A mistake in that condition silently removes opt-out
// protection from REAL campaigns, and nothing else in the system would notice.
//
// ⭐ SO THE DIRECTION IS TESTED, NOT JUST THE FEATURE. R13 states it
// normatively: only a positive, successful read of type = 'drip' may skip. NULL,
// unknown, or unreadable ⇒ the existing behaviour. A test that only proved
// "drip skips" would pass on an implementation that skipped for EVERYTHING.
//
// Each case drives the REAL function against REAL rows, then reads
// campaigns.send_paused to see whether the latch actually fired.
//
// Preview only: it writes.

const PROD_REF = "rtdarhkkjwcetlmruftl";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "";
  if (ref === PROD_REF) {
    console.error("REFUSING to run against PRODUCTION. This test writes and trips a breaker.");
    process.exit(1);
  }
  console.log(`target ref: ${ref}`);

  const orgRows = (await db.execute(sql`
    SELECT id FROM organizations ORDER BY created_at LIMIT 1
  `)) as unknown as { id: string }[];
  const orgId = orgRows[0].id;
  const sfx = String(Date.now()).slice(-7);
  const made: number[] = [];

  // Enough sends + STOPs to breach whatever the configured threshold is. The
  // breaker's own min-sends floor means a handful is not enough.
  const SENT = 600;
  const OPTOUTS = 300; // 50% — well past any threshold

  async function buildCampaign(type: string | null, label: string) {
    const campRows = (await db.execute(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode ${
        type === null ? sql`` : sql`, type`
      })
      VALUES (${orgId}, ${"r13-" + sfx + "-" + label}, ${"R13 " + label}, 'active', 'tracked' ${
        type === null ? sql`` : sql`, ${type}`
      })
      RETURNING id
    `)) as unknown as { id: number }[];
    const campId = campRows[0].id;
    made.push(campId);

    const stageRows = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, send_approved)
      VALUES (${orgId}, ${campId}, 1, true) RETURNING id
    `)) as unknown as { id: number }[];
    const stageId = stageRows[0].id;

    // Contacts first — stage_sends.contact_id is NOT NULL. Synthetic +1991
    // numbers, namespaced by campaign so cleanup is unambiguous.
    await db.execute(sql`
      INSERT INTO contacts (org_id, phone_number)
      SELECT ${orgId}, '+1991' || lpad(${campId}::text, 4, '0') || lpad(g::text, 6, '0')
      FROM generate_series(1, ${SENT}) g
      ON CONFLICT DO NOTHING
    `);
    // Sends, all just now so both the long and short windows see them.
    await db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                               rendered_text, status, sent_at, created_at)
      SELECT ${orgId}, ${campId}, ${stageId}, c.id, c.phone_number,
             'r13 fixture body Reply STOP to opt out',
             'sent', now() - make_interval(mins => 5), now() - make_interval(mins => 5)
      FROM contacts c
      WHERE c.org_id = ${orgId}
        AND c.phone_number LIKE ${'+1991' + '%'}
        AND c.phone_number LIKE '+1991' || lpad(${campId}::text, 4, '0') || '%'
    `);
    // Real opt_outs + attributions. The breaker measures the rate against the
    // MESSAGES that produced the STOPs (via stage_send_id), so the attribution
    // must point at a real send, not just exist.
    await db.execute(sql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
      SELECT ${orgId}, ss.contact_id, ss.phone, 'sms_inbound'
      FROM (SELECT contact_id, phone FROM stage_sends
            WHERE stage_id = ${stageId} ORDER BY id LIMIT ${OPTOUTS}) ss
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_send_id, campaign_id, stage_id)
      SELECT ${orgId}, oo.id, ss.id, ${campId}, ${stageId}
      FROM (SELECT id, contact_id FROM stage_sends
            WHERE stage_id = ${stageId} ORDER BY id LIMIT ${OPTOUTS}) ss
      JOIN opt_outs oo ON oo.contact_id = ss.contact_id AND oo.org_id = ${orgId}
      ON CONFLICT DO NOTHING
    `);
    return { campId, stageId };
  }

  async function isPaused(campId: number) {
    const r = (await db.execute(sql`
      SELECT send_paused FROM campaigns WHERE id = ${campId}
    `)) as unknown as { send_paused: boolean }[];
    return r[0]?.send_paused === true;
  }

  try {
    // ── 1. REGULAR campaign still trips ─────────────────────────────────
    console.log("\n1. a REGULAR campaign must STILL trip (the thing that must not break):");
    const reg = await buildCampaign("regular", "regular");
    const r1 = await checkOptOutRateBreaker(db, {
      orgId, campaignId: reg.campId, stageId: reg.stageId,
    });
    check("breaker reports a trip", r1.tripped_by !== null, true);
    check("⭐ the campaign IS latched", await isPaused(reg.campId), true);

    // ── 2. UNKNOWN type still trips ─────────────────────────────────────
    console.log("\n2. an UNKNOWN/unreadable type must behave like regular (R13's direction):");
    const unk = await buildCampaign("regular", "unknown");
    // Force a value the CHECK would normally forbid, to simulate a future value
    // this build has never heard of.
    await db.execute(sql`ALTER TABLE campaigns DROP CONSTRAINT campaigns_type_check`);
    await db.execute(sql`UPDATE campaigns SET type = 'some_future_type' WHERE id = ${unk.campId}`);
    const r2 = await checkOptOutRateBreaker(db, {
      orgId, campaignId: unk.campId, stageId: unk.stageId,
    });
    check("breaker reports a trip", r2.tripped_by !== null, true);
    check("⭐ an unknown type STILL latches (fails toward existing behaviour)",
          await isPaused(unk.campId), true);
    await db.execute(sql`UPDATE campaigns SET type = 'regular' WHERE id = ${unk.campId}`);
    await db.execute(sql`
      ALTER TABLE campaigns ADD CONSTRAINT campaigns_type_check
      CHECK (type IN ('regular', 'drip'))`);

    // ── 3. DRIP campaign does NOT latch here ────────────────────────────
    console.log("\n3. a DRIP campaign must NOT be latched by the STAGE-level breaker:");
    const drip = await buildCampaign("drip", "drip");
    const r3 = await checkOptOutRateBreaker(db, {
      orgId, campaignId: drip.campId, stageId: drip.stageId,
    });
    check("breaker still MEASURES the rate (it is not blind)", r3.tripped_by !== null, true);
    check("⭐ but the drip campaign is NOT latched", await isPaused(drip.campId), false);
    check("...and it reports tripped=false to the caller", r3.tripped, false);

    console.log(
      "\n        (the drip campaign's latch is owned by the per-ET-day drip monitor,\n" +
      "         which is a different window over a different population)",
    );
  } finally {
    console.log("\ncleanup (by id):");
    // Make sure the CHECK is back even if an assertion threw mid-case — leaving
    // production-shaped schema half-modified would be far worse than a red test.
    await db.execute(sql`
      ALTER TABLE campaigns ADD CONSTRAINT campaigns_type_check
      CHECK (type IN ('regular', 'drip'))
    `).catch(() => {});
    if (made.length) {
      const list = sql.join(made.map((i) => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM opt_out_attributions WHERE campaign_id IN (${list})`);
      await db.execute(sql`
        DELETE FROM opt_outs WHERE org_id = ${orgId} AND phone_number LIKE '+1991%'`);
      await db.execute(sql`DELETE FROM stage_sends WHERE campaign_id IN (${list})`);
      await db.execute(sql`DELETE FROM campaign_stages WHERE campaign_id IN (${list})`);
      await db.execute(sql`DELETE FROM campaigns WHERE id IN (${list})`);
      for (const cid of made) {
        await db.execute(sql`
          DELETE FROM contacts
          WHERE org_id = ${orgId}
            AND phone_number LIKE '+1991' || lpad(${cid}::text, 4, '0') || '%'
        `);
      }
    }
    const residue = (await db.execute(sql`
      SELECT (SELECT count(*)::int FROM campaigns WHERE slug LIKE ${"r13-" + sfx + "%"}) AS camps,
             (SELECT count(*)::int FROM contacts WHERE phone_number LIKE '+1991%')       AS synth
    `)) as unknown as { camps: number; synth: number }[];
    check("no probe campaigns left", residue[0]?.camps, 0);
    check("no synthetic contacts left", residue[0]?.synth, 0);
    const chk = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'campaigns_type_check'
    `)) as unknown as { n: number }[];
    check("⭐ campaigns_type_check restored", chk[0]?.n, 1);
  }

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
