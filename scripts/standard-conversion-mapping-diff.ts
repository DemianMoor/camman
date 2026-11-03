// STANDARD CONVERSION MODEL — per-network diff (READ-ONLY).
//
//   npx tsx scripts/standard-conversion-mapping-diff.ts            # the diff
//   npx tsx scripts/standard-conversion-mapping-diff.ts --sql      # + the A1 SQL to review
//   npx tsx scripts/standard-conversion-mapping-diff.ts --json out.json   # per-network sales/revenue snapshot
//
// Compares every active network's conversion rules with STANDARD_EVENT_MODEL
// (lib/conversions/standard-model.ts) and classifies each Keitaro type:
//   ADD        A1 adds it: a missing registration / deposit rule, or the Lead event type
//   OVERRIDE   differs from the standard ON PURPOSE and stays (OWNER_OVERRIDES below)
//   DIFFERS    differs from the standard, NOT changed by A1 — a later decision
//   MISSING    no rule, NOT added by A1 — a later decision
//   ok         matches the standard
// For each ADD it counts the ledger rows of that type on that network in the
// last 7 ET days (the window the live poll rewrites): non-zero means applying
// the rule would move numbers, and A1 promises it moves none.
//
// It runs inside BEGIN READ ONLY and writes nothing. The --sql output is NOT
// executed; it is applied, after review and the owner's "go", by hand.

import "./_env-preload";

import { writeFileSync } from "node:fs";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import {
  LEAD_EVENT_TYPE,
  STANDARD_EVENT_MODEL,
  isOverride,
} from "../lib/conversions/standard-model";
import { approvedRevenueClause, purchasedClause } from "../lib/sale-attribution";

// Owner decision 2026-11-03: these networks post PAID sales as `lead`, so their
// `lead` rule stays Purchase. Keyed by affiliate_networks.network_id.
const OWNER_OVERRIDES: Record<string, { keitaroType: string; why: string }[]> = {
  swp: [{ keitaroType: "lead", why: "Sweeply posts every paid sale as status=lead" }],
  dg24: [{ keitaroType: "lead", why: "Digistore24's postback sends lead_status=payment" }],
};

// The only standard rules A1 adds to existing networks.
const A1_ADDS = new Set(["registration", "deposit"]);

const args = process.argv.slice(2);
const wantSql = args.includes("--sql");
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

type Row = Record<string, unknown>;

