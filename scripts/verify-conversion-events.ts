import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "../lib/campaign-timezone";
import { etDayWindows, parseKeitaroLedgerRow, type LedgerSourceRow } from "../lib/conversions/keitaro-row";
import { fetchKeitaroConversionLedger } from "../lib/keitaro/client";

// Read-only. Proves conversion_events against a FRESH Keitaro pull (the anchor),
// then PRINTS the documented deltas against today's two conversion sources
// (stage_sends per-recipient, keitaro_stage_results per stage-day).
//   npx tsx scripts/verify-conversion-events.ts
// Phase 1 note: the ledger is not kept live until Phase 2 wires the poll, so
// run this right after the backfill (or re-run the backfill first).

const FROM = process.env.VERIFY_FROM ?? "2026-06-01";

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
const units = (s: string) => Math.round(Number(s) * 10000); // 4dp integer units
const usd = (u: number) => `$${(u / 10000).toFixed(2)}`;

interface LedgerRow {
  id: string;
  type: string;
  revenue: string;
  org: string;
  occurred_et: string;
  last_postback_et: string | null;
}

async function main() {
  const nowEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd HH:mm:ss");
  const windows = etDayWindows(FROM, nowEt, 7);

  const pulled: LedgerSourceRow[] = [];
  let invalid = 0;
  for (const w of windows) {
    const res = await fetchKeitaroConversionLedger(w);
    if (!res.ok) {
      console.log(`FATAL: Keitaro fetch failed for ${w.from}: ${res.error}`);
      process.exit(1);
    }
    for (const raw of res.rows) {
      const p = parseKeitaroLedgerRow(raw);
      if (p) pulled.push(p);
      else invalid++;
    }
  }
  // A conversion re-posted while the pull walks the windows can appear in two of
  // them; one event_id is one ledger row, so keep the last occurrence.
  const live = [...new Map(pulled.map((r) => [r.eventId, r])).values()];
  const duplicates = pulled.length - live.length;
  const ledger = (await db.execute(sql`
    SELECT keitaro_event_id AS id, keitaro_type AS type, revenue::text AS revenue, org_id::text AS org,
           to_char(occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI:SS') AS occurred_et,
           to_char(last_postback_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI:SS') AS last_postback_et
    FROM conversion_events
  `)) as unknown as LedgerRow[];

  console.log(`Scope: Keitaro conversions/log ${FROM} 00:00:00 → ${nowEt} ${CAMPAIGN_TIMEZONE} (${windows.length} windows)`);
  console.log(`       Keitaro rows ${live.length} (+${invalid} unparseable, ${duplicates} duplicate event_id(s) collapsed) · ledger rows ${ledger.length} · orgs ${[...new Set(ledger.map((r) => r.org))].join(", ") || "none"}\n`);

  check("V0 scope is not empty (Keitaro and ledger both have rows)", live.length > 0 && ledger.length > 0);
  check("V0b every Keitaro row parses", invalid === 0, `${invalid} unparseable`);

  const byId = new Map(ledger.map((r) => [r.id, r]));
  const liveIds = new Set(live.map((r) => r.eventId));
  const missing = live.filter((r) => !byId.has(r.eventId));
  const extra = ledger.filter((r) => !liveIds.has(r.id));
  check(
    "V1 every Keitaro conversion is in the ledger",
    missing.length === 0,
    `${missing.length} missing: ${missing.slice(0, 5).map((m) => `${m.eventId} sub_id_3=${m.subId3 ?? "∅"} keitaro_offer=${m.keitaroOfferId ?? "∅"}`).join("; ")}`,
  );
  check("V1b the ledger holds nothing Keitaro doesn't", extra.length === 0, `${extra.length} extra: ${extra.slice(0, 5).map((e) => e.id).join(", ")}`);

  const tally = (pairs: { type: string; revenue: string }[]) => {
    const m = new Map<string, { n: number; u: number }>();
    for (const p of pairs) {
      const t = m.get(p.type) ?? { n: 0, u: 0 };
      t.n++;
      t.u += units(p.revenue);
      m.set(p.type, t);
    }
    return m;
  };
  const k = tally(live.map((r) => ({ type: r.keitaroType, revenue: r.revenue })));
  const l = tally(ledger);
  for (const type of [...new Set([...k.keys(), ...l.keys()])].sort()) {
    const a = k.get(type) ?? { n: 0, u: 0 };
    const b = l.get(type) ?? { n: 0, u: 0 };
    check(
      `V2 ${type}: ledger ${b.n} conv / ${usd(b.u)} = Keitaro ${a.n} conv / ${usd(a.u)}`,
      a.n === b.n && a.u === b.u,
    );
  }

  const unmapped = (await db.execute(sql`
    SELECT ce.keitaro_event_id AS id, ce.keitaro_type AS type, an.network_id AS network
    FROM conversion_events ce
    LEFT JOIN offers o ON o.id = ce.offer_id
    LEFT JOIN affiliate_networks an ON an.id = o.network_id
    WHERE ce.event_type_id IS NULL OR ce.status IS NULL
  `)) as unknown as { id: string; type: string; network: string | null }[];
  check("V3 no unmapped conversions", unmapped.length === 0, unmapped.slice(0, 10).map((u) => `${u.id} ${u.network ?? "∅"}/${u.type}`).join("; "));

  const conflicts = (await db.execute(sql`
    SELECT ce.keitaro_event_id AS id, ce.keitaro_type AS type, et.key AS locked, ct.key AS mapped,
           to_char(ce.event_type_conflict_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI') AS since
    FROM conversion_events ce
    JOIN event_types et ON et.id = ce.event_type_id
    JOIN event_types ct ON ct.id = ce.conflicting_event_type_id
    WHERE ce.conflicting_event_type_id IS NOT NULL
  `)) as unknown as { id: string; type: string; locked: string; mapped: string; since: string }[];
  check(
    "V5 no event-type conflicts (a Keitaro type that now maps to a different event than the locked one)",
    conflicts.length === 0,
    conflicts.slice(0, 10).map((c) => `${c.id} locked ${c.locked}, keitaro type ${c.type} → ${c.mapped} since ${c.since}`).join("; "),
  );

  // Revenue currency (user question 2026-09-17): every conversion to date carries
  // params.currency USD (or none) and revenue == params.payout, so `revenue` is USD.
  // A non-USD postback would leave it unproven whether Keitaro converted the
  // payout — fail loudly so a human decides before those numbers are summed.
  const nonUsd = live.filter((r) => r.currency !== null && r.currency !== "USD");
  check(
    "V6 every conversion's currency param is USD or absent (revenue is summed as USD)",
    nonUsd.length === 0,
    nonUsd.slice(0, 5).map((r) => `${r.eventId} currency=${r.currency} revenue=${r.revenue}`).join("; "),
  );

  const liveById = new Map(live.map((r) => [r.eventId, r]));
  const badTime = ledger.filter((r) => {
    const s = liveById.get(r.id);
    return s !== undefined && r.occurred_et !== s.occurredAtEt;
  });
  check(
    "V4 occurred_at = the original conversion time (earliest status_history entry), in ET",
    badTime.length === 0,
    badTime.slice(0, 5).map((r) => `${r.id} ledger ${r.occurred_et} vs ${liveById.get(r.id)?.occurredAtEt}`).join("; "),
  );
  const redated = ledger.filter((r) => r.last_postback_et !== null && r.occurred_et !== r.last_postback_et);
  console.log(`  info  ${redated.length} conversion(s) re-posted after their original time: ${redated.slice(0, 10).map((r) => `${r.id} ${r.occurred_et} → ${r.last_postback_et}`).join("; ")}`);

  const [head] = (await db.execute(sql`
    SELECT coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'approved'), 0)::text AS approved_revenue,
           coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'pending'), 0)::text AS pending_revenue,
           count(*) FILTER (WHERE et.is_purchase AND ce.status IN ('pending', 'approved'))::int AS purchases,
           count(*) FILTER (WHERE et.is_purchase AND ce.status = 'rejected')::int AS rejected_purchases,
           count(*) FILTER (WHERE et.is_retarget_signal)::int AS registrations
    FROM conversion_events ce LEFT JOIN event_types et ON et.id = ce.event_type_id
  `)) as unknown as { approved_revenue: string; pending_revenue: string; purchases: number; rejected_purchases: number; registrations: number }[];
  console.log(`\nLedger headline: approved revenue ${usd(units(head.approved_revenue))} · pending revenue ${usd(units(head.pending_revenue))} · purchases ${head.purchases} (+${head.rejected_purchases} rejected) · registrations ${head.registrations}`);

  const [rec] = (await db.execute(sql`
    WITH s AS (SELECT id, sale_revenue, keitaro_conversion_id FROM stage_sends WHERE sale_status IS NOT NULL)
    SELECT
      (SELECT count(*) FROM s)::int AS ss_rows,
      (SELECT coalesce(sum(sale_revenue), 0) FROM s)::text AS ss_revenue,
      (SELECT count(*) FROM conversion_events WHERE stage_send_id IS NOT NULL)::int AS ledger_rows,
      (SELECT coalesce(sum(revenue), 0) FROM conversion_events WHERE stage_send_id IS NOT NULL)::text AS ledger_revenue,
      (SELECT count(DISTINCT ce.stage_send_id) FROM conversion_events ce JOIN s ON s.id = ce.stage_send_id
        WHERE ce.keitaro_event_id IS DISTINCT FROM s.keitaro_conversion_id)::int AS extra_recipients,
      (SELECT coalesce(sum(ce.revenue), 0) FROM conversion_events ce JOIN s ON s.id = ce.stage_send_id
        WHERE ce.keitaro_event_id IS DISTINCT FROM s.keitaro_conversion_id)::text AS extra_revenue,
      (SELECT count(*) FROM conversion_events WHERE stage_id IS NOT NULL AND stage_send_id IS NULL)::int AS stage_only_rows,
      (SELECT coalesce(sum(revenue), 0) FROM conversion_events WHERE stage_id IS NOT NULL AND stage_send_id IS NULL)::text AS stage_only_revenue,
      (SELECT count(*) FROM conversion_events WHERE stage_id IS NULL)::int AS offer_only_rows
  `)) as unknown as {
    ss_rows: number; ss_revenue: string; ledger_rows: number; ledger_revenue: string;
    extra_recipients: number; extra_revenue: string; stage_only_rows: number; stage_only_revenue: string; offer_only_rows: number;
  }[];
  const recDelta = units(rec.ledger_revenue) - units(rec.ss_revenue);
  console.log(`\nDelta vs stage_sends (per recipient):`);
  console.log(`  stage_sends ${rec.ss_rows} conv / ${usd(units(rec.ss_revenue))} → ledger (recipient-attributed) ${rec.ledger_rows} conv / ${usd(units(rec.ledger_revenue))}  (${recDelta >= 0 ? "+" : ""}${usd(recDelta)})`);
  console.log(`  explained by conversions latest-wins dropped: ${rec.extra_recipients} recipient(s), ${usd(units(rec.extra_revenue))} · unexplained ${usd(recDelta - units(rec.extra_revenue))}`);
  console.log(`  stage known, no recipient: ${rec.stage_only_rows} conv / ${usd(units(rec.stage_only_revenue))} · offer-only (no stage): ${rec.offer_only_rows}`);

  const [ksr] = (await db.execute(sql`
    SELECT (SELECT coalesce(sum(sales), 0) FROM keitaro_stage_results)::int AS k_sales,
           (SELECT coalesce(sum(revenue), 0) FROM keitaro_stage_results)::text AS k_revenue,
           (SELECT count(*) FROM conversion_events WHERE stage_id IS NOT NULL AND keitaro_type IN ('lead', 'sale', 'rejected'))::int AS l_sales,
           (SELECT coalesce(sum(revenue), 0) FROM conversion_events WHERE stage_id IS NOT NULL AND keitaro_type IN ('lead', 'sale', 'rejected'))::text AS l_revenue
  `)) as unknown as { k_sales: number; k_revenue: string; l_sales: number; l_revenue: string }[];
  const diffs = (await db.execute(sql`
    WITH k AS (SELECT stage_id, stat_date, sales, revenue FROM keitaro_stage_results WHERE sales > 0),
         l AS (SELECT stage_id, (occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
                      count(*)::int AS sales, sum(revenue) AS revenue
               FROM conversion_events
               WHERE stage_id IS NOT NULL AND keitaro_type IN ('lead', 'sale', 'rejected')
               GROUP BY 1, 2)
    SELECT coalesce(k.stage_id, l.stage_id) AS stage_id, coalesce(k.stat_date, l.stat_date)::text AS day,
           coalesce(k.sales, 0) AS k_sales, coalesce(l.sales, 0) AS l_sales,
           coalesce(k.revenue, 0)::text AS k_revenue, coalesce(l.revenue, 0)::text AS l_revenue
    FROM k FULL JOIN l ON l.stage_id = k.stage_id AND l.stat_date = k.stat_date
    WHERE coalesce(k.sales, 0) <> coalesce(l.sales, 0) OR coalesce(k.revenue, 0) <> coalesce(l.revenue, 0)
    ORDER BY 1, 2
  `)) as unknown as { stage_id: number; day: string; k_sales: number; l_sales: number; k_revenue: string; l_revenue: string }[];
  console.log(`\nDelta vs keitaro_stage_results (stage-day, same statuses as the aggregate: lead/sale/rejected):`);
  console.log(`  aggregate ${ksr.k_sales} / ${usd(units(ksr.k_revenue))} → ledger ${ksr.l_sales} / ${usd(units(ksr.l_revenue))}  (${usd(units(ksr.l_revenue) - units(ksr.k_revenue))})`);
  for (const d of diffs) {
    console.log(`  stage ${d.stage_id} ${d.day}: aggregate ${d.k_sales} / ${usd(units(d.k_revenue))} vs ledger ${d.l_sales} / ${usd(units(d.l_revenue))}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
