import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { runEnrichmentBatch } from "@/lib/drip/enrichment";
import type { DbOrTx } from "@/lib/intake/partner-key";
import {
  enqueueInvalidPostback,
  INVALID_POSTBACK_ALERT_KEY,
  tryEnqueueInvalidPostback,
} from "@/lib/partners/postbacks/invalid";
import { createPartnerWithKey } from "./_partner-fixture";
import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";

// Partner postbacks — `invalid` at enrichment (PR2, Task 7).
//
//   I1 a key with `invalid` live ⇒ exactly one row (payload status/event_id/
//      conversion_id, no journey / lead event); a second call ⇒ still one
//   I2 key without `invalid`, disabled key, sandbox key, `at` before the since,
//      missing required field, other org ⇒ zero each
//   I3 enrichment end-to-end: a landline inbox row (fixture phone_lookups row,
//      lookup already complete ⇒ NO Telnyx call) ⇒ inbox row deleted, landline
//      counter +1, exactly one `invalid` postback for that inbox id
//   I4 an `unknown` line-type row in the same batch ⇒ no postback (G19)
//   I5 tryEnqueueInvalidPostback with an insert that fails a SQL statement ⇒
//      resolves, the outer transaction stays usable, the lead's DELETE still
//      happens, and the failure alert latches
//
// I1/I2/I5 run in ONE rolled-back transaction. I3/I4 drive runEnrichmentBatch,
// which opens its own transaction, so their fixtures are COMMITTED in a marked
// throwaway org and torn down by id; residue is counted. Refuses to start while
// the preview inbox has claimable rows (the sweeper would claim them too).
//
// Telegram is disabled in-process (no page from a test). The alert_state row for
// the invalid alert key is snapshotted and restored.
//
// Run: node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-postback-invalid-db.ts

delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

type Row = Record<string, unknown>;
const q = async <T = Row>(tx: DbOrTx, s: SQL) => (await tx.execute(s)) as unknown as T[];

const MARKER = "__POSTBACK_INVALID_TEST__";
const TEMPLATE = "https://p.example/pb?rid={relay_lead_id}&s={status}&e={event_id}";

/** Make `keyId` a live postback key whose events are `events`, each live since `since` before now(). */
async function configureKey(tx: DbOrTx, keyId: number, o: { events: string[]; enabled?: boolean; since?: string }) {
  const since = o.since ?? "1 hour";
  const sinceMap = Object.fromEntries(o.events.map((e) => [e, null]));
  await tx.execute(sql`
    UPDATE partner_keys
    SET passthrough_fields = '["relay_lead_id"]'::jsonb,
        postback_url_template = ${TEMPLATE}::text,
        postback_enabled = ${o.enabled ?? true}::boolean,
        postback_active_since = now() - ${since}::interval,
        postback_event_keys = ${`{${o.events.join(",")}}`}::text[],
        postback_event_since = (
          SELECT coalesce(jsonb_object_agg(e, now() - ${since}::interval), '{}'::jsonb)
          FROM jsonb_object_keys(${JSON.stringify(sinceMap)}::jsonb) AS e)
    WHERE id = ${keyId}::int`);
}

async function alertRow() {
  return (await q<{ state: string; since: string; last_notified_at: string | null; org_id: string | null }>(db, sql`
    SELECT state, since::text, last_notified_at::text, org_id::text FROM alert_state
    WHERE alert_key = ${INVALID_POSTBACK_ALERT_KEY}`))[0];
}

async function restoreAlert(before: Awaited<ReturnType<typeof alertRow>>) {
  if (!before) {
    await db.execute(sql`DELETE FROM alert_state WHERE alert_key = ${INVALID_POSTBACK_ALERT_KEY}`);
  } else {
    await db.execute(sql`
      UPDATE alert_state SET state = ${before.state}, since = ${before.since}::timestamptz,
             last_notified_at = ${before.last_notified_at}::timestamptz, org_id = ${before.org_id}::uuid
      WHERE alert_key = ${INVALID_POSTBACK_ALERT_KEY}`);
  }
}

