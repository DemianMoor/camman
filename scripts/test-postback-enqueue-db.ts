import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  closeJourneyOnOptOut,
  closeJourneysOnPurchase,
  reclassifyCompletedJourneysOnPurchase,
} from "@/lib/drip/lifecycle";
import type { DbOrTx } from "@/lib/intake/partner-key";
import { enqueuePartnerPostbacks } from "@/lib/partners/postbacks/enqueue";
import { createPartnerWithKey } from "./_partner-fixture";

// Partner sales postbacks — enqueue from the conversion_events ledger (E1-E8).
//
// Preview DB only, ONE transaction, rolled back. Fixtures live in a throwaway
// org created inside the transaction. enqueuePartnerPostbacks scans ALL orgs, so
// it may also queue rows for real preview data inside this transaction — every
// assertion is scoped to the fixture's journeys / keys, and the rollback drops
// everything. sweepJourneyLifecycle is NOT driven (it scans every org); the three
// lifecycle functions it calls are driven directly on the fixture org.
//
// ⚠️ now() is frozen for the whole transaction, so postback_active_since and
// conversion_events.created_at are set explicitly relative to it.
//
// Every case runs enqueue TWICE and asserts the count after the second run —
// idempotency is the property, not a side note.
//
// Run: node scripts/with-preview-env.mjs npx tsx --conditions=react-server --conditions=import scripts/test-postback-enqueue-db.ts

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

