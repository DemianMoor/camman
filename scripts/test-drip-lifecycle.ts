import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  cancelPendingForJourney,
  closeCompletedJourneys,
  closeJourneyOnOptOut,
  closeJourneysOnArchive,
  closeJourneysOnPurchase,
} from "@/lib/drip/lifecycle";

// Drip journey lifecycle (Drip Phase 6) — the check Phase 5 failed.
//
// ⭐ THE CONVERTED CASE USES sale_status = 'lead', NOT 'sale', AND THAT IS THE
// WHOLE POINT. This account's network fires `lead`-status postbacks for paid
// conversions and effectively never sends `sale`; an `= 'sale'` test once found
// 2 buyers where the truth was ~835. A lifecycle test that closed on 'sale'
// would pass here and close almost nothing in production.
//
// ⭐ AND THE REAL ASSERTION IS THAT THE SLOT IS FREED, not that a string
// changed. drip_journeys_one_live_per_contact_uniq keys on
// state IN ('routed','active'), so a journey that "closes" without freeing the
// slot leaves the contact permanently unroutable — which is the actual harm.
// Each case proves a SECOND journey can then be created for the same contact.
//
// Everything runs in a rolled-back probe transaction.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  console.log(`ref: ${/postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1]}`);
  let rolledBack = false;

  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[]
      )[0].id;
      const sfx = String(Date.now()).slice(-7);

      const campId = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
          VALUES (${orgId}, ${"lc-" + sfx}, 'lifecycle probe', 'active', 'drip', 'tracked')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const parentId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
          VALUES (${orgId}, ${campId}, 1, 0, 1440, true) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;

      let seq = 0;
      async function newJourney(phone: string) {
        const cid = (
          (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone})
            RETURNING id`)) as unknown as { id: string }[]
        )[0].id;
        const pk = (
          (await tx.execute(sql`
            INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
            VALUES (${orgId}, ${"lc" + sfx + seq}, 'probe', ${"tok" + sfx + seq++}, 'h')
            RETURNING id`)) as unknown as { id: number }[]
        )[0].id;
        const le = (
          (await tx.execute(sql`
            INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
            VALUES (${orgId}, ${cid}, ${pk}, 'probe', now()) RETURNING id`)) as unknown as { id: string }[]
        )[0].id;
        const jid = (
          (await tx.execute(sql`
            INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id,
                                       state, first_send_at, first_stage_id)
            VALUES (${orgId}, ${campId}, ${cid}, ${le}, 'active', now(), ${parentId})
            RETURNING id`)) as unknown as { id: string }[]
        )[0].id;
        return { cid, jid, le, pk };
      }

      /** Can this contact hold a NEW live journey? That is what the slot means.
       *
       * ⚠️ A FRESH lead_event EVERY TIME. drip_journeys also carries a UNIQUE on
       * lead_event_id, so reusing one makes the probe fail on the WRONG
       * constraint and report an occupied slot for a journey that closed
       * perfectly well — which is exactly what the first run of this test did. */
      async function slotFree(cid: string): Promise<boolean> {
        try {
          await tx.transaction(async (sp) => {
            const pk2 = (
              (await sp.execute(sql`
                INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
                VALUES (${orgId}, ${"sf" + sfx + seq}, 'probe', ${"sftok" + sfx + seq++}, 'h')
                RETURNING id`)) as unknown as { id: number }[]
            )[0].id;
            const le2 = (
              (await sp.execute(sql`
                INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
                VALUES (${orgId}, ${cid}, ${pk2}, 'probe', now()) RETURNING id`)) as unknown as { id: string }[]
            )[0].id;
            await sp.execute(sql`
              INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
              VALUES (${orgId}, ${campId}, ${cid}, ${le2}, 'routed')`);
            throw new Error("SP-ROLLBACK");
          });
          return true;
        } catch (e) {
          if ((e as Error).message === "SP-ROLLBACK") return true;
          return false; // unique violation on the CONTACT slot ⇒ still occupied
        }
      }

      const state = async (jid: string) =>
        (
          (await tx.execute(sql`
            SELECT state, closed_at IS NOT NULL AS closed, close_reason
            FROM drip_journeys WHERE id = ${jid}::uuid`)) as unknown as Record<string, unknown>[]
        )[0];

      // ── 1. opt-out ────────────────────────────────────────────────────────
      console.log("\n1. STOP ⇒ opted_out:");
      const a = await newJourney("+19980" + sfx);
      check("slot occupied while live", await slotFree(a.cid), false);
      const r1 = await closeJourneyOnOptOut(tx, { orgId, contactId: a.cid });
      check("one journey closed", r1.closed, 1);
      check("state", (await state(a.jid)).state, "opted_out");
      check("closed_at stamped", (await state(a.jid)).closed, true);
      check("⭐ the slot is FREED", await slotFree(a.cid), true);
      check("⭐ idempotent — a second close does nothing",
            (await closeJourneyOnOptOut(tx, { orgId, contactId: a.cid })).closed, 0);

      // ── 2. converted, via purchasedClause() ───────────────────────────────
      console.log("\n2. ⭐ purchase ⇒ converted — on sale_status = 'lead', not 'sale':");
      const b = await newJourney("+19981" + sfx);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, sale_status, sent_at, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${b.cid}, ${"+19981" + sfx},
                'probe', 'sent', 'lead', now(), now())`);
      const r2 = await closeJourneysOnPurchase(tx, { orgId, campaignId: campId });
      check("closed on a 'lead' postback", r2.closed, 1);
      check("state", (await state(b.jid)).state, "converted");
      check("⭐ slot freed", await slotFree(b.cid), true);

      // the control that makes the above meaningful
      const c = await newJourney("+19982" + sfx);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, sale_status, sent_at, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${c.cid}, ${"+19982" + sfx},
                'probe', 'sent', 'rejected', now(), now())`);
      check("⭐ a 'rejected' conversion is NOT a purchase",
            (await closeJourneysOnPurchase(tx, { orgId, campaignId: campId })).closed, 0);
      check("...and that journey is still live", (await state(c.jid)).state, "active");

      // ── 3. completed ──────────────────────────────────────────────────────
      console.log("\n3. all enabled children sent ⇒ completed:");
      const d = await newJourney("+19983" + sfx);
      const childId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, parent_stage_id, behavioral_tier,
                                       drip_followup_minutes, drip_active, stage_number)
          VALUES (${orgId}, ${campId}, ${parentId}, 0, 1440, true, 99)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      check("⭐ NOT complete while a child is still owed",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed, 0);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, created_at)
        VALUES (${orgId}, ${campId}, ${childId}, ${d.cid}, ${"+19983" + sfx},
                'probe', 'sent', now())`);
      check("complete once it has been sent",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed, 1);
      check("state", (await state(d.jid)).state, "completed");

      // ⭐ THE UNREACHABLE-LANE CASE. Tier is HIGH-WATER, so a contact that
      // clicked can never match the Ignored lane again. If completion waited on
      // that lane it would be unreachable for everyone who ever engaged --
      // exactly the population whose journey should end cleanly. Caught on live
      // data: the sweeper reported completed:0 for a clicker who was finished.
      const g = await newJourney("+19986" + sfx);
      const lowLane = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, parent_stage_id, behavioral_tier,
                                       drip_followup_minutes, drip_active, stage_number)
          VALUES (${orgId}, ${campId}, ${parentId}, 0, 1440, true, 97)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const highLane = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, parent_stage_id, behavioral_tier,
                                       drip_followup_minutes, drip_active, stage_number)
          VALUES (${orgId}, ${campId}, ${parentId}, 1, 60, true, 96)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      // make this contact tier 1 (a clean click), and send it ONLY the tier-1 lane
      const lnk = (
        (await tx.execute(sql`
          INSERT INTO link_destinations (org_id, url, url_hash)
          VALUES (${orgId}, ${"https://x.example/" + sfx}, ${"h" + sfx})
          ON CONFLICT DO NOTHING RETURNING id`)) as unknown as { id: number }[]
      )[0];
      const sd = (
        (await tx.execute(sql`SELECT id FROM short_domains LIMIT 1`)) as unknown as { id: number }[]
      )[0].id;
      const linkId = (
        (await tx.execute(sql`
          INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id,
                             stage_id, contact_id, send_token,
                             campaign_tracking_id, stage_tracking_id)
          VALUES (${orgId}, ${"c" + sfx.slice(-6)}, ${sd}, ${lnk.id}, ${campId},
                  ${parentId}, ${g.cid}, ${"tok" + sfx}, 'x', 'y')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await tx.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification) VALUES (${orgId}, ${linkId}, 'human')`);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, created_at)
        VALUES (${orgId}, ${campId}, ${highLane}, ${g.cid}, ${"+19986" + sfx},
                'probe', 'sent', now())`);
      check("⭐ a clicker completes even though the Ignored lane never sent to it",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed >= 1, true);
      check("...its state is completed", (await state(g.jid)).state, "completed");
      void lowLane;


      // ── 4. archive ⇒ exited ───────────────────────────────────────────────
      console.log("\n4. campaign archived ⇒ exited:");
      const e = await newJourney("+19984" + sfx);
      const r4 = await closeJourneysOnArchive(tx, { orgId, campaignId: campId });
      check("live journeys closed", r4.closed >= 1, true);
      check("state", (await state(e.jid)).state, "exited");
      check("close_reason", (await state(e.jid)).close_reason, "campaign_archived");

      // ── 5. pending cancellation mirrors the opt-out cascade ───────────────
      console.log("\n5. lifecycle cancellation of pending sends:");
      const f = await newJourney("+19985" + sfx);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${f.cid}, ${"+19985" + sfx},
                'probe', 'pending', now())`);
      const n = await cancelPendingForJourney(tx, {
        orgId, contactId: f.cid, campaignId: campId, reason: "converted",
      });
      check("the pending row is cancelled", n, 1);
      const s5 = (await tx.execute(sql`
        SELECT status, last_error FROM stage_sends
        WHERE contact_id = ${f.cid} AND status <> 'sent'`)) as unknown as Record<string, unknown>[];
      check("terminal status", s5[0]?.status, "filtered");
      check("⭐ a distinct marker, countable apart from provider rejects",
            s5[0]?.last_error, "journey_converted");

      rolledBack = true;
      throw new Error("ROLLBACK");
    });
  } catch (e) {
    if ((e as Error).message !== "ROLLBACK") throw e;
  }
  check("probe rolled back", rolledBack, true);
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaigns WHERE name = 'lifecycle probe'
  `)) as unknown as { n: number }[];
  check("nothing left behind", left[0]?.n, 0);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
