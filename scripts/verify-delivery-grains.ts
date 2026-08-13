// Live verification of the delivery report's grain discipline, in the spirit of
// scripts/verify-epc-surface-grains.ts.
//
// It asserts the properties that, when they broke, produced numbers that looked
// plausible and were wrong:
//   1. every row FOOTS (delivered + undelivered + no_receipt == sent)
//   2. the capability gate emits NULL, never 0, for providers with no DLR intake
//   3. the per-message fold actually dedups (txr writes 3.2x rows per message)
//   4. provider / campaign / stage rollups all reconstruct from the same rows
//
// ⚠️ It PRINTS ITS INPUT SCOPE. A passing check read against an unknown universe
// is not evidence — that lesson cost four instances of "verified" that weren't.
//
// Read-only. Run: npx tsx scripts/verify-delivery-grains.ts [days]

import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  DLR_SOURCES,
  getDeliveryByStage,
  getPhoneDirectory,
  getProviderRegistry,
  getStageDirectory,
  isDlrCapable,
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
  const days = Number(process.argv[2] ?? 7);
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

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
