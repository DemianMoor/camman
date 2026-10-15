// scripts/test-drip-hour-overflow.ts — drip hour-level overflow (spec 2026-10-14 §2/§3/§6), PREVIEW DB.
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { db } from "@/db/client";
import { prepareHourly } from "@/lib/drip/hourly-maintenance";
import { hourCommitted, loadHourCounts, loadOpenWindowCampaigns } from "@/lib/drip/hourly-room";
import { runDripRoutingBatch } from "@/lib/drip/routing";
import {
  classifyRoutingOutcome, evaluateLeadRouting, loadCampaignJourneyCounts, overflowSkips,
  type CandidateVerdict, type LeadRoutingEvaluation,
} from "@/lib/drip/routing-eval";
import {
  candidateBadgeLabel, hourFallbackLine, overflowLines, routingNoteLines,
} from "@/lib/drip/overflow-text";
import { makeFixture } from "./_drip-hourly-fixture";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hour-overflow.ts
//
//   H-O1  hour flag OFF (day flag on, and off) ⇒ no hour_capacity / kind / hour_fallback anywhere;
//         stored reason == the main-shape reason built from the verdict; zero hour queries
//   H-O2  A hour-full, B room ⇒ B, overflowed_from [{kind:"hour", "hour full (3/3 this hour)"}]
//   H-O3  A day-full, B hour-full ⇒ O3 fallback to B, hour_fallback, A recorded kind "day"
//   H-O4  no hourly cap on A ⇒ never hour-full
//   H-O5  A's window closed now ⇒ rule absent; routes to A and waits
//   H-O6  one run, A/B cap 3, 8 leads ⇒ A 3 + 2 fallback, B 3; ONE hour-count + ONE windows query
//   H-O7  race: maintenance release between evaluation and insert ⇒ over-commit ≤ routed; room = cap − sentH
//   H-O8  hour boundary: carry-ON queue makes A full from :00 ⇒ divert to B; never re-routed
//   H-O9  (owner) single candidate, hour-full, day room, carry ON ⇒ routes and queues exactly as flag-off
//   H-O10 (owner) carry-ON queue > cap ⇒ fresh leads still route, never defer
//   H-O11 pure: why-not-routed text helpers (day text byte-identical, hour, fallback)
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const Z = (iso: string) => new Date(iso);
const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

// 2026-10-13 is EDT (UTC−4). Fixture windows are 09:00–18:00 ET.
const H = Z("2026-10-13T18:00:00Z");      // 14:00 ET
const NOW = Z("2026-10-13T18:10:00Z");    // 14:10 ET, window open
const MIN = 60_000;

// ── query log: proves "per run at most one hour-count + one windows query, only when flags on"
const dialect = new PgDialect();
let qlog: string[] | null = null;
const origExecute = db.execute.bind(db);
(db as unknown as { execute: (q: SQL) => unknown }).execute = (q: SQL) => {
  if (qlog) { try { qlog.push(dialect.sqlToQuery(q).sql); } catch { qlog.push(String(q)); } }
  return origExecute(q);
};
const hourQueries = (log: string[]) => log.filter((s) => s.includes("pending_fresh")).length;
const windowQueries = (log: string[]) => log.filter((s) => s.includes("cr.text AS creative_text")).length;

type Fx = Awaited<ReturnType<typeof makeFixture>>;
type J = { state: string; campaign_id: number | null; reason: Record<string, unknown>; hour_start: string | null; hour_fresh: boolean | null };
const journeyOf = (leadId: string) => one<J | undefined>(sql`
  SELECT state, campaign_id, reason, hour_start::text AS hour_start, hour_fresh FROM drip_journeys WHERE lead_event_id = ${leadId}::uuid`);
const recheckOf = async (leadId: string) =>
  (await one<{ r: string | null }>(sql`SELECT drip_recheck_at::text AS r FROM lead_events WHERE id = ${leadId}::uuid`)).r;
const setFlags = (orgId: string, f: { day: boolean; hour: boolean }) => db.execute(sql`
  UPDATE org_settings SET drip_routing_send_capacity = ${f.day}, drip_routing_hour_overflow = ${f.hour}
  WHERE org_id = ${orgId}::uuid`);
