// Live verification of the delivery report's grain discipline, in the spirit of
// scripts/verify-epc-surface-grains.ts.
//
// It asserts the properties that, when they broke, produced numbers that looked
// plausible and were wrong:
//   1. every row FOOTS (delivered + undelivered + no_receipt == sent)
//   2. the capability gate emits NULL, never 0, for providers with no DLR intake
//   3. the per-message fold actually dedups (txr writes 3.2x rows per message)
//   4. provider / campaign / stage rollups all reconstruct from the same rows
//   5. the campaign Activity block's cards (lib/reporting/campaign-activity.ts):
//      Messages Sent == the direct status='sent' count, the delivery cards foot
//      to the matured base, N/A is null not 0, they equal the campaign's
//      getDeliveryByStage rows, the nested-loop-off live read returns the SAME
//      rows as the default plan, and every card matches an independent count
//
// ⚠️ It PRINTS ITS INPUT SCOPE. A passing check read against an unknown universe
// is not evidence — that lesson cost four instances of "verified" that weren't.
//
// Read-only. Run:
//   npx tsx --conditions=react-server scripts/verify-delivery-grains.ts [days] [--campaigns=1595,889]
// Section 5 auto-picks the latest tls / txr / txh / mixed-capability campaign and
// any campaign with a send in the last hour; --campaigns adds to that set.

