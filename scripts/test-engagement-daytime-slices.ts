import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Daytime engagement slices (plan: docs/superpowers/plans/2026-11-17-engagement-
// refresh-daytime-incremental-plan.md §5.1) against the PREVIEW DB.
//
// Two IDENTICAL throwaway orgs are built from one recipe and brought to the same
// starting state S0 (history, one full recount, a forced time-due contact, then
// a 90-minute send burst). Org A runs the daytime path — time slices of at most
// 7 contacts, killed once after slice 2 and resumed — and org B runs one full
// recount. Every value the send path reads must come out the same.
//
//   S1  per contact: status, last_sent_at, freeze_cadence_days, freeze clock,
//       msgs_since_click, last_click_at, time_due_at, contacts.lifecycle_status
//       (freeze_entered_at / time_due_at: the "now" each run stamped, ±15 min)
//   S2  contact_offer_campaigns rows identical as sets
//   S3  the eligibility layers (lifecycle + offer rules) return identical sets
//   S4  A never ran an org-wide pass: ≥ 3 slices, none recounting > 7 contacts
//   S5  the cursor moved per slice: a run killed after slice 2 leaves it there,
//       and the resumed run starts from it
//   S6  a daytime slice never escalates; the night path still does
//   S7  a time-due-only contact (hot → warm by age) transitions in A as in B
//   S10 a freeze contact whose clock is past 60 days with ≥ 2 in-freeze
//       messages moves to suppressed in A as in B (status + lifecycle_status +
//       the `suppressed` eligibility layer)
//   S11 a send 10 min before the window start, committed after the previous
//       run (inserted after S0), is caught through the 30-min overlap
//   S8  lag > 60 pages once (latched), ≤ 60 clears
//   S9  a normal burst (heartbeat 70 min old) is not stale; 100 min is
//   R1  red-proof: the S1 comparator catches one corrupted value
//
// Run: node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-engagement-daytime-slices.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__ENGAGEMENT_SLICES_TEST__";
const MIN = 60_000;
const DAY = 86_400_000;

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { refreshContactEngagement } = await import("@/lib/engagement/refresh");
  const { runDaytimeSlices, reportEngagementLag, packSlices, engagementLagAlertKey } = await import(
    "@/lib/engagement/daytime-slices"
  );
  const { engagementCursorJob } = await import("@/lib/engagement/constants");
  const { lifecycleExclusionLayers, offerRuleLayers } = await import("@/lib/sends/eligibility");
  const { checkHeartbeats, HEARTBEAT_JOBS } = await import("@/lib/reporting/cron-heartbeat");

  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const all = async <T>(q: SQL) => (await db.execute(q)) as unknown as T[];
  const one = async <T>(q: SQL) => (await all<T>(q))[0];
  const iso = (d: Date) => d.toISOString();

  // ── Pure: packSlices ─────────────────────────────────────────────────────
  {
    const f = new Date("2026-01-01T10:00:00Z");
    const t = new Date("2026-01-01T10:10:00Z");
    const m = (k: number, n: number) => ({ minute: new Date(f.getTime() + k * MIN), n });
    const ends = packSlices([m(0, 3), m(1, 3), m(2, 3), m(5, 9), m(6, 1)], f, t, 7);
    bar("P1 packSlices: ≤ max per slice, an oversized minute alone, last end = to",
      JSON.stringify(ends.map((d) => (d.getTime() - f.getTime()) / MIN)) === "[2,5,6,10]",
      JSON.stringify(ends.map((d) => (d.getTime() - f.getTime()) / MIN)));
    bar("P2 packSlices: no touched contacts ⇒ one slice ending at `to`",
      packSlices([], f, t, 7).length === 1 && packSlices([], f, t, 7)[0].getTime() === t.getTime());
  }

  const T0 = new Date();
  const ago = (ms: number) => new Date(T0.getTime() - ms);
  const tag = `sl-${Date.now()}`;
  const N_BURST = 30;
  const PER_WORLD = N_BURST + 8;
  const phones = fictionalPhones(2 * PER_WORLD);
  await refuseIfPhonesInUse(db, phones);

  type World = {
    orgId: string;
    contacts: Map<string, string>; // label → contact id
    O1: number;
    K1: number;
  };

  // One recipe, run twice. Older history is placed at whole days ± 12 h, away
  // from every 7/14/30/90-day edge, so seconds between the two runs never move it.
  const buildWorld = async (side: "A" | "B", phoneOffset: number): Promise<World> => {
    const orgId = (await one<{ id: string }>(sql`
      INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag} ${side}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    await db.execute(sql`INSERT INTO lifecycle_settings (org_id) VALUES (${org})`);
    const brand = (await one<{ id: number }>(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`B-${tag}-${side}`}, 'b') RETURNING id`)).id;
    const sd = (await one<{ id: number }>(sql`INSERT INTO short_domains (org_id, brand_id, domain) VALUES (${org}, ${brand}, ${`${tag}-${side}.test`}) RETURNING id`)).id;
    const dest = (await one<{ id: number }>(sql`INSERT INTO link_destinations (org_id, url, url_hash) VALUES (${org}, 'https://example.test/o', ${`h-${tag}-${side}`}) RETURNING id`)).id;
    const net = (await one<{ id: number }>(sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}-${side}`}, 'net') RETURNING id`)).id;
    const offer = async (c: string) =>
      (await one<{ id: number }>(sql`INSERT INTO offers (org_id, network_id, offer_id, name) VALUES (${org}, ${net}, ${`${tag}-${side}-${c}`}, ${c}) RETURNING id`)).id;
    const O1 = await offer("o1");
    const O2 = await offer("o2");
    const camp = async (c: string, o: number) =>
      (await one<{ id: number }>(sql`INSERT INTO campaigns (org_id, slug, name, link_mode, status, offer_id)
        VALUES (${org}, ${`${tag}-${side}-${c}`}, ${c}, 'tracked', 'active', ${o}) RETURNING id`)).id;
    const K = [await camp("k1", O1), await camp("k2", O2), await camp("k3", O1)];
    const S: number[] = [];
    for (const k of K) {
      S.push((await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id)
        VALUES (${org}, ${k}, 1, ${`trk-${tag}-${side}-${k}`}) RETURNING id`)).id);
    }
    const contacts = new Map<string, string>();
    const phoneOf = new Map<string, string>();
    let p = phoneOffset;
    const contact = async (label: string) => {
      const phone = phones[p++];
      const id = (await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${phone}) RETURNING id`)).id;
      contacts.set(label, id);
      phoneOf.set(label, phone);
    };
    const send = async (label: string, k: 0 | 1 | 2, when: Date) =>
      (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${org}, ${K[k]}, ${S[k]}, ${contacts.get(label)}::uuid, ${phoneOf.get(label)}, 'x', 'sent', ${iso(when)}::timestamptz)
        RETURNING id`)).id;
    let linkSeq = 0;
    const click = async (label: string, k: 0 | 1 | 2, sendId: string, clickedAt: Date, scoredAt: Date) => {
      const link = (await one<{ id: number }>(sql`
        INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
                           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES (${org}, ${`${tag}-${side}-${++linkSeq}`}, ${sd}, ${dest}, ${K[k]}, ${S[k]},
                ${contacts.get(label)}::uuid, ${sendId}, 'ct', 'st') RETURNING id`)).id;
      await db.execute(sql`INSERT INTO clicks (org_id, link_id, classification, clicked_at, scored_at)
        VALUES (${org}, ${link}, 'human', ${iso(clickedAt)}::timestamptz, ${iso(scoredAt)}::timestamptz)`);
    };
    const at = (days: number) => ago(days * DAY + 12 * 3_600_000);

    // History (before the window).
    for (let i = 0; i < N_BURST; i++) await contact(`b${i}`);
    for (let i = 0; i < 5; i++) await contact(`u${i}`);
    await contact("tdue");
    await contact("sup");
    await contact("late");
    for (let i = 0; i < 10; i++) for (let d = 0; d < 9; d++) await send(`b${i}`, (d % 3) as 0 | 1 | 2, at(20 + d)); // 9 → the burst makes 10: freeze
    for (let i = 10; i < 20; i++) for (let d = 0; d < 3; d++) await send(`b${i}`, (d % 2) as 0 | 1, at(12 + d)); // cold
    for (let i = 20; i < 25; i++) for (let d = 0; d < 4; d++) await send(`b${i}`, 1, at(15 + d)); // click in the burst → hot
    for (let i = 25; i < N_BURST; i++) for (let d = 0; d < 12; d++) await send(`b${i}`, (d % 3) as 0 | 1 | 2, at(40 + d)); // freeze
    for (let i = 0; i < 5; i++) for (let d = 0; d < 2 + i; d++) await send(`u${i}`, 0, at(30 + d)); // untouched
    const tdueSend = await send("tdue", 0, at(50));
    for (let d = 0; d < 12; d++) await send("sup", (d % 3) as 0 | 1 | 2, at(120 - d)); // freeze long ago
    for (const d of [70, 65]) await send("sup", 1, at(d)); // two in-freeze messages, the first 70 d ago
    for (let d = 0; d < 3; d++) await send("late", 0, at(12 + d)); // cold
    await click("tdue", 0, tdueSend, at(40), at(40)); // 40 d ago ⇒ warm by age

    // S0: one full recount over the history, as of now.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      await refreshContactEngagement(tx, orgId, { mode: "full", dryRun: false, daytimeSlice: null });
    });
    // A stored row the clock has overtaken: still 'hot', due an hour ago.
    await db.execute(sql`UPDATE contact_engagement SET status = 'hot', time_due_at = ${iso(ago(60 * MIN))}::timestamptz
      WHERE contact_id = ${contacts.get("tdue")}::uuid`);
    await db.execute(sql`UPDATE contacts SET lifecycle_status = 'hot' WHERE id = ${contacts.get("tdue")}::uuid`);
    // A freeze clock that started 100 days ago: the two later messages are in-freeze.
    await db.execute(sql`UPDATE contact_engagement SET status = 'freeze', freeze_entered_at = ${iso(ago(100 * DAY))}::timestamptz
      WHERE contact_id = ${contacts.get("sup")}::uuid`);
    await db.execute(sql`UPDATE contacts SET lifecycle_status = 'freeze' WHERE id = ${contacts.get("sup")}::uuid`);

    // The burst: one contact per minute over the last 90 minutes, then 5 clicks.
    for (let i = 0; i < N_BURST; i++) {
      const id = await send(`b${i}`, (i % 3) as 0 | 1 | 2, ago((90 - i * 3) * MIN));
      if (i >= 20 && i < 25) await click(`b${i}`, (i % 3) as 0 | 1 | 2, id, ago((88 - i * 3) * MIN), ago((87 - i * 3) * MIN));
    }
    await send("sup", 2, ago(10 * MIN)); // touched in the window ⇒ recounted ⇒ suppressed
    // Sent 10 min before the window start (cursor0 = now − 95 min) but committed
    // only now — what the 30-min overlap exists for.
    await send("late", 1, ago(105 * MIN));
    return { orgId, contacts, O1, K1: K[0] };
  };

  let A: World | undefined;
  let B: World | undefined;
  try {
    A = await buildWorld("A", 0);
    B = await buildWorld("B", PER_WORLD);
    const cursor0 = ago(95 * MIN);

    // ── Path A: daytime slices, killed after slice 2, then resumed ──────────
    let killedAt: number | null = null;
    try {
      await runDaytimeSlices({
        orgId: A.orgId, cursor: cursor0, overlapMinutes: 30, evaluateAll: false, maxTouched: 7,
        afterSlice: (i) => { if (i === 1) { killedAt = i; throw new Error("simulated kill"); } },
      });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "simulated kill") throw e;
    }
    const cur1 = await one<{ w: string }>(sql`SELECT watermark::text AS w FROM cron_locks WHERE job_name = ${engagementCursorJob(A.orgId)}`);
    const afterKill = cur1 ? new Date(cur1.w) : null;
    const run2 = await runDaytimeSlices({
      orgId: A.orgId, cursor: afterKill ?? cursor0, overlapMinutes: 30, evaluateAll: false, maxTouched: 7,
    });
    bar("S5 a run killed after slice 2 left the cursor inside the window; the resumed run started there and caught up",
      killedAt === 1 && afterKill != null && afterKill > cursor0 && afterKill < T0 && run2.caughtUp,
      `cursor after kill ${afterKill?.toISOString()}, resumed slices ${run2.slices}, caughtUp ${run2.caughtUp}`);
    bar("S4 no org-wide pass: ≥ 3 slices, none recounting more than 7 contacts, none escalated",
      run2.slices + 2 >= 3 && run2.maxSliceRecounted <= 7 && run2.results.every((r) => !r.escalatedToFull),
      `slices ${run2.slices}+2, max per slice ${run2.maxSliceRecounted}`);

    // ── Path B: one full recount ────────────────────────────────────────────
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      await refreshContactEngagement(tx, B!.orgId, { mode: "full", dryRun: false, daytimeSlice: null });
    });

    // ── Comparisons, keyed by label ─────────────────────────────────────────
    type Row = Record<string, string | null>;
    const snapshot = async (w: World) => {
      const rows = await all<Row & { contact_id: string }>(sql`
        SELECT c.id AS contact_id, c.lifecycle_status, ce.status, ce.last_sent_at::text, ce.freeze_cadence_days::text,
               ce.freeze_started_at::text, ce.freeze_msgs::text, ce.msgs_since_click::text, ce.last_click_at::text,
               extract(epoch FROM ce.freeze_entered_at)::bigint::text AS fe, extract(epoch FROM ce.time_due_at)::bigint::text AS due
        FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id WHERE c.org_id = ${w.orgId}::uuid`);
      const byId = new Map(rows.map((r) => [r.contact_id, r]));
      const out = new Map<string, Row>();
      for (const [label, id] of w.contacts) out.set(label, byId.get(id)!);
      return out;
    };
    const EXACT = ["lifecycle_status", "status", "last_sent_at", "freeze_cadence_days", "freeze_started_at", "freeze_msgs", "msgs_since_click", "last_click_at"];
    const diff = (a: Map<string, Row>, b: Map<string, Row>) => {
      const out: string[] = [];
      for (const [label, ra] of a) {
        const rb = b.get(label)!;
        for (const k of EXACT) if (ra[k] !== rb[k]) out.push(`${label}.${k}: ${ra[k]} ≠ ${rb[k]}`);
        for (const k of ["fe", "due"]) {
          const x = ra[k] == null ? null : Number(ra[k]);
          const y = rb[k] == null ? null : Number(rb[k]);
          if ((x == null) !== (y == null) || (x != null && y != null && Math.abs(x - y) > 900)) out.push(`${label}.${k}: ${ra[k]} ≠ ${rb[k]}`);
        }
      }
      return out;
    };
    const sa = await snapshot(A);
    const sb = await snapshot(B);
    const d1 = diff(sa, sb);
    const statuses = [...sb.values()].map((r) => r.status).sort().join(",");
    bar("S1 every send-path value per contact is identical between the slice path and a full recount",
      d1.length === 0, d1.length ? d1.slice(0, 6).join("; ") : `${sa.size} contacts; statuses ${statuses}`);
    const covered = new Set([...sb.values()].map((r) => r.status));
    bar("S1b the world exercises cold, freeze, hot and warm", ["cold", "freeze", "hot", "warm"].every((s) => covered.has(s)), [...covered].join(","));

    const coc = async (w: World) => {
      const label = new Map([...w.contacts].map(([l, id]) => [id, l]));
      const rows = await all<{ contact_id: string; offer: string; campaign: string; f: string; l: string; m: number }>(sql`
        SELECT coc.contact_id, o.name AS offer, ca.name AS campaign, coc.first_sent_at::text AS f, coc.last_sent_at::text AS l, coc.messages AS m
        FROM contact_offer_campaigns coc JOIN offers o ON o.id = coc.offer_id JOIN campaigns ca ON ca.id = coc.campaign_id
        WHERE coc.org_id = ${w.orgId}::uuid`);
      return rows.map((r) => `${label.get(r.contact_id)}|${r.offer}|${r.campaign}|${r.f}|${r.l}|${r.m}`).sort();
    };
    const ca = await coc(A);
    const cb = await coc(B);
    bar("S2 contact_offer_campaigns rows are identical as sets",
      JSON.stringify(ca) === JSON.stringify(cb), `${ca.length} vs ${cb.length} rows`);

    const layerSets = async (w: World) => {
      const label = new Map([...w.contacts].map(([l, id]) => [id, l]));
      const layers = [
        ...lifecycleExclusionLayers({ orgId: w.orgId, offerId: w.O1 }),
        ...offerRuleLayers({ orgId: w.orgId, offerId: w.O1, currentCampaignId: w.K1, cooldownDays: 7, limitTimes: 1 }),
      ];
      const out: Record<string, string[]> = {};
      for (const l of layers) {
        out[l.key] = (await all<{ contact_id: string }>(l.sql)).map((r) => label.get(r.contact_id) ?? "?").sort();
      }
      return out;
    };
    const la = await layerSets(A);
    const lb = await layerSets(B);
    const nonEmpty = Object.entries(lb).filter(([, v]) => v.length > 0).map(([k, v]) => `${k}:${v.length}`);
    bar("S3 every eligibility layer returns the same contacts on both states",
      JSON.stringify(la) === JSON.stringify(lb), nonEmpty.join(" "));

    bar("S7 the time-due contact (hot, click 40 d ago, untouched by the burst) is warm in both",
      sa.get("tdue")?.status === "warm" && sb.get("tdue")?.status === "warm",
      `A=${sa.get("tdue")?.status} B=${sb.get("tdue")?.status}`);

    bar("S10 the freeze contact past its 60-day clock is suppressed in both, and in the suppressed layer of both",
      sa.get("sup")?.status === "suppressed" && sb.get("sup")?.status === "suppressed"
        && sa.get("sup")?.lifecycle_status === "suppressed" && sb.get("sup")?.lifecycle_status === "suppressed"
        && la.suppressed?.includes("sup") === true && lb.suppressed?.includes("sup") === true,
      `A=${sa.get("sup")?.status}/${sa.get("sup")?.lifecycle_status} B=${sb.get("sup")?.status}/${sb.get("sup")?.lifecycle_status}`);
    const lateTotal = async (w: World) =>
      (await one<{ n: number }>(sql`SELECT msgs_total AS n FROM contact_engagement WHERE contact_id = ${w.contacts.get("late")}::uuid`)).n;
    const [ltA, ltB] = [await lateTotal(A), await lateTotal(B)];
    bar("S11 the send 10 min before the window start is counted in A (via the overlap) as in B",
      Number(ltA) === 4 && Number(ltB) === 4, `msgs_total A=${ltA} B=${ltB}`);

    // ── S6: escalation ──────────────────────────────────────────────────────
    const dry = (daytimeSlice: { until: Date; evaluateTimeDue: boolean } | null) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
        const r = await refreshContactEngagement(tx, B!.orgId, {
          mode: "incremental", dryRun: true, since: ago(95 * MIN), maxTouched: 3, daytimeSlice,
        });
        return r;
      });
    const night = await dry(null);
    const day = await dry({ until: new Date(), evaluateTimeDue: false });
    bar("S6 above maxTouched the night path escalates; a daytime slice never does",
      night.escalatedToFull === true && day.escalatedToFull === false && day.recounted > 3,
      `night escalated=${night.escalatedToFull} recounted=${night.recounted}; day escalated=${day.escalatedToFull} recounted=${day.recounted}`);

    // ── S8: lag alert ───────────────────────────────────────────────────────
    const sent: string[] = [];
    const send = async (t: string) => { sent.push(t); return true; };
    await reportEngagementLag(db, A.orgId, 61, send);
    await reportEngagementLag(db, A.orgId, 75, send);
    const afterFiring = sent.length;
    await reportEngagementLag(db, A.orgId, 59, send);
    await reportEngagementLag(db, A.orgId, 0, send);
    bar("S8 lag 61 pages once, stays latched at 75, and 59 / 0 send nothing",
      afterFiring === 1 && sent.length === 1 && /61 min behind/.test(sent[0] ?? ""), `${sent.length} message(s)`);

    // ── S9: heartbeat age on a normal burst ─────────────────────────────────
    const hbJob = `${MARKER}-hb-${tag}`;
    const exp = { ...HEARTBEAT_JOBS.contactEngagement, job_name: hbJob, first_run_grace_hours: undefined };
    await db.execute(sql`INSERT INTO cron_locks (job_name, watermark) VALUES (${hbJob}, now() - interval '70 minutes')`);
    const [h70] = await checkHeartbeats(db, [exp]);
    await db.execute(sql`UPDATE cron_locks SET watermark = now() - interval '100 minutes' WHERE job_name = ${hbJob}`);
    const [h100] = await checkHeartbeats(db, [exp]);
    let burstPages = 0;
    for (const lag of [20, 35, 45, 0]) {
      const before = sent.length;
      await reportEngagementLag(db, A.orgId, lag, send);
      burstPages += sent.length - before;
    }
    bar("S9 a 45-min burst (heartbeat 70 min old, lags 20/35/45) pages neither watcher; 100 min is stale",
      !h70.stale && h100.stale && burstPages === 0,
      `70 min stale=${h70.stale}, 100 min stale=${h100.stale}, burst pages=${burstPages}, max_age=${exp.max_age_hours} h`);
    await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${hbJob}`);

    // ── R1: the comparator is not blind ─────────────────────────────────────
    await db.execute(sql`UPDATE contact_engagement SET msgs_since_click = msgs_since_click + 1 WHERE contact_id = ${A.contacts.get("b12")}::uuid`);
    const dr = diff(await snapshot(A), sb);
    bar("R1 red-proof: one corrupted value in A is reported, and only that one",
      dr.length === 1 && dr[0].startsWith("b12.msgs_since_click"), dr.join("; "));
  } finally {
    for (const w of [A, B]) {
      if (!w) continue;
      const name = (await all<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${w.orgId}::uuid`))[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${w.orgId} lacks the marker (${JSON.stringify(name)})`);
        fail++;
        continue;
      }
      await db.execute(sql`DELETE FROM organizations WHERE id = ${w.orgId}::uuid`);
      await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${engagementCursorJob(w.orgId)}`);
      await db.execute(sql`DELETE FROM alert_state WHERE alert_key = ${engagementLagAlertKey(w.orgId)}`);
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${w.orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${w.orgId}::uuid)
              + (SELECT count(*) FROM contact_engagement WHERE org_id = ${w.orgId}::uuid)
              + (SELECT count(*) FROM contact_offer_campaigns WHERE org_id = ${w.orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${w.orgId}::uuid)
              + (SELECT count(*) FROM cron_locks WHERE job_name = ${engagementCursorJob(w.orgId)})
              + (SELECT count(*) FROM alert_state WHERE alert_key = ${engagementLagAlertKey(w.orgId)})) AS n`);
      console.log(`Teardown ${w.orgId}: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