const route = (fx: Fx, now: Date) => runDripRoutingBatch(now, { onlyOrgId: fx.orgId });
/** n journeys first-sent inside hour H (routed earlier, so they are never pendingFresh). */
const sentThisHour = async (fx: Fx, campaignId: number, n: number, at = Z("2026-10-13T18:02:00Z")) => {
  const ids = await fx.journeys(campaignId, n, Z("2026-10-13T13:00:00Z"));
  await fx.markSent(ids, at);
};
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function scenario(name: string, fn: (fx: Fx) => Promise<void>) {
  console.log(`\n${name}`);
  const fx = await makeFixture();
  try { await fn(fx); } finally {
    const left = await fx.teardown();
    bar(`${name.split(" ")[0]} teardown leaves nothing`, left === 0, String(left));
  }
}

function pure() {
  console.log("\nP pure: overflowSkips kinds, classification ignores hour_capacity");
  const cand = (id: number, priority: number, failing: Record<string, string> = {}): CandidateVerdict => {
    const rules: CandidateVerdict["rules"] = { interest_tag: "pass" };
    for (const k of Object.keys(failing)) rules[k] = k === "interest_tag" ? "mismatch" : "blocked";
    return { campaign_id: id, campaign_name: `C${id}`, priority, rules, detail: { ...failing }, eligible: Object.keys(failing).length === 0 };
  };
  const day = { send_capacity: "campaign full (5/5 today: 5 sent + 0 queued)" };
  const hour = { hour_capacity: "hour full (3/3 this hour)" };
  const w = cand(9, 100);
  const s = overflowSkips([cand(1, 90, hour), cand(2, 91, { ...day, ...hour }), cand(3, 92, day), w], w, { hourRuleOn: true });
  bar("P1 hour-only ⇒ kind hour with the hour text", s[0]?.kind === "hour" && s[0].detail === hour.hour_capacity, JSON.stringify(s[0]));
  bar("P2 day AND hour ⇒ kind day with the unchanged day text", s[1]?.kind === "day" && s[1].detail === day.send_capacity, JSON.stringify(s[1]));
  bar("P3 day-only ⇒ kind day", s[2]?.kind === "day" && s[2].detail === day.send_capacity);
  const off = overflowSkips([cand(3, 92, day), w], w, { hourRuleOn: false });
  bar("P4 hour rule off ⇒ no kind key", off.length === 1 && !("kind" in off[0]));
  bar("P5 hour + a filter mismatch ⇒ not an overflow",
    overflowSkips([cand(1, 90, { ...hour, interest_tag: "x" }), w], w, { hourRuleOn: true }).length === 0);
  const v = (candidates: CandidateVerdict[], global: Record<string, "pass" | "blocked"> = {}): LeadRoutingEvaluation => ({
    lead_event_id: "x", contact_id: "y", phone: null, interest_tag: "t", partner_key_id: 1, received_at: new Date().toISOString(),
    global: { opted_out: "pass", in_use: "pass", week_rule: "pass", ...global }, globalDetail: {},
    candidates, winner: null, send_capacity_on: true, overflowed_from: [], hour_fallback: false,
  });
  bar("P6 day-full AND hour-full ⇒ defer (as flag off), never permanent",
    classifyRoutingOutcome(v([cand(1, 90, { ...day, ...hour })])) === "defer");
  bar("P7 contact in use + hour-only candidate ⇒ defer (as flag off)",
    classifyRoutingOutcome(v([cand(1, 90, hour)], { in_use: "blocked" })) === "defer");
  bar("P8 tag mismatch + hour ⇒ permanent (as flag off)",
    classifyRoutingOutcome(v([cand(1, 90, { ...hour, interest_tag: "x" })])) === "permanent");
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  pure();

  // ── H-O1 ────────────────────────────────────────────────────────────────
  for (const day of [true, false]) {
    await scenario(`H-O1${day ? "a" : "b"} hour flag OFF, day flag ${day ? "ON" : "OFF"}`, async (fx) => {
      await setFlags(fx.orgId, { day, hour: false });
      const tag = "t1";
      const z = await fx.campaign("z", 3, true, true, { interestTag: tag, priority: 90, dailyCap: 1 });
      await fx.journeys(z, 1, Z("2026-10-13T12:00:00Z"));          // U = 1 ⇒ day-full when the day flag is on
      const a = await fx.campaign("a", 3, true, true, { interestTag: tag, priority: 97 });
      await sentThisHour(fx, a, 3);                                // hour-full — must be ignored
      await fx.campaign("b", 3, true, true, { interestTag: tag, priority: 100 });
      const l = await fx.lead(tag, Z("2026-10-13T18:09:00Z"));
      const v = (await evaluateLeadRouting(db, { orgId: fx.orgId, leadEventId: l, now: NOW }))!;
      qlog = [];
      await route(fx, NOW);
      const log = qlog; qlog = null;
      const j = (await journeyOf(l))!;
      const stored = JSON.stringify(j.reason);
      bar("verdict: no hour_capacity rule on any candidate", v.candidates.every((c) => !("hour_capacity" in c.rules)));
      bar("verdict: hour_fallback false", v.hour_fallback === false);
      bar("verdict: overflowed_from entries carry no kind", v.overflowed_from.every((o) => !("kind" in o)), JSON.stringify(v.overflowed_from));
      bar("stored reason: no hour_capacity / kind / hour_fallback",
        !/hour_capacity|"kind"|hour_fallback/.test(stored), stored.slice(0, 200));
      bar(`winner as main: ${day ? "A (Z day-full)" : "Z"}`, j.campaign_id === (day ? a : z), String(j.campaign_id));
      if (day) {
        bar("day overflow entry keeps main's exact keys and text",
          v.overflowed_from.length === 1 &&
          same(Object.keys(v.overflowed_from[0]).sort(), ["campaign_id", "campaign_name", "detail", "priority"]) &&
          v.overflowed_from[0].detail === "campaign full (1/1 today: 0 sent + 1 queued)", JSON.stringify(v.overflowed_from));
      }
      // The reason exactly as origin/main a4a5d3c2 builds it from the same verdict.
      const mainReason = {
        won_by: "priority", priority: v.winner!.priority, campaign_id: v.winner!.campaign_id,
        skipped: v.candidates.filter((c) => c.campaign_id !== v.winner!.campaign_id)
          .map((c) => ({ campaign_id: c.campaign_id, eligible: c.eligible, detail: c.detail })),
        ...(v.overflowed_from.length > 0 && { overflowed_from: v.overflowed_from, campaign_name: v.winner!.campaign_name }),
        evaluated_at: NOW.toISOString(),
      };
      bar("stored reason == main-shape reason (byte identity modulo jsonb key order)", same(j.reason, mainReason), stored);
      bar("zero hour-count / windows queries with the flag off", hourQueries(log) === 0 && windowQueries(log) === 0,
        `${hourQueries(log)}/${windowQueries(log)}`);
    });
  }
  await scenario("H-O1c hour flag ON but day flag OFF ⇒ rule absent (O2)", async (fx) => {
    await setFlags(fx.orgId, { day: false, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
    await sentThisHour(fx, a, 3);
    await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    const l = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
    const v = (await evaluateLeadRouting(db, { orgId: fx.orgId, leadEventId: l, now: NOW }))!;
    bar("no hour_capacity, A wins", v.candidates.every((c) => !("hour_capacity" in c.rules)) && v.winner?.campaign_id === a);
  });

  // ── H-O2 ────────────────────────────────────────────────────────────────
  await scenario("H-O2 A hour-full, B room ⇒ B", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
    const b = await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    await sentThisHour(fx, a, 3);
    const l = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
    const live = (await evaluateLeadRouting(db, { orgId: fx.orgId, leadEventId: l, now: NOW }))!;
    const ca = live.candidates.find((c) => c.campaign_id === a)!;
    const cb = live.candidates.find((c) => c.campaign_id === b)!;
    bar("live (uncached) eval: A hour_capacity blocked with the exact detail",
      ca.rules.hour_capacity === "blocked" && ca.detail.hour_capacity === "hour full (3/3 this hour)", JSON.stringify(ca.detail));
    bar("live eval: B hour_capacity pass, no detail", cb.rules.hour_capacity === "pass" && !("hour_capacity" in cb.detail));
    await route(fx, NOW);
    const j = (await journeyOf(l))!;
    bar("routes to B", j.campaign_id === b, String(j.campaign_id));
    bar("overflowed_from [{A, kind hour, hour full (3/3 this hour)}]", same(j.reason.overflowed_from, [{
      campaign_id: a, campaign_name: "HC a", priority: 97, detail: "hour full (3/3 this hour)", kind: "hour",
    }]), JSON.stringify(j.reason.overflowed_from));
    bar("no hour_fallback key (not a fallback)", !("hour_fallback" in j.reason));
  });

  // ── H-O3 ────────────────────────────────────────────────────────────────
  await scenario("H-O3 A day-full, B hour-full ⇒ O3 fallback to B", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97, dailyCap: 1 });
    await fx.journeys(a, 1, Z("2026-10-13T12:00:00Z"));
    const b = await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    await sentThisHour(fx, b, 3);
    const l = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
    const res = await route(fx, NOW);
    const j = (await journeyOf(l))!;
    bar("routes to B, not deferred", j?.campaign_id === b && res.deferred === 0, `${j?.campaign_id} deferred=${res.deferred}`);
    bar("hour_fallback: true", j.reason.hour_fallback === true);
    bar("overflowed_from has A, kind day, day text unchanged", same(j.reason.overflowed_from, [{
      campaign_id: a, campaign_name: "HC a", priority: 97, detail: "campaign full (1/1 today: 0 sent + 1 queued)", kind: "day",
    }]), JSON.stringify(j.reason.overflowed_from));
  });

  // ── H-O4 ────────────────────────────────────────────────────────────────
  await scenario("H-O4 no hourly cap on A ⇒ never hour-full", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", null, true, true, { interestTag: "t", priority: 97 });
    await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    await sentThisHour(fx, a, 5);
    const l = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
    const v = (await evaluateLeadRouting(db, { orgId: fx.orgId, leadEventId: l, now: NOW }))!;
    bar("A has no hour_capacity rule", !("hour_capacity" in v.candidates.find((c) => c.campaign_id === a)!.rules));
    await route(fx, NOW);
    bar("routes to A", (await journeyOf(l))?.campaign_id === a);
  });

  // ── H-O5 ────────────────────────────────────────────────────────────────
  await scenario("H-O5 A's window closed now ⇒ rule absent", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 1, true, true, { interestTag: "t", priority: 97 });
    await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    await sentThisHour(fx, a, 1);                                  // would be full if the rule applied
    await db.execute(sql`UPDATE campaign_stages SET window_start_min = 600, window_end_min = 660 WHERE campaign_id = ${a}`);
    const l = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
    const v = (await evaluateLeadRouting(db, { orgId: fx.orgId, leadEventId: l, now: NOW }))!;
    bar("A has no hour_capacity rule (window 10–11 ET closed at 14:10)",
      !("hour_capacity" in v.candidates.find((c) => c.campaign_id === a)!.rules));
    await route(fx, NOW);
    const j = (await journeyOf(l))!;
    bar("routes to A and waits (routed, no hour)", j.campaign_id === a && j.state === "routed" && j.hour_start === null);
  });

  // ── H-O6 ────────────────────────────────────────────────────────────────
  await scenario("H-O6 pendingFresh in one run", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
    const b = await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    const leads: string[] = [];
    for (let i = 0; i < 8; i++) leads.push(await fx.lead("t", new Date(Z("2026-10-13T18:01:00Z").getTime() + i * 1000)));
    qlog = [];
    const res = await route(fx, NOW);
    const log = qlog; qlog = null;
    const js = await Promise.all(leads.map(journeyOf));
    const toA = js.filter((j) => j?.campaign_id === a).length;
    const toB = js.filter((j) => j?.campaign_id === b).length;
    const fb = js.filter((j) => j?.reason.hour_fallback === true);
    bar("A 5 (3 + 2 fallback), B 3, none deferred", toA === 5 && toB === 3 && res.deferred === 0, `A ${toA} B ${toB} def ${res.deferred}`);
    bar("the 2 fallbacks are the last two leads, on A",
      fb.length === 2 && fb.every((j) => j!.campaign_id === a) && js[6]?.reason.hour_fallback === true && js[7]?.reason.hour_fallback === true);
    bar("B's leads record A as kind hour (3/3)", js.filter((j) => j?.campaign_id === b).every((j) =>
      same(j!.reason.overflowed_from, [{ campaign_id: a, campaign_name: "HC a", priority: 97, detail: "hour full (3/3 this hour)", kind: "hour" }])));
    const w = await loadOpenWindowCampaigns(db, { campaignIds: [a, b] });
    const hc = await loadHourCounts(db, { campaigns: [{ id: a, windows: w.get(a)! }, { id: b, windows: w.get(b)! }], hourStart: H });
    bar("DB agrees with the in-tick cache (pendingFresh A 5, B 3)",
      hc.get(a)!.pendingFresh === 5 && hc.get(b)!.pendingFresh === 3, JSON.stringify([...hc]));
    bar("ONE hour-count query and ONE windows query for the whole 8-lead run",
      hourQueries(log) === 1 && windowQueries(log) === 1, `${hourQueries(log)}/${windowQueries(log)}`);
  });

  // ── H-O7 ────────────────────────────────────────────────────────────────
  await scenario("H-O7 race: release between evaluation and insert", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
    const b = await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    await fx.journeys(a, 3, Z("2026-10-12T15:00:00Z"));          // waiting backlog (yesterday, hour_start NULL)
    const l1 = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
    const counts = await loadCampaignJourneyCounts(db, { orgId: fx.orgId, now: NOW });
    const v = (await evaluateLeadRouting(db, { orgId: fx.orgId, leadEventId: l1, now: NOW, counts }))!;
    bar("evaluation read A with room", v.winner?.campaign_id === a && counts.get(a)!.hour !== null &&
      hourCommitted(counts.get(a)!.hour!.counts) === 0);
    const deps = { hasHeadroom: async () => true };
    const prep = await prepareHourly(db, { orgId: fx.orgId, now: NOW, notify: async () => undefined, deps });
    bar("maintenance released the backlog into the hour", prep.released === 3, String(prep.released));
    // routing's insert, after the release read (same statement shape as routing.ts)
    await db.execute(sql`
      INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
      SELECT ${fx.orgId}::uuid, ${a}, contact_id, id, 'routed', ${NOW.toISOString()}::timestamptz, '{}'::jsonb, 0
      FROM lead_events WHERE id = ${l1}::uuid`);
    const w = await loadOpenWindowCampaigns(db, { campaignIds: [a] });
    const hc = (await loadHourCounts(db, { campaigns: [{ id: a, windows: w.get(a)! }], hourStart: H })).get(a)!;
    const over = hourCommitted(hc) - 3;
    bar("over-commit ≤ leads routed in that run (1)", over <= 1 && over >= 0, `committed ${hourCommitted(hc)}`);
    bar("scheduler room = cap − sentH (3), unaffected", prep.rooms.get(a)?.room === 3 - hc.sentH, JSON.stringify(prep.rooms.get(a)));
    const prep2 = await prepareHourly(db, { orgId: fx.orgId, now: new Date(NOW.getTime() + MIN), notify: async () => undefined, deps });
    bar("next maintenance pass: room still cap − sentH ≤ cap (no send overshoot possible)",
      prep2.rooms.get(a)?.room === 3 - hc.sentH, JSON.stringify(prep2.rooms.get(a)));
    const l2 = await fx.lead("t", Z("2026-10-13T18:10:00Z"));
    await route(fx, new Date(NOW.getTime() + 2 * MIN));
    bar("the next run sees A full and diverts to B", (await journeyOf(l2))?.campaign_id === b);
  });

  // ── H-O8 ────────────────────────────────────────────────────────────────
  await scenario("H-O8 hour boundary, no ping-pong", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
    const b = await fx.campaign("b", 3, true, true, { interestTag: "t", priority: 100 });
    const t1 = Z("2026-10-13T14:55:00Z");                          // 10:55 ET
    const first: string[] = [];
    for (let i = 0; i < 10; i++) first.push(await fx.lead("t", new Date(Z("2026-10-13T14:50:00Z").getTime() + i * 1000)));
    await route(fx, t1);
    const js1 = await Promise.all(first.map(journeyOf));
    const a1 = js1.filter((j) => j?.campaign_id === a).length;
    const b1 = js1.filter((j) => j?.campaign_id === b).length;
    bar("10:55: A 3 + 4 fallback = 7, B 3", a1 === 7 && b1 === 3, `A ${a1} B ${b1}`);
    await prepareHourly(db, { orgId: fx.orgId, now: Z("2026-10-13T14:56:00Z"), notify: async () => undefined, deps: { hasHeadroom: async () => true } });
    // the scheduler sends each campaign's 3 in hour 10
    for (const c of [a, b]) {
      const ids = (await db.execute(sql`
        SELECT id FROM drip_journeys WHERE campaign_id = ${c} ORDER BY routed_at, id LIMIT 3`)) as unknown as { id: string }[];
      await fx.markSent(ids.map((r) => r.id), Z("2026-10-13T14:57:00Z"));
    }
    const t2 = Z("2026-10-13T15:01:00Z");                          // 11:01 ET
    const second = [await fx.lead("t", Z("2026-10-13T15:00:10Z")), await fx.lead("t", Z("2026-10-13T15:00:20Z"))];
    await route(fx, t2);
    const js2 = await Promise.all(second.map(journeyOf));
    bar("11:01: A full from :00 by its queue (4) ⇒ both new leads to B",
      js2.every((j) => j?.campaign_id === b && same(j.reason.overflowed_from,
        [{ campaign_id: a, campaign_name: "HC a", priority: 97, detail: "hour full (4/3 this hour)", kind: "hour" }])),
      JSON.stringify(js2.map((j) => [j?.campaign_id, j?.reason.overflowed_from])));
    const per = (await db.execute(sql`
      SELECT e.id, count(j.id)::int AS n, min(j.campaign_id) AS c FROM lead_events e
      LEFT JOIN drip_journeys j ON j.lead_event_id = e.id
      WHERE e.id = ANY(${`{${[...first, ...second].join(",")}}`}::uuid[]) GROUP BY e.id`)) as unknown as { id: string; n: number; c: number }[];
    bar("every lead exactly one journey", per.length === 12 && per.every((r) => r.n === 1));
    bar("first-batch journeys never re-routed", first.every((id, i) => per.find((r) => r.id === id)?.c === js1[i]?.campaign_id));
    const sent10 = (await db.execute(sql`
      SELECT campaign_id, count(*)::int AS n FROM drip_journeys
      WHERE campaign_id IN (${a}, ${b}) AND first_send_at >= '2026-10-13T14:00:00Z' AND first_send_at < '2026-10-13T15:00:00Z'
      GROUP BY campaign_id`)) as unknown as { n: number }[];
    bar("per-hour sends ≤ cap", sent10.every((r) => r.n <= 3), JSON.stringify(sent10));
  });

  // ── H-O9 (owner) ────────────────────────────────────────────────────────
  {
    console.log("\nH-O9 (owner) single candidate, hour-full, day room, carry ON ⇒ routes and queues exactly as today");
    const run = async (hour: boolean) => {
      const fx = await makeFixture();
      try {
        await setFlags(fx.orgId, { day: true, hour });
        const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
        await sentThisHour(fx, a, 3);
        const l = await fx.lead("t", Z("2026-10-13T18:09:00Z"));
        const res = await route(fx, NOW);
        const routed = await journeyOf(l);
        await prepareHourly(db, { orgId: fx.orgId, now: new Date(NOW.getTime() + MIN), notify: async () => undefined, deps: { hasHeadroom: async () => true } });
        const after = await journeyOf(l);
        return { a, res, routed, after, recheck: await recheckOf(l) };
      } finally {
        const left = await fx.teardown();
        bar(`H-O9 (${hour ? "on" : "off"}) teardown leaves nothing`, left === 0, String(left));
      }
    };
    const off = await run(false);
    const on = await run(true);
    bar("flag ON: journey routed to the single candidate, no deferral",
      on.routed?.campaign_id === on.a && on.routed?.state === "routed" && on.res.deferred === 0 && on.recheck === null);
    bar("flag ON reason = flag-OFF reason + hour_fallback:true (nothing else differs)", (() => {
      const { hour_fallback, ...rest } = on.routed!.reason;
      const offR = { ...off.routed!.reason, campaign_id: on.a, skipped: rest.skipped };
      return hour_fallback === true && same(rest, offR);
    })(), JSON.stringify([off.routed?.reason, on.routed?.reason]));
    bar("queues exactly as today: same state / hour_start / hour_fresh after maintenance",
      off.after?.state === on.after?.state && off.after?.hour_start === on.after?.hour_start &&
      off.after?.hour_fresh === on.after?.hour_fresh, JSON.stringify([off.after, on.after].map((j) => [j?.state, j?.hour_start, j?.hour_fresh])));
  }

  // ── H-O10 (owner) ───────────────────────────────────────────────────────
  await scenario("H-O10 (owner) carry-ON queue > cap ⇒ fresh leads still route, never defer", async (fx) => {
    await setFlags(fx.orgId, { day: true, hour: true });
    const a = await fx.campaign("a", 3, true, true, { interestTag: "t", priority: 97 });
    const q = await fx.journeys(a, 10, Z("2026-10-13T16:30:00Z"));
    await db.execute(sql`
      UPDATE drip_journeys SET hour_start = '2026-10-13T16:00:00Z', hour_fresh = false
      WHERE id = ANY(${`{${q.join(",")}}`}::uuid[])`);
    for (const [k, now] of [[1, NOW], [2, new Date(NOW.getTime() + 20 * MIN)]] as const) {
      const leads: string[] = [];
      for (let i = 0; i < 5; i++) leads.push(await fx.lead("t", new Date(now.getTime() - MIN + i * 1000)));
      const res = await route(fx, now);
      const js = await Promise.all(leads.map(journeyOf));
      const rechecks = await Promise.all(leads.map(recheckOf));
      bar(`run ${k}: all 5 routed to A via fallback, none deferred`,
        js.every((j) => j?.campaign_id === a && j.reason.hour_fallback === true) && res.deferred === 0 &&
        rechecks.every((r) => r === null), `routed ${res.routed} deferred ${res.deferred}`);
    }
  });

  // ── H-O11 (pure) why-not-routed text ────────────────────────────────────
  {
    console.log("\nH-O11 why-not-routed text helpers");
    const day = { campaign_id: 1, campaign_name: "A", detail: "campaign full (5/5 today: 3 sent + 2 queued)" };
    bar("kind-less (day) entry keeps the existing text byte-for-byte",
      overflowLines([day], "B")[0] === "A: campaign full (5/5 today: 3 sent + 2 queued), overflowed to B");
    bar("kind:'day' entry renders the same as kind-less",
      overflowLines([{ ...day, kind: "day" }], "B")[0] === overflowLines([day], "B")[0]);
    bar("hour entry renders '<name>: hour full (N/cap this hour), overflowed to <winner>'",
      overflowLines([{ campaign_id: 2, campaign_name: "Hot", detail: "hour full (3/3 this hour)", kind: "hour" }], "B")[0] ===
        "Hot: hour full (3/3 this hour), overflowed to B");
    bar("null name falls back to #id", overflowLines([{ ...day, campaign_name: null }], "B")[0].startsWith("#1: "));
    bar("fallback line text", hourFallbackLine("B") ===
      "routed to B although its hour is full — every same-tag candidate was hour-full (it queues)");
    bar("routingNoteLines: skips then fallback; no fallback line unless flagged",
      routingNoteLines([day], "B", true).length === 2 && routingNoteLines([day], "B", true)[1] === hourFallbackLine("B") &&
      routingNoteLines([day], "B", false).length === 1 && routingNoteLines([], "B", false).length === 0);
    bar("fallback winner (eligible:false) is labelled routed, never 'not eligible'",
      candidateBadgeLabel({ eligible: false }, true) === "routed (hour full)" &&
      candidateBadgeLabel({ eligible: false }, false) === "not eligible" &&
      candidateBadgeLabel({ eligible: true }, false) === "eligible");
  }

  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