import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  ACTIVITY_DLR_MATURITY_MINUTES,
  countCampaignOptOuts,
  getCampaignDeliveryRows,
  queryLiveCampaignDelivery,
  summarizeCampaignDelivery,
  type CampaignDeliverySummary,
} from "@/lib/reporting/campaign-activity";
import {
  canonicalDeliveryRows,
  etDayBounds,
  getDeliveryByStage,
} from "@/lib/reporting/delivery-rollup";
import {
  DLR_SOURCES,
  getPhoneDirectory,
  getProviderRegistry,
  getStageDirectory,
  isDlrCapable,
  queryDeliveryByStage,
  rollupByCampaign,
  rollupByProvider,
  rollupByStage,
} from "@/lib/reporting/delivery";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const days = Number(positional[0] ?? 7);
  const extraCampaigns = (process.argv.find((a) => a.startsWith("--campaigns=")) ?? "")
    .slice("--campaigns=".length)
    .split(",")
    .filter(Boolean)
    .map(Number);
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const orgs = (await db.execute(sql`
    SELECT id, name FROM organizations ORDER BY created_at LIMIT 1
  `)) as unknown as { id: string; name: string }[];
  const orgId = orgs[0].id;

  // ---- INPUT SCOPE ---------------------------------------------------------
  console.log("=".repeat(72));
  console.log("INPUT SCOPE");
  console.log("=".repeat(72));
  console.log(`org            ${orgs[0].name} (${orgId})`);
  console.log(`window         ${from} .. ${today} ET  (${days} day(s))`);
  console.log(`DLR sources    ${Object.keys(DLR_SOURCES).join(", ")}`);
  // The surfaces now read stage_delivery_rollup (migration 0186) — so this
  // checks the ROLLUP-backed rows every report consumes, not the live query.
  console.log(`row source     stage_delivery_rollup (getDeliveryByStage, lib/reporting/delivery-rollup.ts)`);

  const t0 = Date.now();
  const rows = await getDeliveryByStage(orgId, { from, to: today });
  const queryMs = Date.now() - t0;
  const [stages, phones, registry] = await Promise.all([
    getStageDirectory(orgId),
    getPhoneDirectory(orgId),
    getProviderRegistry(orgId),
  ]);

  const totalSent = rows.reduce((n, r) => n + r.sent, 0);
  console.log(`rows in win    ${rows.length}  (grain: stage x phone)`);
  console.log(`stages in win  ${new Set(rows.map((r) => r.stage_id)).size}`);
  console.log(`numbers in win ${new Set(rows.map((r) => r.provider_phone_id)).size}`);
  console.log(`sends in win   ${totalSent.toLocaleString()}`);
  console.log(`providers      ${registry.map((p) => p.provider_key).join(", ")}`);
  console.log(`query time     ${queryMs} ms`);
  if (rows.length === 0) {
    console.log("\n⚠️  ZERO stages in window — the checks below would pass vacuously.");
    console.log("    Re-run with a wider window: npx tsx scripts/verify-delivery-grains.ts 30");
    process.exit(1);
  }

  // ---- 1. every row foots --------------------------------------------------
  console.log("\n1. ROWS FOOT (delivered + undelivered + no_receipt == sent)");
  const badStages = rows.filter(
    (r) => r.delivered + r.undelivered + r.no_receipt !== r.sent,
  );
  check(`all ${rows.length} stage rows foot`, badStages.length === 0, JSON.stringify(badStages.slice(0, 3)));

  const byProvider = rollupByProvider(rows, phones, registry);
  const badProviders = byProvider.filter(
    (p) => p.dlr_capable && (p.delivered ?? 0) + (p.undelivered ?? 0) + (p.no_receipt ?? 0) !== p.sent,
  );
  check("all capable provider rows foot", badProviders.length === 0, JSON.stringify(badProviders));

  // ---- 2. the capability gate ---------------------------------------------
  console.log("\n2. CAPABILITY GATE (null, never 0 — an ungated query renders");
  console.log("   ~99.9% of platform volume as '0.0% delivered')");
  const nonCapable = byProvider.filter((p) => !p.dlr_capable);
  check(
    `${nonCapable.length} non-capable provider(s) emit NULL for every DLR column`,
    nonCapable.every(
      (p) => p.delivered === null && p.undelivered === null && p.no_receipt === null && p.delivered_pct === null,
    ),
    JSON.stringify(nonCapable.map((p) => [p.provider_key, p.delivered_pct])),
  );
  check(
    "non-capable providers still report Sent",
    nonCapable.every((p) => typeof p.sent === "number"),
  );
  check(
    "no provider row reports exactly 0% delivered",
    !byProvider.some((p) => p.delivered_pct === 0 && p.sent > 0 && !p.dlr_capable),
  );
  // The declaration must agree with what the DB can actually serve.
  for (const key of Object.keys(DLR_SOURCES)) {
    const exists = (await db.execute(sql`
      SELECT to_regclass(${DLR_SOURCES[key].table}) IS NOT NULL AS ok
    `)) as unknown as { ok: boolean }[];
    check(`declared source table for '${key}' exists: ${DLR_SOURCES[key].table}`, Boolean(exists[0]?.ok));
  }
  check(
    "TextHub is NOT declared capable (it has no DLR table at all)",
    !isDlrCapable("txh") && !isDlrCapable("txh2"),
  );

  // ---- 3. the per-message fold actually dedups -----------------------------
  console.log("\n3. PER-MESSAGE FOLD (row-counting inflates txr ~3.2x → 298% delivered)");
  for (const [key, src] of Object.entries(DLR_SOURCES)) {
    const agg = (await db.execute(sql`
      SELECT count(*)::int AS event_rows,
             count(DISTINCT ${sql.raw(src.key)})::int AS messages
      FROM ${sql.raw(src.table)}
      WHERE lower(status) IN ('delivered','undelivered')
        AND ${sql.raw(src.key)} IS NOT NULL
        ${src.filter ? sql`AND ${sql.raw(src.filter)}` : sql``}
    `)) as unknown as { event_rows: number; messages: number }[];
    const { event_rows, messages } = agg[0];
    const ratio = messages > 0 ? (event_rows / messages).toFixed(2) : "n/a";
    console.log(`   ${key}: ${event_rows} terminal event rows → ${messages} messages (${ratio}x)`);
    check(
      `${key}: fold collapses rows to messages (no message counted twice)`,
      event_rows >= messages,
    );
  }
  // A capable provider can never report more delivered than it sent — the exact
  // shape the txr inflation produced (149 delivered against 50 sent).
  check(
    "no capable provider reports delivered > sent",
    !byProvider.some((p) => p.dlr_capable && (p.delivered ?? 0) > p.sent),
    JSON.stringify(byProvider.filter((p) => p.dlr_capable).map((p) => [p.provider_key, p.delivered, p.sent])),
  );

  // ---- 3b. per-number breakdown -------------------------------------------
  console.log("\n3b. PER-NUMBER BREAKDOWN (grain is (stage, phone), keyed off the");
  console.log("    SEND's stamped number — not the stage's, which can change");
  console.log("    between resumable-materialization windows)");
  const allNumbers = byProvider.flatMap((p) => p.numbers);
  check(
    "every provider's number sub-rows sum to its own row",
    byProvider.every((p) => p.numbers.reduce((n, x) => n + x.sent, 0) === p.sent),
    JSON.stringify(byProvider.map((p) => [p.provider_key, p.sent, p.numbers.reduce((n, x) => n + x.sent, 0)])),
  );
  check(
    "every capable number row foots independently",
    allNumbers.every((x) => !x.dlr_capable ||
      (x.delivered ?? 0) + (x.undelivered ?? 0) + (x.no_receipt ?? 0) === x.sent),
  );
  check(
    "no number row reports a % while its provider is non-capable",
    allNumbers.every((x) => x.dlr_capable || x.delivered_pct === null),
  );
  // Sends with no stamped number would silently vanish from provider rows and
  // break the reconciliation below; bucket them explicitly instead.
  const noNumberSends = rows.filter((r) => r.provider_phone_id == null).reduce((n, r) => n + r.sent, 0);
  check(`sends with no stamped number: ${noNumberSends}`, noNumberSends === 0 || allNumbers.some((x) => x.provider_phone_id === null));

  // Split stages: one stage sending from >1 number. 0 in prod today, but the
  // report must handle it — print the count either way so a future occurrence is
  // visible rather than silently averaged.
  const phonesPerStage = new Map<number, Set<number | null>>();
  for (const r of rows) {
    if (!phonesPerStage.has(r.stage_id)) phonesPerStage.set(r.stage_id, new Set());
    phonesPerStage.get(r.stage_id)!.add(r.provider_phone_id);
  }
  const split = [...phonesPerStage.entries()].filter(([, s]) => s.size > 1);
  console.log(`   stages sending from >1 number: ${split.length}${split.length ? " — " + split.slice(0, 5).map(([id]) => id).join(", ") : " (expected 0 today; not structurally prevented)"}`);
  check(
    "split stages (if any) keep their numbers separate, not collapsed",
    split.every(([id]) => rows.filter((r) => r.stage_id === id).length > 1),
  );

  console.log("\n   provider          number         type          sent");
  for (const p of byProvider.filter((x) => x.sent > 0))
    for (const n of p.numbers)
      console.log(`   ${p.provider_key.padEnd(17)}${String(n.phone_number ?? "(none)").padEnd(15)}${String(n.number_type ?? "—").padEnd(13)}${n.sent.toLocaleString().padStart(9)}`);

  // ---- 4. rollups reconcile ------------------------------------------------
  console.log("\n4. ROLLUPS RECONCILE (every surface aggregates the SAME stage rows)");
  const byCampaign = rollupByCampaign(rows, stages, phones);
  const byStage = rollupByStage(rows, phones);
  const known = rows.filter((r) => stages.has(r.stage_id));
  const knownSent = known.reduce((n, r) => n + r.sent, 0);
  check(
    "provider rollup Sent == stage rows Sent",
    byProvider.reduce((n, p) => n + p.sent, 0) === knownSent,
  );
  check(
    "campaign rollup Sent == stage rows Sent",
    [...byCampaign.values()].reduce((n, c) => n + c.total_sent, 0) === knownSent,
  );
  check("stage rollup covers every distinct stage",
    byStage.size === new Set(rows.map((r) => r.stage_id)).size);
  check(
    "every stage maps to a known campaign+provider",
    known.length === rows.length,
    `${rows.length - known.length} stage(s) missing from the directory`,
  );

  // ---- the numbers, for the PR --------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log(`DELIVERY BY PROVIDER — ${from} .. ${today} ET`);
  console.log("=".repeat(72));
  console.log(
    "provider".padEnd(10) + "sent".padStart(10) + "delivrd".padStart(10) +
      "undeliv".padStart(10) + "no rcpt".padStart(10) + "deliv %".padStart(10),
  );
  const dash = (v: number | null) => (v === null ? "—" : v.toLocaleString());
  for (const p of byProvider) {
    console.log(
      p.provider_key.padEnd(10) +
        p.sent.toLocaleString().padStart(10) +
        dash(p.delivered).padStart(10) +
        dash(p.undelivered).padStart(10) +
        dash(p.no_receipt).padStart(10) +
        (p.delivered_pct === null ? "—" : `${p.delivered_pct.toFixed(1)}%`).padStart(10),
    );
  }

  // MIXED-CAPABILITY is the case the coverage label exists for, and it is NOT
  // the same as mixed-PROVIDER. Every mixed-provider campaign in prod today is
  // txh+txh2 — both non-capable — so it renders "—", not a label. Reporting a
  // bare "0" here would read as a pass over a case that was never exercised.
  const cells = [...byCampaign.values()];
  const mixedCapability = cells.filter(
    (c) => c.coverage_pct !== null && c.coverage_pct > 0 && c.coverage_pct < 100,
  );
  const fullyCapable = cells.filter((c) => c.coverage_pct === 100);
  const noneCapable = cells.filter((c) => c.coverage_pct === 0);
  console.log(
    `\ncampaigns in window: ${cells.length}  ` +
      `(${fullyCapable.length} fully DLR-capable · ${noneCapable.length} none-capable → "—" · ` +
      `${mixedCapability.length} MIXED-capability → coverage label)`,
  );
  for (const c of mixedCapability.slice(0, 5)) {
    console.log(
      `   ${c.delivered_pct?.toFixed(1)}% (of ${c.coverage_pct?.toFixed(0)}% of ${c.total_sent.toLocaleString()} sends)`,
    );
  }
  if (mixedCapability.length === 0) {
    console.log(
      "   ⚠️  NO mixed-capability campaign in this window — the coverage-label path is\n" +
        "       NOT exercised by this run. It is covered by scripts/test-delivery-rollups.ts\n" +
        "       instead. It will start firing here as soon as a tls/txr stage lands in a\n" +
        "       campaign that also sends via txh/txh2.",
    );
  }
  // Whatever the mix, a campaign must never report a percentage it cannot back.
  check(
    "no campaign reports a % without capable sends behind it",
    !cells.some((c) => c.delivered_pct !== null && c.capable_sent === 0),
  );
  check(
    "every mixed-capability campaign carries a coverage figure to label with",
    mixedCapability.every((c) => c.coverage_pct !== null && c.delivered_pct !== null),
  );

  await verifyCampaignCards(orgId, phones, extraCampaigns);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 5. CAMPAIGN ACTIVITY CARDS
