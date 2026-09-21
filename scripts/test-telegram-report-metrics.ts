import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { escapeHtml, sendTelegramReport } from "@/lib/alerts/telegram";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import {
  computeReportMetrics,
  etDayRange,
  type ReportMetrics,
} from "@/lib/reporting/report-snapshot";
import { loadEventTypes, pluralizeLabel } from "@/lib/reporting/event-columns";
import { dailyMessage } from "@/lib/reporting/telegram-report-format";

// THE REAL-READER PROOF for the scheduled Telegram report's numbers (Phase 5
// Task 8). It runs computeReportMetrics — the exact function the cron calls —
// over a seeded ET day and reconciles the per-event split against the headline
// it sits under.
//
// ⚠️ WHAT THIS SCRIPT USED TO BE, AND WHY IT COULD NEVER RUN. It called dotenv's
// config() as a STATEMENT positioned after its imports, so ESM evaluated
// `@/db/client` first and the pool was constructed before DATABASE_URL existed:
// every run died with 32P01 connecting as the OS user. It now uses
// `import "./_env-preload"` as its first import, the convention every other
// script here follows, which is what makes the bars below runnable at all.
//
// ⚠️ IT ALSO USED TO READ `.env.local`, WHICH IS PRODUCTION. It now writes
// fixtures, so it carries the preview-DB refusal on line 2 and can only target
// camman-v2. The production eyeball it used to offer is deliberately gone: a
// read-only glance at prod is not worth a script that writes being one forgotten
// environment variable away from writing there.
//
// Run:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-telegram-report-metrics.ts
//
// ⭐ WHY COMMITTED FIXTURES UNDER A THROWAWAY ORG, NOT A ROLLED-BACK TX.
// computeReportMetrics binds the MODULE-LEVEL `db` (db/client.ts) and takes no
// `tx`, so seeding inside a transaction this script later rolls back would hand
// it a world it cannot see — every bar would read zero and pass for the wrong
// reason. Torn down by org_id in a `finally`, after re-reading the marker.
//
// ⭐ AND WHY THE NUMBERS ARE ASSERTED NON-ZERO. On an unseeded corpus both sides
// of T13/T14 are 0 and the identities hold trivially. A bar that has only ever
// been satisfied by zeros is a countdown, not a proof, so T13z/T14z pin the
// fixture's figures as non-zero and T13x/T14x pin them to the exact seeded
// values — the identity cannot start passing because the data went away.

