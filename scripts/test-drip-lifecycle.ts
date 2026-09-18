import "./_env-preload";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  checkFollowupTierSupported,
  FOLLOWUP_TIER_UNSUPPORTED,
} from "@/lib/api/followup-tier-guard";
import { FOLLOWUP_TIERS } from "@/lib/drip/children";
import {
  cancelPendingForJourney,
  closeCompletedJourneys,
  closeJourneyOnOptOut,
  closeJourneysOnArchive,
  closeJourneysOnPurchase,
  expireJourneysPastEndDate,
} from "@/lib/drip/lifecycle";

import { seedConversionEvent } from "./_conversion-fixture";

// Drip journey lifecycle (Drip Phase 6) — the check Phase 5 failed.
//
// ⭐ THE CONVERTED CASE CLOSES ON A COUNTED PURCHASE EVENT IN THE
// conversion_events LEDGER, NOT ON stage_sends.sale_status, AND THAT IS THE
// WHOLE POINT. Which Keitaro status carried the conversion is now irrelevant to
// the close: the mapping in `conversion_event_mappings` decides what a 'lead'
// postback means, and lib/sale-attribution.ts decides which event types and
// statuses count. (That mapping is where the old "'lead' AND 'sale' both count"
// rule went — this account's network pays out on `lead` postbacks, and an
// `= 'sale'` test once found 2 buyers where the truth was ~835.)
//
// ⭐ SO SECTION 2 CARRIES TWO ONE-SIDED CONTROLS. A fixture that writes the
// ledger row AND sale_status together closes under either source and proves
// nothing about the switch:
//   ledger-only (purchase pending, sale_status NULL)   ⇒ MUST close
//   legacy-only (sale_status 'lead', no ledger row)    ⇒ MUST NOT close
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

  // ── 0. the follow-up TIER guard on the stage PATCH route ──────────────────
  //
  // ⭐ THE HOLE IT CLOSES. A tier-3 lane is creatable (Phase 4, Task 3) with
  // drip_followup_minutes NULL and drip_active NULL. Two raw PATCHes turn it
  // into a drip follow-up CHILD — and that child can never send (runDripFollowups'
  // detection ladder has no arm above tier 2) while the reachability predicate in
  // lib/drip/lifecycle.ts keeps waiting on it (3 >= 3). The journey hangs for
  // ever, which is exactly the failure sections 3 and 3b below exist to prevent.
  //
  // ⭐ WHY IT IS A REFUSAL AND NOT A NON_UPDATABLE ENTRY. The route DROPS
  // NON_UPDATABLE keys silently, so listing drip_followup_minutes there would
  // make the follow-up timer <Select> return 200, toast success and never save —
  // a live feature broken invisibly. The refusal names the TIER instead, so the
  // editor (children are always 0/1/2) is untouched.
  //
  // These bars live here rather than in the pure suite because the guard's whole
  // point is its coupling to FOLLOWUP_TIERS, and lib/drip/children.ts is
  // `server-only` — a pure copy of that list would assert nothing.
  console.log("\n0. the follow-up tier guard (PATCH /stages/[stageId]):");
  const refusalOf = (r: ReturnType<typeof checkFollowupTierSupported>) =>
    r === null ? null : { field: r.field, reason: r.reason };
  check("⭐ tier 3 + a follow-up timer is REFUSED",
        refusalOf(checkFollowupTierSupported({ behavioralTier: 3, dripFollowupMinutes: 60 })),
        { field: "drip_followup_minutes", reason: FOLLOWUP_TIER_UNSUPPORTED });
  check("⭐ tier 3 + drip_active:true is REFUSED",
        refusalOf(checkFollowupTierSupported({ behavioralTier: 3, dripActive: true })),
        { field: "drip_active", reason: FOLLOWUP_TIER_UNSUPPORTED });
  check("⭐ tier 1 + a follow-up timer still SUCCEEDS (the editor is untouched)",
        checkFollowupTierSupported({ behavioralTier: 1, dripFollowupMinutes: 60 }), null);
  check("⭐ tier 1 + drip_active:true still SUCCEEDS",
        checkFollowupTierSupported({ behavioralTier: 1, dripActive: true }), null);
  check("tier 0 and tier 2 timers still succeed",
        [0, 2].map((t) => checkFollowupTierSupported({ behavioralTier: t, dripFollowupMinutes: 60 })),
        [null, null]);
  // The drip FIRST-SEND stage is behavioral_tier NULL with drip_active true —
  // the posture switch for the whole stage. Refusing it would break drip itself.
  check("⭐ a NULL tier is not a lane: drip_active:true still succeeds (the drip first-send stage)",
        checkFollowupTierSupported({ behavioralTier: null, dripActive: true }), null);
  // Disarming must always be possible, or a stage armed before this guard
  // existed could never be switched off again.
  check("clearing the timer on an unsupported tier is allowed (disarm)",
        checkFollowupTierSupported({ behavioralTier: 3, dripFollowupMinutes: null }), null);
  check("switching an unsupported tier OFF is allowed",
        checkFollowupTierSupported({ behavioralTier: 3, dripActive: false }), null);
  check("an unrelated edit to a tier-3 lane is untouched",
        checkFollowupTierSupported({ behavioralTier: 3 }), null);
  // The message restates its own valid set, so it is derived — not retyped.
  const refusalMsg = checkFollowupTierSupported({ behavioralTier: 3, dripActive: true })?.message ?? "";
  check("⭐ the refusal message names every FOLLOWUP_TIER, derived rather than hard-coded",
        FOLLOWUP_TIERS.filter((t) => !refusalMsg.includes(String(t))), []);
  // A guard nothing calls is not a guard. Read from the route's source so this
  // cannot pass on a wired-up-looking module that no request ever reaches.
  const routeSrc = readFileSync(
    resolve(process.cwd(), "app/api/campaigns/[campaignId]/stages/[stageId]/route.ts"),
    "utf8",
  ).replace(/\s+/g, " ");
  check("⭐ the PATCH route actually CALLS the guard",
        /import \{ checkFollowupTierSupported \} from "@\/lib\/api\/followup-tier-guard";/.test(routeSrc)
          && routeSrc.includes("checkFollowupTierSupported({ behavioralTier: current.behavioral_tier"),
        true);

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

      // ── 2. converted, via purchasedClause() over the conversion_events ledger
      console.log("\n2. ⭐ purchase ⇒ converted — on a counted purchase event, whatever Keitaro status carried it:");
      const b = await newJourney("+19981" + sfx);
      const bSend = (await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, sale_status, sent_at, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${b.cid}, ${"+19981" + sfx},
                'probe', 'sent', 'lead', now(), now())
        RETURNING id::text AS id`)) as unknown as { id: string }[];
      await seedConversionEvent(tx, {
        orgId,
        stageSendId: bSend[0].id,
        contactId: b.cid,
        campaignId: campId,
        stageId: parentId,
        eventKey: "purchase",
        status: "approved",
        revenue: 100,
        keitaroType: "lead",
      });
      const r2 = await closeJourneysOnPurchase(tx, { orgId, campaignId: campId });
      check("closed on a counted purchase event, whatever Keitaro status carried it", r2.closed, 1);
      check("state", (await state(b.jid)).state, "converted");
      check("⭐ slot freed", await slotFree(b.cid), true);

      // the control that makes the above meaningful
      const c = await newJourney("+19982" + sfx);
      const cSend = (await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, sale_status, sent_at, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${c.cid}, ${"+19982" + sfx},
                'probe', 'sent', 'rejected', now(), now())
        RETURNING id::text AS id`)) as unknown as { id: string }[];
      await seedConversionEvent(tx, {
        orgId,
        stageSendId: cSend[0].id,
        contactId: c.cid,
        campaignId: campId,
        stageId: parentId,
        eventKey: "purchase",
        status: "rejected",
        revenue: 100,
        keitaroType: "rejected",
      });
      check("⭐ a 'rejected' conversion is NOT a purchase",
            (await closeJourneysOnPurchase(tx, { orgId, campaignId: campId })).closed, 0);
      check("...and that journey is still live", (await state(c.jid)).state, "active");

      // ── 2b. ⭐ the two ONE-SIDED source controls ───────────────────────────
      // h: the ledger alone says "bought" — sale_status stays NULL. Under the
      // old stage_sends reader this journey never closes.
      console.log("\n2b. ⭐ ledger vs legacy source controls:");
      const hLedger = await newJourney("+19987" + sfx);
      const hSend = (await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, sale_status, sent_at, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${hLedger.cid}, ${"+19987" + sfx},
                'probe', 'sent', NULL, now(), now())
        RETURNING id::text AS id`)) as unknown as { id: string }[];
      await seedConversionEvent(tx, {
        orgId,
        stageSendId: hSend[0].id,
        contactId: hLedger.cid,
        campaignId: campId,
        stageId: parentId,
        eventKey: "purchase",
        status: "pending",
        revenue: 40,
      });
      check("⭐ a LEDGER-ONLY purchase (pending, sale_status NULL) closes the journey",
            (await closeJourneysOnPurchase(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is converted", (await state(hLedger.jid)).state, "converted");
      check("...⭐ slot freed", await slotFree(hLedger.cid), true);

      // i: the legacy column alone says "bought" — there is NO ledger row. Under
      // the switched reader this journey must stay live.
      const iLegacy = await newJourney("+19988" + sfx);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, sale_status, sale_revenue,
                                 converted_at, sent_at, created_at)
        VALUES (${orgId}, ${campId}, ${parentId}, ${iLegacy.cid}, ${"+19988" + sfx},
                'probe', 'sent', 'lead', 100.0000, now(), now(), now())`);
      check("⭐ a LEGACY-ONLY row (sale_status 'lead', no ledger) does NOT close it",
            (await closeJourneysOnPurchase(tx, { orgId, campaignId: campId })).closed, 0);
      check("...that journey is still live", (await state(iLegacy.jid)).state, "active");

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

      // ⭐ THE REGISTERED CASE (Phase 4). A registrant's real tier is 3, above
      // every drip child (0/1/2), so no child can ever match them. If the
      // inlined reachability expression still tops out at 2 it judges the tier-2
      // child "reachable", the child never sends, and the journey hangs for ever
      // — the same shape as a buyer, which only survives today because
      // closeJourneysOnPurchase closes those separately. There is no
      // registration analogue and (user decision) none is being built.
      //
      // ONE-SIDED: this contact gets a registration ledger row and nothing else —
      // no click, no offer reach, no sale_status.
      const reg = await newJourney("+19989" + sfx);
      const regLane = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, parent_stage_id, behavioral_tier,
                                       drip_followup_minutes, drip_active, stage_number)
          VALUES (${orgId}, ${campId}, ${parentId}, 2, 60, true, 95)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const regSend = (
        (await tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                   rendered_text, status, created_at)
          VALUES (${orgId}, ${campId}, ${parentId}, ${reg.cid}, ${"+19989" + sfx},
                  'probe', 'sent', now())
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      check("⭐ NOT complete yet — the tier-2 child is genuinely owed to a tier-0 contact",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed, 0);
      await seedConversionEvent(tx, {
        orgId, stageSendId: regSend, contactId: reg.cid, campaignId: campId, stageId: parentId,
        eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead",
      });
      check("⭐ a REGISTRANT completes — the tier-2 child is unreachable at tier 3",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is completed", (await state(reg.jid)).state, "completed");

      // ⭐ THE UNMAPPED-STATUS PURCHASE CASE — the ONLY fixture that can tell
      // `AND pe.status IS NOT NULL` (lib/drip/lifecycle.ts, both copies) apart
      // from its absence. Every other fixture in this file is green with that
      // line deleted, because none of them carries a purchase row at all.
      //
      // Delete it and the eviction NOT EXISTS starts matching a purchase-type
      // row whose STATUS is unmapped: the registration is thrown away, this
      // contact reads tier 0 in the lifecycle while lib/campaign-tier.ts still
      // reads them 3 — so recipients.ts sends them nothing while the lifecycle
      // keeps waiting on a child that can never match. The journey hangs for
      // ever: exactly the bug this whole section exists to prevent, re-created
      // by one deleted line. An unmapped row counts as NOTHING everywhere else
      // in this codebase (conversion_events_unmapped_idx — "stored, alerted,
      // never counted"), so it must evict nobody here either.
      //
      // ONE-SIDED where it counts: the purchase-type row is the only extra
      // signal — no click, no offer reach, no legacy sale_status — and its
      // status is NULL, so it is not a purchase under any reading.
      const regu = await newJourney("+19978" + sfx);
      const reguSend = (
        (await tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                   rendered_text, status, created_at)
          VALUES (${orgId}, ${campId}, ${parentId}, ${regu.cid}, ${"+19978" + sfx},
                  'probe', 'sent', now())
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      check("⭐ NOT complete yet — the tier-2 child is genuinely owed to a tier-0 contact",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed, 0);
      await seedConversionEvent(tx, {
        orgId, stageSendId: reguSend, contactId: regu.cid, campaignId: campId, stageId: parentId,
        eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead",
      });
      // status: null ⇒ a PURCHASE-TYPE row we do not understand. Not `eventKey`
      // omitted — that shape (NULL event_type_id) is already harmless because
      // `NULL IN (…)` is NULL, and would prove nothing about the status filter.
      await seedConversionEvent(tx, {
        orgId, stageSendId: reguSend, contactId: regu.cid, campaignId: campId, stageId: parentId,
        eventKey: "purchase", status: null, revenue: 0, keitaroType: "lead",
      });
      check("⭐ a registrant carrying an UNMAPPED-STATUS purchase row STILL completes — an unmapped row evicts nobody",
            (await closeCompletedJourneys(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is completed", (await state(regu.jid)).state, "completed");

      // ── 3b. the SAME predicate's twin, in expireJourneysPastEndDate ───────
      // ⭐ THE TWIN IS A SEPARATE COPY AND HAS TO BE PROVEN SEPARATELY. The
      // reachability block is inlined TWICE (completion and expiry) because it
      // is correlated per journey row; an untested copy is exactly how the two
      // drift and a registrant hangs past end_at instead of hanging before it.
      //
      // ⭐ AND ITS COVERAGE MIRRORS SECTION 3's, case for case. The twin shipped
      // with no test at all; covering only the registrant would have left the
      // other three shapes section 3 proves (owed ⇒ held, everything sent ⇒
      // closes, a lane BELOW the contact's tier never blocks) asserted on one
      // copy only — which is the asymmetry that lets the two drift in the first
      // place. Every bar below has a named sibling in section 3.
      console.log("\n3b. ⭐ past end_at ⇒ expired — the twin copy of the same predicate:");
      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, end_at)
        VALUES (${campId}, ${orgId}, ${"probe-" + sfx}, NULL)`);

      // ⭐ THE end_at GATE ITSELF, in all three of its states — and a registrant
      // is the cleanest probe for it, because "nothing owed" is already true for
      // them, so end_at is the ONLY thing holding the journey open. Before this,
      // only the "already past" state was ever exercised: an implementation that
      // dropped the `cfg.end_at <= now()` test, or the `IS NOT NULL` one, would
      // have expired every live journey on a campaign that has no end date and
      // no bar would have noticed.
      const gate = await newJourney("+19977" + sfx);
      const gateSend = (
        (await tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                   rendered_text, status, created_at)
          VALUES (${orgId}, ${campId}, ${parentId}, ${gate.cid}, ${"+19977" + sfx},
                  'probe', 'sent', now())
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      await seedConversionEvent(tx, {
        orgId, stageSendId: gateSend, contactId: gate.cid, campaignId: campId, stageId: parentId,
        eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead",
      });
      check("⭐ end_at NULL ⇒ nothing expires, even with nothing owed",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 0);
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET end_at = now() + interval '1 day'
        WHERE campaign_id = ${campId} AND org_id = ${orgId}`);
      check("⭐ a FUTURE end_at ⇒ still nothing (the campaign is still running)",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 0);
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET end_at = now() - interval '1 day'
        WHERE campaign_id = ${campId} AND org_id = ${orgId}`);
      check("⭐ ...and the SAME journey expires once end_at has passed",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is expired", (await state(gate.jid)).state, "expired");
      check("close_reason", (await state(gate.jid)).close_reason, "campaign_end_date_passed");

      const xp = await newJourney("+19979" + sfx);
      const xpSend = (
        (await tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                   rendered_text, status, created_at)
          VALUES (${orgId}, ${campId}, ${parentId}, ${xp.cid}, ${"+19979" + sfx},
                  'probe', 'sent', now())
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      check("⭐ NOT expired yet — the tier-2 child is genuinely owed to a tier-0 contact",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 0);
      await seedConversionEvent(tx, {
        orgId, stageSendId: xpSend, contactId: xp.cid, campaignId: campId, stageId: parentId,
        eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead",
      });
      check("⭐ a REGISTRANT past end_at expires — the tier-3 branch in the twin",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is expired", (await state(xp.jid)).state, "expired");

      // Twin of "a registrant carrying an UNMAPPED-STATUS purchase row STILL
      // completes". The `AND pe.status IS NOT NULL` line exists TWICE; a fixture
      // that only reaches the completion copy lets the expiry copy lose it
      // silently, and a registrant would then hang past end_at instead of
      // before it — the drift this whole section is shaped to catch.
      const xpu = await newJourney("+19976" + sfx);
      const xpuSend = (
        (await tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                   rendered_text, status, created_at)
          VALUES (${orgId}, ${campId}, ${parentId}, ${xpu.cid}, ${"+19976" + sfx},
                  'probe', 'sent', now())
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      check("⭐ NOT expired yet — the tier-2 child is genuinely owed to a tier-0 contact",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 0);
      await seedConversionEvent(tx, {
        orgId, stageSendId: xpuSend, contactId: xpu.cid, campaignId: campId, stageId: parentId,
        eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead",
      });
      await seedConversionEvent(tx, {
        orgId, stageSendId: xpuSend, contactId: xpu.cid, campaignId: campId, stageId: parentId,
        eventKey: "purchase", status: null, revenue: 0, keitaroType: "lead",
      });
      check("⭐ a registrant with an UNMAPPED-STATUS purchase row expires too — the twin's copy of the same filter",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is expired", (await state(xpu.jid)).state, "expired");

      // Twin of "complete once it has been sent". A tier-0 contact owes EVERY
      // child; the send rows are inserted by parentage, not by tier, so this
      // bar cannot restate the predicate it is testing.
      const xpAll = await newJourney("+19975" + sfx);
      check("NOT expired while children are unsent (tier 0 owes all of them)",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 0);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, created_at)
        SELECT ${orgId}::uuid, ${campId}::int, ch.id, ${xpAll.cid}::uuid,
               ${"+19975" + sfx}::text, 'probe', 'sent', now()
        FROM campaign_stages ch
        WHERE ch.parent_stage_id = ${parentId}::int AND ch.org_id = ${orgId}::uuid`);
      check("expires once every child has been sent",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is expired", (await state(xpAll.jid)).state, "expired");

      // Twin of "⭐ a clicker completes even though the Ignored lane never sent
      // to it" — the high-water case caught on live data. Only the lanes AT OR
      // ABOVE this contact's tier are sent, and they are named by id, not
      // selected by tier, so the bar does not encode the rule it checks.
      const xpClick = await newJourney("+19974" + sfx);
      const linkId2 = (
        (await tx.execute(sql`
          INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id,
                             stage_id, contact_id, send_token,
                             campaign_tracking_id, stage_tracking_id)
          VALUES (${orgId}, ${"x" + sfx.slice(-6)}, ${sd}, ${lnk.id}, ${campId},
                  ${parentId}, ${xpClick.cid}, ${"xtok" + sfx}, 'x', 'y')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await tx.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification) VALUES (${orgId}, ${linkId2}, 'human')`);
      check("NOT expired while a lane AT OR ABOVE the clicker's tier is unsent",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 0);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone,
                                 rendered_text, status, created_at)
        SELECT ${orgId}::uuid, ${campId}::int, ch.id, ${xpClick.cid}::uuid,
               ${"+19974" + sfx}::text, 'probe', 'sent', now()
        FROM campaign_stages ch
        WHERE ch.id IN (${highLane}::int, ${regLane}::int)`);
      check("⭐ a clicker expires even though the two Ignored lanes never sent to it",
            (await expireJourneysPastEndDate(tx, { orgId, campaignId: campId })).closed, 1);
      check("...its state is expired", (await state(xpClick.jid)).state, "expired");

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