// ---------------------------------------------------------------------------

const CAPABLE = Object.keys(DLR_SOURCES);
const capableArray = () => sql`ARRAY[${sql.join(CAPABLE.map((p) => sql`${p}`), sql`, `)}]::text[]`;
// The independent receipt scan reads every receipt since the campaign's first
// send. Bounded so an old txr campaign can't turn a verify run into a multi-GB
// read (heavy prod verification runs on a window, not full history).
const DIRECT_MAX_AGE_DAYS = 14;
// The default-plan side of the plan proof IS the 8–12 s misplan; only campaigns
// with sends in the live window have anything to prove.
const PLAN_PROOF_MAX_AGE_DAYS = 3;

async function pickCampaigns(orgId: string, extra: number[]) {
  const picks = new Map<number, string>();
  const latest = (await db.execute(sql`
    WITH c AS (
      SELECT cs.campaign_id,
             array_agg(DISTINCT sp.sms_provider_id) AS provs,
             max(r.sent_date_et) AS last_day
      FROM stage_delivery_rollup r
      JOIN campaign_stages cs ON cs.id = r.stage_id
      LEFT JOIN provider_phones pp ON pp.id = r.provider_phone_id
      LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
      WHERE r.org_id = ${orgId}::uuid
      GROUP BY 1
    ), k AS (
      SELECT campaign_id, last_day,
        CASE
          WHEN provs <@ ARRAY['tls']::text[] THEN 'tls'
          WHEN provs <@ ARRAY['txr']::text[] THEN 'txr'
          WHEN provs <@ ARRAY['txh', 'txh2']::text[] THEN 'txh/txh2 (no DLR)'
          WHEN provs && ${capableArray()} THEN 'mixed capability'
        END AS kind
      FROM c
    )
    SELECT DISTINCT ON (kind) kind, campaign_id FROM k WHERE kind IS NOT NULL
    ORDER BY kind, last_day DESC, campaign_id DESC
  `)) as unknown as { kind: string; campaign_id: number }[];
  for (const r of latest) picks.set(Number(r.campaign_id), `latest ${r.kind}`);
  const recent = (await db.execute(sql`
    SELECT campaign_id FROM stage_sends
    WHERE org_id = ${orgId}::uuid AND status = 'sent' AND sent_at >= now() - interval '1 hour'
    GROUP BY 1 ORDER BY max(sent_at) DESC LIMIT 1
  `)) as unknown as { campaign_id: number }[];
  if (recent[0]) picks.set(Number(recent[0].campaign_id), "sent in the last hour");
  else console.log("⚠️  no campaign sent in the last hour — the Pending path is NOT exercised by this run");
  for (const id of extra) picks.set(id, picks.has(id) ? `${picks.get(id)} + requested` : "requested");
  return picks;
}

