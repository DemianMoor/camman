import "./_env-preload";

import { inArray, sql, type SQL } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import { db } from "../db/client";
import { conversion_events } from "../db/schema";
import { clearAlert } from "../lib/alerts/alert-state";
import type { IngestResult } from "../lib/conversions/ingest";
import {
  CONFLICT_COUNT_SQL,
  CONVERSION_ALERT_KEYS,
  CONVERSION_ALERT_KEY_PREFIXES,
  INGEST_HEARTBEAT_ALERT_KEY,
  UNMAPPED_COUNT_SQL,
  evaluateConversionAlerts,
  ledgerAlertKey,
  readLedgerHealth,
  watchIngestHeartbeat,
  type IngestOutcome,
} from "../lib/conversions/monitor";
import { HEARTBEAT_JOBS, recordHeartbeat } from "../lib/reporting/cron-heartbeat";

// The conversion ledger monitor's DB side, run through the REAL exported
// functions inside a transaction that always rolls back. Every page goes to a
// stub sender; TELEGRAM_* is also unset so a missed injection cannot reach the
// channel. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-conversion-monitor-db.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}
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
const P = CONVERSION_ALERT_KEY_PREFIXES;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function alertRow(tx: Tx, key: string) {
  const rows = (await tx.execute(sql`
    SELECT state, last_notified_at IS NOT NULL AS notified, org_id IS NULL AS global
    FROM alert_state WHERE alert_key = ${key}
  `)) as unknown as { state: string; notified: boolean; global: boolean }[];
  return rows[0];
}

