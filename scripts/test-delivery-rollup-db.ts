import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// stage_delivery_rollup (migration 0186) against a throwaway world on the
// PREVIEW DB. Committed fixtures in a closed past window (2026-04-14..15 ET),
// torn down by org_id with a post-teardown count of 0.
//
// The expected cells are HAND-DERIVED from the fixture below — not read off the
// live query — so a defect shared by the live query and the rollup (they share
// terminalCte + DELIVERY_COUNTS) still turns a bar red. The live query is then
// compared as a SECOND, independent check.
//
// Covers: txr callback+poll dedup, delivered-wins, lower() on mixed case, the
// tls non-terminal 'sent' and kind='inbound' exclusions, a receipt landing
// BEFORE its send and before the window opens (the 1-hour margin), a stage
// straddling ET midnight (the day key), a NULL-number send, a failed send,
// skip-unchanged, range isolation, a late receipt, a vanished cell, and the
// foots CHECK. Plus the pure tier logic (rollupScope / reconcileRange).
//
// Run: npx tsx scripts/test-delivery-rollup-db.ts

import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

const MARKER = "__DELIVERY_ROLLUP_TEST__";
const D0 = "2026-04-13";
const D1 = "2026-04-14";
const D2 = "2026-04-15";

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { CAMPAIGN_TIMEZONE } = await import("@/lib/campaign-timezone");
  const { queryDeliveryByStage } = await import("@/lib/reporting/delivery");
  const R = await import("@/lib/reporting/delivery-rollup");

  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const reg = (await db.execute(sql`SELECT to_regclass('public.stage_delivery_rollup') IS NOT NULL AS ok`)) as unknown as { ok: boolean }[];
  if (!reg[0]?.ok) {
    console.error("stage_delivery_rollup does not exist on this DB — migration 0186 is not applied here yet.");
    process.exit(1);
  }

  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };
  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const et = (day: string, hhmmss: string) => fromZonedTime(`${day}T${hhmmss}`, CAMPAIGN_TIMEZONE);
  const iso = (d: Date) => d.toISOString();

  // ── pure tier logic ────────────────────────────────────────────────────────
  console.log("PURE — rollupScope / reconcileRange");
  const now = new Date("2026-09-22T15:00:00Z"); // 11:00 ET
  const never = R.rollupScope(now, null);
  bar("P1 no settle yet ⇒ 7-day settle window", never.settle && never.range.from === "2026-09-16" && never.range.to === "2026-09-22", JSON.stringify(never));
  const recent = R.rollupScope(now, new Date(now.getTime() - 3_600_000));
  bar("P2 settled 1h ago ⇒ TODAY only (fresh tier narrowed 2026-09-23)",
    !recent.settle && recent.range.from === "2026-09-22" && recent.range.to === "2026-09-22", JSON.stringify(recent));
  const due = R.rollupScope(now, new Date(now.getTime() - 3 * 3_600_000));
  bar("P3 settled exactly 3h ago ⇒ settle again", due.settle && due.range.from === "2026-09-16", JSON.stringify(due));
  const rec = R.reconcileRange(now);
  bar("P4 reconcile = the 7 frozen days ending 7 days ago", rec.from === "2026-09-09" && rec.to === "2026-09-15", JSON.stringify(rec));
  const lateEt = R.rollupScope(new Date("2026-09-23T03:30:00Z"), null); // 23:30 ET on 09-22
  bar("P5 'today' is the ET day, not the UTC day", lateEt.range.to === "2026-09-22", JSON.stringify(lateEt));
  const bad = R.rollupScope(now, new Date("not a date"));
  bar("P6 an unparseable settle stamp settles (never silently stops)", bad.settle, JSON.stringify(bad));

  // Freshness: what the Overview's "as of" and stale flag are computed from.
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  const f1 = R.deliveryFreshness({ from: "2026-09-22", to: "2026-09-22" }, min(5), min(170), now);
  bar("F1 today only ⇒ as of the 10-min refresh, not stale", !f1.final && !f1.stale && f1.as_of === min(5).toISOString(), JSON.stringify(f1));
  const f2 = R.deliveryFreshness({ from: "2026-09-16", to: "2026-09-22" }, min(5), min(170), now);
  bar("F2 7 days ⇒ as of the OLDER stamp (the settle)", !f2.stale && f2.as_of === min(170).toISOString(), JSON.stringify(f2));
  const f3 = R.deliveryFreshness({ from: "2026-09-22", to: "2026-09-22" }, min(45), min(10), now);
  bar("F3 10-min refresh 45 min old ⇒ stale", f3.stale, JSON.stringify(f3));
  const f4 = R.deliveryFreshness({ from: "2026-09-18", to: "2026-09-19" }, min(5), min(8 * 60), now);
  bar("F4 days 3–4 back depend on the settle only; 8 h old ⇒ stale", f4.stale && f4.as_of === min(8 * 60).toISOString(), JSON.stringify(f4));
  const f5 = R.deliveryFreshness({ from: "2026-09-01", to: "2026-09-15" }, null, null, now);
  bar("F5 window entirely past the horizon ⇒ final, never stale", f5.final && !f5.stale && f5.as_of === null, JSON.stringify(f5));
  const f6 = R.deliveryFreshness({ from: "2026-09-22", to: "2026-09-22" }, null, null, now);
  bar("F6 refresh never ran ⇒ stale, no as-of", f6.stale && f6.as_of === null && !f6.final, JSON.stringify(f6));
  // Since the fresh tier is today-only, YESTERDAY is the settle tier's job, so a
  // yesterday-only window must report the settle stamp — the honest older one.
  const f7 = R.deliveryFreshness({ from: "2026-09-21", to: "2026-09-21" }, min(5), min(170), now);
  bar("F7 yesterday-only ⇒ as of the SETTLE stamp, not the 10-min refresh",
    !f7.stale && f7.as_of === min(170).toISOString(), JSON.stringify(f7));
  const f8 = R.deliveryFreshness({ from: "2026-09-21", to: "2026-09-21" }, min(5), min(8 * 60), now);
  bar("F8 …and it goes stale on the SETTLE threshold (8 h > 7 h)", f8.stale, JSON.stringify(f8));

  const tag = `dr-${Date.now()}`;
  let orgId = "";
  try {
    // ── the world ─────────────────────────────────────────────────────────────
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const provider = (await one<{ id: number }>(sql`
      INSERT INTO sms_providers (org_id, sms_provider_id, name) VALUES (${orgId}::uuid, ${`t-${tag}`}, 'test') RETURNING id`)).id;
    const phone = async (n: string) =>
      (await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number) VALUES (${orgId}::uuid, ${provider}, ${n}) RETURNING id`)).id;
    const P1 = await phone("+15550100901");
    const P2 = await phone("+15550100902");
    const campaignId = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, link_mode, status)
      VALUES (${orgId}::uuid, ${`camp-${tag}`}, 'Delivery rollup', 'tracked', 'active') RETURNING id`)).id;
    const stage = async (n: number, sentAt: Date) =>
      (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}, ${n}, ${`trk-${tag}-s${n}`}, ${iso(sentAt)}::timestamptz) RETURNING id`)).id;
    const S0 = await stage(0, et(D1, "00:00:10"));
    const S1 = await stage(1, et(D1, "12:00:00"));
    const S2 = await stage(2, et(D1, "23:30:00"));
    const S3 = await stage(3, et(D2, "12:00:00"));

    let n = 0;
    const send = async (stageId: number, phoneId: number | null, at: Date, status: "sent" | "failed" = "sent") => {
      n++;
      const contact = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1555019${String(n).padStart(4, "0")}`}) RETURNING id`)).id;
      return (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at, provider_phone_id)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${contact}::uuid, '+15550000000', 'x', ${status},
                ${iso(at)}::timestamptz, ${phoneId}) RETURNING id`)).id;
    };
    const txr = (opts: { stageSendId?: string; matched?: string; status: string; at: Date; method?: string }) =>
      db.execute(sql`
        INSERT INTO textrequest_dlr_events (org_id, method, status, stage_send_id, matched_stage_send_id, received_at)
        VALUES (${orgId}::uuid, ${opts.method ?? "POST"}, ${opts.status},
                ${opts.stageSendId ?? null}::uuid, ${opts.matched ?? null}::uuid, ${iso(opts.at)}::timestamptz)`);
    const tls = (matched: string, kind: "dlr" | "inbound", status: string, at: Date) =>
      db.execute(sql`
        INSERT INTO tells_webhook_events (org_id, kind, method, status, matched_stage_send_id, received_at)
        VALUES (${orgId}::uuid, ${kind}, 'POST', ${status}, ${matched}::uuid, ${iso(at)}::timestamptz)`);
    const ahoi = (matched: string, status: string, at: Date) =>
      db.execute(sql`
        INSERT INTO ahoi_dlr_events (org_id, method, status, matched_stage_send_id, received_at)
        VALUES (${orgId}::uuid, 'POST', ${status}, ${matched}::uuid, ${iso(at)}::timestamptz)`);
    const later = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

    // S0 / P1 / D1 — a receipt that lands 20 s BEFORE its send, and before the
    // window opens: counted only because of the 1-hour early-arrival margin.
    const tG = et(D1, "00:00:10");
    const g = await send(S0, P1, tG);
    await txr({ stageSendId: g, status: "delivered", at: et(D0, "23:59:50") });

    // S1 / P1 / D1 — seven sent, one failed.
    const t1 = et(D1, "12:00:00");
    const a = await send(S1, P1, t1);
    await txr({ stageSendId: a, status: "delivered", at: later(t1, 5) }); // callback
    await txr({ matched: a, status: "Delivered", at: later(t1, 900), method: "poll" }); // poll — same message
    const b = await send(S1, P1, t1);
    await txr({ stageSendId: b, status: "undelivered", at: later(t1, 5) });
    await txr({ stageSendId: b, status: "delivered", at: later(t1, 60) }); // delivered wins
    const c = await send(S1, P1, t1);
    await txr({ stageSendId: c, status: "UNDELIVERED", at: later(t1, 5) }); // lower()
    const d = await send(S1, P1, t1);
    await tls(d, "dlr", "sent", later(t1, 5)); // non-terminal ⇒ no receipt
    const e = await send(S1, P1, t1);
    await tls(e, "inbound", "delivered", later(t1, 5)); // kind filter ⇒ no receipt
    const f = await send(S1, P1, t1);
    await ahoi(f, "Delivered", later(t1, 5)); // mixed case
    const h = await send(S1, P1, t1); // no receipt at all
    const i = await send(S1, P1, t1, "failed");
    await txr({ stageSendId: i, status: "delivered", at: later(t1, 5) }); // not a sent message

    // S2 / P2 — straddles ET midnight: one send on D1, two on D2.
    const k = await send(S2, P2, et(D1, "23:30:00"));
    await txr({ stageSendId: k, status: "delivered", at: et(D1, "23:30:10") });
    const l = await send(S2, P2, et(D2, "00:30:00"));
    await txr({ stageSendId: l, status: "undelivered", at: et(D2, "02:00:00") });
    await send(S2, P2, et(D2, "00:40:00")); // m — no receipt

    // S3 / no number / D2
    const j = await send(S3, null, et(D2, "12:00:00"));
    await txr({ stageSendId: j, status: "delivered", at: et(D2, "12:00:05") });

    type Row = { stage_id: number; provider_phone_id: number | null; sent: number; delivered: number; undelivered: number; no_receipt: number };
    const row = (stage_id: number, provider_phone_id: number | null, sent: number, dl: number, un: number, nr: number): Row =>
      ({ stage_id, provider_phone_id, sent, delivered: dl, undelivered: un, no_receipt: nr });
    const W = { from: D1, to: D2 };
    const check = async (label: string, range: { from: string; to: string }, expected: Row[]) => {
      const stored = await R.readDeliveryRollup(db, orgId, range);
      const live = await queryDeliveryByStage(db, orgId, R.etDayBounds(range));
      bar(`${label}: stored == hand-derived`, R.canonicalDeliveryRows(stored) === R.canonicalDeliveryRows(expected),
        R.canonicalDeliveryRows(stored));
      bar(`${label}: live query == hand-derived`, R.canonicalDeliveryRows(live) === R.canonicalDeliveryRows(expected),
        R.canonicalDeliveryRows(live));
    };

    // ── 1. first refresh ──────────────────────────────────────────────────────
    console.log("\nREFRESH — first build");
    const r1 = await R.refreshDeliveryRollup(db, orgId, W);
    bar("R1 five cells (S0·D1, S1·D1, S2·D1, S2·D2, S3·D2), all written, none deleted",
      r1.cells === 5 && r1.written === 5 && r1.deleted === 0, JSON.stringify(r1));
    await check("R2 [D1..D2]", W, [
      row(S0, P1, 1, 1, 0, 0), // early receipt counted
      row(S1, P1, 7, 3, 1, 3), // a,b,f delivered; c undelivered; d,e,h no receipt; i excluded
      row(S2, P2, 3, 1, 1, 1),
      row(S3, null, 1, 1, 0, 0),
    ]);
    await check("R3 [D1] — straddling stage split by day", { from: D1, to: D1 }, [
      row(S0, P1, 1, 1, 0, 0), row(S1, P1, 7, 3, 1, 3), row(S2, P2, 1, 1, 0, 0),
    ]);
    await check("R4 [D2]", { from: D2, to: D2 }, [row(S2, P2, 2, 0, 1, 1), row(S3, null, 1, 1, 0, 0)]);

    // ── 2. idempotence ────────────────────────────────────────────────────────
    console.log("\nREFRESH — unchanged");
    const r2 = await R.refreshDeliveryRollup(db, orgId, W);
    bar("U1 re-refresh writes nothing", r2.cells === 5 && r2.written === 0 && r2.deleted === 0, JSON.stringify(r2));

    // ── 3. a late receipt, and range isolation ────────────────────────────────
    console.log("\nREFRESH — late receipt");
    await txr({ stageSendId: h, status: "delivered", at: later(t1, 3 * 86_400) });
    const r3 = await R.refreshDeliveryRollup(db, orgId, { from: D2, to: D2 });
    const s1After = await R.readDeliveryRollup(db, orgId, { from: D1, to: D1 });
    bar("L1 refreshing [D2] leaves the D1 cell alone (still 3 delivered)",
      r3.written === 0 && s1After.find((x) => x.stage_id === S1)?.delivered === 3, JSON.stringify(r3));
    const r4 = await R.refreshDeliveryRollup(db, orgId, { from: D1, to: D1 });
    bar("L2 refreshing [D1] rewrites exactly that one cell", r4.written === 1 && r4.deleted === 0, JSON.stringify(r4));
    await check("L3 [D1..D2] after the late receipt", W, [
      row(S0, P1, 1, 1, 0, 0), row(S1, P1, 7, 4, 1, 2), row(S2, P2, 3, 1, 1, 1), row(S3, null, 1, 1, 0, 0),
    ]);

    // ── 4. a vanished cell ─────────────────────────────────────────────────────
    console.log("\nREFRESH — vanished cell");
    await db.execute(sql`UPDATE stage_sends SET status = 'failed' WHERE id = ${j}::uuid`);
    const r5 = await R.refreshDeliveryRollup(db, orgId, W);
    bar("V1 the NULL-number cell is deleted", r5.deleted === 1 && r5.cells === 4, JSON.stringify(r5));
    await check("V2 [D1..D2] after the send left 'sent'", W, [
      row(S0, P1, 1, 1, 0, 0), row(S1, P1, 7, 4, 1, 2), row(S2, P2, 3, 1, 1, 1),
    ]);

    // ── 5. the foots CHECK ─────────────────────────────────────────────────────
    console.log("\nCONSTRAINT");
    let checkErr = "";
    try {
      await db.execute(sql`
        INSERT INTO stage_delivery_rollup (org_id, stage_id, provider_phone_id, sent_date_et, sent, delivered, undelivered, no_receipt)
        VALUES (${orgId}::uuid, ${S3}, ${P1}, ${D0}::date, 5, 1, 1, 1)`);
    } catch (err) {
      const e2 = err as { cause?: { message?: string; code?: string }; message?: string };
      checkErr = `${e2.cause?.code ?? ""} ${e2.cause?.message ?? e2.message ?? ""}`;
    }
    bar("C1 a row that does not foot is rejected by stage_delivery_rollup_foots",
      checkErr.includes("23514") && checkErr.includes("stage_delivery_rollup_foots"), checkErr.trim());

    console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    // ── teardown: by org_id, and only after re-reading the marker ─────────────
    if (orgId) {
      const name = ((await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the test marker (name=${JSON.stringify(name)})`);
        process.exitCode = 1;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const org = sql`NULLIF(${orgId}, '')::uuid`;
    const left = await one<{ orgs: number; rows: number }>(sql`
      SELECT (SELECT count(*) FROM organizations WHERE name LIKE ${`%${MARKER} ${tag}%`})::int AS orgs,
             ((SELECT count(*) FROM stage_delivery_rollup  WHERE org_id = ${org})
            + (SELECT count(*) FROM stage_sends            WHERE org_id = ${org})
            + (SELECT count(*) FROM textrequest_dlr_events WHERE org_id = ${org})
            + (SELECT count(*) FROM tells_webhook_events   WHERE org_id = ${org})
            + (SELECT count(*) FROM ahoi_dlr_events        WHERE org_id = ${org})
            + (SELECT count(*) FROM campaign_stages        WHERE org_id = ${org})
            + (SELECT count(*) FROM provider_phones        WHERE org_id = ${org})
            + (SELECT count(*) FROM sms_providers          WHERE org_id = ${org})
            + (SELECT count(*) FROM contacts               WHERE org_id = ${org}))::int AS rows
    `);
    console.log(`\nTeardown: ${left.orgs} org(s), ${left.rows} row(s) left for this run`);
    if (left.orgs !== 0 || left.rows !== 0) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