async function main() {
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const q = async <T extends Row>(s: ReturnType<typeof sql>) =>
      (await tx.execute(s)) as unknown as T[];

    const eventTypes = await q<{ org_id: string; id: number; key: string; status: string }>(sql`
      SELECT org_id::text, id, key, status FROM event_types ORDER BY org_id, id`);
    const networks = await q<{ org_id: string; id: number; code: string; name: string }>(sql`
      SELECT org_id::text, id, network_id AS code, name FROM affiliate_networks
      WHERE status = 'active' ORDER BY org_id, id`);
    const rules = await q<{
      network_id: number; keitaro_type: string; event_key: string | null; event_type_id: number | null; conversion_status: string;
    }>(sql`
      SELECT m.affiliate_network_id AS network_id, m.keitaro_type, et.key AS event_key,
             m.event_type_id, m.conversion_status
      FROM conversion_event_mappings m LEFT JOIN event_types et ON et.id = m.event_type_id
      WHERE m.status = 'active' AND m.affiliate_network_id IS NOT NULL`);
    const recent = await q<{ network_id: number; keitaro_type: string; n: number }>(sql`
      SELECT o.network_id, ce.keitaro_type, count(*)::int AS n
      FROM conversion_events ce JOIN offers o ON o.id = ce.offer_id
      WHERE ce.occurred_at >= ((now() AT TIME ZONE 'America/New_York')::date - 6)::timestamp AT TIME ZONE 'America/New_York'
         OR ce.last_postback_at >= ((now() AT TIME ZONE 'America/New_York')::date - 6)::timestamp AT TIME ZONE 'America/New_York'
      GROUP BY 1, 2`);
    const money = await q<{ network_id: number; sales: number; revenue: string; rows: number }>(sql`
      SELECT o.network_id,
             count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS sales,
             coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0)::numeric(14,4)::text AS revenue,
             count(*)::int AS rows
      FROM conversion_events ce JOIN offers o ON o.id = ce.offer_id
      GROUP BY 1`);
    return { eventTypes, networks, rules, recent, money };
  });

  const sqlLines: string[] = [];
  const orgs = [...new Set(out.networks.map((n) => n.org_id))];
  let addsWithRows = 0;

  for (const org of orgs) {
    const ets = out.eventTypes.filter((e) => e.org_id === org && e.status === "active");
    const hasKey = (k: string) => ets.some((e) => e.key === k);
    console.log(`\n=== org ${org}  (event types: ${ets.map((e) => e.key).join(", ")})`);

    if (!hasKey(LEAD_EVENT_TYPE.key)) {
      console.log(`  ADD event type '${LEAD_EVENT_TYPE.key}' (not a sale, counts revenue, not a retarget signal)`);
      sqlLines.push(
        `INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal) ` +
          `VALUES ('${org}', '${LEAD_EVENT_TYPE.key}', '${LEAD_EVENT_TYPE.label}', ${LEAD_EVENT_TYPE.display_order}, ` +
          `${LEAD_EVENT_TYPE.is_purchase}, ${LEAD_EVENT_TYPE.counts_revenue}, ${LEAD_EVENT_TYPE.is_retarget_signal});`,
      );
    }

    for (const n of out.networks.filter((x) => x.org_id === org)) {
      const m = out.money.find((x) => x.network_id === n.id);
      console.log(
        `\n  ${n.name} (#${n.id}, ${n.code})  ledger: ${m?.rows ?? 0} rows · sales ${m?.sales ?? 0} · approved revenue $${Number(m?.revenue ?? 0).toFixed(2)}`,
      );
      const nr = out.rules.filter((r) => r.network_id === n.id);
      for (const std of STANDARD_EVENT_MODEL) {
        const r = nr.find((x) => x.keitaro_type === std.keitaroType);
        const stdText = `${std.eventTypeKey ?? "(keep type)"}/${std.conversionStatus}`;
        const recentN = out.recent.find((x) => x.network_id === n.id && x.keitaro_type === std.keitaroType)?.n ?? 0;
        let verdict: string;
        if (!r) {
          if (A1_ADDS.has(std.keitaroType) && std.eventTypeKey && hasKey(std.eventTypeKey)) {
            verdict = `ADD       → ${stdText}   (rows of this type, last 7 ET days: ${recentN})`;
            if (recentN > 0) addsWithRows++;
            sqlLines.push(
              `INSERT INTO conversion_event_mappings (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status) ` +
                `SELECT '${org}', ${n.id}, '${std.keitaroType}', id, '${std.conversionStatus}' FROM event_types ` +
                `WHERE org_id = '${org}' AND key = '${std.eventTypeKey}';  -- ${n.name}`,
            );
          } else {
            verdict = `MISSING   standard ${stdText} — not in A1`;
          }
        } else {
          const current = `${r.event_key ?? "(keep type)"}/${r.conversion_status}`;
          if (!isOverride(r.keitaro_type, r.event_key, r.conversion_status)) {
            verdict = `ok        ${current}`;
          } else {
            const owner = OWNER_OVERRIDES[n.code]?.find((o) => o.keitaroType === std.keitaroType);
            verdict = owner
              ? `OVERRIDE  ${current} (standard ${stdText}) — keep: ${owner.why}`
              : `DIFFERS   ${current} (standard ${stdText}) — not in A1`;
          }
        }
        console.log(`    ${std.keitaroType.padEnd(13)}${verdict}`);
      }
      for (const r of nr.filter((x) => !STANDARD_EVENT_MODEL.some((s) => s.keitaroType === x.keitaro_type))) {
        console.log(`    ${r.keitaro_type.padEnd(13)}extra     ${r.event_key ?? "(keep type)"}/${r.conversion_status} (outside the model, untouched)`);
      }
    }
  }

  console.log(
    `\nA1 adds touching rows in the 7-day window: ${addsWithRows} ${addsWithRows === 0 ? "(no numbers move)" : "⚠️ NUMBERS WOULD MOVE — stop"}`,
  );
  if (wantSql) {
    console.log(`\n-- A1 SQL (NOT executed; apply attended, after "go")\nBEGIN;\n${sqlLines.join("\n")}\nCOMMIT;`);
  }
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(out.money.sort((a, b) => a.network_id - b.network_id), null, 2));
    console.log(`\nper-network sales/revenue snapshot → ${jsonOut}`);
  }
  process.exit(addsWithRows === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