type Row = Record<string, unknown>;
const q = async <T = Row>(tx: DbOrTx, s: ReturnType<typeof sql>) => (await tx.execute(s)) as unknown as T[];

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  const RUN = `pbq-${Date.now().toString(36)}`;
  let fixtureOrg = "";

  try {
    await db.transaction(async (tx) => {
      // ── fixtures ───────────────────────────────────────────────────────
      const mkOrg = async (name: string) => {
        const id = (await q<{ id: string }>(tx, sql`INSERT INTO organizations (name) VALUES (${name}) RETURNING id::text AS id`))[0].id;
        // 0181 seeds purchase/registration per org; a fresh org may lack them.
        await tx.execute(sql`
          INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue, is_retarget_signal)
          VALUES (${id}::uuid, 'purchase', 'Purchase', true, true, false),
                 (${id}::uuid, 'registration', 'Registration', false, false, true),
                 (${id}::uuid, 'upsell', 'Upsell', false, true, false)
          ON CONFLICT (org_id, key) DO NOTHING`);
        return id;
      };
      const orgId = await mkOrg(`${RUN}-a`);
      fixtureOrg = orgId;
      const orgB = await mkOrg(`${RUN}-b`);
      const et = Object.fromEntries(
        (await q<{ key: string; id: number }>(tx, sql`SELECT key, id FROM event_types WHERE org_id = ${orgId}::uuid`)).map(
          (r) => [r.key, Number(r.id)],
        ),
      ) as Record<"purchase" | "registration" | "upsell", number>;

      const mkKey = async (org: string, slug: string, o: { enabled?: boolean; firstOnly?: boolean } = {}) => {
        const k = await createPartnerWithKey(tx, { orgId: org, slug: `${RUN}-${slug}`, sandbox: true });
        await tx.execute(sql`
          UPDATE partner_keys
          SET passthrough_fields = '["list_id","relay_lead_id"]'::jsonb,
              postback_url_template = 'https://p.example/pb?rid={relay_lead_id}&c={conversion_id}',
              postback_enabled = ${o.enabled ?? true}::boolean,
              postback_first_purchase_only = ${o.firstOnly ?? false}::boolean,
              postback_active_since = now() - interval '1 hour'
          WHERE id = ${k.keyId}::int`);
        return k.keyId;
      };
      const key = await mkKey(orgId, "every");
      const keyFirst = await mkKey(orgId, "first", { firstOnly: true });
      const keyOff = await mkKey(orgId, "off", { enabled: false });
      const keyB = await mkKey(orgB, "orgb");

      const mkCampaign = async (org: string, type: "drip" | "regular") =>
        Number((await q<{ id: number }>(tx, sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
          VALUES (${org}::uuid, ${`${RUN}-${type}-${randomUUID().slice(0, 6)}`}, 'postback probe', 'active', ${type}, 'tracked')
          RETURNING id`))[0].id);
      const camp = await mkCampaign(orgId, "drip");
      const regular = await mkCampaign(orgId, "regular");

      let seq = 0;
      const mkContact = async (org: string) =>
        (await q<{ id: string }>(tx, sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${org}::uuid, ${`+1999${String(Date.now()).slice(-5)}${String(seq++).padStart(2, "0")}`})
          RETURNING id::text AS id`))[0].id;
      const mkLead = async (org: string, cid: string, keyId: number, partnerData: Record<string, string>) =>
        (await q<{ id: string }>(tx, sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at, partner_data)
          VALUES (${org}::uuid, ${cid}::uuid, ${keyId}::int, 'probe', now(), ${JSON.stringify(partnerData)}::jsonb)
          RETURNING id::text AS id`))[0].id;
      /** A journey. Live states carry no closed_at; terminal ones do (drip_journeys_closed_at_check). */
      const mkJourney = async (
        org: string, campaignId: number, cid: string, le: string,
        state: "active" | "completed", routedAgo = "2 days",
      ) =>
        (await q<{ id: string }>(tx, sql`
          INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state,
                                     routed_at, first_send_at, close_reason, closed_at)
          VALUES (${org}::uuid, ${campaignId}::int, ${cid}::uuid, ${le}::uuid, ${state},
                  now() - ${routedAgo}::interval, now() - ${routedAgo}::interval,
                  ${state === "completed" ? "all_stages_sent" : null}::text,
                  ${state === "completed" ? sql`now() - interval '1 hour'` : sql`NULL`})
          RETURNING id::text AS id`))[0].id;
      /** A ledger row. `createdAgo` / `occurredAgo` are intervals before the frozen now(). */
      const mkSale = async (o: {
        cid: string; campaignId?: number; eventTypeId?: number;
        status?: "pending" | "approved" | "rejected"; revenue?: number;
        occurredAgo?: string; createdAgo?: string;
      }) =>
        Number((await q<{ id: number }>(tx, sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status, revenue, currency,
             occurred_at, last_postback_at, contact_id, campaign_id, created_at)
          VALUES (${orgId}::uuid, ${`fixture-${randomUUID()}`}, 'lead', 'lead',
                  ${o.eventTypeId ?? et.purchase}::int, ${o.status ?? "approved"}::text,
                  ${(o.revenue ?? 42.5).toFixed(4)}::numeric, 'USD',
                  now() - ${o.occurredAgo ?? "30 minutes"}::interval, now(), ${o.cid}::uuid,
                  ${o.campaignId ?? camp}::int, now() - ${o.createdAgo ?? "0 seconds"}::interval)
          RETURNING id`))[0].id);

      const enqueueTwice = async () => {
        await enqueuePartnerPostbacks(tx);
        await enqueuePartnerPostbacks(tx);
      };
      const rowsForJourney = (jid: string) =>
        q<{ conversion_event_id: number; lead_event_id: string; partner_key_id: number; payload: Row; status: string; org_id: string }>(tx, sql`
          SELECT conversion_event_id, lead_event_id::text AS lead_event_id, partner_key_id, payload, status, org_id::text AS org_id
          FROM partner_postbacks WHERE drip_journey_id = ${jid}::uuid ORDER BY id`);
      const rowsForConversion = (ceId: number) =>
        q<Row>(tx, sql`SELECT id FROM partner_postbacks WHERE conversion_event_id = ${ceId}::bigint`);
      const stateOf = async (jid: string) =>
        (await q<{ state: string }>(tx, sql`SELECT state FROM drip_journeys WHERE id = ${jid}::uuid`))[0].state;

      // ── E1 live journey closed `converted` ⇒ 1 row, fields = partner_data ─
      console.log("\nE1. live journey closes converted:");
      const c1 = await mkContact(orgId);
      const le1 = await mkLead(orgId, c1, key, { list_id: "L1", relay_lead_id: "R1" });
      const j1 = await mkJourney(orgId, camp, c1, le1, "active");
      const ce1 = await mkSale({ cid: c1 });
      await closeJourneysOnPurchase(tx, { orgId, campaignId: camp });
      check("journey converted", await stateOf(j1), "converted");
      await enqueueTwice();
      const r1 = await rowsForJourney(j1);
      check("⭐ exactly 1 row after two runs", r1.length, 1);
      check("row is for the sale, the lead, the key, the org, pending",
            [Number(r1[0]?.conversion_event_id), r1[0]?.lead_event_id, Number(r1[0]?.partner_key_id), r1[0]?.org_id, r1[0]?.status],
            [ce1, le1, key, orgId, "pending"]);
      const occ = (await q<{ s: string }>(tx, sql`
        SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS s FROM conversion_events WHERE id = ${ce1}::bigint`))[0].s;
      check("⭐ payload is exactly the PostbackPayload shape", r1[0]?.payload, {
        event: "purchase", fields: { list_id: "L1", relay_lead_id: "R1" }, payout: "42.5000",
        status: "approved", currency: "USD", occurred_at: occ, conversion_id: String(ce1),
      });
      check("payload keys", Object.keys(r1[0]?.payload ?? {}).sort(),
            ["conversion_id", "currency", "event", "fields", "occurred_at", "payout", "status"]);

      // ── E2 completed, purchase lands later, reclassified ⇒ 1 row ────────
      console.log("\nE2. completed journey, late purchase, reclassified:");
      const c2 = await mkContact(orgId);
      const j2 = await mkJourney(orgId, camp, c2, await mkLead(orgId, c2, key, { relay_lead_id: "R2" }), "completed");
      await mkSale({ cid: c2 });
      await reclassifyCompletedJourneysOnPurchase(tx, { orgId, campaignId: camp });
      check("journey reclassified converted", await stateOf(j2), "converted");
      await enqueueTwice();
      check("⭐ exactly 1 row", (await rowsForJourney(j2)).length, 1);

      // ── E3 opted_out with an approved purchase ⇒ 1 row ─────────────────
      console.log("\nE3. opted-out journey with an approved purchase:");
      const c3 = await mkContact(orgId);
      const j3 = await mkJourney(orgId, camp, c3, await mkLead(orgId, c3, key, { relay_lead_id: "R3" }), "active");
      await closeJourneyOnOptOut(tx, { orgId, contactId: c3 });
      await mkSale({ cid: c3 });
      await reclassifyCompletedJourneysOnPurchase(tx, { orgId, campaignId: camp });
      check("journey stays opted_out", await stateOf(j3), "opted_out");
      await enqueueTwice();
      check("⭐ fires anyway: 1 row", (await rowsForJourney(j3)).length, 1);

      // ── E4 pending ⇒ 0; approved in place ⇒ 1; revenue change ⇒ still 1 ─
      console.log("\nE4. ledger row pending → approved → revenue change:");
      const c4 = await mkContact(orgId);
      const j4 = await mkJourney(orgId, camp, c4, await mkLead(orgId, c4, key, { relay_lead_id: "R4" }), "active");
      const ce4 = await mkSale({ cid: c4, status: "pending" });
      await enqueueTwice();
      check("pending ⇒ 0", (await rowsForJourney(j4)).length, 0);
      await tx.execute(sql`UPDATE conversion_events SET status = 'approved', updated_at = now() WHERE id = ${ce4}::bigint`);
      await enqueueTwice();
      check("⭐ approved in place ⇒ 1", (await rowsForJourney(j4)).length, 1);
      await tx.execute(sql`UPDATE conversion_events SET revenue = 99.0000, updated_at = now() WHERE id = ${ce4}::bigint`);
      await enqueueTwice();
      check("⭐ updated again ⇒ still 1", (await rowsForJourney(j4)).length, 1);

      // ── E5 two purchases: every ⇒ 2; first-only ⇒ 1 (earlier); third ⇒ 1 ─
      console.log("\nE5. two purchases on one journey:");
      const c5 = await mkContact(orgId);
      const j5 = await mkJourney(orgId, camp, c5, await mkLead(orgId, c5, key, { relay_lead_id: "R5" }), "active");
      await mkSale({ cid: c5, occurredAgo: "3 hours" });
      await mkSale({ cid: c5, occurredAgo: "1 hour" });
      await enqueueTwice();
      check("⭐ every-purchase ⇒ 2 rows", (await rowsForJourney(j5)).length, 2);

      const c5f = await mkContact(orgId);
      const j5f = await mkJourney(orgId, camp, c5f, await mkLead(orgId, c5f, keyFirst, { relay_lead_id: "R5F" }), "active");
      // The LATER sale is inserted first (lower id) so the pick must be by occurred_at, not id.
      await mkSale({ cid: c5f, occurredAgo: "1 hour" });
      const ce5Early = await mkSale({ cid: c5f, occurredAgo: "3 hours" });
      await enqueueTwice();
      const r5f = await rowsForJourney(j5f);
      check("⭐ first-only ⇒ 1 row", r5f.length, 1);
      check("⭐ ...the earlier occurred_at", Number(r5f[0]?.conversion_event_id), ce5Early);
      await mkSale({ cid: c5f, occurredAgo: "10 minutes" });
      await enqueueTwice();
      check("⭐ a third purchase later ⇒ still 1", (await rowsForJourney(j5f)).length, 1);

      // ── E6 re-entry: sale after journey 2's routed_at ⇒ journey 2's lead ─
      console.log("\nE6. re-entry on the same campaign:");
      const c6 = await mkContact(orgId);
      const le6a = await mkLead(orgId, c6, key, { relay_lead_id: "R6-J1" });
      const j6a = await mkJourney(orgId, camp, c6, le6a, "completed", "10 days");
      const le6b = await mkLead(orgId, c6, key, { relay_lead_id: "R6-J2" });
      const j6b = await mkJourney(orgId, camp, c6, le6b, "completed", "1 day");
      await mkSale({ cid: c6, occurredAgo: "2 hours" });
      await enqueueTwice();
      const r6 = await rowsForJourney(j6b);
      check("⭐ journey 1 gets nothing", (await rowsForJourney(j6a)).length, 0);
      check("⭐ journey 2 gets 1 row", r6.length, 1);
      check("⭐ ...with journey 2's lead_event_id", r6[0]?.lead_event_id, le6b);
      check("⭐ ...and its relay_lead_id", (r6[0]?.payload as { fields?: Row } | undefined)?.fields?.relay_lead_id, "R6-J2");

      // ── E7 not fired ────────────────────────────────────────────────────
      console.log("\nE7. not fired:");
      const c7a = await mkContact(orgId);
      const j7a = await mkJourney(orgId, camp, c7a, await mkLead(orgId, c7a, key, { relay_lead_id: "R7a" }), "active");
      await mkSale({ cid: c7a, createdAgo: "2 hours", occurredAgo: "2 hours" });
      const c7b = await mkContact(orgId);
      const j7b = await mkJourney(orgId, camp, c7b, await mkLead(orgId, c7b, key, { relay_lead_id: "R7b" }), "active");
      await mkSale({ cid: c7b, eventTypeId: et.registration });
      const c7c = await mkContact(orgId);
      const j7c = await mkJourney(orgId, camp, c7c, await mkLead(orgId, c7c, key, { relay_lead_id: "R7c" }), "active");
      await mkSale({ cid: c7c, eventTypeId: et.upsell });
      const c7d = await mkContact(orgId);
      const j7d = await mkJourney(orgId, camp, c7d, await mkLead(orgId, c7d, key, { relay_lead_id: "R7d" }), "active");
      const ce7d = await mkSale({ cid: c7d, campaignId: regular });
      const c7e = await mkContact(orgId);
      const j7e = await mkJourney(orgId, camp, c7e, await mkLead(orgId, c7e, keyOff, { relay_lead_id: "R7e" }), "active");
      await mkSale({ cid: c7e });
      // Org B holds a journey on org A's campaign for org A's contact, under an
      // ENABLED org-B key. Only org-matched joins keep org A's sale off it.
      const c7f = await mkContact(orgId);
      const le7f = await mkLead(orgB, c7f, keyB, { relay_lead_id: "R7f" });
      const j7f = await mkJourney(orgB, camp, c7f, le7f, "active");
      const ce7f = await mkSale({ cid: c7f });
      await enqueueTwice();
      check("ledger created before postback_active_since ⇒ 0", (await rowsForJourney(j7a)).length, 0);
      check("registration ⇒ 0", (await rowsForJourney(j7b)).length, 0);
      check("upsell (counts_revenue, not is_purchase) ⇒ 0", (await rowsForJourney(j7c)).length, 0);
      check("sale on a non-drip campaign ⇒ 0", [(await rowsForJourney(j7d)).length, (await rowsForConversion(ce7d)).length], [0, 0]);
      check("key postback_enabled = false ⇒ 0", (await rowsForJourney(j7e)).length, 0);
      check("⭐ journey in another org with the same contact id ⇒ 0",
            [(await rowsForJourney(j7f)).length, (await rowsForConversion(ce7f)).length],
            [0, 0]);

      // ── E8 drip posture OFF ⇒ still enqueues ────────────────────────────
      console.log("\nE8. drip posture OFF:");
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, drip_enabled) VALUES (${orgId}::uuid, false)
        ON CONFLICT (org_id) DO UPDATE SET drip_enabled = false`);
      const c8 = await mkContact(orgId);
      const j8 = await mkJourney(orgId, camp, c8, await mkLead(orgId, c8, key, { relay_lead_id: "R8" }), "active");
      await mkSale({ cid: c8 });
      await enqueueTwice();
      check("org_settings.drip_enabled is false",
            (await q<{ d: boolean }>(tx, sql`SELECT drip_enabled AS d FROM org_settings WHERE org_id = ${orgId}::uuid`))[0].d, false);
      check("⭐ still enqueues 1 row", (await rowsForJourney(j8)).length, 1);

      // Sanity: everything this fixture queued, by key.
      const byKey = await q<{ k: number; n: number }>(tx, sql`
        SELECT partner_key_id AS k, count(*)::int AS n FROM partner_postbacks
        WHERE org_id IN (${orgId}::uuid, ${orgB}::uuid) GROUP BY 1 ORDER BY 1`);
      check("fixture totals per key (every: E1+E2+E3+E4+E5×2+E6+E8 = 8, first-only: 1)",
            byKey.map((r) => [Number(r.k), Number(r.n)]), [[key, 8], [keyFirst, 1]]);

      throw new Error("ROLLBACK");
    });
  } catch (e) {
    if ((e as Error).message !== "ROLLBACK") throw e;
  }

  console.log("\nrollback:");
  const left = await q<{ orgs: number; pbs: number }>(db, sql`
    SELECT (SELECT count(*)::int FROM organizations WHERE id::text = ${fixtureOrg}) AS orgs,
           (SELECT count(*)::int FROM partner_postbacks WHERE org_id::text = ${fixtureOrg}) AS pbs`);
  check("fixture org and its postbacks are gone", [left[0].orgs, left[0].pbs], [0, 0]);
  check("fixture keys are gone", (await q<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM partner_keys WHERE org_id::text = ${fixtureOrg}`))[0].n, 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
