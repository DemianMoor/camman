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
import { ENQUEUE_LOCK_KEY, enqueuePartnerPostbacks } from "@/lib/partners/postbacks/enqueue";
import { createPartnerWithKey } from "./_partner-fixture";

// Partner postbacks — enqueue purchase rows from the conversion_events ledger
// (E1-E10) and opt_out rows from opted-out drip journeys (E11-E14).
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
/** JSON with object keys sorted at every level, so equality is per key, not key order. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x);
}
function check(label: string, actual: unknown, expected: unknown) {
  const ok = canon(actual) === canon(expected);
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

      // Live keys are NON-sandbox: every event skips sandbox keys. `optOutSince`
      // (an interval before now()) adds opt_out to the key's events with that since.
      const mkKey = async (org: string, slug: string, o: {
        enabled?: boolean; firstOnly?: boolean; template?: string; sandbox?: boolean;
        optOutSince?: string; words?: Record<string, string>;
      } = {}) => {
        const k = await createPartnerWithKey(tx, { orgId: org, slug: `${RUN}-${slug}`, sandbox: o.sandbox ?? false });
        await tx.execute(sql`
          UPDATE partner_keys
          SET passthrough_fields = '["list_id","relay_lead_id"]'::jsonb,
              postback_url_template = ${o.template ?? "https://p.example/pb?rid={relay_lead_id}&c={conversion_id}"}::text,
              postback_enabled = ${o.enabled ?? true}::boolean,
              postback_first_purchase_only = ${o.firstOnly ?? false}::boolean,
              postback_active_since = now() - interval '1 hour',
              postback_event_keys = ${o.optOutSince ? sql`ARRAY['purchase','opt_out']::text[]` : sql`ARRAY['purchase']::text[]`},
              postback_event_since = jsonb_build_object('purchase', now() - interval '1 hour')
                || ${o.optOutSince ? sql`jsonb_build_object('opt_out', now() - ${o.optOutSince}::interval)` : sql`'{}'::jsonb`},
              postback_status_words = ${JSON.stringify(o.words ?? {})}::jsonb
          WHERE id = ${k.keyId}::int`);
        return k.keyId;
      };
      const key = await mkKey(orgId, "every");
      const keyFirst = await mkKey(orgId, "first", { firstOnly: true });
      const keyOff = await mkKey(orgId, "off", { enabled: false });
      const keyB = await mkKey(orgB, "orgb");
      const keyJ1 = await mkKey(orgId, "e6j1"); // E6 journey 1's lead: a DIFFERENT enabled key
      // E9c: a template that references NO passthrough field — nothing is required.
      const keySys = await mkKey(orgId, "sys", { template: "https://p.example/pb?s=sold&c={conversion_id}&st={status}" });

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
        state: "active" | "completed" | "opted_out", routedAgo = "2 days", closedAgo = "1 hour",
      ) =>
        (await q<{ id: string }>(tx, sql`
          INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state,
                                     routed_at, first_send_at, close_reason, closed_at)
          VALUES (${org}::uuid, ${campaignId}::int, ${cid}::uuid, ${le}::uuid, ${state},
                  now() - ${routedAgo}::interval, now() - ${routedAgo}::interval,
                  ${state === "completed" ? "all_stages_sent" : state === "opted_out" ? "stop_received" : null}::text,
                  ${state === "active" ? sql`NULL` : sql`now() - ${closedAgo}::interval`})
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
      type PbRow = {
        conversion_event_id: number | null; lead_event_id: string; partner_key_id: number;
        payload: Row; status: string; org_id: string; event: string;
      };
      const rowsForJourney = (jid: string, event = "purchase") =>
        q<PbRow>(tx, sql`
          SELECT conversion_event_id, lead_event_id::text AS lead_event_id, partner_key_id, payload, status,
                 org_id::text AS org_id, event
          FROM partner_postbacks WHERE drip_journey_id = ${jid}::uuid AND event = ${event}::text ORDER BY id`);
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
        event: "purchase", event_id: `purchase-${ce1}`, fields: { list_id: "L1", relay_lead_id: "R1" }, payout: "42.5000",
        status: "sold", currency: "USD", occurred_at: occ, conversion_id: String(ce1),
      });
      check("payload keys", Object.keys(r1[0]?.payload ?? {}).sort(),
            ["conversion_id", "currency", "event", "event_id", "fields", "occurred_at", "payout", "status"]);

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
      check("E12: key without opt_out in its events ⇒ 0 opt_out rows", (await rowsForJourney(j3, "opt_out")).length, 0);

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

      // E5b: the first-only NOT EXISTS guard. The journey's earliest purchase is
      // still PENDING, so the later approved one is "first" and fires. When the
      // earlier one is approved it becomes the earliest approved purchase — only
      // the "journey already has a real row" guard keeps it from firing too.
      const c5g = await mkContact(orgId);
      const j5g = await mkJourney(orgId, camp, c5g, await mkLead(orgId, c5g, keyFirst, { relay_lead_id: "R5G" }), "active");
      const ce5gEarly = await mkSale({ cid: c5g, occurredAgo: "3 hours", status: "pending" });
      const ce5gLate = await mkSale({ cid: c5g, occurredAgo: "1 hour" });
      await enqueueTwice();
      const r5g = await rowsForJourney(j5g);
      check("⭐ first-only, earliest pending ⇒ 1 row, the later approved one",
            [r5g.length, Number(r5g[0]?.conversion_event_id)], [1, ce5gLate]);
      await tx.execute(sql`UPDATE conversion_events SET status = 'approved', updated_at = now() WHERE id = ${ce5gEarly}::bigint`);
      await enqueueTwice();
      const r5g2 = await rowsForJourney(j5g);
      check("⭐ earlier one flipped to approved ⇒ still exactly 1 row (the later one)",
            [r5g2.length, Number(r5g2[0]?.conversion_event_id)], [1, ce5gLate]);

      // ── E6 re-entry: sale after journey 2's routed_at ⇒ journey 2's lead ─
      console.log("\nE6. re-entry on the same campaign:");
      const c6 = await mkContact(orgId);
      // Journey 1's lead is on keyJ1, journey 2's on key: a broken next-journey
      // anchor shows up as an extra row on keyJ1 instead of hiding behind
      // ON CONFLICT (same key + same conversion).
      const le6a = await mkLead(orgId, c6, keyJ1, { relay_lead_id: "R6-J1" });
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

      // ── E9 required fields: template-referenced passthrough fields must be non-empty ─
      console.log("\nE9. required fields (derived from the template):");
      const c9a = await mkContact(orgId);
      const j9a = await mkJourney(orgId, camp, c9a, await mkLead(orgId, c9a, key, { relay_lead_id: "R9A" }), "active");
      await mkSale({ cid: c9a });
      const c9b = await mkContact(orgId);
      const j9b = await mkJourney(orgId, camp, c9b, await mkLead(orgId, c9b, key, { list_id: "L9B" }), "active");
      await mkSale({ cid: c9b });
      const c9e = await mkContact(orgId);
      const j9e = await mkJourney(orgId, camp, c9e, await mkLead(orgId, c9e, key, { relay_lead_id: "   " }), "active");
      await mkSale({ cid: c9e });
      const c9f = await mkContact(orgId);
      const j9f = await mkJourney(orgId, camp, c9f, await mkLead(orgId, c9f, keyFirst, {}), "active");
      await mkSale({ cid: c9f });
      const c9c = await mkContact(orgId);
      const j9c = await mkJourney(orgId, camp, c9c, await mkLead(orgId, c9c, keySys, {}), "active");
      await mkSale({ cid: c9c });
      await enqueueTwice();
      check("⭐ lead WITH relay_lead_id ⇒ 1 row", (await rowsForJourney(j9a)).length, 1);
      check("⭐ lead WITHOUT relay_lead_id (only an unreferenced field) ⇒ 0 rows", (await rowsForJourney(j9b)).length, 0);
      check("⭐ relay_lead_id blank/whitespace ⇒ 0 rows", (await rowsForJourney(j9e)).length, 0);
      check("⭐ first-only key, lead without the field ⇒ 0 rows", (await rowsForJourney(j9f)).length, 0);
      check("⭐ system-placeholders-only template, lead with NO partner data ⇒ 1 row", (await rowsForJourney(j9c)).length, 1);
      check("an unreferenced passthrough field is not required (E2's lead has no list_id and fired)",
            (await rowsForJourney(j2)).length, 1);

      // ── E10 purchase on the new shape: event column, status word, event_id ─
      console.log("\nE10. purchase row: event, status word, event_id:");
      check("E1 row event column = purchase", r1[0]?.event, "purchase");
      check("E1 default word = sold", r1[0]?.payload.status, "sold");
      const keyWord = await mkKey(orgId, "word", { words: { purchase: "SALE" } });
      const c10 = await mkContact(orgId);
      const j10 = await mkJourney(orgId, camp, c10, await mkLead(orgId, c10, keyWord, { relay_lead_id: "R10" }), "active");
      const ce10 = await mkSale({ cid: c10 });
      await enqueueTwice();
      const r10 = await rowsForJourney(j10);
      check("⭐ key's word + event_id", [r10.length, r10[0]?.event, r10[0]?.payload.status, r10[0]?.payload.event_id],
            [1, "purchase", "SALE", `purchase-${ce10}`]);

      // ── E11 opted-out journey ⇒ 1 opt_out row ───────────────────────────
      console.log("\nE11. opted-out journey ⇒ opt_out row:");
      const keyOpt = await mkKey(orgId, "opt", { optOutSince: "2 hours" });
      const c11 = await mkContact(orgId);
      const le11 = await mkLead(orgId, c11, keyOpt, { list_id: "L11", relay_lead_id: "R11" });
      const j11 = await mkJourney(orgId, camp, c11, le11, "opted_out", "2 days", "1 hour");
      const first = await enqueuePartnerPostbacks(tx);
      const second = await enqueuePartnerPostbacks(tx);
      const r11 = await rowsForJourney(j11, "opt_out");
      const closedAt = (await q<{ s: string }>(tx, sql`
        SELECT to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS s FROM drip_journeys WHERE id = ${j11}::uuid`))[0].s;
      check("⭐ exactly 1 opt_out row after two runs", r11.length, 1);
      check("row columns: no conversion, the lead, the key, the org, pending",
            [r11[0]?.conversion_event_id, r11[0]?.lead_event_id, Number(r11[0]?.partner_key_id), r11[0]?.org_id, r11[0]?.status],
            [null, le11, keyOpt, orgId, "pending"]);
      check("⭐ payload is exactly the opt_out PostbackPayload", r11[0]?.payload, {
        event: "opt_out", event_id: `opt_out-${j11}`, status: "opt_out", conversion_id: "",
        occurred_at: closedAt, currency: null, payout: null, fields: { list_id: "L11", relay_lead_id: "R11" },
      });
      check("occurred_at is UTC Z", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(closedAt), true);
      check("no purchase row for a journey with no sale", (await rowsForJourney(j11)).length, 0);
      check("⭐ queuedByEvent: first run counts the opt_out, second run queues nothing",
            [first.queuedByEvent?.opt_out >= 1, first.queued === first.queuedByEvent?.purchase + first.queuedByEvent?.opt_out,
             second.queued, second.queuedByEvent],
            [true, true, 0, { purchase: 0, opt_out: 0 }]);
      const keyOptWord = await mkKey(orgId, "optword", { optOutSince: "2 hours", words: { opt_out: "STOP" } });
      const c11w = await mkContact(orgId);
      const j11w = await mkJourney(orgId, camp, c11w, await mkLead(orgId, c11w, keyOptWord, { relay_lead_id: "R11W" }), "opted_out");
      await enqueueTwice();
      check("opt_out uses the key's word", (await rowsForJourney(j11w, "opt_out"))[0]?.payload.status, "STOP");

      // ── E12 not fired ───────────────────────────────────────────────────
      console.log("\nE12. opt_out not fired:");
      // opt_out turned on 30 min ago; the journey closed 1 h ago (before it).
      const keyOptLate = await mkKey(orgId, "optlate", { optOutSince: "30 minutes" });
      const c12a = await mkContact(orgId);
      const j12a = await mkJourney(orgId, camp, c12a, await mkLead(orgId, c12a, keyOptLate, { relay_lead_id: "R12a" }), "opted_out");
      // Closed 31 days ago, on a key whose opt_out since is older still: outside the 30-day window.
      const keyOptOld = await mkKey(orgId, "optold", { optOutSince: "60 days" });
      const c12e = await mkContact(orgId);
      const j12e = await mkJourney(orgId, camp, c12e, await mkLead(orgId, c12e, keyOptOld, { relay_lead_id: "R12e" }),
                                   "opted_out", "40 days", "31 days");
      // Sandbox key with both events live: neither the sale nor the opt-out fires.
      const keySandbox = await mkKey(orgId, "sandbox", { sandbox: true, optOutSince: "2 hours" });
      const c12b = await mkContact(orgId);
      const j12b = await mkJourney(orgId, camp, c12b, await mkLead(orgId, c12b, keySandbox, { relay_lead_id: "R12b" }), "opted_out");
      await mkSale({ cid: c12b });
      // Lead missing the template's passthrough field (relay_lead_id).
      const c12c = await mkContact(orgId);
      const j12c = await mkJourney(orgId, camp, c12c, await mkLead(orgId, c12c, keyOpt, { list_id: "L12c" }), "opted_out");
      // Live journey (not opted out) on an opt_out key.
      const c12d = await mkContact(orgId);
      const j12d = await mkJourney(orgId, camp, c12d, await mkLead(orgId, c12d, keyOpt, { relay_lead_id: "R12d" }), "active");
      await enqueueTwice();
      check("⭐ journey closed before the opt_out since ⇒ 0", (await rowsForJourney(j12a, "opt_out")).length, 0);
      check("closed outside the 30-day window ⇒ 0", (await rowsForJourney(j12e, "opt_out")).length, 0);
      check("⭐ sandbox key ⇒ 0 opt_out and 0 purchase",
            [(await rowsForJourney(j12b, "opt_out")).length, (await rowsForJourney(j12b)).length], [0, 0]);
      check("⭐ lead missing the template's passthrough field ⇒ 0", (await rowsForJourney(j12c, "opt_out")).length, 0);
      check("live journey ⇒ 0", (await rowsForJourney(j12d, "opt_out")).length, 0);

      // ── E13 first-only is a purchase rule ───────────────────────────────
      console.log("\nE13. first-purchase-only key still fires opt_out:");
      const keyOptFirst = await mkKey(orgId, "optfirst", { firstOnly: true, optOutSince: "2 hours" });
      const c13 = await mkContact(orgId);
      const j13 = await mkJourney(orgId, camp, c13, await mkLead(orgId, c13, keyOptFirst, { relay_lead_id: "R13" }), "opted_out");
      // The opt-out is queued FIRST, before any sale exists; the sale that lands
      // later must still fire (first-only counts the journey's PURCHASE rows).
      await enqueueTwice();
      check("opt_out queued before the sale", (await rowsForJourney(j13, "opt_out")).length, 1);
      await mkSale({ cid: c13, occurredAgo: "20 minutes" });
      await enqueueTwice();
      await mkSale({ cid: c13, occurredAgo: "10 minutes" });
      await enqueueTwice();
      check("⭐ 1 purchase + 1 opt_out row",
            [(await rowsForJourney(j13)).length, (await rowsForJourney(j13, "opt_out")).length], [1, 1]);

      // ── E14 org-matched joins ───────────────────────────────────────────
      console.log("\nE14. opt_out across orgs:");
      // Org-B journey whose lead is an org-A lead on org A's opt_out key.
      const c14 = await mkContact(orgId);
      const j14 = await mkJourney(orgB, camp, c14, await mkLead(orgId, c14, keyOpt, { relay_lead_id: "R14" }), "opted_out");
      // Org-B journey + org-B lead, but the lead points at org A's opt_out key.
      const j14b = await mkJourney(orgB, camp, c14, await mkLead(orgB, c14, keyOpt, { relay_lead_id: "R14b" }), "opted_out");
      await enqueueTwice();
      check("⭐ journey in another org with the same contact id ⇒ 0",
            [(await rowsForJourney(j14, "opt_out")).length, (await rowsForJourney(j14b, "opt_out")).length], [0, 0]);

      // Sanity: everything this fixture queued, by key.
      const byKey = await q<{ k: number; e: string; n: number }>(tx, sql`
        SELECT partner_key_id AS k, event AS e, count(*)::int AS n FROM partner_postbacks
        WHERE org_id IN (${orgId}::uuid, ${orgB}::uuid) GROUP BY 1, 2 ORDER BY 1, 2`);
      check("fixture totals per key+event (every: E1+E2+E3+E4+E5×2+E6+E8+E9a = 9, first-only: E5+E5b = 2, system-only: E9c = 1, " +
            "word: E10 = 1, opt: E11 = 1 opt_out, optword: 1 opt_out, optfirst: E13 = 1 + 1, E6 journey-1 / late / old / sandbox: 0)",
            byKey.map((r) => [Number(r.k), r.e, Number(r.n)]),
            ([[key, "purchase", 9], [keyFirst, "purchase", 2], [keySys, "purchase", 1], [keyWord, "purchase", 1],
              [keyOpt, "opt_out", 1], [keyOptWord, "opt_out", 1], [keyOptFirst, "opt_out", 1], [keyOptFirst, "purchase", 1],
            ] as [number, string, number][]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])));

      // The serialising advisory lock is taken in the caller's transaction (and
      // held until it ends). A bigint key shows as classid = high 32 bits,
      // objid = low 32 bits, objsubid = 1.
      check("⭐ enqueue holds the ENQUEUE_LOCK_KEY xact advisory lock in the caller's tx",
            (await q<{ n: number }>(tx, sql`
              SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
                AND classid = (${ENQUEUE_LOCK_KEY}::bigint >> 32)::oid
                AND objid = (${ENQUEUE_LOCK_KEY}::bigint & 4294967295)::oid`))[0].n, 1);

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
