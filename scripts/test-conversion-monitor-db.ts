import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { inArray, like, sql, type SQL } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import { db } from "../db/client";
import { conversion_events } from "../db/schema";
import { clearAlert } from "../lib/alerts/alert-state";
import type { IngestResult } from "../lib/conversions/ingest";
import {
  CONFLICT_COMBOS_SQL,
  CONVERSION_ALERT_KEYS,
  INGEST_HEARTBEAT_ALERT_KEY,
  LEDGER_MAX_COMBOS,
  UNMAPPED_COMBOS_SQL,
  evaluateConversionAlerts,
  evaluateProjectionAlert,
  readLedgerHealth,
  watchIngestHeartbeat,
  type IngestOutcome,
  type LedgerHealth,
} from "../lib/conversions/monitor";
import { HEARTBEAT_JOBS, recordHeartbeat } from "../lib/reporting/cron-heartbeat";

// The conversion ledger monitor's DB side, run through the REAL exported
// functions inside a transaction that always rolls back. Every page goes to a
// stub sender; TELEGRAM_* is also unset so a missed injection cannot reach the
// channel. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-conversion-monitor-db.ts
// The refusal itself is the `_require-preview-db` import above — an allowlist,
// and early enough that nothing can query ahead of it.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}
const RUN = `test-cm-${Date.now()}`;
const K = CONVERSION_ALERT_KEYS;
// Written out, not imported: the keys the docs and alert_state rows name.
const UNM = "conversion_events:unmapped:";
const CONF = "conversion_events:type_conflicts:";
// The per-kind cap keys. Neither is under a combo prefix, so the stale-combo
// clear never sees them.
const CAP_UNM = "conversion_events:combo_cap_exceeded:unmapped";
const CAP_CONF = "conversion_events:combo_cap_exceeded:type_conflicts";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function alertRow(tx: Tx, key: string) {
  const rows = (await tx.execute(sql`
    SELECT state, last_notified_at IS NOT NULL AS notified, org_id IS NULL AS global
    FROM alert_state WHERE alert_key = ${key}
  `)) as unknown as { state: string; notified: boolean; global: boolean }[];
  return rows[0];
}