// Every delivery card, recomputed WITHOUT the product's helpers: no terminalCte,
// no DELIVERY_COUNTS, no rollup. The fold is retyped here on purpose, so a bug
// in the shared fragments shows up as a mismatch instead of agreeing with itself.
async function directDeliveryCounts(
  orgId: string,
  campaignId: number,
  cutoff: Date,
  providers: Set<string>,
) {
  // Only the receipt tables of providers this campaign actually used — an
  // August ahi campaign must not scan two months of txr receipts.
  const NONE = sql`SELECT NULL::uuid, NULL::text WHERE false`;
  const tls = providers.has("tls")
    ? sql`SELECT matched_stage_send_id, lower(status) FROM tells_webhook_events
          WHERE kind = 'dlr' AND received_at >= (SELECT t FROM lo)`
    : NONE;
  const txr = providers.has("txr")
    ? sql`SELECT coalesce(matched_stage_send_id, stage_send_id), lower(status) FROM textrequest_dlr_events
          WHERE received_at >= (SELECT t FROM lo)`
    : NONE;
  const ahi = providers.has("ahi")
    ? sql`SELECT matched_stage_send_id, lower(status) FROM ahoi_dlr_events
          WHERE received_at >= (SELECT t FROM lo)`
    : NONE;
  const rows = (await db.execute(sql`
    WITH s AS (
      SELECT ss.id, ss.sent_at, sp.sms_provider_id AS p
      FROM stage_sends ss
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
      WHERE ss.org_id = ${orgId}::uuid AND ss.campaign_id = ${campaignId} AND ss.status = 'sent'
    ),
    lo AS (SELECT min(sent_at) - interval '1 hour' AS t FROM s),
    ev(id, st) AS (${tls} UNION ALL ${txr} UNION ALL ${ahi}),
    per AS (
      SELECT id, bool_or(st = 'delivered') AS d, bool_or(st = 'undelivered') AS u,
             count(*) FILTER (WHERE st IN ('delivered', 'undelivered')) AS terminal_rows
      FROM ev WHERE id IN (SELECT id FROM s) GROUP BY id
    ),
    j AS (
      SELECT s.p, s.p = ANY(${capableArray()}) AS cap,
             s.sent_at < ${cutoff.toISOString()}::timestamptz AS mature,
             coalesce(per.d, false) AS d, coalesce(per.u, false) AS u,
             coalesce(per.terminal_rows, 0) AS terminal_rows
      FROM s LEFT JOIN per ON per.id = s.id
    )
    SELECT count(*) FILTER (WHERE cap)::int                                AS capable_sent,
           count(*) FILTER (WHERE cap AND mature)::int                     AS matured,
           count(*) FILTER (WHERE cap AND mature AND d)::int               AS delivered,
           count(*) FILTER (WHERE cap AND mature AND u AND NOT d)::int     AS undelivered,
           count(*) FILTER (WHERE cap AND mature AND NOT d AND NOT u)::int AS no_receipt,
           count(*) FILTER (WHERE cap AND NOT mature)::int                 AS pending,
           count(*) FILTER (WHERE p = 'txr' AND (d OR u))::int             AS txr_terminal_msgs,
           coalesce(sum(terminal_rows) FILTER (WHERE p = 'txr'), 0)::int   AS txr_terminal_rows
    FROM j
  `)) as unknown as Record<string, number>[];
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)])) as Record<
    | "capable_sent" | "matured" | "delivered" | "undelivered" | "no_receipt" | "pending"
    | "txr_terminal_msgs" | "txr_terminal_rows",
    number
  >;
}