// Every non-ok key under a prefix. starts_with, not LIKE, so the test does not
// share the monitor's LIKE escaping.
async function firingKeys(tx: Tx, prefix: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT alert_key FROM alert_state
    WHERE starts_with(alert_key, ${prefix}::text) AND state <> 'ok'
    ORDER BY alert_key
  `)) as unknown as { alert_key: string }[];
  return rows.map((r) => r.alert_key);
}

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
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
    return true;
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
        `M0b pre-existing problem rows neutralised in the tx (${preexisting.unmapped_total} unmapped, ${preexisting.conflict_total} conflicting) → counts 0, newest ids null`,
        before.unmapped_total === 0 &&
          before.conflict_total === 0 &&
          before.unmapped_newest_id === null &&
          before.conflict_newest_id === null,
        JSON.stringify(before),
      );
      if (before.unmapped_total !== 0 || before.conflict_total !== 0) throw new Rollback();

      for (const key of [...Object.values(K), INGEST_HEARTBEAT_ALERT_KEY]) {
        await clearAlert(tx, { alertKey: key });
      }
      await tx.execute(sql`
        UPDATE alert_state SET state = 'ok'
        WHERE starts_with(alert_key, ${P.unmapped}::text) OR starts_with(alert_key, ${P.typeConflicts}::text)
      `);
      // Decoys that an unescaped LIKE would match (`_` is a LIKE wildcard): a
      // prefix clear must leave them firing.
      const decoys = ["conversionXevents:unmapped:1", "conversion_events:typeXconflicts:1"];
      for (const key of decoys) {
        await tx.execute(sql`
          INSERT INTO alert_state (alert_key, state, since, last_notified_at)
          VALUES (${key}, 'firing', now(), now())
          ON CONFLICT (alert_key) DO UPDATE SET state = 'firing'
        `);
      }

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
      const unmKey = (name: string) => ledgerAlertKey(P.unmapped, rowId(name));
      const confKey = (name: string) => ledgerAlertKey(P.typeConflicts, rowId(name));
      const unmappedRow = (name: string) => ({
        keitaro_event_id: id(name),
        org_id: org.id,
        keitaro_status: "trash",
        keitaro_type: "trash",
        occurred_at: new Date("2026-09-16T12:00:00Z"),
      });

      await insertRows([
        // unmapped via NULL event type (and NULL status); no CamMan offer, Keitaro offer 41
        { ...unmappedRow("unm-new"), keitaro_offer_id: 41 },
        // unmapped via NULL status only (event type set); created 3 days ago
        {
          keitaro_event_id: id("unm-old"),
          org_id: org.id,
          keitaro_status: "deposit",
          keitaro_type: "deposit",
          offer_id: offer.id,
          event_type_id: registration,
          status: null,
          occurred_at: new Date("2026-09-10T12:00:00Z"),
          created_at: sql`now() - interval '3 days'`,
        },
        // type conflict: locked registration, Keitaro type now maps to purchase
        {
          keitaro_event_id: id("conflict"),
          org_id: org.id,
          keitaro_status: "sale",
          keitaro_type: "sale",
          offer_id: offer.id,
          event_type_id: registration,
          status: "approved",
          conflicting_event_type_id: purchase,
          event_type_conflict_at: new Date("2026-09-17T14:00:00Z"),
          occurred_at: new Date("2026-09-15T12:00:00Z"),
        },
        // fully mapped — must not be counted anywhere
        {
          keitaro_event_id: id("clean"),
          org_id: org.id,
          keitaro_status: "sale",
          keitaro_type: "sale",
          offer_id: offer.id,
          event_type_id: purchase,
          status: "approved",
          occurred_at: new Date("2026-09-15T12:00:00Z"),
        },
      ]);

      const h = await readLedgerHealth(tx);
      check("M1 unmapped = event type NULL OR status NULL (both arms); mapped rows excluded", h.unmapped_total === 2, JSON.stringify(h));
      check("M2 last-24h unmapped count is by created_at", h.unmapped_last_24h === 1, JSON.stringify(h));
      const [s1, s2] = h.unmapped_samples;
      check(
        "M3 unmapped samples newest first; Keitaro offer id when no CamMan offer",
        h.unmapped_samples.length === 2 &&
          s1.keitaro_event_id === id("unm-new") &&
          s1.offer_name === null &&
          s1.keitaro_offer_id === 41 &&
          s1.keitaro_type === "trash",
        JSON.stringify(h.unmapped_samples),
      );
      check(
        "M4 unmapped sample carries the CamMan offer name when attributed",
        s2?.keitaro_event_id === id("unm-old") && s2.offer_name === offer.name && s2.keitaro_type === "deposit",
        JSON.stringify(s2),
      );
      const [c1] = h.conflict_samples;
      check(
        "M5 conflicts: count, locked + conflicting event keys, Keitaro type, since as UTC ISO",
        h.conflict_total === 1 &&
          c1?.keitaro_event_id === id("conflict") &&
          c1.locked_event_key === "registration" &&
          c1.conflicting_event_key === "purchase" &&
          c1.keitaro_type === "sale" &&
          c1.since === "2026-09-17T14:00:00Z",
        JSON.stringify(h.conflict_samples),
      );
      check(
        "M6 the unmapped count (with max(id)) is answerable from conversion_events_unmapped_idx",
        await usesIndex(tx, UNMAPPED_COUNT_SQL, "conversion_events_unmapped_idx"),
      );
      check(
        "M7 the conflict count (with max(id)) is answerable from conversion_events_type_conflict_idx",
        await usesIndex(tx, CONFLICT_COUNT_SQL, "conversion_events_type_conflict_idx"),
      );
      check(
        "M8 newest problem row ids are max(id), not the newest created_at (unm-old was created 3 days earlier but inserted later)",
        h.unmapped_newest_id === rowId("unm-old") &&
          rowId("unm-old") > rowId("unm-new") &&
          h.conflict_newest_id === rowId("conflict"),
        JSON.stringify({ h_unm: h.unmapped_newest_id, h_conf: h.conflict_newest_id, ids: [...rowIds] }),
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
      // The ingest heartbeat (last COMPLETE ingest) that the fetch_failed debounce reads.
      const setLastSuccess = (watermark: SQL) =>
        tx.execute(sql`
          INSERT INTO cron_locks (job_name, watermark)
          VALUES (${HEARTBEAT_JOBS.conversionEventsIngest.job_name}, ${watermark})
          ON CONFLICT (job_name) DO UPDATE SET watermark = excluded.watermark
        `);
      const heal = (names: string[]) =>
        tx
          .update(conversion_events)
          .set({ event_type_id: purchase, status: "approved", conflicting_event_type_id: null, event_type_conflict_at: null })
          .where(inArray(conversion_events.keitaro_event_id, names.map(id)));

      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "A1 first tick with a standing unmapped + conflict condition → exactly two pages",
        sent.length === 2 && sent[0].includes("have no event-type mapping") && sent[1].includes("locked registration"),
        JSON.stringify(sent),
      );
      const [aUnm, aConf, aFetch, aInv, aOrg] = [
        await alertRow(tx, unmKey("unm-old")),
        await alertRow(tx, confKey("conflict")),
        await alertRow(tx, K.fetchFailed),
        await alertRow(tx, K.invalidRows),
        await alertRow(tx, K.orgMismatch),
      ];
      check(
        "A2 alert_state: unmapped:<newest unmapped id> + type_conflicts:<newest conflict id> firing and delivered (the only firing keys under their prefixes), fetch_failed + invalid_rows + org_mismatch ok, all org-less",
        aUnm?.state === "firing" &&
          aUnm.notified &&
          aConf?.state === "firing" &&
          aConf.notified &&
          aFetch?.state === "ok" &&
          aInv?.state === "ok" &&
          aOrg?.state === "ok" &&
          [aUnm, aConf, aFetch, aInv, aOrg].every((r) => r?.global === true) &&
          JSON.stringify(await firingKeys(tx, P.unmapped)) === JSON.stringify([unmKey("unm-old")]) &&
          JSON.stringify(await firingKeys(tx, P.typeConflicts)) === JSON.stringify([confKey("conflict")]),
        JSON.stringify({ aUnm, aConf, aFetch, aInv, aOrg }),
      );

      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "A3 next tick, same newest rows → no second page (latched on the same keys)",
        sent.length === 2 &&
          JSON.stringify(await firingKeys(tx, P.unmapped)) === JSON.stringify([unmKey("unm-old")]),
        `${sent.length} sent`,
      );

      // A NEW problem row pages again and supersedes the older key.
      await insertRows([unmappedRow("unm-2")]);
      await evaluateConversionAlerts(tx, ok, { send });
      await evaluateConversionAlerts(tx, ok, { send });
      const superseded = await alertRow(tx, unmKey("unm-old"));
      check(
        "S1 a newer unmapped row (older one still unfixed) → pages once over two ticks on unmapped:<new id>; the old key → ok, exactly as clearAlert leaves a row (last_notified_at kept, org-less)",
        sent.length === 3 &&
          sent[2].includes("3 conversion(s) have no event-type mapping") &&
          sent[2].includes(id("unm-2")) &&
          JSON.stringify(await firingKeys(tx, P.unmapped)) === JSON.stringify([unmKey("unm-2")]) &&
          (await alertRow(tx, unmKey("unm-2")))?.notified === true &&
          superseded?.state === "ok" &&
          superseded.notified &&
          superseded.global,
        JSON.stringify({ sent: sent.slice(2), superseded, firing: await firingKeys(tx, P.unmapped) }),
      );

      await heal(["unm-2"]);
      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "S2 the newest unmapped row fixed, older ones remain → no page; unmapped:<unm-2> stays firing and the superseded unmapped:<unm-old> does not re-fire",
        sent.length === 3 &&
          JSON.stringify(await firingKeys(tx, P.unmapped)) === JSON.stringify([unmKey("unm-2")]) &&
          (await alertRow(tx, unmKey("unm-old")))?.state === "ok",
        JSON.stringify({ sent: sent.length, firing: await firingKeys(tx, P.unmapped) }),
      );

      await insertRows([
        {
          keitaro_event_id: id("conflict-2"),
          org_id: org.id,
          keitaro_status: "sale",
          keitaro_type: "sale",
          offer_id: offer.id,
          event_type_id: registration,
          status: "approved",
          conflicting_event_type_id: purchase,
          event_type_conflict_at: new Date("2026-09-17T15:00:00Z"),
          occurred_at: new Date("2026-09-16T12:00:00Z"),
        },
      ]);
      await evaluateConversionAlerts(tx, ok, { send });
      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "S3 type_conflicts: a newer conflicting row → pages once over two ticks on type_conflicts:<new id>; the old key → ok",
        sent.length === 4 &&
          sent[3].includes("2 conversion(s) changed Keitaro type") &&
          sent[3].includes(id("conflict-2")) &&
          JSON.stringify(await firingKeys(tx, P.typeConflicts)) === JSON.stringify([confKey("conflict-2")]) &&
          (await alertRow(tx, confKey("conflict")))?.state === "ok",
        JSON.stringify({ sent: sent.slice(3), firing: await firingKeys(tx, P.typeConflicts) }),
      );

      await heal(["conflict-2"]);
      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "S4 type_conflicts: the newest conflict fixed, the older one remains → no page, no step back to the superseded key",
        sent.length === 4 &&
          JSON.stringify(await firingKeys(tx, P.typeConflicts)) === JSON.stringify([confKey("conflict-2")]) &&
          (await alertRow(tx, confKey("conflict")))?.state === "ok",
        JSON.stringify({ sent: sent.length, firing: await firingKeys(tx, P.typeConflicts) }),
      );

      // A leftover second firing key under the prefix (e.g. a swallowed clear):
      // count 0 must clear it too.
      const leftover = ledgerAlertKey(P.unmapped, 1);
      await tx.execute(sql`
        INSERT INTO alert_state (alert_key, state, since, last_notified_at)
        VALUES (${leftover}, 'firing', now(), now())
        ON CONFLICT (alert_key) DO UPDATE SET state = 'firing'
      `);
      await heal(["unm-new", "unm-old", "conflict"]);
      await evaluateConversionAlerts(tx, ok, { send });
      const decoyStates = await Promise.all(decoys.map((k) => alertRow(tx, k)));
      check(
        "A4 rows healed + conflicts resolved → every key under both prefixes cleared (incl. a leftover second key), no page; LIKE-wildcard decoys untouched",
        sent.length === 4 &&
          (await firingKeys(tx, P.unmapped)).length === 0 &&
          (await firingKeys(tx, P.typeConflicts)).length === 0 &&
          (await alertRow(tx, leftover))?.state === "ok" &&
          (await alertRow(tx, unmKey("unm-2")))?.state === "ok" &&
          (await alertRow(tx, confKey("conflict-2")))?.state === "ok" &&
          decoyStates.every((r) => r?.state === "firing"),
        JSON.stringify({ sent: sent.length, decoyStates }),
      );

      await tx
        .update(conversion_events)
        .set({ status: null })
        .where(inArray(conversion_events.keitaro_event_id, [id("clean")]));
      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "A5 a new unmapped row after the clear → pages again (re-armed) on unmapped:<its id>, though that id is below the cleared keys",
        sent.length === 5 &&
          sent[4].includes("1 conversion(s) have no event-type mapping (1 new in the last 24h)") &&
          rowId("clean") < rowId("unm-2") &&
          JSON.stringify(await firingKeys(tx, P.unmapped)) === JSON.stringify([unmKey("clean")]),
        JSON.stringify(sent[4]),
      );

      // fetch_failed: debounced on the last COMPLETE ingest (the heartbeat), and
      // a throw is a failed tick exactly like a refused window.
      await setLastSuccess(sql`now() - interval '5 minutes'`);
      await evaluateConversionAlerts(tx, refused, { send });
      check(
        "A6 refused window, last complete ingest 5 min ago → debounced: no page, fetch_failed untouched (ok)",
        sent.length === 5 && (await alertRow(tx, K.fetchFailed))?.state === "ok",
        `${sent.length} sent`,
      );
      await setLastSuccess(sql`now() - interval '20 minutes'`);
      await evaluateConversionAlerts(tx, refused, { send });
      check(
        "A7 refused window, last complete ingest 20 min ago → fetch_failed pages with the error",
        sent.length === 6 && sent[5].includes("truncated: 1000 of 1200 rows"),
        JSON.stringify(sent[5]),
      );
      await evaluateConversionAlerts(tx, refused, { send });
      check("A8 still refused and stale → no second page (latched)", sent.length === 6, `${sent.length} sent`);

      // A failed tick must still re-read the ledger (design decision 3).
      await insertRows([unmappedRow("unm-3")]);
      await evaluateConversionAlerts(tx, refused, { send });
      check(
        "A8b a failed tick still re-reads the ledger: a new unmapped row → the refused tick pages it on unmapped:<new id> (old key ok), and fetch_failed does not page twice",
        sent.length === 7 &&
          sent[6].includes("2 conversion(s) have no event-type mapping") &&
          sent[6].includes(id("unm-3")) &&
          JSON.stringify(await firingKeys(tx, P.unmapped)) === JSON.stringify([unmKey("unm-3")]) &&
          (await alertRow(tx, unmKey("clean")))?.state === "ok" &&
          (await alertRow(tx, K.fetchFailed))?.state === "firing",
        JSON.stringify({ sent: sent.slice(6), firing: await firingKeys(tx, P.unmapped) }),
      );

      await setLastSuccess(sql`now() - interval '5 minutes'`);
      await evaluateConversionAlerts(tx, refused, { send });
      check(
        "A9 a debounced failure never clears: fresh heartbeat + refused → no page, fetch_failed still firing",
        sent.length === 7 && (await alertRow(tx, K.fetchFailed))?.state === "firing",
        `${sent.length} sent`,
      );
      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "A10 complete window → fetch_failed cleared, no page",
        sent.length === 7 && (await alertRow(tx, K.fetchFailed))?.state === "ok",
        `${sent.length} sent`,
      );
      await setLastSuccess(sql`NULL::timestamptz`);
      await evaluateConversionAlerts(tx, threw, { send });
      check(
        "A11 an ingest that THREW, no complete ingest ever recorded → fetch_failed pages again with the thrown message",
        sent.length === 8 &&
          sent[7].includes("connect ECONNREFUSED 10.0.0.1:6543") &&
          sent[7].includes("never recorded"),
        JSON.stringify(sent[7]),
      );

      await evaluateConversionAlerts(tx, invalid, { send });
      check(
        "A12 unparseable rows → invalid_rows pages with the count and a sample (and the complete window clears fetch_failed silently)",
        sent.length === 9 &&
          sent[8].includes("2 Keitaro conversion row(s)") &&
          sent[8].includes("event_id=bad") &&
          (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(sent[8]),
      );
      await evaluateConversionAlerts(tx, invalid, { send });
      check("A13 still unparseable → no second page", sent.length === 9, `${sent.length} sent`);
      await evaluateConversionAlerts(tx, ok, { send });
      check(
        "A14 clean complete window → invalid_rows cleared, no page",
        sent.length === 9 && (await alertRow(tx, K.invalidRows))?.state === "ok",
        `${sent.length} sent`,
      );

      await setLastSuccess(sql`now() - interval '3 hours'`);
      const stale = await watchIngestHeartbeat(tx, { send });
      check(
        "B1 stale ingest heartbeat → one page naming the job",
        stale.stale && sent.length === 10 && sent[9].includes("Conversion events ingest (Keitaro poll tick)"),
        JSON.stringify({ stale, text: sent[9] }),
      );
      await watchIngestHeartbeat(tx, { send });
      check("B2 still stale → no second page", sent.length === 10, `${sent.length} sent`);
      await recordHeartbeat(tx, HEARTBEAT_JOBS.conversionEventsIngest.job_name);
      const fresh = await watchIngestHeartbeat(tx, { send });
      check(
        "B3 fresh heartbeat → cleared, no page",
        !fresh.stale && sent.length === 10 && (await alertRow(tx, INGEST_HEARTBEAT_ALERT_KEY))?.state === "ok",
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
    "Z1 rolled back — no test rows left, pre-existing unmapped/conflict counts unchanged",
    left.n === 0 &&
      after.unmapped_total === preexisting.unmapped_total &&
      after.conflict_total === preexisting.conflict_total,
    JSON.stringify({ left: left.n, before: [preexisting.unmapped_total, preexisting.conflict_total], after: [after.unmapped_total, after.conflict_total] }),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
