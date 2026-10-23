import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Carrier-rejection ledger (migration 0225) against a throwaway org on the
// PREVIEW DB. Each receipt is received one minute after its message was sent,
// as in production; each scenario uses its own phone. Expected outcomes are
// HAND-DERIVED from the fixture below. Torn down by org_id with a post-teardown
// count of 0. Resets the carrier-rejections cron_locks rows (preview only).
//
// Covers: one outcome per message (txr poll + webhook = 1), webhook code only
// in raw_body, hard threshold, soft window (inside / outside), delivered reset
// (before / after), delivered-wins on one message, Ahoi status 'error' with
// case/trim matching, Ahoi ignored reasons, Tells hard reasons, ignored txr
// codes, a non-'sent' send, org thresholds + recompute, idempotent re-ingest,
// the refusals before a full rebuild, a RESUMED full rebuild, stale-row
// removal by the full and the daily trailing rebuild, and the incremental pass.
//
// Run: npx tsx --conditions=react-server scripts/test-carrier-rejection-ledger-db.ts

import { sql } from "drizzle-orm";

const MARKER = "__CARRIER_REJECTION_TEST__";
const WIN_FROM = new Date(Date.now() - 60 * 86_400_000).toISOString();
const WIN_TO = new Date().toISOString();

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const L = await import("@/lib/carrier-rejection/ledger");

  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };
  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const tsq = (s: string) => sql`${s}::timestamptz`;

  const tag = `cr-${Date.now()}`;
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const campaignId = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, link_mode, status)
      VALUES (${orgId}::uuid, ${`camp-${tag}`}, 'Carrier rejection', 'tracked', 'active') RETURNING id`)).id;
    const stageId = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id)
      VALUES (${orgId}::uuid, ${campaignId}, 1, ${`trk-${tag}`}) RETURNING id`)).id;

    const contacts = new Map<string, string>();
    const send = async (phone: string, sentAt: string, status: "sent" | "failed" = "sent") => {
      if (!contacts.has(phone)) {
        contacts.set(phone, (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone}) RETURNING id`)).id);
      }
      return (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${contacts.get(phone)}::uuid, ${phone}, 'x', ${status},
                ${sentAt}::timestamptz) RETURNING id`)).id;
    };
    const txrPoll = (ss: string, status: string, code: string | null) => db.execute(sql`
      INSERT INTO textrequest_dlr_events (org_id, method, status, error_code, matched_stage_send_id, received_at)
      VALUES (${orgId}::uuid, 'poll', ${status}, ${code}, ${ss}::uuid, (SELECT sent_at + interval '1 minute' FROM stage_sends WHERE id = ${ss}::uuid))`);
    const txrHook = (ss: string, status: string, code: string | null) => db.execute(sql`
      INSERT INTO textrequest_dlr_events (org_id, method, status, error_code, raw_body, stage_send_id, received_at)
      VALUES (${orgId}::uuid, 'POST', ${status}, NULL,
              ${JSON.stringify({ message_id: "m", status, ...(code ? { error_code: code } : {}) })},
              ${ss}::uuid, (SELECT sent_at + interval '1 minute' FROM stage_sends WHERE id = ${ss}::uuid))`);
    const ahoi = (ss: string, status: string, error: string) => db.execute(sql`
      INSERT INTO ahoi_dlr_events (org_id, method, status, send_status, error, matched_stage_send_id, received_at)
      VALUES (${orgId}::uuid, 'POST', ${status}, ${status}, ${error}, ${ss}::uuid, (SELECT sent_at + interval '1 minute' FROM stage_sends WHERE id = ${ss}::uuid))`);
    const tells = (ss: string, status: string, msg: string | null) => db.execute(sql`
      INSERT INTO tells_webhook_events (org_id, kind, method, status, error_message, matched_stage_send_id, received_at)
      VALUES (${orgId}::uuid, 'dlr', 'POST', ${status}, ${msg}, ${ss}::uuid, (SELECT sent_at + interval '1 minute' FROM stage_sends WHERE id = ${ss}::uuid))`);

    // ── fixture: one phone per scenario ───────────────────────────────────────
    const P = (n: number) => `+1555027${String(n).padStart(4, "0")}`;
    // A: 2 hard messages, each reported by poll (30005) AND webhook (2001) → 2, flagged
    for (const d of [20, 10]) { const s = await send(P(1), daysAgo(d)); await txrPoll(s, "undelivered", "30005"); await txrHook(s, "undelivered", "2001"); }
    // B: ONE hard message, poll + webhook → 1, not flagged (4 events would be 2)
    { const s = await send(P(2), daysAgo(5)); await txrPoll(s, "undelivered", "30006"); await txrHook(s, "undelivered", "2003"); }
    // C: 3 soft, webhook only (code only in raw_body), inside 30 days → flagged
    for (const d of [3, 2, 1]) await txrHook(await send(P(3), daysAgo(d)), "undelivered", "1002");
    // D: 3 soft, 40+ days ago → outside the window, not flagged
    for (const d of [45, 44, 43]) await txrPoll(await send(P(4), daysAgo(d)), "undelivered", "30003");
    // E: 2 hard, THEN a delivered message → reset, not flagged
    for (const d of [9, 8]) await txrPoll(await send(P(5), daysAgo(d)), "undelivered", "30005");
    await txrPoll(await send(P(5), daysAgo(7)), "delivered", null);
    // F: delivered, THEN 2 hard → flagged
    await txrPoll(await send(P(6), daysAgo(9)), "delivered", null);
    for (const d of [8, 7]) await txrPoll(await send(P(6), daysAgo(d)), "undelivered", "30006");
    // G: one message with BOTH receipts (delivered wins) + one hard → 1, not flagged
    { const s = await send(P(7), daysAgo(6)); await txrPoll(s, "undelivered", "30005"); await txrHook(s, "delivered", null); }
    await txrPoll(await send(P(7), daysAgo(5)), "undelivered", "30005");
    // H: Ahoi status 'error', reason with odd case/space → 2 hard, flagged
    for (const d of [4, 3]) await ahoi(await send(P(8), daysAgo(d)), "error", "  invalid DESTINATION address ");
    // H2: Ahoi ignored reason ×3 → not flagged
    for (const d of [4, 3, 2]) await ahoi(await send(P(9), daysAgo(d)), "error", "Invalid client network");
    // I: Tells, two different hard reasons → flagged
    await tells(await send(P(10), daysAgo(4)), "undelivered", "Landline or unreachable carrier detected.");
    await tells(await send(P(10), daysAgo(3)), "undelivered", "Unknown or invalid destination number.");
    // J: txr 30008 ×3 → ignored
    for (const d of [3, 2, 1]) await txrPoll(await send(P(11), daysAgo(d)), "undelivered", "30008");
    // K: 2 hard on sends that are not status 'sent' → excluded
    for (const d of [3, 2]) await txrPoll(await send(P(12), daysAgo(d), "failed"), "undelivered", "30005");

    const expected = new Set([P(1), P(3), P(6), P(8), P(10)]);
    const flaggedNow = async () =>
      (await db.execute(sql`SELECT phone, hard_count, soft_count, last_code, last_provider
        FROM carrier_rejected_phones WHERE org_id = ${orgId}::uuid ORDER BY phone`)) as unknown as
        { phone: string; hard_count: number; soft_count: number; last_code: string; last_provider: string }[];
    const sameSet = (rows: { phone: string }[]) =>
      rows.length === expected.size && rows.every((r) => expected.has(r.phone));

    // ── incremental-style ingest + refresh, scoped to this org ───────────────
    console.log("INGEST + REFRESH");
    await L.ingestWindow(db, tsq(WIN_FROM), tsq(WIN_TO), { rejections: L.NEVER, delivery: L.NEVER });
    const r1 = await L.refreshFlaggedPhones(db, orgId);
    const rows = await flaggedNow();
    bar("flagged set = A, C, F, H, I", sameSet(rows), rows.map((r) => r.phone).join(","));
    const byPhone = new Map(rows.map((r) => [r.phone, r]));
    bar("A counts ONE rejection per message (2, not 4)", byPhone.get(P(1))?.hard_count === 2, JSON.stringify(byPhone.get(P(1))));
    bar("A last code is the canonical poll code", byPhone.get(P(1))?.last_code === "30005" && byPhone.get(P(1))?.last_provider === "txr");
    bar("C soft read from raw_body, 3 in window", byPhone.get(P(3))?.soft_count === 3 && byPhone.get(P(3))?.last_code === "30003");
    bar("H Ahoi reason stored in listed casing", byPhone.get(P(8))?.last_code === "Invalid destination address");
    bar("refresh reports added = 5", r1.added === 5 && r1.flagged === 5, JSON.stringify(r1));
    const ledger = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM carrier_rejections WHERE org_id = ${orgId}::uuid`);
    // A2 + B1 + C3 + D3 + E2 + F2 + G1(only the undelivered-only msg) + H2 + I2 = 18
    bar("ledger holds 18 rejected messages (G's delivered msg, H2/J ignored, K not sent)", ledger.n === 18, String(ledger.n));
    const dlv = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM carrier_phone_delivery WHERE org_id = ${orgId}::uuid`);
    bar("delivery marker for E, F, G", dlv.n === 3, String(dlv.n));

    console.log("IDEMPOTENT");
    await L.ingestWindow(db, tsq(WIN_FROM), tsq(WIN_TO), { rejections: L.NEVER, delivery: L.NEVER });
    const r2 = await L.refreshFlaggedPhones(db, orgId);
    const ledger2 = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM carrier_rejections WHERE org_id = ${orgId}::uuid`);
    bar("re-ingest changes nothing", ledger2.n === 18 && r2.added === 0 && r2.removed === 0 && r2.flagged === 5, JSON.stringify(r2));

    console.log("THRESHOLDS");
    await db.execute(sql`INSERT INTO org_settings (org_id, carrier_rejection_hard_threshold) VALUES (${orgId}::uuid, 3)
      ON CONFLICT (org_id) DO UPDATE SET carrier_rejection_hard_threshold = 3`);
    const r3 = await L.refreshFlaggedPhones(db, orgId);
    const t3 = await flaggedNow();
    bar("hard threshold 3 ⇒ only C (soft) remains", t3.length === 1 && t3[0].phone === P(3) && r3.removed === 4, JSON.stringify(r3));
    await db.execute(sql`UPDATE org_settings SET carrier_rejection_hard_threshold = 2, carrier_rejection_soft_window_days = 60
      WHERE org_id = ${orgId}::uuid`);
    await L.refreshFlaggedPhones(db, orgId);
    const t4 = await flaggedNow();
    bar("soft window 60 days ⇒ D joins", t4.length === 6 && t4.some((r) => r.phone === P(4)), t4.map((r) => r.phone).join(","));
    await db.execute(sql`UPDATE org_settings SET carrier_rejection_soft_window_days = 30 WHERE org_id = ${orgId}::uuid`);
    bar("toggle stays OFF by default", (await one<{ on: boolean }>(sql`
      SELECT carrier_rejection_suppression_enabled AS on FROM org_settings WHERE org_id = ${orgId}::uuid`)).on === false);
    const oo = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE org_id = ${orgId}::uuid`);
    bar("no opt_outs written", oo.n === 0);

    console.log("REBUILDS + INCREMENTAL (whole preview DB)");
    await db.execute(sql`DELETE FROM cron_locks WHERE job_name LIKE 'carrier-rejections:%'`);
    const inc0 = await L.runIncremental(db);
    bar("incremental refuses before any full rebuild", !inc0.ran && inc0.reason === "awaiting_rebuild", JSON.stringify(inc0));
    const tr0 = await L.runTrailingRebuild(db);
    bar("daily rebuild refuses before any full rebuild", !tr0.ran && tr0.reason === "awaiting_full_rebuild", JSON.stringify(tr0));

    // A row the receipts no longer support (as after a code-map change): H2's
    // ignored Ahoi message, planted as hard with an old refreshed_at.
    const plant = () => db.execute(sql`
      INSERT INTO carrier_rejections (stage_send_id, org_id, phone, provider, severity, code, sent_at, refreshed_at)
      SELECT ss.id, ss.org_id, ss.phone, 'ahi', 'hard', 'planted', ss.sent_at, '2020-01-01'
      FROM stage_sends ss WHERE ss.org_id = ${orgId}::uuid AND ss.phone = ${P(9)} LIMIT 1`);
    const plantedLeft = async () =>
      (await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM carrier_rejections WHERE org_id = ${orgId}::uuid AND code = 'planted'`)).n;
    await plant();

    // Budget 0 ⇒ exactly one chunk per call; the cursor must persist between calls.
    const f1 = await L.runFullRebuild(db, { budgetMs: 0 });
    const f2 = await L.runFullRebuild(db, { budgetMs: 0 });
    bar("full rebuild stops at its budget after one chunk and RESUMES",
      !f1.complete && !f2.complete && f1.chunks === 1 && f2.chunks === 1 && f2.cursor > f1.cursor && f1.run_start === f2.run_start,
      JSON.stringify({ f1, f2 }));
    bar("…and keeps the previous ledger while incomplete", (await plantedLeft()) === 1);
    const inc1 = await L.runIncremental(db);
    bar("…and the incremental still refuses mid-way", !inc1.ran);
    const f3 = await L.runFullRebuild(db, { budgetMs: 600_000 });
    bar("full rebuild completes on a later call", f3.complete, JSON.stringify(f3));
    bar("full rebuild deletes a ledger row the receipts no longer support",
      (await plantedLeft()) === 0 && f3.complete && f3.stale_rejections_removed >= 1);
    bar("full rebuild reproduces the same flagged set", sameSet(await flaggedNow()));
    const st = await one<{ n: number; wm: string | null }>(sql`
      SELECT count(*) FILTER (WHERE job_name LIKE 'carrier-rejections:full-%')::int AS n,
             max(watermark) FILTER (WHERE job_name = 'carrier-rejections:watermark')::text AS wm
      FROM cron_locks WHERE job_name LIKE 'carrier-rejections:%'`);
    bar("…sets the watermark and clears its resume state", st.wm != null && st.n === 0, JSON.stringify(st));

    await plant(); // H2's messages were sent 2–4 days ago: inside the 14-day window
    const tr = await L.runTrailingRebuild(db);
    bar("daily rebuild deletes a stale row for a message inside its window",
      tr.ran && (await plantedLeft()) === 0 && tr.stale_rejections_removed >= 1, JSON.stringify(tr));
    bar("…and keeps the flagged set (D's 40-day-old rows untouched)", sameSet(await flaggedNow()));
    const dOld = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM carrier_rejections WHERE org_id = ${orgId}::uuid AND phone = ${P(4)}`);
    bar("rows for messages older than the window are not deleted", dOld.n === 3, String(dOld.n));
    const e = await one<{ ld: string }>(sql`SELECT last_delivered_sent_at::text AS ld FROM carrier_phone_delivery WHERE org_id = ${orgId}::uuid AND phone = ${P(5)}`);
    bar("delivery marker kept (E's delivered message, 7 days ago)", e?.ld != null, String(e?.ld));

    const inc = await L.runIncremental(db);
    bar("incremental runs after the full rebuild", inc.ran === true, JSON.stringify(inc));
    bar("…and keeps the set", sameSet(await flaggedNow()));
  } finally {
    if (orgId) {
      const name = ((await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the test marker`);
        process.exitCode = 1;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const org = sql`NULLIF(${orgId}, '')::uuid`;
    const left = await one<{ orgs: number; rows: number }>(sql`
      SELECT (SELECT count(*) FROM organizations WHERE name LIKE ${`%${MARKER} ${tag}%`})::int AS orgs,
             ((SELECT count(*) FROM carrier_rejections      WHERE org_id = ${org})
            + (SELECT count(*) FROM carrier_phone_delivery  WHERE org_id = ${org})
            + (SELECT count(*) FROM carrier_rejected_phones WHERE org_id = ${org})
            + (SELECT count(*) FROM stage_sends             WHERE org_id = ${org})
            + (SELECT count(*) FROM textrequest_dlr_events  WHERE org_id = ${org})
            + (SELECT count(*) FROM tells_webhook_events    WHERE org_id = ${org})
            + (SELECT count(*) FROM ahoi_dlr_events         WHERE org_id = ${org})
            + (SELECT count(*) FROM contacts                WHERE org_id = ${org}))::int AS rows`);
    console.log(`\nTeardown: ${left.orgs} org(s), ${left.rows} row(s) left for this run`);
    if (left.orgs !== 0 || left.rows !== 0) process.exitCode = 1;
    console.log(fail === 0 && !process.exitCode ? "ALL GREEN" : `${fail} FAILED`);
    process.exit(fail === 0 ? (process.exitCode ?? 0) : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