async function directStatusCounts(orgId: string, campaignId: number) {
  const rows = (await db.execute(sql`
    SELECT status, count(*)::int AS n FROM stage_sends
    WHERE org_id = ${orgId}::uuid AND campaign_id = ${campaignId} GROUP BY 1
  `)) as unknown as { status: string; n: number }[];
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  // Independent opt-out count: per send, does ANY intake table hold a linked
  // STOP-class event for it (EXISTS per send, not the product's UNION + DISTINCT).
  const oo = (await db.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends ss
    WHERE ss.org_id = ${orgId}::uuid AND ss.campaign_id = ${campaignId} AND (
      EXISTS (SELECT 1 FROM texthub_inbound_events e WHERE e.matched_stage_send_id = ss.id
              AND e.result IN ('suppressed', 'duplicate', 'already_opted_out'))
      OR EXISTS (SELECT 1 FROM textrequest_inbound_events e WHERE e.matched_stage_send_id = ss.id
              AND e.result IN ('suppressed', 'duplicate', 'already_opted_out'))
      OR EXISTS (SELECT 1 FROM tells_webhook_events e WHERE e.kind = 'inbound'
              AND e.matched_stage_send_id = ss.id
              AND e.result IN ('suppressed', 'duplicate', 'already_opted_out'))
      OR EXISTS (SELECT 1 FROM ahoi_inbound_events e WHERE e.matched_stage_send_id = ss.id
              AND e.result IN ('suppressed', 'duplicate', 'already_opted_out')))
  `)) as unknown as { n: number }[];
  return { by, optOuts: Number(oo[0].n) };
}

type Cells = Pick<
  CampaignDeliverySummary,
  "dlr_capable" | "delivered" | "undelivered" | "no_receipt" | "matured" | "pending" | "capable_sent"
>;
function foots(c: Cells) {
  if (!c.dlr_capable) return true;
  return (
    (c.delivered ?? 0) + (c.undelivered ?? 0) + (c.no_receipt ?? 0) === c.matured &&
    (c.matured ?? 0) + (c.pending ?? 0) === c.capable_sent
  );
}

async function verifyCampaignCards(
  orgId: string,
  phones: Awaited<ReturnType<typeof getPhoneDirectory>>,
  extra: number[],
) {
  console.log("\n" + "=".repeat(72));
  console.log("5. CAMPAIGN ACTIVITY CARDS (lib/reporting/campaign-activity.ts)");
  console.log("=".repeat(72));
  const picks = await pickCampaigns(orgId, extra);
  console.log(`maturity       ${ACTIVITY_DLR_MATURITY_MINUTES} min`);
  console.log(`campaigns      ${[...picks].map(([id, why]) => `${id} (${why})`).join(", ") || "(none)"}`);
  check("section 5 input scope is non-empty", picks.size > 0);

  for (const [campaignId, why] of picks) {
    const stageIds = ((await db.execute(sql`
      SELECT id FROM campaign_stages WHERE org_id = ${orgId}::uuid AND campaign_id = ${campaignId}
    `)) as unknown as { id: number }[]).map((r) => Number(r.id));
    const now = new Date();
    const t0 = Date.now();
    const rows = await getCampaignDeliveryRows(orgId, stageIds, now);
    const readMs = Date.now() - t0;
    const card = summarizeCampaignDelivery(rows.matured, rows.pending, phones);
    const optOuts = await countCampaignOptOuts(db, orgId, campaignId);
    const span = (await db.execute(sql`
      SELECT min(sent_at) AS first, max(sent_at) AS last FROM stage_sends
      WHERE org_id = ${orgId}::uuid AND campaign_id = ${campaignId} AND status = 'sent'
    `)) as unknown as { first: string | null; last: string | null }[];
    const first = span[0].first ? new Date(span[0].first) : null;
    const last = span[0].last ? new Date(span[0].last) : null;
    const ageDays = first ? (now.getTime() - first.getTime()) / 86_400_000 : Infinity;
    const liveFromUtc = etDayBounds({ from: rows.liveFromDay, to: rows.liveFromDay }).fromUtc;

    console.log(`\n-- campaign ${campaignId} (${why})`);
    console.log(
      `   scope: ${stageIds.length} stage(s), ${card.sent.toLocaleString()} sent, ` +
        `first ${first?.toISOString() ?? "—"}, last ${last?.toISOString() ?? "—"}; ` +
        `live window from ${rows.liveFromDay} ET, cutoff ${rows.cutoff.toISOString()}; card read ${readMs} ms`,
    );
    check(`c${campaignId}: scope non-empty (sent > 0)`, card.sent > 0, "an empty campaign proves nothing");
    if (card.sent === 0) continue;

    const { by, optOuts: directOptOuts } = await directStatusCounts(orgId, campaignId);
    const n = (k: string) => by.get(k) ?? 0;
    check(`c${campaignId}: Messages Sent == direct status='sent' count`, card.sent === n("sent"),
      `card ${card.sent} vs direct ${n("sent")}`);
    check(`c${campaignId}: cards foot (D + F + NS = matured; matured + pending = capable sent)`,
      foots(card), JSON.stringify(card));
    check(`c${campaignId}: every stage x number row foots`, card.by_stage_phone.every(foots));
    const keys = ["sent", "delivered", "undelivered", "no_receipt", "pending"] as const;
    check(`c${campaignId}: stage x number rows sum to the cards`,
      keys.every((k) => card.by_stage_phone.reduce((t, r) => t + (r[k] ?? 0), 0) === (card[k] ?? 0)));
    if (!card.dlr_capable) {
      check(`c${campaignId}: no DLR-capable sends → every delivery field is NULL (N/A), never 0`,
        [card.delivered, card.undelivered, card.no_receipt, card.pending, card.matured, card.capable_sent,
          card.delivered_pct, card.undelivered_pct, card.no_receipt_pct, card.pending_pct].every((x) => x === null));
    } else {
      check(`c${campaignId}: non-capable stage x number rows are NULL, not 0`,
        card.by_stage_phone.every((r) => r.dlr_capable || (r.delivered === null && r.delivered_pct === null)));
      if ((card.capable_sent ?? 0) < card.sent)
        console.log(`   coverage label: Based on ${card.capable_sent} of ${card.sent} sent`);
    }

    // Cards == the campaign's stage rows from getDeliveryByStage. Exact when the
    // whole campaign predates the live window; otherwise only printed, because
    // the live half is fresher than the 10-min / 3-h rollup by design.
    const fromRollup = summarizeCampaignDelivery(
      await getDeliveryByStage(orgId, {
        from: "2000-01-01",
        to: formatInCampaignTimezone(now, "yyyy-MM-dd"),
      }, stageIds),
      [],
      phones,
    );
    if (last != null && last < liveFromUtc) {
      check(`c${campaignId}: cards == sum of its getDeliveryByStage stage rows`,
        fromRollup.sent === card.sent && fromRollup.delivered === card.delivered &&
          fromRollup.undelivered === card.undelivered && fromRollup.no_receipt === card.no_receipt &&
          (card.pending ?? 0) === 0,
        JSON.stringify({
          rollup: [fromRollup.sent, fromRollup.delivered, fromRollup.undelivered, fromRollup.no_receipt],
          card: [card.sent, card.delivered, card.undelivered, card.no_receipt, card.pending],
        }));
    } else {
      console.log(
        `   in the live window — rollup (stored, may lag) vs card: sent ${fromRollup.sent}/${card.sent}, ` +
          `delivered ${fromRollup.delivered}/${card.delivered}, undelivered ${fromRollup.undelivered}/${card.undelivered}, ` +
          `no_receipt ${fromRollup.no_receipt}/${(card.no_receipt ?? 0) + (card.pending ?? 0)} (card no status + pending)`,
      );
      check(`c${campaignId}: rollup Sent <= card Sent (the rollup can only lag)`, fromRollup.sent <= card.sent);
    }

    // Plan proof: the transaction-scoped enable_nestloop = off read returns the
    // SAME rows as the default plan, over the same bounds.
    if (ageDays <= PLAN_PROOF_MAX_AGE_DAYS) {
      let t = Date.now();
      const def = await queryDeliveryByStage(db, orgId, {
        fromUtc: liveFromUtc, toExclusiveUtc: now, maturedBefore: rows.cutoff, stageIds,
      });
      const defMs = Date.now() - t;
      t = Date.now();
      const off = await queryLiveCampaignDelivery(stageIds, orgId, liveFromUtc, rows.cutoff, now);
      const offMs = Date.now() - t;
      check(`c${campaignId}: nestloop-off rows == default-plan rows (default ${defMs} ms, off ${offMs} ms, ${def.length} row(s))`,
        canonicalDeliveryRows(def) === canonicalDeliveryRows(off.matured),
        `${canonicalDeliveryRows(def)} vs ${canonicalDeliveryRows(off.matured)}`);
    } else {
      console.log(`   plan proof skipped: first send ${ageDays.toFixed(1)} d ago, nothing in the live window`);
    }

    // Side by side against independent counts.
    const hasTxr = card.by_stage_phone.some((r) => r.provider_key === "txr");
    const direct = ageDays <= DIRECT_MAX_AGE_DAYS || !hasTxr
      ? await directDeliveryCounts(orgId, campaignId, rows.cutoff,
        new Set(card.by_stage_phone.map((r) => r.provider_key ?? "")))
      : null;
    const fmt = (x: number | null) => (x === null ? "N/A" : x.toLocaleString());
    const withPct = (x: number | null, p: number | null) => fmt(x) + (p === null ? "" : ` (${p.toFixed(1)}%)`);
    const dir = (k: keyof NonNullable<typeof direct>) =>
      direct === null ? "skipped" : card.dlr_capable ? fmt(direct[k]) : direct.capable_sent === 0 ? "N/A" : fmt(direct[k]);
    const lines: [string, string, string][] = [
      ["Messages sent", fmt(card.sent), fmt(n("sent"))],
      ["Failed at send", fmt(n("failed")), fmt(n("failed"))],
      ["Filtered", fmt(n("filtered")), fmt(n("filtered"))],
      ["Skipped", fmt(n("skipped_duplicate") + n("skipped_opted_out") + n("skipped_ineligible")),
        `${n("skipped_duplicate")}+${n("skipped_opted_out")}+${n("skipped_ineligible")}`],
      ["In flight", fmt(n("pending") + n("sending")), fmt(n("pending") + n("sending"))],
      ["Opt-outs", fmt(optOuts), fmt(directOptOuts)],
      ["Delivered", withPct(card.delivered, card.delivered_pct), dir("delivered")],
      ["Failed delivery", withPct(card.undelivered, card.undelivered_pct), dir("undelivered")],
      ["No status", withPct(card.no_receipt, card.no_receipt_pct), dir("no_receipt")],
      ["Pending", withPct(card.pending, card.pending_pct), dir("pending")],
      ["% base (matured)", fmt(card.matured), dir("matured")],
    ];
    console.log(`   ${"card".padEnd(20)}${"shown".padStart(20)}${"direct DB".padStart(16)}`);
    for (const [k, a, b] of lines) console.log(`   ${k.padEnd(20)}${a.padStart(20)}${b.padStart(16)}`);
    check(`c${campaignId}: Opt-outs card == independent per-send EXISTS count`, optOuts === directOptOuts,
      `${optOuts} vs ${directOptOuts}`);
    if (direct === null) {
      console.log(`   independent delivery count skipped: txr campaign first sent ${ageDays.toFixed(0)} d ago (> ${DIRECT_MAX_AGE_DAYS} d — multi-GB receipt scan)`);
      continue;
    }
    if (card.dlr_capable) {
      check(`c${campaignId}: delivery cards == independent count`,
        card.delivered === direct.delivered && card.undelivered === direct.undelivered &&
          card.no_receipt === direct.no_receipt && card.pending === direct.pending &&
          card.matured === direct.matured && card.capable_sent === direct.capable_sent,
        JSON.stringify(direct));
    } else {
      check(`c${campaignId}: independent count agrees nothing is DLR-capable`, direct.capable_sent === 0);
    }
    if (hasTxr) {
      console.log(`   txr dedup: ${direct.txr_terminal_rows} final-receipt rows → ${direct.txr_terminal_msgs} messages`);
      check(`c${campaignId}: txr fold — no message counted twice (delivered + failed <= messages with a final receipt)`,
        (card.delivered ?? 0) + (card.undelivered ?? 0) <= direct.txr_terminal_msgs);
    }
  }
}
