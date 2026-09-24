import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Contact engagement (migration 0187) against the PREVIEW DB.
//
// Part A — the evaluator (lib/engagement/status-sql.ts) over hand-written
//   VALUES rows at a fixed instant: every transition and boundary of spec §3.2,
//   the freeze clock, the transition reason and time_due_at. No writes.
// Part B — refreshContactEngagement over a throwaway org whose expected facts
//   are hand-derived from the fixture timeline, not read back off the job.
// Part C — watchEngagementHeartbeat: silent while every engine is off, and one
//   latched alert once a switched-on job stays missing past its first-run grace.
//
// Torn down by org_id after re-reading the marker, with a post-teardown count of 0.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-engagement-db.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const A = new Date("2026-03-01T12:00:00Z"); // Part A's instant, and the world's "now"
const MARKER = "__ENGAGEMENT_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const epoch = (d: Date | null) => (d == null ? null : Math.floor(d.getTime() / 1000));
const plus = (base: Date, days: number, hours = 0) =>
  new Date(base.getTime() + days * DAY + hours * HOUR);

type EvalCase = {
  label: string;
  prev_status: string | null;
  prev_freeze_entered_at?: Date | null;
  msgs_total: number;
  msgs_since_click: number;
  last_click_at?: Date | null;
  calc_freeze_started_at?: Date | null;
  calc_freeze_msgs?: number;
  freeze_after_messages?: number;
  expect: {
    status: string;
    reason?: string;
    freeze_entered_at?: Date | null;
    freeze_started_at?: Date | null;
    freeze_msgs?: number;
    time_due_at?: Date | null;
  };
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const S = await import("@/lib/engagement/status-sql");
  const { refreshContactEngagement } = await import("@/lib/engagement/refresh");
  const { watchEngagementHeartbeat } = await import("@/lib/engagement/monitor");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T,>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T,>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
  const iso = (d: Date) => d.toISOString();
  const n = (v: unknown) => (v == null ? null : Number(v));

  // ── PART A — the evaluator ────────────────────────────────────────────────
  console.log("PART A — evaluator (spec §3.2) at a fixed instant");
  const ts = (d: Date | null | undefined) =>
    d ? sql`${d.toISOString()}::timestamptz` : sql`NULL::timestamptz`;
  const cases: EvalCase[] = [
    { label: "E1 never messaged ⇒ new (first row reason = backfill)", prev_status: null, msgs_total: 0, msgs_since_click: 0,
      expect: { status: "new", reason: "backfill" } },
    { label: "E2 new → cold on the first message", prev_status: "new", msgs_total: 1, msgs_since_click: 1,
      expect: { status: "cold", reason: "first_message" } },
    { label: "E3 9 messages, no click ⇒ cold", prev_status: "cold", msgs_total: 9, msgs_since_click: 9,
      expect: { status: "cold" } },
    { label: "E4 cold → freeze at exactly 10; clock enters now, nothing sent in freeze yet", prev_status: "cold", msgs_total: 10, msgs_since_click: 10,
      expect: { status: "freeze", reason: "freeze_threshold", freeze_entered_at: A, freeze_started_at: null, freeze_msgs: 0, time_due_at: null } },
    { label: "E5 freeze with 0 in-freeze messages stays freeze after 200 days", prev_status: "freeze", prev_freeze_entered_at: plus(A, -200), msgs_total: 12, msgs_since_click: 12,
      expect: { status: "freeze", freeze_entered_at: plus(A, -200), freeze_started_at: null, freeze_msgs: 0, time_due_at: null } },
    { label: "E6 freeze → suppressed at 60 days + 2 in-freeze messages", prev_status: "freeze", prev_freeze_entered_at: plus(A, -70), msgs_total: 14, msgs_since_click: 14, calc_freeze_started_at: plus(A, -60), calc_freeze_msgs: 2,
      expect: { status: "suppressed", reason: "freeze_expired" } },
    { label: "E7 59 days + 2 messages ⇒ still freeze, due in 1 day", prev_status: "freeze", prev_freeze_entered_at: plus(A, -70), msgs_total: 14, msgs_since_click: 14, calc_freeze_started_at: plus(A, -59), calc_freeze_msgs: 2,
      expect: { status: "freeze", freeze_started_at: plus(A, -59), freeze_msgs: 2, time_due_at: plus(A, 1) } },
    { label: "E8 60 days + 1 message ⇒ still freeze, nothing due by time", prev_status: "freeze", prev_freeze_entered_at: plus(A, -70), msgs_total: 13, msgs_since_click: 13, calc_freeze_started_at: plus(A, -60), calc_freeze_msgs: 1,
      expect: { status: "freeze", freeze_msgs: 1, time_due_at: null } },
    { label: "E9 suppressed stays suppressed when the threshold is raised", prev_status: "suppressed", msgs_total: 12, msgs_since_click: 12, freeze_after_messages: 20,
      expect: { status: "suppressed" } },
    { label: "E10 cold → hot on a human click", prev_status: "cold", msgs_total: 5, msgs_since_click: 0, last_click_at: plus(A, 0, -1),
      expect: { status: "hot", reason: "human_click", freeze_entered_at: null } },
    { label: "E11 freeze → hot clears the freeze clock", prev_status: "freeze", prev_freeze_entered_at: plus(A, -30), msgs_total: 12, msgs_since_click: 0, last_click_at: plus(A, 0, -1), calc_freeze_started_at: plus(A, -20), calc_freeze_msgs: 1,
      expect: { status: "hot", reason: "human_click", freeze_entered_at: null, freeze_started_at: null, freeze_msgs: 0 } },
    { label: "E12 suppressed → hot on a human click", prev_status: "suppressed", msgs_total: 16, msgs_since_click: 0, last_click_at: plus(A, 0, -1),
      expect: { status: "hot", reason: "human_click" } },
    { label: "E13 warm → hot on a new click", prev_status: "warm", msgs_total: 8, msgs_since_click: 0, last_click_at: plus(A, 0, -1),
      expect: { status: "hot", reason: "human_click" } },
    { label: "E14 click exactly 30 days ago ⇒ still hot, due now", prev_status: "hot", msgs_total: 8, msgs_since_click: 1, last_click_at: plus(A, -30),
      expect: { status: "hot", time_due_at: A } },
    { label: "E15 hot → warm at 31 days, due at click + 120 days", prev_status: "hot", msgs_total: 8, msgs_since_click: 3, last_click_at: plus(A, -31),
      expect: { status: "warm", reason: "click_aged_warm", time_due_at: plus(A, 89) } },
    { label: "E16 click exactly 120 days ago ⇒ still warm", prev_status: "warm", msgs_total: 8, msgs_since_click: 3, last_click_at: plus(A, -120),
      expect: { status: "warm" } },
    { label: "E17 warm → cold at 121 days", prev_status: "warm", msgs_total: 8, msgs_since_click: 3, last_click_at: plus(A, -121),
      expect: { status: "cold", reason: "click_aged_cold" } },
    { label: "E18 warm → freeze on the same run when ≥10 messages since the last click", prev_status: "warm", msgs_total: 25, msgs_since_click: 10, last_click_at: plus(A, -121),
      expect: { status: "freeze", reason: "click_aged_cold", freeze_entered_at: A } },
    { label: "E19 threshold lowered to 5: cold → freeze", prev_status: "cold", msgs_total: 6, msgs_since_click: 6, freeze_after_messages: 5,
      expect: { status: "freeze", reason: "freeze_threshold" } },
    { label: "E20 threshold raised to 20: freeze → cold, clock cleared", prev_status: "freeze", prev_freeze_entered_at: plus(A, -5), msgs_total: 12, msgs_since_click: 12, freeze_after_messages: 20,
      expect: { status: "cold", reason: "threshold_change", freeze_entered_at: null, freeze_msgs: 0 } },
    { label: "E21 backfill of a 12-message contact: freeze, clock starts at the backfill instant", prev_status: null, msgs_total: 12, msgs_since_click: 12,
      expect: { status: "freeze", reason: "backfill", freeze_entered_at: A, freeze_started_at: null, freeze_msgs: 0 } },
    { label: "E22 freeze stays; the clock is carried", prev_status: "freeze", prev_freeze_entered_at: plus(A, -10), msgs_total: 13, msgs_since_click: 13, calc_freeze_started_at: plus(A, -9), calc_freeze_msgs: 1,
      expect: { status: "freeze", freeze_entered_at: plus(A, -10), freeze_started_at: plus(A, -9), freeze_msgs: 1 } },
    { label: "E23 suppression needs a PREVIOUS freeze (a cold contact that qualifies becomes freeze first)", prev_status: "cold", msgs_total: 12, msgs_since_click: 12, calc_freeze_started_at: plus(A, -100), calc_freeze_msgs: 5,
      expect: { status: "freeze" } },
    { label: "E24 suppression needs the freeze condition to still hold", prev_status: "freeze", prev_freeze_entered_at: plus(A, -80), msgs_total: 12, msgs_since_click: 12, calc_freeze_started_at: plus(A, -70), calc_freeze_msgs: 3, freeze_after_messages: 20,
      expect: { status: "cold", reason: "threshold_change" } },
  ];
  const values = sql.join(
    cases.map(
      (c) => sql`(
      ${c.label}::text, ${c.prev_status}::text, NULL::timestamptz, ${ts(c.prev_freeze_entered_at)},
      ${c.msgs_total}::int, ${c.msgs_since_click}::int, 0::int, 0::int, 0::int, 0::int,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, ${ts(c.last_click_at)},
      ${ts(c.calc_freeze_started_at)}, ${c.calc_freeze_msgs ?? 0}::int,
      30::int, 120::int, ${c.freeze_after_messages ?? 10}::int, 14::int, 60::int, 2::int, '{}'::int[])`,
    ),
    sql`, `,
  );
  const input = sql`(SELECT * FROM (VALUES ${values}) v(
    contact_id, prev_status, prev_status_changed_at, prev_freeze_entered_at,
    msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
    first_sent_at, last_sent_at, first_click_at, last_click_at,
    calc_freeze_started_at, calc_freeze_msgs,
    hot_days, warm_days, freeze_after_messages, freeze_cadence_days,
    suppress_after_days, suppress_min_freeze_messages, override_group_ids))`;
  const out = await all<{
    label: string; status: string; reason: string;
    fe: string | null; fs: string | null; freeze_msgs: number; due: string | null;
  }>(sql`
    SELECT contact_id AS label, status, reason,
           extract(epoch FROM freeze_entered_at)::bigint AS fe,
           extract(epoch FROM freeze_started_at)::bigint AS fs,
           freeze_msgs,
           extract(epoch FROM time_due_at)::bigint AS due
    FROM (${S.evaluationSelectSql(input, sql`${A.toISOString()}::timestamptz`, "backfill")}) x`);
  for (const c of cases) {
    const r = out.find((o) => o.label === c.label);
    if (!r) {
      bar(c.label, false, "row missing");
      continue;
    }
    const problems: string[] = [];
    if (r.status !== c.expect.status) problems.push(`status ${r.status} ≠ ${c.expect.status}`);
    if (c.expect.reason !== undefined && r.reason !== c.expect.reason) problems.push(`reason ${r.reason} ≠ ${c.expect.reason}`);
    if (c.expect.freeze_entered_at !== undefined && n(r.fe) !== epoch(c.expect.freeze_entered_at)) problems.push(`freeze_entered_at ${r.fe}`);
    if (c.expect.freeze_started_at !== undefined && n(r.fs) !== epoch(c.expect.freeze_started_at)) problems.push(`freeze_started_at ${r.fs}`);
    if (c.expect.freeze_msgs !== undefined && Number(r.freeze_msgs) !== c.expect.freeze_msgs) problems.push(`freeze_msgs ${r.freeze_msgs}`);
    if (c.expect.time_due_at !== undefined && n(r.due) !== epoch(c.expect.time_due_at)) problems.push(`time_due_at ${r.due}`);
    bar(c.label, problems.length === 0, problems.join("; "));
  }

  // ── PART B — the job over a throwaway world ───────────────────────────────
  // Timeline (A = 2026-03-01T12:00Z). Sends sit away from every window edge
  // (7/14/30/90 d) so a recount one day later gives the same windows — that is
  // what lets "a full run right after an incremental one writes 0 rows" be exact.
  console.log("\nPART B — refreshContactEngagement over a throwaway org");
  const tag = `eng-${Date.now()}`;
  let orgId = "";
  const run = (opts: Parameters<typeof refreshContactEngagement>[2]) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      return refreshContactEngagement(tx, orgId, opts);
    });
  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    // Org row: cadence 21, everything else default. engine_mode stays 'off' —
    // the switch gates the cron, not a direct call.
    await db.execute(sql`INSERT INTO lifecycle_settings (org_id, freeze_cadence_days) VALUES (${org}, 21)`);

    const group = async (name: string, status: string, o: { fam?: number; fcd?: number; sad?: number; smm?: number }) =>
      (await one<{ id: number }>(sql`
        INSERT INTO contact_groups (contact_group_id, org_id, name, status,
          freeze_after_messages, freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages)
        VALUES (${`${tag}-${name}`}, ${org}, ${name}, ${status},
          ${o.fam ?? null}::smallint, ${o.fcd ?? null}::smallint, ${o.sad ?? null}::smallint, ${o.smm ?? null}::smallint)
        RETURNING id`)).id;
    const GA = await group("A", "active", { fcd: 7 });
    const GB = await group("B", "active", {});
    const GC = await group("C", "archived", { fam: 3 });
    const GD = await group("D", "active", { fam: 8, sad: 30, smm: 1 });

    const brand = (await one<{ id: number }>(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`B-${tag}`}, ${`Brand ${tag}`}) RETURNING id`)).id;
    const sd = (await one<{ id: number }>(sql`INSERT INTO short_domains (org_id, brand_id, domain) VALUES (${org}, ${brand}, ${`${tag}.test`}) RETURNING id`)).id;
    const dest = (await one<{ id: number }>(sql`INSERT INTO link_destinations (org_id, url, url_hash) VALUES (${org}, 'https://example.test/o', ${`h-${tag}`}) RETURNING id`)).id;
    const net = (await one<{ id: number }>(sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, 'net') RETURNING id`)).id;
    const offer = async (code: string) =>
      (await one<{ id: number }>(sql`INSERT INTO offers (org_id, network_id, offer_id, name) VALUES (${org}, ${net}, ${`${tag}-${code}`}, ${code}) RETURNING id`)).id;
    const O1 = await offer("o1");
    const O2 = await offer("o2");
    const campaign = async (code: string, offerId: number) =>
      (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, link_mode, status, offer_id)
        VALUES (${org}, ${`${tag}-${code}`}, ${code}, 'tracked', 'active', ${offerId}) RETURNING id`)).id;
    const K1 = await campaign("k1", O1);
    const K2 = await campaign("k2", O2);
    const stage = async (campaignId: number) =>
      (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id)
        VALUES (${org}, ${campaignId}, 1, ${`trk-${tag}-${campaignId}`}) RETURNING id`)).id;
    const S1 = await stage(K1);
    const S2 = await stage(K2);

    const phones = fictionalPhones(8);
    await refuseIfPhonesInUse(db, phones);
    type C = { id: string; phone: string };
    const contact = async (i: number, groups: number[]): Promise<C> => {
      const id = (await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${phones[i]}) RETURNING id`)).id;
      for (const g of groups) {
        await db.execute(sql`INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id) VALUES (${id}::uuid, ${g}, ${org})`);
      }
      return { id, phone: phones[i] };
    };
    const cNew = await contact(0, [GA]);
    const cCold = await contact(1, [GA, GB]);
    const cFreeze = await contact(2, []);
    const cHot = await contact(3, []);
    const cWarm = await contact(4, []);
    const cBot = await contact(5, [GC]);
    const cD = await contact(6, [GD, GB]);
    const cOpt = await contact(7, []);

    const send = async (c: C, k: 1 | 2, when: Date): Promise<string> =>
      (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${org}, ${k === 1 ? K1 : K2}, ${k === 1 ? S1 : S2}, ${c.id}::uuid, ${c.phone}, 'x', 'sent', ${iso(when)}::timestamptz)
        RETURNING id`)).id;
    // One link per send (links is unique on stage_id, contact_id, send_token);
    // a link can carry many clicks, which is what a repeat tap looks like live.
    let linkSeq = 0;
    const linkBySend = new Map<string, number>();
    const linkFor = async (c: C, k: 1 | 2, sendId: string): Promise<number> => {
      const cached = linkBySend.get(sendId);
      if (cached != null) return cached;
      linkSeq++;
      const id = (await one<{ id: number }>(sql`
        INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
                           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES (${org}, ${`${tag}-${linkSeq}`}, ${sd}, ${dest}, ${k === 1 ? K1 : K2}, ${k === 1 ? S1 : S2},
                ${c.id}::uuid, ${sendId}, ${`ct-${tag}`}, ${`st-${tag}`})
        RETURNING id`)).id;
      linkBySend.set(sendId, id);
      return id;
    };
    const click = async (c: C, k: 1 | 2, sendId: string, clickedAt: Date, classification: string, scoredAt: Date | null) => {
      const link = await linkFor(c, k, sendId);
      await db.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification, clicked_at, scored_at)
        VALUES (${org}, ${link}, ${classification}, ${iso(clickedAt)}::timestamptz,
                ${scoredAt ? iso(scoredAt) : null}::timestamptz)`);
    };

    for (const d of [-10, -9, -8]) await send(cCold, 1, plus(A, d));
    const cColdLast = await send(cCold, 1, plus(A, -7, -12)); // -7.5 d: outside the 7-day window
    for (const d of [-55, -50, -45, -40, -35]) await send(cFreeze, 1, plus(A, d));
    for (const d of [-25, -20, -15, -12, -11]) await send(cFreeze, 2, plus(A, d));
    let hotSend = "";
    for (let d = -45; d <= -34; d++) hotSend = await send(cHot, 1, plus(A, d));
    await click(cHot, 1, hotSend, plus(A, -5), "human", plus(A, -5, 1));
    for (const d of [-3, -2]) await send(cHot, 2, plus(A, d));
    let warmSend = "";
    for (let d = -60; d <= -56; d++) warmSend = await send(cWarm, 1, plus(A, d));
    await click(cWarm, 1, warmSend, plus(A, -45), "human", plus(A, -45, 1));
    let botSend = "";
    for (const d of [-20, -19, -18]) botSend = await send(cBot, 1, plus(A, d));
    await click(cBot, 1, botSend, plus(A, -17), "bot", plus(A, -17, 1)); // scored, but a bot
    await click(cBot, 1, botSend, plus(A, -16), "human", null); // human, but UNSCORED
    for (let d = -50; d <= -43; d++) await send(cD, 1, plus(A, d));
    await send(cOpt, 1, plus(A, -33));
    await db.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number) VALUES (${org}, ${cOpt.id}::uuid, ${cOpt.phone})`);

    // Rows AFTER A — invisible to any run whose asOf precedes them.
    await send(cNew, 1, plus(A, 0, 1));
    await send(cFreeze, 2, plus(A, 0, 1)); // 1st in-freeze message
    await send(cFreeze, 2, plus(A, 15)); // 2nd in-freeze message
    await click(cCold, 1, cColdLast, plus(A, 0, 2), "human", plus(A, 0, 3));
    await click(cBot, 1, botSend, plus(A, 0, 2), "bot", plus(A, 0, 2));

    const row = async (c: C) =>
      one<Record<string, unknown>>(sql`
        SELECT status, msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
               extract(epoch FROM last_click_at)::bigint AS last_click,
               extract(epoch FROM freeze_entered_at)::bigint AS fe,
               extract(epoch FROM freeze_started_at)::bigint AS fs,
               freeze_msgs, freeze_cadence_days, thresholds,
               extract(epoch FROM time_due_at)::bigint AS due
        FROM contact_engagement WHERE contact_id = ${c.id}::uuid`);
    const count = async (table: string) =>
      Number((await one<{ n: string }>(sql`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE org_id = ${org}`)).n);

    // B1 — the DRY RUN writes nothing and reports the right counts.
    const r0 = await run({ mode: "full", dryRun: true, asOf: A, initialReason: "backfill", withReport: true });
    bar("B1 dry run: status counts",
      JSON.stringify(r0.statusCounts) === JSON.stringify({ new: 1, cold: 3, hot: 1, warm: 1, freeze: 2, suppressed: 0 }),
      JSON.stringify(r0.statusCounts));
    bar("B1 dry run: would write 8 rows, 8 transitions, 9 offer rows",
      r0.rowsWritten === 8 && r0.transitionsWritten === 8 && r0.offerRowsWritten === 9,
      `${r0.rowsWritten}/${r0.transitionsWritten}/${r0.offerRowsWritten}`);
    bar("B1 dry run: freeze not due = 1 (cFreeze's last message is 11 d old, cadence 21)", r0.freezeNotDue === 1, String(r0.freezeNotDue));
    bar("B1 dry run: opted-out per status (cOpt is cold)", r0.optedOutByStatus?.cold === 1, JSON.stringify(r0.optedOutByStatus));
    const gA = r0.groups?.find((g) => g.group_id === GA);
    const gNone = r0.groups?.find((g) => g.group_id === 0);
    bar("B1 dry run: group A = new 1 + cold 1; the archived group C is not listed",
      gA?.counts.new === 1 && gA?.counts.cold === 1 && !r0.groups?.some((g) => g.group_id === GC), JSON.stringify(gA));
    bar("B1 dry run: no-active-group bucket = freeze 1, hot 1, warm 1, cold 2 (cBot's only group is archived)",
      gNone?.counts.freeze === 1 && gNone?.counts.hot === 1 && gNone?.counts.warm === 1 && gNone?.counts.cold === 2, JSON.stringify(gNone));
    bar("B1 dry run: nothing written",
      (await count("contact_engagement")) === 0 && (await count("contact_engagement_transitions")) === 0 && (await count("contact_offer_campaigns")) === 0);

    // B2 — the FULL run (what the backfill does).
    const r1 = await run({ mode: "full", dryRun: false, asOf: A, initialReason: "backfill" });
    bar("B2 full: 8 rows, 8 backfill transitions, 9 offer rows",
      r1.rowsWritten === 8 && r1.transitionsWritten === 8 && r1.offerRowsWritten === 9,
      `${r1.rowsWritten}/${r1.transitionsWritten}/${r1.offerRowsWritten}`);
    const reasons = await all<{ reason: string; n: string }>(sql`
      SELECT reason, count(*) AS n FROM contact_engagement_transitions WHERE org_id = ${org} GROUP BY 1`);
    bar("B2 every first row is reason 'backfill' from ∅",
      reasons.length === 1 && reasons[0].reason === "backfill" && Number(reasons[0].n) === 8, JSON.stringify(reasons));
    const vNew = await row(cNew);
    bar("B2 cNew: new, cadence 7 (its only group is A)", vNew.status === "new" && n(vNew.freeze_cadence_days) === 7, JSON.stringify(vNew));
    const vCold = await row(cCold);
    bar("B2 cCold: cold, 4 msgs, windows 7/14/30/90 d = 0/4/4/4, cadence 21 (strictest of A's 7 and B's inherited 21)",
      vCold.status === "cold" && n(vCold.msgs_total) === 4 && n(vCold.msgs_7d) === 0 && n(vCold.msgs_14d) === 4 &&
      n(vCold.msgs_30d) === 4 && n(vCold.msgs_90d) === 4 && n(vCold.freeze_cadence_days) === 21, JSON.stringify(vCold));
    const vFreeze = await row(cFreeze);
    bar("B2 cFreeze: freeze, 10 msgs, clock entered at A, nothing sent in freeze, not due",
      vFreeze.status === "freeze" && n(vFreeze.msgs_total) === 10 && n(vFreeze.fe) === epoch(A) &&
      vFreeze.fs == null && n(vFreeze.freeze_msgs) === 0 && vFreeze.due == null, JSON.stringify(vFreeze));
    const vHot = await row(cHot);
    bar("B2 cHot: hot, 14 msgs, 2 since the click, 7 d = 2, due at click + 30 d",
      vHot.status === "hot" && n(vHot.msgs_total) === 14 && n(vHot.msgs_since_click) === 2 &&
      n(vHot.msgs_7d) === 2 && n(vHot.due) === epoch(plus(A, 25)), JSON.stringify(vHot));
    const vWarm = await row(cWarm);
    bar("B2 cWarm: warm, due at click + 120 d", vWarm.status === "warm" && n(vWarm.due) === epoch(plus(A, 75)), JSON.stringify(vWarm));
    const vBot = await row(cBot);
    bar("B2 cBot: cold; the bot and unscored clicks are ignored; archived group C's threshold 3 is ignored",
      vBot.status === "cold" && vBot.last_click == null &&
      (vBot.thresholds as { freeze_after_messages: number }).freeze_after_messages === 10, JSON.stringify(vBot));
    const vD = await row(cD);
    const tD = vD.thresholds as { freeze_after_messages: number; suppress_after_days: number; suppress_min_freeze_messages: number; override_group_ids: number[] };
    bar("B2 cD: freeze via group D (8 / 30 / 1), override_group_ids = [D]",
      vD.status === "freeze" && tD.freeze_after_messages === 8 && tD.suppress_after_days === 30 &&
      tD.suppress_min_freeze_messages === 1 && JSON.stringify(tD.override_group_ids) === JSON.stringify([GD]), JSON.stringify(vD));
    const offers = await all<{ offer_id: number; messages: number; first: string; last: string }>(sql`
      SELECT offer_id, messages,
             extract(epoch FROM first_sent_at)::bigint AS first, extract(epoch FROM last_sent_at)::bigint AS last
      FROM contact_offer_campaigns WHERE org_id = ${org} AND contact_id = ${cFreeze.id}::uuid ORDER BY offer_id`);
    bar("B2 cFreeze offer rows: O1 5 msgs (-55..-35), O2 5 msgs (-25..-11)",
      offers.length === 2 &&
      Number(offers[0].offer_id) === O1 && Number(offers[0].messages) === 5 &&
      Number(offers[0].first) === epoch(plus(A, -55)) && Number(offers[0].last) === epoch(plus(A, -35)) &&
      Number(offers[1].offer_id) === O2 && Number(offers[1].messages) === 5 &&
      Number(offers[1].last) === epoch(plus(A, -11)), JSON.stringify(offers));

    // B2t — the extracted threshold builder resolves what the job stores.
    const thr = await import("@/lib/engagement/thresholds-sql");
    const resolved = await db.transaction(async (tx) => {
      await thr.createThresholdTempTables(tx, orgId);
      return (await tx.execute(sql`
        SELECT contact_id::text AS contact_id, freeze_after_messages, freeze_cadence_days,
               suppress_after_days, suppress_min_freeze_messages
        FROM eng_grp_thr ORDER BY contact_id`)) as unknown as Record<string, unknown>[];
    });
    const forContact = (c: C) => resolved.find((r) => r.contact_id === c.id);
    bar("B2t cCold: strictest across A (cadence 7) and B (inherits 21) ⇒ 21",
      n(forContact(cCold)?.freeze_cadence_days) === 21, JSON.stringify(forContact(cCold)));
    bar("B2t cD: group D's 8 / 30 / 1 win over the org's 10 / 60 / 2",
      n(forContact(cD)?.freeze_after_messages) === 8 && n(forContact(cD)?.suppress_after_days) === 30 &&
      n(forContact(cD)?.suppress_min_freeze_messages) === 1, JSON.stringify(forContact(cD)));
    bar("B2t cBot: its only group is archived ⇒ not in the per-contact table at all",
      forContact(cBot) === undefined);
    const proposedThr = await db.transaction(async (tx) => {
      await thr.createThresholdTempTables(tx, orgId, {
        proposedOrg: { hot_days: 30, warm_days: 120, freeze_after_messages: 5,
                       freeze_cadence_days: 21, suppress_after_days: 60, suppress_min_freeze_messages: 2 },
        proposedGroup: { groupId: GD, overrides: { freeze_after_messages: null } },
      });
      return (await tx.execute(sql`
        SELECT (SELECT freeze_after_messages FROM eng_org_thr) AS org_fam,
               (SELECT freeze_after_messages FROM eng_grp_thr WHERE contact_id = ${cD.id}::uuid) AS cd_fam
      `)) as unknown as { org_fam: number; cd_fam: number }[];
    });
    bar("B2t proposed org values are used instead of the saved row",
      n(proposedThr[0].org_fam) === 5, JSON.stringify(proposedThr[0]));
    bar("B2t clearing group D's override falls back to the proposed org value",
      n(proposedThr[0].cd_fam) === 5, JSON.stringify(proposedThr[0]));

    // B3 — the same full run again changes nothing.
    const r1b = await run({ mode: "full", dryRun: false, asOf: A });
    bar("B3 full again: 0 rows, 0 transitions, 0 offer writes, 0 deletes",
      r1b.rowsWritten === 0 && r1b.transitionsWritten === 0 && r1b.offerRowsWritten === 0 && r1b.offerRowsDeleted === 0, JSON.stringify(r1b));

    // B4 — INCREMENTAL at A + 1 d.
    const A2 = plus(A, 1);
    const r2 = await run({ mode: "incremental", dryRun: false, asOf: A2, since: plus(A, 0, -0.5) });
    bar("B4 incremental: recounted 3 (cNew, cFreeze, cCold); the bot click touches nobody", r2.recounted === 3, String(r2.recounted));
    bar("B4 transitions: new→cold 1, cold→hot 1",
      r2.transitions["new→cold"] === 1 && r2.transitions["cold→hot"] === 1 && r2.transitionsWritten === 2, JSON.stringify(r2.transitions));
    const v2Freeze = await row(cFreeze);
    bar("B4 cFreeze: clock carried from A, first in-freeze message at A+1h, 1 message, not due (needs 2)",
      v2Freeze.status === "freeze" && n(v2Freeze.fe) === epoch(A) && n(v2Freeze.fs) === epoch(plus(A, 0, 1)) &&
      n(v2Freeze.freeze_msgs) === 1 && v2Freeze.due == null, JSON.stringify(v2Freeze));
    bar("B4 offer rows: cNew's new row + cFreeze's O2 row changed", r2.offerRowsWritten === 2, String(r2.offerRowsWritten));
    const lastReason = await one<{ reason: string }>(sql`
      SELECT reason FROM contact_engagement_transitions WHERE contact_id = ${cCold.id}::uuid ORDER BY id DESC LIMIT 1`);
    bar("B4 cCold's transition reason is human_click", lastReason.reason === "human_click", lastReason.reason);

    // B5 — a FULL run right after the incremental one, same instant: nothing to write.
    const r2b = await run({ mode: "full", dryRun: false, asOf: A2 });
    bar("B5 full after incremental at the same instant writes 0 rows / 0 transitions / 0 offer changes",
      r2b.rowsWritten === 0 && r2b.transitionsWritten === 0 && r2b.offerRowsWritten === 0 && r2b.offerRowsDeleted === 0, JSON.stringify(r2b));

    // B6 — time alone: hot → warm (cHot's click is 31 d old at A + 26 d).
    const A3 = plus(A, 26);
    const r3 = await run({ mode: "incremental", dryRun: false, asOf: A3, since: plus(A2, 0, -0.5) });
    bar("B6 cHot hot→warm by time_due (no send, no click)",
      (await row(cHot)).status === "warm" && r3.transitions["hot→warm"] === 1, JSON.stringify(r3.transitions));
    const v3Freeze = await row(cFreeze);
    bar("B6 cFreeze: 2 in-freeze messages, due at the first in-freeze message + 60 d",
      n(v3Freeze.freeze_msgs) === 2 && n(v3Freeze.due) === epoch(plus(A, 60, 1)), JSON.stringify(v3Freeze));

    // B7 — time alone: freeze → suppressed, and cCold hot → warm.
    const A4 = plus(A, 60, 2);
    const r4 = await run({ mode: "incremental", dryRun: false, asOf: A4, since: plus(A3, 0, -0.5) });
    bar("B7 cFreeze freeze→suppressed (reason freeze_expired)",
      (await row(cFreeze)).status === "suppressed" && r4.transitions["freeze→suppressed"] === 1, JSON.stringify(r4.transitions));
    bar("B7 cCold hot→warm (its click is 60 d old)",
      (await row(cCold)).status === "warm" && r4.transitions["hot→warm"] === 1);
    bar("B7 cD stays freeze: no in-freeze message, so it is never suppressed", (await row(cD)).status === "freeze");
    const expired = await one<{ reason: string; t: { suppress_after_days: number } }>(sql`
      SELECT reason, thresholds AS t FROM contact_engagement_transitions
      WHERE contact_id = ${cFreeze.id}::uuid ORDER BY id DESC LIMIT 1`);
    bar("B7 the suppression transition records the thresholds in effect",
      expired.reason === "freeze_expired" && expired.t.suppress_after_days === 60, JSON.stringify(expired));
    const totalTransitions = await count("contact_engagement_transitions");
    bar("B7 transition history total = 8 + 2 + 1 + 2 = 13", totalTransitions === 13, String(totalTransitions));

    // ── PART D — the settings preview over STORED facts ─────────────────────
    // State after B7: cNew cold (1 msg), cCold warm, cFreeze suppressed,
    // cHot warm, cWarm warm, cBot cold (3 msgs), cD freeze (8 msgs), cOpt cold (1 msg).
    console.log("\nPART D — previewLifecycleThresholds");
    const { previewLifecycleThresholds } = await import("@/lib/engagement/preview");
    const preview = (opts: Parameters<typeof previewLifecycleThresholds>[2]) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
        return previewLifecycleThresholds(tx, orgId, opts);
      });
    const SAVED = {
      hot_days: 30, warm_days: 120, freeze_after_messages: 10,
      freeze_cadence_days: 21, suppress_after_days: 60, suppress_min_freeze_messages: 2,
    };
    const d0 = await preview({ proposedOrg: SAVED, asOf: A4 });
    bar("D1 proposing the saved values moves nobody",
      Object.keys(d0.transitions).length === 0 && d0.evaluated === 8, JSON.stringify(d0.transitions));
    bar("D1 current counts are the stored ones",
      d0.currentCounts.cold === 3 && d0.currentCounts.warm === 3 &&
      d0.currentCounts.freeze === 1 && d0.currentCounts.suppressed === 1, JSON.stringify(d0.currentCounts));
    // Only cBot has ≥3 messages since its last click; cNew and cOpt have 1 each,
    // and the three warm contacts are decided by their click before any message
    // count is consulted. So exactly one contact moves and freeze goes 1 → 2.
    const d1 = await preview({ proposedOrg: { ...SAVED, freeze_after_messages: 3 }, asOf: A4 });
    bar("D2 lowering freeze_after_messages to 3 freezes only the 3-message contact",
      d1.transitions["cold→freeze"] === 1 && d1.projectedCounts.freeze === 2, JSON.stringify(d1.transitions));
    const d2 = await preview({ proposedOrg: { ...SAVED, warm_days: 30 }, asOf: A4 });
    bar("D3 shrinking warm_days to 30 ages all three warm contacts out",
      (d2.transitions["warm→cold"] ?? 0) + (d2.transitions["warm→freeze"] ?? 0) === 3, JSON.stringify(d2.transitions));
    const d3 = await preview({ proposedGroup: { groupId: GA, overrides: { freeze_after_messages: 1 } }, asOf: A4 });
    bar("D4 a group override reaches only that group's contacts (A = cNew, cCold)",
      (d3.transitions["cold→freeze"] ?? 0) === 1 && (d3.transitions["warm→freeze"] ?? 0) === 0,
      JSON.stringify(d3.transitions));
    bar("D5 the preview writes nothing",
      (await count("contact_engagement_transitions")) === 13 && (await row(cBot)).status === "cold");

    // ── PART F — a big touched set escalates to a full recount ──────────────
    // On 2026-09-23 a send burst put 43,448 contacts in one 15-minute window;
    // the per-contact recount blew the statement timeout, and because `since`
    // only advances on success every later run inherited a wider window. The
    // escalation is what bounds that. maxTouched is set to 1 here so a world of
    // eight contacts can exercise it.
    console.log("\nPART F — incremental escalation");
    const fSmall = await run({ mode: "incremental", dryRun: true, asOf: A4, since: plus(A4, -70), maxTouched: 10_000 });
    bar("F1 a normal window stays incremental",
      fSmall.escalatedToFull !== true && fSmall.mode === "incremental", JSON.stringify({ esc: fSmall.escalatedToFull, recounted: fSmall.recounted }));
    const fBig = await run({ mode: "incremental", dryRun: true, asOf: A4, since: plus(A4, -70), maxTouched: 1 });
    bar("F2 a window over the ceiling escalates: every contact recounted and evaluated",
      fBig.escalatedToFull === true && fBig.recounted === 8 && fBig.evaluated === 8,
      JSON.stringify({ esc: fBig.escalatedToFull, recounted: fBig.recounted, evaluated: fBig.evaluated }));
    bar("F3 the escalated run agrees with a real full run (same rows would change)",
      fBig.rowsWritten === (await run({ mode: "full", dryRun: true, asOf: A4 })).rowsWritten,
      String(fBig.rowsWritten));

    // ── PART E — a threshold change reaches contacts nothing else touched ────
    console.log("\nPART E — reevaluate_requested_at");
    const { reevaluationDue } = await import("@/lib/engagement/refresh");
    bar("R1 pure: never requested ⇒ not due", reevaluationDue(null, null) === false);
    bar("R2 pure: requested, never re-evaluated ⇒ due", reevaluationDue(A4, null) === true);
    bar("R3 pure: requested BEFORE the last re-evaluation ⇒ not due",
      reevaluationDue(A4, new Date(A4.getTime() + 1000)) === false);
    bar("R4 pure: requested AFTER the last re-evaluation ⇒ due",
      reevaluationDue(new Date(A4.getTime() + 2000), A4) === true);
    // cBot is cold with 3 messages and no click, and nothing has touched it since B2.
    await db.execute(sql`UPDATE lifecycle_settings SET freeze_after_messages = 3 WHERE org_id = ${org}`);
    const rNo = await run({ mode: "incremental", dryRun: false, asOf: A4, since: plus(A4, 0, -0.5) });
    bar("R5 an ordinary incremental run does NOT see the new threshold",
      (await row(cBot)).status === "cold" && rNo.rowsWritten === 0, JSON.stringify(rNo.transitions));
    const rAll = await run({
      mode: "incremental", dryRun: false, asOf: A4, since: plus(A4, 0, -0.5), evaluateAll: true,
    });
    bar("R6 evaluateAll applies it: cBot cold→freeze",
      (await row(cBot)).status === "freeze" && rAll.transitions["cold→freeze"] === 1, JSON.stringify(rAll.transitions));
    const cBotLast = await one<{ reason: string; t: { freeze_after_messages: number } }>(sql`
      SELECT reason, thresholds AS t FROM contact_engagement_transitions
      WHERE contact_id = ${cBot.id}::uuid ORDER BY id DESC LIMIT 1`);
    bar("R7 recorded as a transition carrying the NEW thresholds",
      cBotLast.t.freeze_after_messages === 3, JSON.stringify(cBotLast));
    await db.execute(sql`UPDATE lifecycle_settings SET freeze_after_messages = 10 WHERE org_id = ${org}`);

    // ── PART G — status-at-send stamping (PR 2b) ─────────────────────────────
    // stage_send_lifecycle records what a contact's status WAS when the send
    // was materialized. It is written by a CTE inside bulkInsertStageSends —
    // the real statement is imported here, because a test that rebuilds the
    // SQL only compares the statement against a copy of itself.
    console.log("\nPART G — stage_send_lifecycle stamping at Prepare");
    const { bulkInsertStageSends } = await import("@/lib/sends/kickoff");

    // Three known statuses, including the one that has no row at all. Deleting
    // cWarm's row is how a contact uploaded minutes ago looks: no
    // contact_engagement record yet, which IS 'new' by contract
    // (db/schema.ts:4106-4108).
    await db.execute(sql`UPDATE contact_engagement SET status = 'hot' WHERE contact_id = ${cHot.id}::uuid`);
    await db.execute(sql`UPDATE contact_engagement SET status = 'freeze' WHERE contact_id = ${cBot.id}::uuid`);
    await db.execute(sql`DELETE FROM contact_engagement WHERE contact_id = ${cWarm.id}::uuid`);

    const gRows = [cHot, cBot, cWarm].map((c) => ({
      id: crypto.randomUUID(),
      orgId,
      campaignId: K1,
      stageId: S1,
      contactId: c.id,
      phone: c.phone,
      linkId: null,
      renderedText: "part G",
      leadId: `lead-${tag}-${c.id.slice(0, 8)}`,
      carrierNorm: null,
      providerPhoneId: null,
      costPerSms: null,
    }));
    const gIds = sql.join(gRows.map((r) => sql`${r.id}`), sql`, `);

    const gInserted = await bulkInsertStageSends(db, gRows);
    bar("G1 the insert still returns one row per send", gInserted === 3, `got ${gInserted}`);

    const gStamped = await all<{ status: string; reconstructed: boolean }>(sql`
      SELECT status, reconstructed FROM stage_send_lifecycle
      WHERE stage_send_id = ANY(ARRAY[${gIds}]::uuid[]) ORDER BY status`);
    bar("G2 every inserted send is stamped, and live rows are not reconstructed",
      gStamped.length === 3 && gStamped.every((r) => r.reconstructed === false),
      JSON.stringify(gStamped));
    bar("G3 hot/freeze stamp themselves; a contact with NO engagement row stamps 'new'",
      gStamped.map((r) => r.status).join(",") === "freeze,hot,new",
      gStamped.map((r) => r.status).join(","));

    // Re-materialization is idempotent by design: the send insert conflicts
    // away, so the stamp must too — and must not duplicate or overwrite.
    await db.execute(sql`UPDATE stage_send_lifecycle SET status = 'cold' WHERE stage_send_id = ${gRows[0].id}::uuid`);
    const gAgain = await bulkInsertStageSends(db, gRows);
    const gCount = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM stage_send_lifecycle WHERE stage_send_id = ANY(ARRAY[${gIds}]::uuid[])`);
    const gKept = await one<{ status: string } | undefined>(sql`
      SELECT status FROM stage_send_lifecycle WHERE stage_send_id = ${gRows[0].id}::uuid`);
    bar("G4 re-running inserts no send, no duplicate stamp, and does not overwrite",
      gAgain === 0 && Number(gCount.n) === 3 && gKept?.status === "cold",
      JSON.stringify({ gAgain, n: gCount.n, kept: gKept?.status ?? null }));

    bar("G5 the stamp is scoped to the send's org",
      (await one<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM stage_send_lifecycle
        WHERE stage_send_id = ANY(ARRAY[${gIds}]::uuid[]) AND org_id = ${org}`)).n === 3);

    // ── PART H — the contacts-list status filter ─────────────────────────────
    // Calls lifecycleStatusCondition, the function the route ships. A test that
    // rebuilt the SQL would only compare the statement against a copy of itself.
    // World right now: cHot hot, cBot freeze, cWarm has NO row, and the other
    // five carry whatever Parts B/E left them.
    console.log("\nPART H — lifecycleStatusCondition (contacts list filter)");
    const { lifecycleStatusCondition, parseLifecycleStatuses } = await import(
      "@/lib/engagement/list-filter"
    );
    const { ENGAGEMENT_STATUSES: H_ALL } = await import("@/lib/engagement/constants");

    const countWith = async (statuses: readonly string[]) => {
      const cond = lifecycleStatusCondition(orgId, statuses as never);
      return Number(
        (await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM contacts
          WHERE org_id = ${org}${cond ? sql` AND ${cond}` : sql``}`)).n,
      );
    };

    const hStored = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM contact_engagement WHERE org_id = ${org}`);
    bar("H1 precondition: one of the 8 contacts has no contact_engagement row",
      Number(hStored.n) === 7, `${hStored.n} stored rows`);

    const hNew = await countWith(["new"]);
    bar("H2 'new' finds the contact with NO engagement row — the bug a bare EXISTS causes",
      hNew === 1, `matched ${hNew}`);
    const hHot = await countWith(["hot"]);
    bar("H3 'hot' finds cHot", hHot === 1, `matched ${hHot}`);
    bar("H4 multi-select is a union", (await countWith(["hot", "new"])) === hHot + hNew,
      `${await countWith(["hot", "new"])} vs ${hHot}+${hNew}`);
    const hAll = await countWith(H_ALL);
    const hNone = await countWith([]);
    bar("H5 every status selected == no filter at all", hAll === hNone && hAll === 8,
      `${hAll} vs ${hNone}`);
    bar("H6 unknown values are dropped, and duplicates collapse",
      parseLifecycleStatuses("hot,nonsense,hot, warm ").join(",") === "hot,warm",
      parseLifecycleStatuses("hot,nonsense,hot, warm ").join(","));
    bar("H7 an empty param means no filter",
      lifecycleStatusCondition(orgId, parseLifecycleStatuses(null)) === null);

    // ── PART I — the 0188 projection on contacts.lifecycle_status ───────────
    // contact_engagement.status is the source of truth; contacts.lifecycle_status
    // is a projection the job maintains in the same transaction as the
    // transition row. The bar that matters is that they NEVER disagree after a
    // run — and that a drifted row heals rather than staying wrong forever,
    // which is what makes the 0188 reconcile safe to run at any time.
    console.log("\nPART I — contacts.lifecycle_status projection");

    const drift = async () =>
      Number(
        (await one<{ n: number }>(sql`
          SELECT count(*)::int AS n
          FROM contacts c
          JOIN contact_engagement ce ON ce.contact_id = c.id AND ce.org_id = c.org_id
          WHERE c.org_id = ${org} AND c.lifecycle_status IS DISTINCT FROM ce.status`)).n,
      );

    // Deliberately corrupt one row, the way a failed transaction or the window
    // between 0188's backfill and this code deploying would.
    await db.execute(sql`
      UPDATE contacts SET lifecycle_status = 'suppressed' WHERE id = ${cCold.id}::uuid`);
    bar("I1 a drifted row is visible before the run", (await drift()) >= 1);

    const iRun = await run({ mode: "full", dryRun: false, asOf: A4 });
    bar("I2 after a job run the projection and the source do not disagree",
      (await drift()) === 0, `${await drift()} disagreeing`);
    bar("I3 the run reports what it re-projected",
      iRun.projectionWritten >= 1, `projectionWritten=${iRun.projectionWritten}`);

    // A dry run must not touch the projection either.
    await db.execute(sql`
      UPDATE contacts SET lifecycle_status = 'hot' WHERE id = ${cCold.id}::uuid`);
    const iDry = await run({ mode: "full", dryRun: true, asOf: A4 });
    bar("I4 a dry run writes no projection", iDry.projectionWritten === 0 && (await drift()) === 1,
      `projectionWritten=${iDry.projectionWritten}`);
    await run({ mode: "full", dryRun: false, asOf: A4 }); // heal it again

    // A contact the job has never seen: no engagement row, and the column's
    // default is the same 'new' the rest of the system reads for it.
    const orphanPhone = fictionalPhones(9)[8];
    await refuseIfPhonesInUse(db, [orphanPhone]);
    const orphan = await one<{ id: string; lifecycle_status: string }>(sql`
      INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${orphanPhone})
      RETURNING id, lifecycle_status`);
    const orphanHasRow = Number(
      (await one<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM contact_engagement
        WHERE contact_id = ${orphan.id}::uuid`)).n,
    );
    bar("I5 a contact with no engagement row reads 'new'",
      orphan.lifecycle_status === "new" && orphanHasRow === 0,
      `${orphan.lifecycle_status}, engagement rows=${orphanHasRow}`);
  } finally {
    if (orgId) {
      const name = (await all<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the test marker (name=${JSON.stringify(name)})`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_engagement WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_engagement_transitions WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_offer_campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_send_lifecycle WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM lifecycle_settings WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left for this run`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  // ── PART C — the heartbeat watch ──────────────────────────────────────────
  console.log("\nPART C — watchEngagementHeartbeat");
  const onNow = await all<{ n: number }>(sql`SELECT count(*)::int AS n FROM lifecycle_settings WHERE engine_mode = 'write'`);
  if (Number(onNow[0].n) !== 0) {
    bar("C0 precondition: no org on this preview DB has the engine on", false, `${onNow[0].n} org(s) do — skipping C1/C2`);
  } else {
    const sent: string[] = [];
    const send = async (text: string) => {
      sent.push(text);
      return true;
    };
    const r = await watchEngagementHeartbeat(db, "incremental", { send });
    bar("C1 engine off everywhere ⇒ no check, no alert", r === null && sent.length === 0, JSON.stringify(r));
    const monitorOrg = (await one<{ id: string }>(sql`
      INSERT INTO organizations (name) VALUES (${`${MARKER} monitor-${Date.now()}`}) RETURNING id`)).id;
    try {
      await db.execute(sql`INSERT INTO lifecycle_settings (org_id, engine_mode) VALUES (${monitorOrg}::uuid, 'write')`);
      // Part C PREPARES its own world rather than asserting the preview DB has
      // never seen this job. It had asserted exactly that, and went red the first
      // time somebody legitimately ran the backfill here — a guard that expires
      // on correct use. cron_locks carries no org_id and the preview DB runs no
      // crons, so clearing these two rows is safe and repeatable.
      await db.execute(sql`
        DELETE FROM cron_locks
        WHERE job_name IN ('contact-engagement', 'contact-engagement:awaiting-first-run')`);
      {
        // PR #210's first-run grace: a job that has never run is not stale until
        // it has been missing longer than first_run_grace_hours (0.5 h here), so
        // the deploy that introduces the watch cannot page.
        const s1 = await watchEngagementHeartbeat(db, "incremental", { send });
        bar("C2a engine on + never ran, inside the grace ⇒ not stale, no alert",
          s1?.stale === false && sent.length === 0, `stale=${s1?.stale} sent=${sent.length}`);
        await db.execute(sql`
          UPDATE cron_locks SET watermark = now() - interval '1 hour'
          WHERE job_name = 'contact-engagement:awaiting-first-run'`);
        const s2 = await watchEngagementHeartbeat(db, "incremental", { send });
        const s3 = await watchEngagementHeartbeat(db, "incremental", { send });
        bar("C2b missing past the grace ⇒ stale, one alert, latched on the second check",
          s2?.stale === true && s3?.stale === true && sent.length === 1, `sent=${sent.length}`);
      }
    } finally {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${monitorOrg}::uuid AND name LIKE ${`${MARKER}%`}`);
      await watchEngagementHeartbeat(db, "incremental", { send }); // engine off again ⇒ clears the latch
      await db.execute(sql`DELETE FROM cron_locks WHERE job_name = 'contact-engagement:awaiting-first-run'`);
    }
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