const MARKER = "__P5_TELEGRAM_REPORT_TEST__";
// A CLOSED ET day in the past: nothing that happens while this runs can move it,
// and no "today" boundary can make the range ambiguous. Noon ET, so the instant
// is unambiguously inside the day in any offset.
const DAY = "2026-05-12";
const DAY_ANCHOR = new Date("2026-05-12T16:00:00Z");
// A SECOND closed day, for the residual fixture — kept apart so the stray it
// carries cannot perturb the clean reconciliation on DAY.
const DAY2 = "2026-05-13";
const DAY2_ANCHOR = new Date("2026-05-13T16:00:00Z");
// A THIRD closed day, for the malformed-VALUE fixture (T19b). Kept apart for the
// same reason DAY2 is: the row it carries has a real purchase count on it, and
// on DAY or DAY2 that count would move T13x's or T20's exact deltas.
const DAY3 = "2026-05-14";
const DAY3_ANCHOR = new Date("2026-05-14T16:00:00Z");
// Telegram's OWN sendMessage limit — the thing MAX_MESSAGE_CHARS keeps clear of.
// Spelled here (not imported) so this bar still fails if MAX_MESSAGE_CHARS is
// ever raised above it: a cap checked against itself checks nothing.
const TELEGRAM_HARD_LIMIT = 4096;

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) {
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    } else {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  // ⭐ THE PURCHASE SET COMES FROM THE REGISTRY, NOT FROM A KEY SPELLED HERE —
  // the same rule the columns follow. A bar that named "purchase" would still be
  // green on the day someone configures a second purchase-bearing type, while
  // the report it guards had started disagreeing with itself.
  const purchaseKeysOf = async () =>
    new Set((await loadEventTypes(db, null)).filter((t) => t.is_purchase).map((t) => t.key));
  const sumPurchaseN = (m: ReportMetrics, keys: Set<string>) =>
    Object.entries(m.events)
      .filter(([k]) => keys.has(k))
      .reduce((s, [, v]) => s + v.n, 0);
  const sumRev = (m: ReportMetrics) =>
    Object.values(m.events).reduce((s, v) => s + v.revenue, 0);

  const tag = `p5t8-${Date.now()}`;
  let orgId = "";

  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];

  try {
    // ── baseline: what this window holds BEFORE the fixture ─────────────────
    // Every assertion below is a DELTA against this, so a leftover row from an
    // unrelated run cannot make a bar pass or fail on its own.
    const base = await computeReportMetrics(etDayRange(campaignDayBoundsUtc(DAY_ANCHOR)));
    const base2 = await computeReportMetrics(etDayRange(campaignDayBoundsUtc(DAY2_ANCHOR)));
    const base3 = await computeReportMetrics(etDayRange(campaignDayBoundsUtc(DAY3_ANCHOR)));
    console.log(
      `baseline ${DAY}: sales=${base.sales} revenue=${base.revenue} unmapped=${base.unmapped} ` +
        `topup=${base.manualTopup} eventKeys=${Object.keys(base.events).length}`,
    );

    // ── the world ───────────────────────────────────────────────────────────
    orgId = (
      await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id
      `)
    ).id;

    const evt = async (key: string, purchase: boolean, revenue: boolean, signal: boolean) =>
      one<{ id: number }>(sql`
        INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
        VALUES (${orgId}::uuid, ${key}, ${key}, 10, ${purchase}, ${revenue}, ${signal})
        RETURNING id
      `);
    await evt("purchase", true, true, false);
    await evt("registration", false, false, true);

    const networkId = (
      await one<{ id: number }>(sql`
        INSERT INTO affiliate_networks (network_id, org_id, name)
        VALUES (${`net-${tag}`}, ${orgId}::uuid, ${"Net"}) RETURNING id
      `)
    ).id;
    const offerId = (
      await one<{ id: number }>(sql`
        INSERT INTO offers (offer_id, org_id, name, network_id)
        VALUES (${`off-${tag}`}, ${orgId}::uuid, ${"Offer"}, ${networkId}) RETURNING id
      `)
    ).id;
    const campaignId = (
      await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, offer_id, link_mode, status)
        VALUES (${orgId}::uuid, ${`camp-${tag}`}, ${"P5 telegram"}, ${offerId}, 'tracked', 'active')
        RETURNING id
      `)
    ).id;

    const stage = async (n: number, day: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at, sms_count, total_cost)
          VALUES (${orgId}::uuid, ${campaignId}, ${n}, ${`trk-${tag}-s${n}`},
                  ${`${day} 12:00`}::timestamp AT TIME ZONE 'America/New_York', 2, 0)
          RETURNING id
        `)
      ).id;
    const stageA = await stage(1, DAY);
    const stageB = await stage(2, DAY);
    const stageBad = await stage(3, DAY);
    const stageStray = await stage(4, DAY2);
    const stageBadValue = await stage(5, DAY3);

    const ksr = async (
      stageId: number,
      n: number,
      day: string,
      sales: number,
      revenue: string,
      events: string,
      unmapped: number,
      pendingRevenue = "0",
    ) =>
      db.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue, pending_revenue,
           events, unmapped_conversions, cost)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${`trk-${tag}-s${n}`}, ${day}::date,
                ${sales}, ${revenue}::numeric, ${pendingRevenue}::numeric,
                ${events}::jsonb, ${unmapped}, 0)
      `);

    // DAY — the clean reconciliation. ONE-SIDED on purpose: registrations carry
    // no revenue and no purchase flag, so a bar about `sales` can never be
    // satisfied by them, and the held money is in pending_revenue only.
    //   stage A: 2 purchases ($50, $15 held) + 4 registrations ($0)
    //   stage B: 1 purchase  ($20)
    //   + a manual top-up of 3 on stage B (tracker says 1, operator says 4)
    await ksr(
      stageA, 1, DAY, 2, "50.0000",
      JSON.stringify({
        purchase: { n: 2, pending_n: 1, revenue: 50.0, pending_revenue: 15.0 },
        registration: { n: 4, pending_n: 0, revenue: 0, pending_revenue: 0 },
      }),
      0,
      "15.0000",
    );
    await ksr(
      stageB, 2, DAY, 1, "20.0000",
      JSON.stringify({ purchase: { n: 1, pending_n: 0, revenue: 20.0, pending_revenue: 0 } }),
      0,
    );
    await db.execute(sql`
      INSERT INTO stage_manual_sales (org_id, campaign_id, stage_id, delta, created_at)
      VALUES (${orgId}::uuid, ${campaignId}, ${stageB}, 4,
              ${`${DAY} 13:00`}::timestamp AT TIME ZONE 'America/New_York')
    `);

    // ⭐ A MALFORMED `events` ON THE SAME DAY. jsonb_each RAISES 22023 on a
    // non-object and the error is NOT scoped to the row — it aborts the whole
    // statement. Without the jsonb_typeof guard in salesRevenueTotals this single
    // row would make computeReportMetrics throw, the cron return 500, and the
    // report fail EVERY HOUR until someone edited the row. There is no CHECK
    // constraint stopping it being written.
    await ksr(stageBad, 3, DAY, 0, "0", "5", 0);

    // DAY2 — the RESIDUAL fixture. `sales` says 3, the per-event object accounts
    // for 2, and unmapped_conversions names the third. This is the documented
    // stray shape (db/schema.ts, keitaro_stage_results.events): a ledger row
    // carrying another org's event_type_id is counted by the scalar and placed
    // under no key. It is the reason the report prints an "unmapped" line at all.
    await ksr(
      stageStray, 4, DAY2, 3, "90.0000",
      JSON.stringify({ purchase: { n: 2, pending_n: 0, revenue: 60.0, pending_revenue: 0 } }),
      1,
    );

    // DAY3 — ⭐ A MALFORMED VALUE INSIDE A WELL-FORMED OBJECT. The row above
    // (events = '5') is caught by jsonb_typeof(events) = 'object'; THIS one is
    // an object, so that guard passes it straight to
    // `(e.value ->> 'n')::numeric`, which raises 22P02 ("invalid input syntax
    // for type numeric") — statement-wide, exactly like the 22023, and with the
    // same consequence: computeReportMetrics throws, the cron returns 500, and
    // the report fails EVERY HOUR until a human edits the row. No CHECK
    // constraint stops the value being written. MIXED on purpose: a real
    // purchase count and real money sit on the same row as the rotten fields,
    // so "it survived by returning nothing" fails.
    await ksr(
      stageBadValue, 5, DAY3, 2, "40.0000",
      JSON.stringify({
        purchase: { n: 2, pending_n: 0, revenue: 40.0, pending_revenue: 0 },
        word_count: { n: "abc", pending_n: 0, revenue: "xyz", pending_revenue: 0 },
        bare_string_entry: "not an object",
      }),
      0,
    );

    // ── the bars ────────────────────────────────────────────────────────────
    const purchaseKeys = await purchaseKeysOf();
    // ⭐ A THROW IS TURNED INTO ZEROS, DELIBERATELY. The failure T19 exists to
    // catch — jsonb_each raising 22023 on the malformed row above — aborts the
    // whole statement, so computeReportMetrics THROWS and an unguarded call
    // would end this run with a stack trace and no bar output at all. Degrading
    // to a zeroed metrics object makes every affected bar print a WRONG NUMBER
    // instead, which is what a red proof has to look like to be readable.
    let fatal = "";
    const safeMetrics = async (anchor: Date): Promise<ReportMetrics> => {
      try {
        return await computeReportMetrics(etDayRange(campaignDayBoundsUtc(anchor)));
      } catch (e) {
        fatal = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
        return {
          sales: 0, revenue: 0, spend: 0, optOuts: 0, delivered: 0, roiPct: null,
          events: {}, eventTypes: [], unmapped: 0, manualTopup: 0,
        };
      }
    };
    const m = await safeMetrics(DAY_ANCHOR);
    const m2 = await safeMetrics(DAY2_ANCHOR);
    const m3 = await safeMetrics(DAY3_ANCHOR);

    const dPurchaseN = sumPurchaseN(m, purchaseKeys) - sumPurchaseN(base, purchaseKeys);
    const dRev = sumRev(m) - sumRev(base);

    check(
      "T13 ⭐ Σ (is_purchase) n + manualTopup = sales",
      sumPurchaseN(m, purchaseKeys) + m.manualTopup === m.sales,
      `${sumPurchaseN(m, purchaseKeys)} + ${m.manualTopup} vs ${m.sales} (unmapped ${m.unmapped})`,
    );
    check(
      "T14 ⭐ Σ per-event revenue = revenue",
      Math.abs(sumRev(m) - m.revenue) < 1e-6,
      `${sumRev(m)} vs ${m.revenue}`,
    );
    check(
      "T13z ⭐ …and BOTH SIDES ARE NON-ZERO — an identity only ever satisfied by zeros is a countdown",
      sumPurchaseN(m, purchaseKeys) > 0 && m.sales > 0 && m.manualTopup > 0,
      `Σn=${sumPurchaseN(m, purchaseKeys)} sales=${m.sales} topup=${m.manualTopup}`,
    );
    check(
      "T14z ⭐ …and the revenue side is non-zero too",
      sumRev(m) > 0 && m.revenue > 0,
      `Σrev=${sumRev(m)} revenue=${m.revenue}`,
    );
    check(
      "T13x ⭐ the delta is EXACTLY the fixture: 3 tracker purchases, +3 manual top-up, 4 registrations",
      dPurchaseN === 3 &&
        m.manualTopup - base.manualTopup === 3 &&
        (m.events.registration?.n ?? 0) - (base.events.registration?.n ?? 0) === 4,
      `Δpurchase=${dPurchaseN} Δtopup=${m.manualTopup - base.manualTopup} Δreg=${
        (m.events.registration?.n ?? 0) - (base.events.registration?.n ?? 0)
      }`,
    );
    check(
      "T14x ⭐ …and Δrevenue is exactly $70.00, with $15.00 held SEPARATELY and never added in",
      Math.abs(dRev - 70) < 1e-6 &&
        Math.abs((m.events.purchase?.pending_revenue ?? 0) - (base.events.purchase?.pending_revenue ?? 0) - 15) < 1e-6,
      `Δrev=${dRev} Δpending=${
        (m.events.purchase?.pending_revenue ?? 0) - (base.events.purchase?.pending_revenue ?? 0)
      }`,
    );
    check(
      "T18 ⭐ a $0 event type still appears in the map, reading its real count",
      (m.events.registration?.n ?? 0) > 0 && (m.events.registration?.revenue ?? -1) === 0,
      `registration n=${m.events.registration?.n} revenue=${m.events.registration?.revenue}`,
    );
    check(
      "T19 ⭐⭐ a MALFORMED `events` row does not abort the statement — jsonb_each raises 22023 statement-wide, which would 500 the cron every hour",
      fatal === "" && dPurchaseN === 3,
      fatal === ""
        ? "the row seeded with events='5'::jsonb is skipped, not fatal"
        : `THREW: ${fatal}`,
    );
    check(
      "T19b ⭐⭐ a malformed VALUE does not abort the statement either — the numeric cast raises 22P02 statement-wide, which the top-level jsonb_typeof guard does NOT catch",
      fatal === "" &&
        sumPurchaseN(m3, purchaseKeys) - sumPurchaseN(base3, purchaseKeys) === 2 &&
        // …and the day's other two bars still hold with the bad row present:
        // the good half of the half-rotten row is counted in full.
        Math.abs(sumRev(m3) - sumRev(base3) - 40) < 1e-6,
      fatal === ""
        ? `Δpurchase=${sumPurchaseN(m3, purchaseKeys) - sumPurchaseN(base3, purchaseKeys)} Δrev=${sumRev(m3) - sumRev(base3)}`
        : `THREW: ${fatal}`,
    );
    check(
      "T19c ⭐ …and the rotten entries read 0 rather than taking their row with them — a field is skipped, never the row",
      (m3.events.word_count?.n ?? -1) === 0 &&
        (m3.events.word_count?.revenue ?? -1) === 0 &&
        (m3.events.bare_string_entry?.n ?? -1) === 0,
      JSON.stringify({
        word_count: m3.events.word_count,
        bare_string_entry: m3.events.bare_string_entry,
      }),
    );
    check(
      "T20 ⭐ the RESIDUAL is real: on a day with a stray, Σ(is_purchase) n + topup is SHORT of sales by exactly the unmapped count",
      m2.sales - (sumPurchaseN(m2, purchaseKeys) + m2.manualTopup) === 1 &&
        m2.unmapped - base2.unmapped === 1,
      `sales=${m2.sales} Σn=${sumPurchaseN(m2, purchaseKeys)} topup=${m2.manualTopup} unmapped=${m2.unmapped}`,
    );
    check(
      "T20b ⭐ …and the same stray shows on the REVENUE side: Σ per-event revenue is $30.00 short of revenue",
      Math.abs(m2.revenue - sumRev(m2) - 30) < 1e-6,
      `revenue=${m2.revenue} Σrev=${sumRev(m2)}`,
    );
    check(
      "T21 ⭐ the registry reaches the formatter: EVERY merged type gets a line (including one reading 0), and the residual is stated",
      (() => {
        const msg = dailyMessage("Wed 13 May", m2);
        const lines = msg.split("\n");
        // ⭐ LABELS ARE DERIVED FROM THE METRICS, NOT SPELLED HERE. The first
        // draft asserted /^purchase: /m and went RED against a label of
        // "Purchase" — loadEventTypes(db, null) merges ACROSS ORGS and the
        // lowest display_order wins the label, so another org's row supplied it.
        // That is the cross-org merge working; a bar that names a label is
        // asserting one org's configuration.
        const shown = m2.eventTypes.slice(0, 6);
        // …and PLURALISED with the same generator the report tables use, so a
        // label rendered one way on screen cannot be rendered another way here.
        const everyTypeHasALine = shown.every((t) =>
          lines.some((l) =>
            l.startsWith(
              `${escapeHtml(pluralizeLabel(t.label.replace(/\s+/g, " ").trim() || t.key))}: `,
            ),
          ),
        );
        const someTypeReadsZero = shown.some((t) => (m2.events[t.key]?.n ?? 0) === 0);
        return (
          shown.length > 0 &&
          everyTypeHasALine &&
          someTypeReadsZero &&
          msg.includes(
            `⚠ ${m2.unmapped} unmapped — in no line above, but Sales/Revenue may already count them`,
          )
        );
      })(),
      `types=${m2.eventTypes.map((t) => t.label).join(", ")}`,
    );

    // ── the DELIVERY payload, with the transport stubbed ────────────────────
    //
    // ⚠️ NOTHING HERE REACHES THE REAL TELEGRAM CHAT, and it is belt AND braces.
    // `_env-preload` loads .env.local, which is PRODUCTION and carries the real
    // bot token — so (1) global fetch is replaced before the call and every
    // request is captured rather than sent, (2) TELEGRAM_BOT_TOKEN/CHAT_ID are
    // overwritten with fakes for the duration, so even a failed stub could only
    // authenticate as nobody, and (3) the stub ASSERTS the URL carries the fake
    // token, so a real one would fail the bar instead of posting.
    //
    // A formatter test proves the string; this proves what the cron hands the
    // transport: parse_mode HTML, the exact rendered message, under Telegram's
    // own 4096 limit.
    const FAKE_TOKEN = "stub-token-not-a-real-bot";
    const realFetch = globalThis.fetch;
    const realToken = process.env.TELEGRAM_BOT_TOKEN;
    const realChat = process.env.TELEGRAM_CHAT_ID;
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const sendThroughStub = async (text: string) => {
      process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
      process.env.TELEGRAM_CHAT_ID = "stub-chat";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        posted.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response("{\"ok\":true}", { status: 200 });
      }) as typeof fetch;
      try {
        return await sendTelegramReport(text);
      } finally {
        globalThis.fetch = realFetch;
        if (realToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = realToken;
        if (realChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
        else process.env.TELEGRAM_CHAT_ID = realChat;
      }
    };

    const normalMsg = dailyMessage("Tue 12 May", m);
    const outcome = await sendThroughStub(normalMsg);
    const sent = posted[0];
    check(
      "T23 ⭐ the cron hands the transport parse_mode HTML and the EXACT rendered message, under Telegram's own 4096 limit",
      outcome.status === "sent" &&
        sent?.body.parse_mode === "HTML" &&
        sent?.body.text === normalMsg &&
        String(sent?.body.text).length <= TELEGRAM_HARD_LIMIT,
      `status=${outcome.status} parse_mode=${String(sent?.body.parse_mode)} len=${
        String(sent?.body.text ?? "").length
      }`,
    );
    check(
      "T23b ⭐ …and it went to the STUB, not to a real bot token",
      sent !== undefined && sent.url.includes(FAKE_TOKEN) && globalThis.fetch === realFetch,
    );

    // ── the HOSTILE label, committed to the registry and re-rendered ─────────
    // The brief's preview-deploy step, done locally: a label containing markup
    // must still produce a message Telegram would accept. A NEW key is used
    // rather than editing an existing one, because loadEventTypes merges ACROSS
    // ORGS and the lowest display_order wins the label — editing "purchase"
    // would have been silently overridden by another org's row (which is exactly
    // what happened to an earlier draft of T21). display_order 0 on a key no
    // other org has makes this org's label the one that renders.
    await db.execute(sql`
      INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
      VALUES (${orgId}::uuid, 'hostile_evt', ${"<b>Buy</b> & <win> 💰"}, 0, false, false, true)
    `);
    const mHostile = await safeMetrics(DAY_ANCHOR);
    const hostileMsg = dailyMessage("Tue 12 May", mHostile);
    posted.length = 0;
    const hostileOutcome = await sendThroughStub(hostileMsg);
    // ⭐ THE 400 CONDITION, STATED AS AN ASSERTION. Telegram rejects an unknown
    // start tag, so the ONLY angle-bracket markup in the payload may be the
    // header's own bold pair. A raw <win> from the label would be exactly the
    // permanent failure this task exists to prevent.
    const tags = hostileMsg.match(/<[^>]*>/g) ?? [];
    check(
      "T24 ⭐⭐ a label containing markup renders as TEXT: the payload carries exactly one <b>…</b> pair (the header) and nothing else Telegram could reject",
      hostileOutcome.status === "sent" &&
        tags.length === 2 &&
        tags[0] === "<b>" &&
        tags[1] === "</b>" &&
        // Pluralised BEFORE escaping — the "s" lands on the label, never inside
        // an entity (a "&amps;" would be the malformed markup this bar exists
        // to catch). The label ends in an emoji, so the dumb pluraliser appends
        // to it; that is the generator being total, not a special case.
        hostileMsg.includes("&lt;b&gt;Buy&lt;/b&gt; &amp; &lt;win&gt; 💰s: 0") &&
        !hostileMsg.includes("&amps;") &&
        hostileMsg.length <= TELEGRAM_HARD_LIMIT,
      `tags=${JSON.stringify(tags)} len=${hostileMsg.length}`,
    );
    console.log(`\n--- the payload a hostile label produces (${hostileMsg.length} chars) ---`);
    console.log(hostileMsg);

    console.log(`\n--- the message the cron would send for ${DAY} ---`);
    console.log(dailyMessage("Tue 12 May", m));
    console.log(`\n--- …and for ${DAY2} (the stray day) ---`);
    console.log(dailyMessage("Wed 13 May", m2));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    // ── teardown: by org_id, and only after re-reading the marker ───────────
    if (orgId) {
      const row = (await db.execute(sql`
        SELECT name FROM organizations WHERE id = ${orgId}::uuid
      `)) as unknown as { name: string }[];
      const name = row[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(
          `REFUSING TEARDOWN: org ${orgId} does not carry the test marker (name=${JSON.stringify(name)})`,
        );
        process.exitCode = 1;
      } else {
        await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    // Scoped to THIS run's tag, not the marker: the marker is org-wide across
    // every run that ever used it, so a concurrent invocation would be counted
    // here and reported as a leak this run did not cause.
    const leftovers = (await db.execute(sql`
      SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`%${MARKER} ${tag}%`}
    `)) as unknown as { n: number }[];
    console.log(`teardown: ${Number(leftovers[0]?.n ?? -1)} org(s) from this run (${tag}) left behind (expected 0)`);
    if (Number(leftovers[0]?.n ?? -1) !== 0) process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
