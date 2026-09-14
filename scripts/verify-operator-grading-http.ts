// Route-level checks for the operator-API grading fields, over HTTP with a real
// session. READ-ONLY (GETs + SELECTs). Before merge: BASE_URL=http://localhost:3107
// against a local `next dev` on the prod DB. After deploy:
// BASE_URL=https://camman.vercel.app. Independent SQL is the reference side.
// Run: BASE_URL=... npx tsx scripts/verify-operator-grading-http.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local"), quiet: true });

import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

import { pct } from "../lib/reporting/grading-rates";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3107";
let failures = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
function skip(name: string, why: string) {
  console.log(`  - SKIPPED ${name}: ${why}`);
  skipped++;
}
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const etToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function main() {
  const db = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false });
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cs) => {
          for (const { name, value } of cs) jar.set(name, value);
        },
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  const bodies: { path: string; body: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function get(path: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") },
      redirect: "manual",
    });
    const body = await res.text();
    bodies.push({ path, body });
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* non-JSON body: the status check reports it */
    }
    return { status: res.status, json };
  }

  const me = await get("/api/me");
  check("signed in (/api/me 200)", me.status === 200, me.status);
  const orgId: string = me.json.org.id;
  console.log(`BASE_URL ${BASE_URL} · org ${orgId}`);

  // ---- performance ----
  console.log("\n1. /api/reports/performance");
  const to = addDays(etToday(), -1);
  const from = addDays(to, -6);
  const perf = await get(`/api/reports/performance?dimension=offer&from=${from}&to=${to}`);
  check("200", perf.status === 200, perf.status);
  const t = perf.json?.totals ?? {};
  for (const k of ["reached", "clicks_human", "click_to_reach_pct", "reach_to_sale_pct", "opt_rate"]) {
    check(`totals has ${k}`, k in t);
  }
  check("totals.clicks_human = totals.counted_clickers", t.clicks_human === t.counted_clickers, t);
  check("totals.opt_rate arithmetic", t.opt_rate === pct(t.opt_outs, t.sent), t);
  check(
    "rows carry reach_to_sale_pct",
    (perf.json?.data ?? []).length > 0 &&
      (perf.json?.data ?? []).every((r: object) => "reach_to_sale_pct" in r),
  );

  // ---- stages ----
  console.log("\n2. /api/campaigns/{id}/stages");
  const [camp] = await db`
    SELECT ss.campaign_id FROM stage_sends ss JOIN campaigns c ON c.id = ss.campaign_id
    WHERE ss.org_id = ${orgId} AND c.link_mode = 'tracked'
      AND ss.offer_reached_at >= now() - interval '30 days'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`;
  if (!camp) throw new Error("no tracked campaign with a reach in 30 days — nothing to verify against");
  const cid = Number(camp.campaign_id);
  const reachBy = new Map(
    (
      await db`
        SELECT stage_id, count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS n
        FROM stage_sends WHERE org_id = ${orgId} AND campaign_id = ${cid} GROUP BY 1`
    ).map((r) => [Number(r.stage_id), Number(r.n)]),
  );
  const clickersBy = new Map(
    (
      await db`
        SELECT stage_id, count(*)::int AS n FROM counted_clickers
        WHERE org_id = ${orgId} AND campaign_id = ${cid} GROUP BY 1`
    ).map((r) => [Number(r.stage_id), Number(r.n)]),
  );
  const st = await get(`/api/campaigns/${cid}/stages`);
  check(`campaign ${cid}: 200`, st.status === 200, st.status);
  let anyReach = false;
  for (const s of st.json?.data ?? []) {
    const wantReach = reachBy.get(s.id) ?? 0;
    if (wantReach > 0) anyReach = true;
    check(`stage ${s.id}: reached = direct count ${wantReach}`, s.reached === wantReach, s.reached);
    check(
      `stage ${s.id}: clicks_human = cached clickers`,
      s.clicks_human === (clickersBy.get(s.id) ?? 0),
      s.clicks_human,
    );
    check(
      `stage ${s.id}: click_to_reach_pct`,
      s.click_to_reach_pct === pct(s.reached, s.clicks_human),
      s.click_to_reach_pct,
    );
    check(
      `stage ${s.id}: reach_to_sale_pct`,
      s.reach_to_sale_pct === pct(s.keitaro_sales_count, s.reached),
      s.reach_to_sale_pct,
    );
    check(
      `stage ${s.id}: opt_rate`,
      s.opt_rate === pct(s.inbound_stop_count, s.send_counts?.sent),
      s.opt_rate,
    );
  }
  check("control: at least one stage has a real reach", anyReach);

  // ---- click-report ----
  console.log("\n3. /api/campaigns/{id}/click-report");
  const humanBy = new Map(
    (
      await db`
        SELECT l.stage_id, count(*)::int AS n FROM links l JOIN clicks ck ON ck.link_id = l.id
        WHERE l.org_id = ${orgId} AND l.campaign_id = ${cid}
          AND ck.classification = 'human' AND ck.scored_at IS NOT NULL
        GROUP BY 1`
    ).map((r) => [Number(r.stage_id), Number(r.n)]),
  );
  const cr = await get(`/api/campaigns/${cid}/click-report`);
  check("200 + tracked", cr.status === 200 && cr.json?.source === "tracked", cr.json?.source);
  let clickersSeen = 0;
  for (const s of cr.json?.stages ?? []) {
    clickersSeen += s.clicks_human ?? 0;
    check(
      `stage ${s.stage_id}: human = scored human click events`,
      s.human === (humanBy.get(s.stage_id) ?? 0),
      s.human,
    );
    check(
      `stage ${s.stage_id}: clicks_human = cached clickers`,
      s.clicks_human === (clickersBy.get(s.stage_id) ?? 0),
      s.clicks_human,
    );
  }
  check("control: some stage has human clickers", clickersSeen > 0, clickersSeen);

  // ---- sends/today ----
  console.log("\n4. /api/sends/today");
  const today = await get("/api/sends/today");
  check("200", today.status === 200, today.status);
  const items: { stage_id: number; creative_id?: number | null; creative_slug?: string | null }[] =
    today.json?.data ?? [];
  if (items.length === 0) {
    skip("creative_slug per stage", "no stages in play today");
  } else {
    const slugBy = new Map(
      (
        await db`
          SELECT cs.id, cs.creative_id, cr.slug FROM campaign_stages cs
          LEFT JOIN creatives cr ON cr.id = cs.creative_id
          WHERE cs.org_id = ${orgId} AND cs.id IN ${db(items.map((d) => d.stage_id))}`
      ).map((r) => [
        Number(r.id),
        { id: r.creative_id == null ? null : Number(r.creative_id), slug: (r.slug as string) ?? null },
      ]),
    );
    for (const d of items) {
      const want = slugBy.get(d.stage_id);
      check(
        `today stage ${d.stage_id}: creative_id/creative_slug match`,
        "creative_slug" in d && d.creative_slug === want?.slug && d.creative_id === want?.id,
        { got: [d.creative_id, d.creative_slug], want },
      );
    }
  }

  // ---- attribution param ----
  console.log("\n6. /api/reports/performance?attribution=");
  const sd = await get(
    `/api/reports/performance?dimension=offer&from=${from}&to=${to}&attribution=send_date`,
  );
  check("send_date: 200", sd.status === 200, sd.status);
  check("send_date: response echoes the basis", sd.json?.attribution === "send_date", sd.json?.attribution);
  check("default: response echoes conversion_date", perf.json?.attribution === "conversion_date", perf.json?.attribution);
  const bad = await get(
    `/api/reports/performance?dimension=offer&from=${from}&to=${to}&attribution=click_date`,
  );
  check("unknown attribution: 400", bad.status === 400, bad.status);
  const hr = await get(
    `/api/reports/performance?dimension=hourly&from=${to}&to=${to}&attribution=send_date`,
  );
  check("hourly + send_date: 400", hr.status === 400, hr.status);

  // ---- tails ----
  console.log("\n7. /api/reports/tails");
  const tl = await get(`/api/reports/tails?date=${to}`);
  check("200", tl.status === 200, tl.status);
  const tt = tl.json?.totals ?? {};
  check(
    "same_day + tail + unknown = conversions",
    tt.same_day_conversions + tt.tail_conversions + tt.unknown_send_date_conversions === tt.conversions,
    tt,
  );
  check(
    "rows carry creative_slug and days_after_send",
    (tl.json?.data ?? []).every((r: object) => "creative_slug" in r && "days_after_send" in r),
  );
  const badDate = await get("/api/reports/tails?date=2026-02-31");
  check("impossible date: 400", badDate.status === 400, badDate.status);

  // ---- privacy sweep over every body fetched above ----
  console.log("\n5. Privacy sweep");
  const senders = new Set(
    (await db`SELECT phone_number FROM provider_phones`).map((r) =>
      String(r.phone_number).replace(/\D/g, ""),
    ),
  );
  check("control: sending-number scope is non-empty", senders.size > 0, senders.size);
  // A phone-shaped value that is not a known sending number, or undefined. On a
  // hit it reports WHERE the value sits (preceding JSON text, every digit masked)
  // and only the last 4 digits — never a full number.
  // A run of digits right after a digit or "." is the fraction of a JSON number,
  // not a phone: summed floats serialize as e.g. `"cost":1234.9999999999995`,
  // which the bare pattern flagged on the first run. A phone in these payloads
  // is a JSON string, preceded by `"` or `+`.
  const findPhoneLeak = (body: string): string | undefined => {
    for (const m of body.matchAll(/(?<![\d.])\+?1?\d{10,15}(?!\d)/g)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 10 || senders.has(digits)) continue;
      const before = body.slice(Math.max(0, (m.index ?? 0) - 40), m.index).replace(/\d/g, "#");
      return `…${digits.slice(-4)} after ${JSON.stringify(before)}`;
    }
    return undefined;
  };
  // The matcher itself must still go red on a real phone, and stay quiet on a float.
  check("control: sweep flags a recipient-shaped phone string", findPhoneLeak('{"to":"+15550001234"}') !== undefined);
  check("control: sweep ignores a float's fractional digits", findPhoneLeak('{"cost":1234.9999999999995}') === undefined);
  for (const { path, body } of bodies) {
    check(`${path}: no contact_id`, !body.includes("contact_id"));
    const leak = findPhoneLeak(body);
    check(`${path}: every phone-shaped value is a sending number`, leak === undefined, leak);
  }

  await db.end();
  console.log(
    failures === 0
      ? `\nverify-operator-grading-http OK${skipped ? ` (${skipped} skipped)` : ""}.`
      : `\nFAILED: ${failures}${skipped ? ` (${skipped} skipped)` : ""}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