class Rollback extends Error {}

async function rolledBackCases(RUN: string) {
  try {
    await db.transaction(async (tx) => {
      const orgId = (await q<{ id: string }>(tx, sql`INSERT INTO organizations (name) VALUES (${`${RUN}-a`}) RETURNING id::text AS id`))[0].id;
      const orgB = (await q<{ id: string }>(tx, sql`INSERT INTO organizations (name) VALUES (${`${RUN}-b`}) RETURNING id::text AS id`))[0].id;
      const mk = async (slug: string, sandbox = false) =>
        (await createPartnerWithKey(tx, { orgId, slug: `${RUN}-${slug}`, sandbox })).keyId;
      const keyInv = await mk("inv");
      const keyNoInv = await mk("noinv");
      const keyOff = await mk("off");
      const keySand = await mk("sand", true);
      await configureKey(tx, keyInv, { events: ["purchase", "invalid"] });
      await configureKey(tx, keyNoInv, { events: ["purchase", "opt_out"] });
      await configureKey(tx, keyOff, { events: ["invalid"], enabled: false });
      await configureKey(tx, keySand, { events: ["invalid"] });

      const pd = { list_id: "L9", relay_lead_id: "r-1" }; // jsonb key order (length, then bytes) — compared as JSON text
      const rowsFor = async (keyId: number, inbox: string) =>
        q<{ event: string; lead_inbox_id: string; payload: Row; conversion_event_id: unknown;
            drip_journey_id: unknown; lead_event_id: unknown; org_id: string; status: string }>(tx, sql`
          SELECT event, lead_inbox_id::text, payload, conversion_event_id, drip_journey_id, lead_event_id,
                 org_id::text, status
          FROM partner_postbacks WHERE partner_key_id = ${keyId}::int AND lead_inbox_id = ${inbox}::uuid`);

      // ── I1 ────────────────────────────────────────────────────────────
      const inbox1 = randomUUID();
      const at = new Date();
      const first = await enqueueInvalidPostback(tx, { orgId, partnerKeyId: keyInv, leadInboxId: inbox1, partnerData: pd, at });
      const second = await enqueueInvalidPostback(tx, { orgId, partnerKeyId: keyInv, leadInboxId: inbox1, partnerData: pd, at });
      const r1 = await rowsFor(keyInv, inbox1);
      const p = (r1[0]?.payload ?? {}) as Row;
      const wantAt = at.toISOString().slice(0, 19) + "Z";
      check("I1 one invalid row for a key with invalid live", r1.length === 1 && first === true, `rows ${r1.length}, first ${first}`);
      check("I1 twice ⇒ still one row, second returns false", second === false && r1.length === 1, `second ${second}`);
      check("I1 row shape: event invalid, org, pending, no conversion/journey/lead event",
        r1[0]?.event === "invalid" && r1[0]?.org_id === orgId && r1[0]?.status === "pending" &&
          r1[0]?.conversion_event_id === null && r1[0]?.drip_journey_id === null && r1[0]?.lead_event_id === null,
        JSON.stringify(r1[0] ?? null));
      check("I1 payload: status invalid, event_id invalid-<uuid>, conversion_id '', null currency/payout",
        p.event === "invalid" && p.status === "invalid" && p.event_id === `invalid-${inbox1}` &&
          p.conversion_id === "" && p.currency === null && p.payout === null,
        JSON.stringify(p));
      check("I1 payload: occurred_at = at (UTC Z), fields = partner data",
        p.occurred_at === wantAt && JSON.stringify(p.fields) === JSON.stringify(pd),
        `${String(p.occurred_at)} vs ${wantAt}; ${JSON.stringify(p.fields)}`);

      // A custom word is snapshotted.
      await tx.execute(sql`UPDATE partner_keys SET postback_status_words = '{"invalid":"bad_number"}'::jsonb WHERE id = ${keyInv}::int`);
      const inboxW = randomUUID();
      await enqueueInvalidPostback(tx, { orgId, partnerKeyId: keyInv, leadInboxId: inboxW, partnerData: pd, at });
      const rw = await rowsFor(keyInv, inboxW);
      check("I1 the key's own invalid word is used", (rw[0]?.payload as Row | undefined)?.status === "bad_number",
        JSON.stringify(rw[0]?.payload ?? null));

      // ── I2 ────────────────────────────────────────────────────────────
      const none = async (label: string, keyId: number, o: { partnerData?: Row | null; at?: Date; org?: string }) => {
        const inbox = randomUUID();
        const ok = await enqueueInvalidPostback(tx, {
          orgId: o.org ?? orgId, partnerKeyId: keyId, leadInboxId: inbox,
          partnerData: o.partnerData === undefined ? pd : o.partnerData, at: o.at ?? at,
        });
        const n = (await q(tx, sql`SELECT 1 FROM partner_postbacks WHERE lead_inbox_id = ${inbox}::uuid`)).length;
        check(`I2 ${label} ⇒ 0`, ok === false && n === 0, `returned ${ok}, rows ${n}`);
      };
      await none("key without invalid", keyNoInv, {});
      await none("disabled key", keyOff, {});
      await none("sandbox key", keySand, {});
      await none("at before the invalid since", keyInv, { at: new Date(Date.now() - 2 * 3600_000) });
      await none("missing required field (relay_lead_id)", keyInv, { partnerData: { list_id: "L9" } });
      await none("blank required field", keyInv, { partnerData: { relay_lead_id: "  " } });
      await none("no partner data", keyInv, { partnerData: null });
      await none("key of another org", keyInv, { org: orgB });

      // ── I5 ────────────────────────────────────────────────────────────
      const inbox5 = (await q<{ id: string }>(tx, sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, partner_data)
        VALUES (${orgId}::uuid, ${keyInv}::int, ${`${RUN}-inv`}, now(), '{}'::jsonb, '+12005550100',
                ${JSON.stringify(pd)}::jsonb)
        RETURNING id::text AS id`))[0].id;
      const alertBefore = await alertRow();
      const envBefore = process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED;
      process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED = "true"; // postbacks "live" ⇒ the alert latches
      let threw = false;
      let latched: Awaited<ReturnType<typeof alertRow>>;
      try {
        await tryEnqueueInvalidPostback(
          tx,
          { orgId, partnerKeyId: keyInv, leadInboxId: inbox5, partnerData: pd, at },
          async (sp) => {
            await sp.execute(sql`SELECT 1/0`); // a real SQL failure, aborting the savepoint
            return true;
          },
        );
      } catch {
        threw = true;
      } finally {
        latched = await alertRow();
        if (envBefore === undefined) delete process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED;
        else process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED = envBefore;
        await restoreAlert(alertBefore);
      }
      check("I5 a failing insert never throws", threw === false);
      const one = await q<{ n: number }>(tx, sql`SELECT 1 AS n`);
      check("I5 the outer transaction is still usable", one[0]?.n === 1);
      await tx.execute(sql`DELETE FROM lead_inbox WHERE id = ${inbox5}::uuid`);
      const gone = (await q(tx, sql`SELECT 1 FROM lead_inbox WHERE id = ${inbox5}::uuid`)).length === 0;
      check("I5 the lead's DELETE still happens", gone);
      check("I5 the failure alert latches (postbacks live)", latched?.state === "firing", JSON.stringify(latched ?? null));
      const n5 = (await q(tx, sql`SELECT 1 FROM partner_postbacks WHERE lead_inbox_id = ${inbox5}::uuid`)).length;
      check("I5 nothing queued by the failed insert", n5 === 0, `rows ${n5}`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function enrichmentCases(RUN: string) {
  const one = async <T>(s: SQL): Promise<T> => (await q<T>(db, s))[0];
  const pending = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM lead_inbox WHERE status IN ('received','awaiting_lookup')`)).n;
  if (pending > 0) throw new Error(`REFUSING: lead_inbox already has ${pending} claimable row(s)`);

  const [pLand, pUnk] = fictionalPhones(2);
  const phones = [pLand, pUnk];
  await refuseIfPhonesInUse(db, phones);
  const alertBefore = await alertRow();
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${RUN}`}) RETURNING id::text AS id`)).id;
    const slug = `${RUN}-e2e`;
    const { keyId } = await createPartnerWithKey(db, { orgId, slug, sandbox: false });
    await configureKey(db, keyId, { events: ["purchase", "invalid"] });

    const inboxIds: Record<string, string> = {};
    for (const [p, lt] of [[pLand, "landline"], [pUnk, "unknown"]] as const) {
      // Lookup already COMPLETE ⇒ the claim treats it as a cache hit; Telnyx is never called.
      await db.execute(sql`
        INSERT INTO phone_lookups (phone, line_type, source, lookup_status, looked_up_at)
        VALUES (${p}, ${lt}, 'manual_edit', 'complete', now())`);
      inboxIds[lt] = (await one<{ id: string }>(sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, interest_tag, partner_data)
        VALUES (${orgId}::uuid, ${keyId}, ${slug}, now() - interval '1 minute',
                ${JSON.stringify({ phone: p })}::jsonb, ${p}, 'inv',
                ${JSON.stringify({ relay_lead_id: `r-${lt}` })}::jsonb)
        RETURNING id::text AS id`)).id;
    }

    const enr = await runEnrichmentBatch();
    const landGone = (await q(db, sql`SELECT 1 FROM lead_inbox WHERE id = ${inboxIds.landline}::uuid`)).length === 0;
    const counter = await one<{ landline: number } | undefined>(sql`
      SELECT coalesce(sum(landline), 0)::int AS landline FROM lead_intake_daily
      WHERE org_id = ${orgId}::uuid AND partner_key_id = ${keyId}`);
    const pbs = await q<{ event: string; lead_inbox_id: string; payload: Row }>(db, sql`
      SELECT event, lead_inbox_id::text, payload FROM partner_postbacks WHERE partner_key_id = ${keyId}`);
    check("I3 the landline inbox row is deleted", landGone && enr.landline === 1, `landline ${enr.landline}`);
    check("I3 the landline counter is +1", counter?.landline === 1, `landline ${counter?.landline}`);
    const inv = pbs.filter((r) => r.event === "invalid" && r.lead_inbox_id === inboxIds.landline);
    check("I3 exactly one invalid postback for the landline inbox row", inv.length === 1,
      JSON.stringify(pbs.map((r) => [r.event, r.lead_inbox_id])));
    check("I3 its fields are the inbox row's partner data",
      JSON.stringify((inv[0]?.payload as Row | undefined)?.fields) === JSON.stringify({ relay_lead_id: "r-landline" }));
    const unk = await one<{ status: string } | undefined>(sql`SELECT status FROM lead_inbox WHERE id = ${inboxIds.unknown}::uuid`);
    check("I4 the unknown row is processed, not discarded", unk?.status === "processed" && enr.processed === 1,
      `status ${unk?.status}, processed ${enr.processed}`);
    check("I4 the unknown row produces no postback (G19)",
      pbs.filter((r) => r.lead_inbox_id === inboxIds.unknown).length === 0 && pbs.length === 1, `postbacks ${pbs.length}`);
  } finally {
    await restoreAlert(alertBefore);
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        failures++;
      } else {
        await db.execute(sql`DELETE FROM partner_postbacks WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_inbox WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_daily WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_hourly WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const list = sql.join(phones.map((p) => sql`${p}`), sql`, `);
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone IN (${list}) AND source = 'manual_edit'`);
    await db.execute(sql`DELETE FROM lookup_queue WHERE phone IN (${list})`);
    const left = await one<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM partner_keys WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM partner_postbacks WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM phone_lookups WHERE phone IN (${list}))
            + (SELECT count(*) FROM lookup_queue WHERE phone IN (${list}))) AS n`);
    console.log(`  Teardown: ${left.n} row(s) left`);
    if (Number(left.n) !== 0) failures++;
  }
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  const RUN = `pbi-${Date.now().toString(36)}`;
  await rolledBackCases(RUN);
  await enrichmentCases(RUN);
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