// Every non-ok key under the combo prefixes, sorted in JS.
async function firingKeys(tx: Tx, prefixes: string[] = [UNM, CONF]): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of prefixes) {
    const rows = (await tx.execute(sql`
      SELECT alert_key FROM alert_state
      WHERE starts_with(alert_key, ${prefix}::text) AND state <> 'ok'
    `)) as unknown as { alert_key: string }[];
    keys.push(...rows.map((r) => r.alert_key));
  }
  return keys.sort();
}
const sameKeys = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Proves the statement CAN be answered from the named index: with seq scans
// disabled, a predicate that doesn't match the partial index's predicate falls
// back to a (penalised) seq scan and the index name is absent from the plan.
async function usesIndex(tx: Tx, query: SQL, index: string): Promise<boolean> {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  const plan = await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
  await tx.execute(sql`SET LOCAL enable_seqscan = on`);
  return JSON.stringify(plan).includes(index);
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
    return true;
  };
  // The pages a step sent.
  const pagesDuring = async (step: () => Promise<unknown>): Promise<string[]> => {
    const n = sent.length;
    await step();
    return sent.slice(n);
  };
  const preexisting = await readLedgerHealth(db);

  try {
    await db.transaction(async (tx) => {
      const [org] = (await tx.execute(
        sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`,
      )) as unknown as { id: string }[];
      const types = (await tx.execute(
        sql`SELECT id, key FROM event_types WHERE org_id = ${org.id}::uuid`,
      )) as unknown as { id: number; key: string }[];
      const purchase = types.find((t) => t.key === "purchase")?.id ?? null;
      const registration = types.find((t) => t.key === "registration")?.id ?? null;
      const [offer] = (await tx.execute(
        sql`SELECT id, name FROM offers WHERE org_id = ${org.id}::uuid ORDER BY id LIMIT 1`,
      )) as unknown as { id: number; name: string }[];
      check(
        "M0 fixtures: seeded event types and an offer exist for the first org",
        purchase !== null && registration !== null && offer !== undefined,
        JSON.stringify({ types, offer }),
      );
      if (purchase === null || registration === null || offer === undefined) throw new Rollback();

      // Neutralise any pre-existing problem rows INSIDE the rolled-back tx, so the
      // clear/re-fire checks start from a clean ledger without requiring one.
      await tx.execute(sql`
        UPDATE conversion_events
        SET event_type_id = COALESCE(event_type_id, ${purchase}), status = COALESCE(status, 'approved')
        WHERE event_type_id IS NULL OR status IS NULL
      `);
      await tx.execute(sql`
        UPDATE conversion_events
        SET conflicting_event_type_id = NULL, event_type_conflict_at = NULL
        WHERE conflicting_event_type_id IS NOT NULL
      `);
      const before = await readLedgerHealth(tx);
      check(
        `M0b pre-existing problem rows neutralised in the tx (${preexisting.unmapped_total} unmapped, ${preexisting.conflict_total} conflicting) → no problem rows, no combos`,
        before.unmapped_total === 0 &&
          before.conflict_total === 0 &&
          before.unmapped_combo_count === 0 &&
          before.conflict_combo_count === 0 &&
          before.unmapped_combos.length === 0 &&
          before.conflict_combos.length === 0,
        JSON.stringify(before),
      );
      if (before.unmapped_total !== 0 || before.conflict_total !== 0) throw new Rollback();

      for (const key of [...Object.values(K), INGEST_HEARTBEAT_ALERT_KEY]) {
        await clearAlert(tx, { alertKey: key });
      }
      await tx.execute(sql`
        UPDATE alert_state SET state = 'ok'
        WHERE starts_with(alert_key, ${UNM}::text) OR starts_with(alert_key, ${CONF}::text)
      `);
      const seedFiring = (key: string) =>
        tx.execute(sql`
          INSERT INTO alert_state (alert_key, state, since, last_notified_at)
          VALUES (${key}, 'firing', now(), now())
          ON CONFLICT (alert_key) DO UPDATE SET state = 'firing', last_notified_at = now()
        `);
      // Firing keys OUTSIDE both prefixes (the pre-combo fixed key has no trailing
      // colon; the others differ by one character): never touched (g).
      const decoys = ["conversion_events:unmapped", "conversionXevents:unmapped:1", "conversion_events:typeXconflicts:1"];
      // Firing keys INSIDE the prefixes that no combo builds (fix wave 1's per-row
      // format): stale, so the first tick clears them without a page.
      const leftovers = [`${UNM}1`, `${CONF}1`];
      for (const key of [...decoys, ...leftovers]) await seedFiring(key);

      const id = (s: string) => `${RUN}-${s}`;
      const rowIds = new Map<string, number>();
      // Records each inserted row's id under its name (keitaro_event_id minus the run prefix).
      const insertRows = async (rows: PgInsertValue<typeof conversion_events>[]) => {
        const inserted = await tx
          .insert(conversion_events)
          .values(rows)
          .returning({ id: conversion_events.id, keitaro_event_id: conversion_events.keitaro_event_id });
        for (const r of inserted) rowIds.set(r.keitaro_event_id.slice(RUN.length + 1), r.id);
      };
      const rowId = (name: string) => rowIds.get(name) ?? -1;
      const mappedRow = (name: string, eventTypeId: number, age: string): PgInsertValue<typeof conversion_events> => ({
        keitaro_event_id: id(name),
        org_id: org.id,
        keitaro_status: "sale",
        keitaro_type: "sale",
        offer_id: offer.id,
        event_type_id: eventTypeId,
        status: "approved",
        occurred_at: new Date("2026-09-05T12:00:00Z"),
        created_at: sql`now() - ${age}::interval`,
      });
      // NULL event type and NULL status, no attribution unless `over` adds it.
      const unmappedRow = (
        name: string,
        keitaroType: string,
        over: Partial<PgInsertValue<typeof conversion_events>> = {},
      ): PgInsertValue<typeof conversion_events> => ({
        keitaro_event_id: id(name),
        org_id: org.id,
        keitaro_status: keitaroType,
        keitaro_type: keitaroType,
        occurred_at: new Date("2026-09-16T12:00:00Z"),
        ...over,
      });
      const byName = (names: string[]) => inArray(conversion_events.keitaro_event_id, names.map(id));
      // What upsertConversionEvents writes on an EXISTING row whose re-posted
      // Keitaro type maps to a different event than the locked one: the raw type
      // moves, the event type stays, and the conflict is recorded (conflict_at is
      // COALESCE(existing, now())). Conflicts never arise at insert.
      const conflictOnUpdate = (names: string[], keitaroType: string, mapsTo: number) =>
        tx
          .update(conversion_events)
          .set({
            keitaro_type: keitaroType,
            keitaro_status: keitaroType,
            conflicting_event_type_id: mapsTo,
            event_type_conflict_at: sql`COALESCE(conversion_events.event_type_conflict_at, now())`,
            updated_at: sql`now()`,
          })
          .where(byName(names));
      // …and when the new Keitaro type maps to nothing (or its rule was archived):
      // status becomes NULL, the locked event type stays.
      const unmapOnUpdate = (names: string[], keitaroType: string) =>
        tx
          .update(conversion_events)
          .set({ keitaro_type: keitaroType, keitaro_status: keitaroType, status: null, updated_at: sql`now()` })
          .where(byName(names));
      const healSet = { event_type_id: purchase, status: "approved", conflicting_event_type_id: null, event_type_conflict_at: null };
      const heal = (names: string[]) => tx.update(conversion_events).set(healSet).where(byName(names));

      // EXISTING, healthy rows first — the lowest ids, created days ago. They
      // become problems later only through UPDATE, as the live ingest makes them.
      await insertRows([
        mappedRow("old-mapped", purchase, "10 days"),
        mappedRow("old-p1", purchase, "5 days"),
        mappedRow("old-p2", purchase, "4 days"),
        mappedRow("old-r1", registration, "6 days"),
      ]);
      await insertRows([
        // one combo (Keitaro offer 41, no CamMan offer; trash) with 4 rows, newest
        // first by name, each last changed when it was created
        ...[1, 2, 3, 4].map((n) =>
          unmappedRow(`trash-${n}`, "trash", {
            keitaro_offer_id: 41,
            created_at: sql`now() - ${`${n} minutes`}::interval`,
            updated_at: sql`now() - ${`${n} minutes`}::interval`,
          }),
        ),
        // What ingest INSERTS for a row first seen through a status-only mapping
        // (the seeded PsychoBook "rejected" rule): a status, but NO event type. It
        // is unmapped through the event_type_id arm, not the status arm. CamMan
        // offer + Keitaro offer 41, created 3 days ago and re-posted just now, so
        // it is the most recently changed combo while being the smallest.
        unmappedRow("rej", "rejected", {
          offer_id: offer.id,
          keitaro_offer_id: 41,
          status: "rejected",
          created_at: sql`now() - interval '3 days'`,
        }),
        // fully mapped — never counted
        mappedRow("clean", purchase, "0 days"),
      ]);
      await conflictOnUpdate(["old-r1"], "sale", purchase);
      const [{ now_utc }] = (await tx.execute(
        sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS now_utc`,
      )) as unknown as { now_utc: string }[];

      const h = await readLedgerHealth(tx);
      const [rej, trash] = h.unmapped_combos;
      check(
        "M1 unmapped = event type NULL OR status NULL, one group per combo (offer, Keitaro type), MOST RECENTLY CHANGED first — the 1-row rejected combo, re-posted now, ahead of the 4-row trash combo; mapped rows excluded",
        h.unmapped_total === 5 &&
          h.unmapped_combo_count === 2 &&
          h.unmapped_combos.length === 2 &&
          rej?.keitaro_type === "rejected" &&
          rej.total === 1 &&
          trash?.keitaro_type === "trash" &&
          trash.total === 4,
        JSON.stringify(h.unmapped_combos),
      );
      const [rejRow] = (await tx.execute(sql`
        SELECT event_type_id, status FROM conversion_events WHERE keitaro_event_id = ${id("rej")}
      `)) as unknown as { event_type_id: number | null; status: string | null }[];
      check(
        "M1b a first-seen status-only row, exactly as ingest inserts one (event_type_id NULL, status 'rejected'), counts as unmapped — through the event_type_id arm of the predicate, which a 'status IS NULL' read would miss",
        rejRow?.event_type_id === null &&
          rejRow.status === "rejected" &&
          rej?.total === 1 &&
          JSON.stringify(rej.sample_event_ids) === JSON.stringify([id("rej")]),
        JSON.stringify({ rejRow, rej }),
      );
      check(
        "M2 each combo's last-24h count is by created_at, not updated_at (the rejected row was changed just now but created 3 days ago)",
        trash?.last_24h === 4 && rej?.last_24h === 0,
        JSON.stringify(h.unmapped_combos),
      );
      check(
        "M3 combo offer: no CamMan offer → keitaro_offer_id, no name; a CamMan offer → offer_id + name, and its keitaro_offer_id is dropped (offer_id wins)",
        trash?.offer_id === null &&
          trash.keitaro_offer_id === 41 &&
          trash.offer_name === null &&
          rej?.offer_id === offer.id &&
          rej.offer_name === offer.name &&
          rej.keitaro_offer_id === null,
        JSON.stringify(h.unmapped_combos),
      );
      check(
        "M4 combo samples: newest created first, at most 3",
        JSON.stringify(trash?.sample_event_ids) === JSON.stringify([id("trash-1"), id("trash-2"), id("trash-3")]) &&
          JSON.stringify(rej?.sample_event_ids) === JSON.stringify([id("rej")]),
        JSON.stringify(h.unmapped_combos.map((c) => c.sample_event_ids)),
      );
      const [c1] = h.conflict_combos;
      check(
        "M5 a conflict set by UPDATE on an existing row, grouped per combo (offer, locked event, conflicting event): count, first-seen-in-24h count, first seen as UTC ISO, samples",
        h.conflict_total === 1 &&
          h.conflict_combo_count === 1 &&
          c1?.offer_id === offer.id &&
          c1.offer_name === offer.name &&
          c1.keitaro_offer_id === null &&
          c1.locked_event_key === "registration" &&
          c1.conflicting_event_key === "purchase" &&
          c1.total === 1 &&
          c1.last_24h === 1 &&
          c1.since === now_utc &&
          JSON.stringify(c1.sample_event_ids) === JSON.stringify([id("old-r1")]),
        JSON.stringify({ combos: h.conflict_combos, now_utc }),
      );
      check(
        "M6 the unmapped combo statement is answerable from conversion_events_unmapped_idx",
        await usesIndex(tx, UNMAPPED_COMBOS_SQL, "conversion_events_unmapped_idx"),
      );
      check(
        "M7 the conflict combo statement is answerable from conversion_events_type_conflict_idx",
        await usesIndex(tx, CONFLICT_COMBOS_SQL, "conversion_events_type_conflict_idx"),
      );
      let capped: LedgerHealth | undefined;
      try {
        await tx.transaction(async (sp) => {
          await sp.insert(conversion_events).values(
            Array.from({ length: 11 }, (_, i) =>
              [1, 2].map((n) =>
                unmappedRow(`cap-${i}-${n}`, `cap-${String(i).padStart(2, "0")}`, {
                  updated_at: sql`now() - ${`${i + 1} hours`}::interval`,
                }),
              ),
            ).flat(),
          );
          capped = await readLedgerHealth(sp);
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      const afterCap = await readLedgerHealth(tx);
      check(
        "M8 over the cap (11 more combos of 2 rows, changed 1–11h ago, in a savepoint): the 10 MOST RECENTLY CHANGED are listed — the 1-row rejected combo and the 4-row trash combo ahead of the bigger but older cap-* ones, whose oldest three drop out — while the combo count and row total still cover all 13 combos / 27 rows; the savepoint rolled back",
        LEDGER_MAX_COMBOS === 10 &&
          JSON.stringify(capped?.unmapped_combos.map((c) => c.keitaro_type)) ===
            JSON.stringify(["rejected", "trash", ...Array.from({ length: 8 }, (_, i) => `cap-0${i}`)]) &&
          capped?.unmapped_combo_count === 13 &&
          capped.unmapped_total === 27 &&
          afterCap.unmapped_combo_count === 2 &&
          afterCap.unmapped_total === 5,
        JSON.stringify({
          count: capped?.unmapped_combo_count,
          total: capped?.unmapped_total,
          listed: capped?.unmapped_combos.map((c) => `${c.keitaro_type}:${c.total}`),
        }),
      );

      const okRun: IngestResult = {
        ok: true,
        dryRun: false,
        range: { from: "2026-09-11 00:00:00", to: "2026-09-17 10:05:00", timezone: "America/New_York" },
        fetched: 4,
        invalid: 0,
        invalidSamples: [],
        unresolved: 0,
        unresolvedSamples: [],
        rows: 4,
        unmappedInBatch: 0,
        statusOnlyInBatch: 0,
        inserted: 0,
        updated: 0,
        unchanged: 4,
        typeConflicts: 0,
        orgMismatch: 0,
        orgMismatchSamples: [],
        error: null,
      };
      const failedRun: IngestResult = {
        ...okRun,
        ok: false,
        fetched: 0,
        rows: 0,
        unchanged: 0,
        error: "Keitaro conversions/log truncated: 1000 of 1200 rows",
      };
      const invalidRun: IngestResult = {
        ...okRun,
        invalid: 2,
        invalidSamples: [
          "event_id=∅ conversion_type=Lead datetime=2026-09-17 09:00:00 revenue=0",
          "event_id=bad conversion_type=∅ datetime=2026-09-17 09:00:00 revenue=0",
        ],
      };
      const ok: IngestOutcome = { kind: "result", result: okRun };
      const refused: IngestOutcome = { kind: "result", result: failedRun };
      const invalid: IngestOutcome = { kind: "result", result: invalidRun };
      const threw: IngestOutcome = { kind: "threw", range: okRun.range, error: "connect ECONNREFUSED 10.0.0.1:6543" };
      const tick = (outcome: IngestOutcome = ok) => pagesDuring(() => evaluateConversionAlerts(tx, outcome, { send }));
      // The ingest heartbeat (last COMPLETE ingest) that the fetch_failed debounce reads.
      const setLastSuccess = (watermark: SQL) =>
        tx.execute(sql`
          INSERT INTO cron_locks (job_name, watermark)
          VALUES (${HEARTBEAT_JOBS.conversionEventsIngest.job_name}, ${watermark})
          ON CONFLICT (job_name) DO UPDATE SET watermark = excluded.watermark
        `);

      const keyTrash = `${UNM}k41:trash`;
      const keyRej = `${UNM}${offer.id}:rejected`;
      const keyRegPurchase = `${CONF}${offer.id}:registration>purchase`;
      const a1 = await tick();
      check(
        "A1 first tick → one page per problem combo, most recently changed first: rejected (the CamMan offer), trash (Keitaro offer 41), registration → purchase",
        a1.length === 3 &&
          a1[0].includes(`1 conversion(s) for ${offer.name} (offer ${offer.id}) with Keitaro type rejected`) &&
          a1[1].includes("4 conversion(s) for Keitaro offer 41 (no CamMan offer) with Keitaro type trash") &&
          a1[1].includes(id("trash-1")) &&
          a1[2].includes("locked registration → now purchase") &&
          a1[2].includes(id("old-r1")),
        JSON.stringify(a1),
      );
      const [aTrash, aRej, aConf, aFetch, aInv, aOrg, aCapU, aCapC, aLeft1, aLeft2] = await Promise.all(
        [
          keyTrash,
          keyRej,
          keyRegPurchase,
          K.fetchFailed,
          K.invalidRows,
          K.orgMismatch,
          CAP_UNM,
          CAP_CONF,
          ...leftovers,
        ].map((k) => alertRow(tx, k)),
      );
      check(
        "A2 alert_state: exactly the three combo keys firing under the prefixes, delivered and org-less; the five fixed keys (both cap keys included, the ledger being far under the cap) ok; the leftover in-prefix keys cleared without a page (as clearAlert leaves a row)",
        sameKeys(await firingKeys(tx), [keyTrash, keyRej, keyRegPurchase]) &&
          [aTrash, aRej, aConf].every((r) => r?.state === "firing" && r.notified && r.global) &&
          [aFetch, aInv, aOrg, aCapU, aCapC].every((r) => r?.state === "ok") &&
          [aLeft1, aLeft2].every((r) => r?.state === "ok" && r.notified && r.global),
        JSON.stringify({ firing: await firingKeys(tx), aTrash, aRej, aConf, aFetch, aInv, aOrg, aCapU, aCapC, aLeft1, aLeft2 }),
      );
      const a3 = await tick();
      check(
        "A3 next tick, nothing changed → no page, the same firing keys",
        a3.length === 0 && sameKeys(await firingKeys(tx), [keyTrash, keyRej, keyRegPurchase]),
        JSON.stringify(a3),
      );

      const keyLead = `${UNM}none:lead`;
      await insertRows([unmappedRow("lead-1", "lead")]);
      const s1a = await tick();
      check(
        "S1a (a) a row of a NEW combo (no offer, lead) → exactly one page, on unmapped:none:lead",
        s1a.length === 1 &&
          s1a[0].includes("1 conversion(s) for no offer with Keitaro type lead") &&
          (await alertRow(tx, keyLead))?.notified === true,
        JSON.stringify(s1a),
      );
      await insertRows([unmappedRow("lead-2", "lead")]);
      const s1b = await tick();
      const s1c = await tick();
      check(
        "S1b (a) another row of the SAME combo, then one more tick → no page on either (a stream doesn't flood); the key stays firing",
        s1b.length === 0 && s1c.length === 0 && (await alertRow(tx, keyLead))?.state === "firing",
        JSON.stringify([...s1b, ...s1c]),
      );

      const keyLeadK41 = `${UNM}k41:lead`;
      await insertRows([unmappedRow("lead-k41", "lead", { keitaro_offer_id: 41 })]);
      const s2 = await tick();
      check(
        "S2 (b) a row of another NEW combo (same type, Keitaro offer 41) → one more page, on unmapped:k41:lead",
        s2.length === 1 &&
          s2[0].includes("1 conversion(s) for Keitaro offer 41 (no CamMan offer) with Keitaro type lead") &&
          (await alertRow(tx, keyLeadK41))?.state === "firing",
        JSON.stringify(s2),
      );

      const keyChargeback = `${UNM}${offer.id}:chargeback`;
      await unmapOnUpdate(["old-mapped"], "chargeback");
      const s3 = await tick();
      check(
        "S3 (c) an EXISTING mapped row (lowest id, created 10 days ago) turned unmapped by UPDATE — its Keitaro type changed to an unmapped one → pages for its new combo",
        s3.length === 1 &&
          s3[0].includes(`1 conversion(s) for ${offer.name} (offer ${offer.id}) with Keitaro type chargeback`) &&
          s3[0].includes("(0 created in the last 24h)") &&
          s3[0].includes(id("old-mapped")) &&
          (await alertRow(tx, keyChargeback))?.state === "firing" &&
          rowId("old-mapped") < rowId("trash-1"),
        JSON.stringify(s3),
      );

      const keyPurchaseReg = `${CONF}${offer.id}:purchase>registration`;
      await conflictOnUpdate(["old-p1"], "lead", registration);
      const s4a = await tick();
      check(
        "S4a (d) a type conflict set on an EXISTING row by UPDATE (conflicting_event_type_id + event_type_conflict_at = now(), as ingest writes it) → pages for its combo",
        s4a.length === 1 &&
          s4a[0].includes(`1 conversion(s) for ${offer.name} (offer ${offer.id}) changed Keitaro type`) &&
          s4a[0].includes("locked purchase → now registration") &&
          s4a[0].includes(id("old-p1")) &&
          (await alertRow(tx, keyPurchaseReg))?.state === "firing",
        JSON.stringify(s4a),
      );
      await conflictOnUpdate(["old-p2"], "lead", registration);
      const s4b = await tick();
      const s4bCombo = (await readLedgerHealth(tx)).conflict_combos.find((c) => c.locked_event_key === "purchase");
      check(
        "S4b (d) a second conflict of the SAME combo on another existing row → no page; the key stays firing and the combo now counts 2",
        s4b.length === 0 && (await alertRow(tx, keyPurchaseReg))?.state === "firing" && s4bCombo?.total === 2,
        JSON.stringify({ s4b, s4bCombo }),
      );

      await heal(["lead-1", "lead-2", "old-p1", "old-p2"]);
      const s5a = await tick();
      const [clearedLead, clearedConflict] = [await alertRow(tx, keyLead), await alertRow(tx, keyPurchaseReg)];
      check(
        "S5a (e) combos resolved (the lead rows healed, the purchase → registration conflicts cleared) → their keys cleared as clearAlert leaves a row (delivered stamp kept, org-less), no page; the other combos stay firing",
        s5a.length === 0 &&
          clearedLead?.state === "ok" &&
          clearedLead.notified &&
          clearedLead.global &&
          clearedConflict?.state === "ok" &&
          sameKeys(await firingKeys(tx), [keyTrash, keyRej, keyRegPurchase, keyLeadK41, keyChargeback]),
        JSON.stringify({ s5a, firing: await firingKeys(tx), clearedLead, clearedConflict }),
      );
      await unmapOnUpdate(["lead-2"], "lead");
      await conflictOnUpdate(["old-p1"], "lead", registration);
      const s5b = await tick();
      check(
        "S5b (e) the same two combos reappear → each pages again (re-armed), on the same keys",
        s5b.length === 2 &&
          s5b.some((t) => t.includes("for no offer with Keitaro type lead")) &&
          s5b.some((t) => t.includes("locked purchase → now registration")) &&
          (await alertRow(tx, keyLead))?.state === "firing" &&
          (await alertRow(tx, keyPurchaseReg))?.state === "firing",
        JSON.stringify(s5b),
      );

      await tx
        .update(conversion_events)
        .set(healSet)
        .where(like(conversion_events.keitaro_event_id, `${RUN}-%`));
      const s6 = await tick();
      const decoyRows = await Promise.all(decoys.map((k) => alertRow(tx, k)));
      check(
        "S6 every problem row healed → every key under both prefixes cleared, no page; (g) the firing decoy keys outside the prefixes are untouched",
        s6.length === 0 &&
          (await firingKeys(tx)).length === 0 &&
          decoyRows.every((r) => r?.state === "firing"),
        JSON.stringify({ s6, firing: await firingKeys(tx), decoyRows }),
      );

      // The cap (LEDGER_MAX_COMBOS per kind): ten unmapped combos of 2 rows each,
      // last changed 1–10 hours ago, then a brand-new combo of ONE row.
      const tenType = (i: number) => `ten-${String(i).padStart(2, "0")}`;
      const tenNames = Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) => [`${tenType(i)}-1`, `${tenType(i)}-2`]).flat();
      const tenKeys = Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) => `${UNM}none:${tenType(i)}`);
      await insertRows(
        Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) =>
          [1, 2].map((n) =>
            unmappedRow(`${tenType(i)}-${n}`, tenType(i), { updated_at: sql`now() - ${`${i + 1} hours`}::interval` }),
          ),
        ).flat(),
      );
      const p1 = await tick();
      check(
        "P1 ten unmapped combos (2 rows each) → one page each; AT the cap, not past it, so the combo_cap_exceeded key stays ok and no cap page is sent",
        p1.length === LEDGER_MAX_COMBOS &&
          sameKeys(await firingKeys(tx), tenKeys) &&
          (await alertRow(tx, CAP_UNM))?.state === "ok" &&
          !p1.some((t) => t.includes("unmapped combos exist")),
        JSON.stringify({ pages: p1.length, firing: await firingKeys(tx) }),
      );
      const keyEleventh = `${UNM}none:eleventh`;
      await insertRows([unmappedRow("eleventh", "eleventh")]);
      const p2 = await tick();
      check(
        "P2a a NEW 11th combo of one row, against ten bigger ones already firing → it is listed and pages exactly once, because the listing ranks by recency, not by size; none of the ten re-pages",
        p2.filter((t) => t.includes("with Keitaro type eleventh")).length === 1 &&
          (await alertRow(tx, keyEleventh))?.state === "firing" &&
          p2.filter((t) => /with Keitaro type ten-/.test(t)).length === 0,
        JSON.stringify(p2),
      );
      const capRow = await alertRow(tx, CAP_UNM);
      check(
        "P2b crossing the cap → exactly one more page, on the fixed combo_cap_exceeded key (11 combos, cap 10), delivered; and the least recently changed combo, now unlisted, is NOT cleared",
        p2.length === 2 &&
          p2.filter((t) => t.includes("11 unmapped combos exist, more than the 10")).length === 1 &&
          capRow?.state === "firing" &&
          capRow.notified &&
          capRow.global &&
          (await alertRow(tx, tenKeys[LEDGER_MAX_COMBOS - 1]))?.state === "firing",
        JSON.stringify({ p2, capRow }),
      );
      const p3 = await tick();
      check(
        "P3 still past the cap, nothing changed → no page (the cap key is latched like any other)",
        p3.length === 0 && (await alertRow(tx, CAP_UNM))?.state === "firing",
        JSON.stringify(p3),
      );
      await heal([`${tenType(LEDGER_MAX_COMBOS - 1)}-1`, `${tenType(LEDGER_MAX_COMBOS - 1)}-2`]);
      const p4 = await tick();
      check(
        "P4 back to ten combos (at the cap) → the cap key clears without a page, and combo clears resume: the healed combo's key goes ok while the other ten stay firing",
        p4.length === 0 &&
          (await alertRow(tx, CAP_UNM))?.state === "ok" &&
          (await alertRow(tx, tenKeys[LEDGER_MAX_COMBOS - 1]))?.state === "ok" &&
          sameKeys(await firingKeys(tx), [...tenKeys.slice(0, LEDGER_MAX_COMBOS - 1), keyEleventh]),
        JSON.stringify({ p4, firing: await firingKeys(tx) }),
      );
      await heal([...tenNames, "eleventh"]);
      const p5 = await tick();
      check(
        "P5 every cap-scenario row healed → no page, and nothing firing under either prefix (the fixed-key checks below start clean)",
        p5.length === 0 && (await firingKeys(tx)).length === 0,
        JSON.stringify({ p5, firing: await firingKeys(tx) }),
      );

      // fetch_failed: debounced on the last COMPLETE ingest (the heartbeat), and
      // a throw is a failed tick exactly like a refused window.
      await setLastSuccess(sql`now() - interval '5 minutes'`);
      const a6 = await tick(refused);
      check(
        "A6 refused window, last complete ingest 5 min ago → debounced: no page, fetch_failed untouched (ok)",
        a6.length === 0 && (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(a6),
      );
      await setLastSuccess(sql`now() - interval '20 minutes'`);
      const a7 = await tick(refused);
      check(
        "A7 refused window, last complete ingest 20 min ago → fetch_failed pages with the error",
        a7.length === 1 && a7[0].includes("truncated: 1000 of 1200 rows"),
        JSON.stringify(a7),
      );
      const a8 = await tick(refused);
      check("A8 still refused and stale → no second page (latched)", a8.length === 0, JSON.stringify(a8));

      // (f) A failed tick must still re-read the ledger (design decision 3).
      const keyUpsell = `${UNM}${offer.id}:upsell`;
      await insertRows([unmappedRow("upsell", "upsell", { offer_id: offer.id })]);
      const a8b = await tick(refused);
      check(
        "A8b (f) a refused tick still re-reads the ledger: a row of a new combo → that tick pages it on unmapped:<offer>:upsell, and fetch_failed stays firing without a second page",
        a8b.length === 1 &&
          a8b[0].includes(`for ${offer.name} (offer ${offer.id}) with Keitaro type upsell`) &&
          (await alertRow(tx, keyUpsell))?.state === "firing" &&
          (await alertRow(tx, K.fetchFailed))?.state === "firing",
        JSON.stringify(a8b),
      );

      await setLastSuccess(sql`now() - interval '5 minutes'`);
      const a9 = await tick(refused);
      check(
        "A9 a debounced failure never clears: fresh heartbeat + refused → no page, fetch_failed still firing",
        a9.length === 0 && (await alertRow(tx, K.fetchFailed))?.state === "firing",
        JSON.stringify(a9),
      );
      const a10 = await tick();
      check(
        "A10 complete window → fetch_failed cleared, no page",
        a10.length === 0 && (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(a10),
      );
      await setLastSuccess(sql`NULL::timestamptz`);
      const a11 = await tick(threw);
      check(
        "A11 an ingest that THREW, no complete ingest ever recorded → fetch_failed pages again with the thrown message",
        a11.length === 1 && a11[0].includes("connect ECONNREFUSED 10.0.0.1:6543") && a11[0].includes("never recorded"),
        JSON.stringify(a11),
      );

      const a12 = await tick(invalid);
      check(
        "A12 unparseable rows → invalid_rows pages with the count and a sample (and the complete window clears fetch_failed silently)",
        a12.length === 1 &&
          a12[0].includes("2 Keitaro conversion row(s)") &&
          a12[0].includes("event_id=bad") &&
          (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(a12),
      );
      const a13 = await tick(invalid);
      check("A13 still unparseable → no second page", a13.length === 0, JSON.stringify(a13));
      const a14 = await tick();
      check(
        "A14 clean complete window → invalid_rows cleared, no page",
        a14.length === 0 && (await alertRow(tx, K.invalidRows))?.state === "ok",
        JSON.stringify(a14),
      );

      // The stage-day projection's own latched key (Phase 3 Task 3).
      await clearAlert(tx, { alertKey: K.projectionFailed });
      const pf1 = await pagesDuring(() =>
        evaluateProjectionAlert(tx, { kind: "threw", error: "statement timeout" }, { send }),
      );
      check(
        "C1 a thrown projection pages once and latches firing",
        pf1.length === 1 &&
          pf1[0].includes("stage-day conversion projection failed") &&
          pf1[0].includes("statement timeout") &&
          (await alertRow(tx, K.projectionFailed))?.state === "firing",
        JSON.stringify(pf1),
      );
      const pf2 = await pagesDuring(() =>
        evaluateProjectionAlert(tx, { kind: "threw", error: "statement timeout" }, { send }),
      );
      check("C2 still failing → no second page", pf2.length === 0, JSON.stringify(pf2));
      const pf3 = await pagesDuring(() => evaluateProjectionAlert(tx, { kind: "ok" }, { send }));
      check(
        "C3 a successful projection clears it, silently",
        pf3.length === 0 && (await alertRow(tx, K.projectionFailed))?.state === "ok",
        JSON.stringify(pf3),
      );
      const pf4 = await pagesDuring(() =>
        evaluateProjectionAlert(tx, { kind: "refused", reason: "empty_ledger" }, { send }),
      );
      check(
        "C4 the empty-ledger refusal re-arms the same key and pages, pointing at the backfill",
        pf4.length === 1 &&
          pf4[0].includes("no stage-attributed rows") &&
          pf4[0].includes("backfill-conversion-events.ts --apply") &&
          (await alertRow(tx, K.projectionFailed))?.state === "firing" &&
          (await alertRow(tx, K.projectionFailed))?.global === true,
        JSON.stringify(pf4),
      );
      const pf5 = await pagesDuring(() => evaluateProjectionAlert(tx, { kind: "ok" }, { send }));
      check(
        "C5 and clears again",
        pf5.length === 0 && (await alertRow(tx, K.projectionFailed))?.state === "ok",
        JSON.stringify(pf5),
      );
      // The coverage refusal (review fix A2) and the capped discovery window
      // (A5) ride the SAME latched key: each pages once when it appears.
      const pf6 = await pagesDuring(() =>
        evaluateProjectionAlert(
          tx,
          { kind: "refused", reason: "ledger_behind_history", reportedFrom: "2026-04-01", coverageFrom: "2026-09-14" },
          { send },
        ),
      );
      check(
        "C6 ⭐ the coverage refusal pages with both dates and latches firing",
        pf6.length === 1 &&
          pf6[0].includes("2026-04-01") &&
          pf6[0].includes("2026-09-14") &&
          pf6[0].includes("nothing was zeroed") &&
          (await alertRow(tx, K.projectionFailed))?.state === "firing",
        JSON.stringify(pf6),
      );
      const pf6b = await pagesDuring(() =>
        evaluateProjectionAlert(tx, { kind: "truncated", projected: 20000 }, { send }),
      );
      check(
        "C6b sharing the key means a SECOND condition does not re-page while the first is firing (accepted trade)",
        pf6b.length === 0 && (await alertRow(tx, K.projectionFailed))?.state === "firing",
        JSON.stringify(pf6b),
      );
      await clearAlert(tx, { alertKey: K.projectionFailed });
      const pf7 = await pagesDuring(() => evaluateProjectionAlert(tx, { kind: "truncated", projected: 20000 }, { send }));
      check(
        "C7 ⭐ from a clear key, a truncated window pages on its own: the cursor was held and it says so",
        pf7.length === 1 && pf7[0].includes("NOT advanced") && pf7[0].includes("20000"),
        JSON.stringify(pf7),
      );
      const pf8 = await pagesDuring(() => evaluateProjectionAlert(tx, { kind: "truncated", projected: 20000 }, { send }));
      check("C8 still truncated → no second page", pf8.length === 0, JSON.stringify(pf8));
      const pf9 = await pagesDuring(() => evaluateProjectionAlert(tx, { kind: "ok" }, { send }));
      check(
        "C9 a finished window clears it",
        pf9.length === 0 && (await alertRow(tx, K.projectionFailed))?.state === "ok",
        JSON.stringify(pf9),
      );

      await setLastSuccess(sql`now() - interval '3 hours'`);
      let stale: Awaited<ReturnType<typeof watchIngestHeartbeat>> | undefined;
      const b1 = await pagesDuring(async () => {
        stale = await watchIngestHeartbeat(tx, { send });
      });
      check(
        "B1 stale ingest heartbeat → one page naming the job",
        stale?.stale === true && b1.length === 1 && b1[0].includes("Conversion events ingest (Keitaro poll tick)"),
        JSON.stringify({ stale, b1 }),
      );
      const b2 = await pagesDuring(() => watchIngestHeartbeat(tx, { send }));
      check("B2 still stale → no second page", b2.length === 0, JSON.stringify(b2));
      await recordHeartbeat(tx, HEARTBEAT_JOBS.conversionEventsIngest.job_name);
      let fresh: Awaited<ReturnType<typeof watchIngestHeartbeat>> | undefined;
      const b3 = await pagesDuring(async () => {
        fresh = await watchIngestHeartbeat(tx, { send });
      });
      check(
        "B3 fresh heartbeat → cleared, no page",
        fresh?.stale === false && b3.length === 0 && (await alertRow(tx, INGEST_HEARTBEAT_ALERT_KEY))?.state === "ok",
        JSON.stringify(fresh),
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const [left] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM conversion_events WHERE keitaro_event_id LIKE ${`${RUN}%`}`,
  )) as unknown as { n: number }[];
  const after = await readLedgerHealth(db);
  check(
    "Z1 rolled back — no test rows left, pre-existing unmapped/conflict row and combo counts unchanged",
    left.n === 0 &&
      after.unmapped_total === preexisting.unmapped_total &&
      after.conflict_total === preexisting.conflict_total &&
      after.unmapped_combo_count === preexisting.unmapped_combo_count &&
      after.conflict_combo_count === preexisting.conflict_combo_count,
    JSON.stringify({
      left: left.n,
      before: [preexisting.unmapped_total, preexisting.conflict_total],
      after: [after.unmapped_total, after.conflict_total],
    }),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
