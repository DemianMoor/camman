import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { getDripFunnel } from "@/lib/drip/funnel";
import { getCalibratedLookupRate, describeRate } from "@/lib/reporting/lookup-rate";
import { getPartnerReport } from "@/lib/reporting/partner-report";
import {
  issueReportToken, resolveReportToken, revokeReportToken,
} from "@/lib/reporting/partner-report-token";

// Drip Phase 7 production proof.
//
// ⭐ EVERY REPORTED NUMBER IS CHECKED AGAINST A SEPARATE HAND-WRITTEN QUERY, not
// against itself. Re-running the report's own SQL and comparing would prove only
// that Postgres is deterministic. The counter-queries below count raw rows —
// stage_sends, clicks, opt_out_attributions — by a different route, so a wrong
// join in partner-report.ts shows up as a disagreement rather than as two
// matching wrong answers.
//
// ⚠️ READ-ONLY except for the token lifecycle on the `internal-test` key, which
// the P7 ruling explicitly asks to be proven in production ("verify the signed
// link renders partner-scoped data only, a revoked token 404s"). It ends
// REVOKED, so the run leaves no live link behind.

const CAMPAIGN = 994;
const FROM = "2026-08-01";
const TO = "2026-08-31";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}\n`);

  const org = (await db.execute(sql`
    SELECT org_id FROM campaigns WHERE id = ${CAMPAIGN}
  `)) as unknown as { org_id: string }[];
  if (org.length === 0) throw new Error(`campaign ${CAMPAIGN} not found`);
  const orgId = org[0].org_id;

  // ── the lookup rate, and the window it was calibrated from ───────────────
  console.log("── R1: the lookup rate is explainable ──");
  const rate = await getCalibratedLookupRate();
  console.log(`  ${describeRate(rate)}`);
  check("⭐ rate is calibrated from the ledger, not the flat fallback", rate.source, "ledger");
  check("⭐ and it is derived, not hardcoded: delta / lookups == rate",
        Math.abs(rate.ledgerDeltaUsd! / rate.lookupsProcessed! - rate.rate) < 1e-12, true);
  check("rate is a plausible per-lookup price (< 1 cent)", rate.rate < 0.01, true);

  // ── the funnel, against raw rows ─────────────────────────────────────────
  console.log("\n── R4: the journey funnel for campaign 994 ──");
  const funnel = await getDripFunnel(orgId, CAMPAIGN);
  console.log(`  progression: ${JSON.stringify(funnel.progression)}`);
  console.log(`  outcomes   : ${funnel.outcomes.map((o) => `${o.label}=${o.count}`).join(", ")}`);
  console.log(`  stages     : ${funnel.stages.map((s) => `${s.label}[sent=${s.sent} clicks=${s.clicks} opt=${s.opt_outs}]`).join(", ")}`);

  // hand-computed counterparts, counted a different way
  const hand = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM drip_journeys
        WHERE org_id = ${orgId}::uuid AND campaign_id = ${CAMPAIGN})                AS routed,
      (SELECT count(*)::int FROM drip_journeys
        WHERE org_id = ${orgId}::uuid AND campaign_id = ${CAMPAIGN}
          AND first_send_at IS NOT NULL)                                            AS sent_journeys,
      (SELECT count(DISTINCT l.contact_id)::int FROM links l JOIN clicks ck ON ck.link_id = l.id
        WHERE l.org_id = ${orgId}::uuid AND l.campaign_id = ${CAMPAIGN}
          AND ck.classification NOT IN ('bot','prefetch','suspect'))                AS clicking_contacts,
      (SELECT count(*)::int FROM stage_sends
        WHERE org_id = ${orgId}::uuid AND campaign_id = ${CAMPAIGN}
          AND status = 'sent')                                                      AS send_rows,
      (SELECT count(DISTINCT oa.opt_out_id)::int
         FROM stage_sends ss JOIN opt_out_attributions oa ON oa.stage_send_id = ss.id
        WHERE ss.org_id = ${orgId}::uuid AND ss.campaign_id = ${CAMPAIGN})          AS optouts
  `)) as unknown as Record<string, number>[];
  const h = hand[0];
  console.log(`  hand-counted: ${JSON.stringify(h)}`);

  check("routed matches a raw journey count", funnel.progression.routed, Number(h.routed));
  check("sent matches journeys with a first send", funnel.progression.sent, Number(h.sent_journeys));
  check("⭐ clicked matches DISTINCT clicking contacts (not click events)",
        funnel.progression.clicked, Number(h.clicking_contacts));

  const stageSent = funnel.stages.reduce((a, s) => a + s.sent, 0);
  check("⭐ per-stage sends sum to the campaign's raw sent rows",
        stageSent, Number(h.send_rows));
  const stageOptOuts = funnel.stages.reduce((a, s) => a + s.opt_outs, 0);
  check("per-stage opt-outs sum to the campaign's attributed opt-outs",
        stageOptOuts, Number(h.optouts));

  // ⭐ the shape assertion that catches a fan-out: outcomes are DISJOINT and
  // must sum to routed. Progression is nested and must NOT be summed — if the
  // two ever agreed, one of them would be wrong.
  const outcomeTotal = funnel.outcomes.reduce((a, o) => a + o.count, 0);
  check("⭐ outcomes are disjoint — they sum to routed", outcomeTotal, funnel.progression.routed);
  check("⭐ progression is monotone (routed ≥ sent ≥ clicked ≥ offer ≥ converted)",
        [
          funnel.progression.routed >= funnel.progression.sent,
          funnel.progression.sent >= funnel.progression.clicked,
          funnel.progression.clicked >= funnel.progression.reached_offer,
          funnel.progression.reached_offer >= funnel.progression.converted,
        ],
        [true, true, true, true]);

  // ── the partner report, against raw rows ─────────────────────────────────
  console.log(`\n── R2: the partner report, ${FROM} → ${TO} ──`);
  const report = await getPartnerReport(orgId, FROM, TO);
  for (const r of report.rows) {
    console.log(`  ${r.partner_slug}/${r.interest_tag || "(untagged)"}: ` +
      `leads=${r.leads_received} (m${r.mobile}/v${r.voip}/u${r.unknown}/l${r.landline}) ` +
      `sent=${r.sent} clicks=${r.clicks} ctr=${r.ctr} opt=${r.opt_outs} ` +
      `sales=${r.sales} cost=$${r.lookup_cost_usd.toFixed(4)} rev=$${r.revenue_usd}`);
  }

  const row = report.rows.find((r) => r.partner_slug === "internal-test");
  check("the internal-test partner appears", !!row, true);
  if (row) {
    const raw = (await db.execute(sql`
      SELECT sum(received)::int AS received, sum(mobile)::int AS mobile,
             sum(voip)::int AS voip, sum(landline)::int AS landline,
             sum(lookups_spent)::int AS lookups
      FROM lead_intake_daily
      WHERE org_id = ${orgId}::uuid AND partner_key_id = ${row.partner_key_id}
        AND day_et >= ${FROM}::date AND day_et <= ${TO}::date
    `)) as unknown as Record<string, number>[];
    const q = raw[0];
    check("leads_received matches the raw counter sum", row.leads_received, Number(q.received));
    check("the line-type split matches the raw counters",
          [row.mobile, row.voip, row.landline],
          [Number(q.mobile), Number(q.voip), Number(q.landline)]);
    check("⭐ the split sums to leads_received (landlines INCLUDED)",
          row.mobile + row.voip + row.unknown + row.landline, row.leads_received);
    check("⭐ lookup cost == lookups × the calibrated rate, to the cent",
          Math.round(row.lookup_cost_usd * 1e6),
          Math.round(Number(q.lookups) * rate.rate * 1e6));
    check("⭐ CTR is clicks/sent, not a stored number",
          row.ctr, row.sent > 0 ? row.clicks / row.sent : null);
    check("⭐ revenue is 0 while nothing has converted", row.revenue_usd, 0);
  }

  // ⭐ sandbox must be absent, not zeroed — a sandbox key in the list with all
  // zeroes would still tell a partner that a test key exists.
  const sandboxLeak = report.rows.filter((r) => r.partner_slug.includes("sandbox"));
  check("⭐ no sandbox key appears in the report at all", sandboxLeak.length, 0);

  // ── the signed link ──────────────────────────────────────────────────────
  console.log("\n── R4: signed report links ──");
  const key = (await db.execute(sql`
    SELECT id, partner_slug FROM partner_keys
    WHERE org_id = ${orgId}::uuid AND partner_slug = 'internal-test' LIMIT 1
  `)) as unknown as { id: number; partner_slug: string }[];
  if (key.length === 0) throw new Error("internal-test partner key not found");
  const keyId = key[0].id;

  const token = await issueReportToken(orgId, keyId, null);
  check("a token is issued", typeof token === "string" && token!.length > 20, true);

  const stored = (await db.execute(sql`
    SELECT report_token_hash, report_show_revenue FROM partner_keys WHERE id = ${keyId}
  `)) as unknown as { report_token_hash: string; report_show_revenue: boolean }[];
  check("⭐ the plaintext token is NOT in the database",
        stored[0].report_token_hash === token, false);
  check("⭐ what is stored is a sha256 hex digest",
        /^[0-9a-f]{64}$/.test(stored[0].report_token_hash), true);
  check("⭐ revenue is OFF by default for this key", stored[0].report_show_revenue, false);

  const resolved = await resolveReportToken(token);
  check("the token resolves", resolved?.partnerKeyId, keyId);
  check("⭐ scope comes from the key row", resolved?.partnerSlug, "internal-test");
  check("⭐ and it carries the revenue flag, not the URL", resolved?.showRevenue, false);

  // partner-scoped data only
  const scoped = await getPartnerReport(orgId, FROM, TO, resolved!.partnerKeyId);
  check("⭐ the scoped report contains ONLY this partner",
        [...new Set(scoped.rows.map((r) => r.partner_key_id))], [keyId]);
  check("⭐ and it is a strict subset of the internal report",
        scoped.rows.length <= report.rows.length, true);

  check("a garbage token resolves to null", await resolveReportToken("not-a-real-token"), null);
  check("an empty token resolves to null", await resolveReportToken(""), null);

  const revoked = await revokeReportToken(orgId, keyId);
  check("revoke succeeds", revoked, true);
  check("⭐ the revoked token now resolves to null (the page 404s)",
        await resolveReportToken(token), null);

  const afterRevoke = (await db.execute(sql`
    SELECT report_token_hash IS NULL AS cleared, status FROM partner_keys WHERE id = ${keyId}
  `)) as unknown as { cleared: boolean; status: string }[];
  check("the hash is cleared", afterRevoke[0].cleared, true);
  check("⭐ the KEY itself still works — intake is unaffected by revoking a link",
        afterRevoke[0].status, "active");

  console.log(`\nleft in production: ${keyId} has NO live report link (revoked above).`);
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
