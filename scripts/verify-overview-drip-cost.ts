// Verifies Overview Cost vs the "Show Drip Campaigns" toggle. READ-ONLY. Usage:
//   npx tsx --conditions=react-server scripts/verify-overview-drip-cost.ts \
//     <dripFrom> <dripTo> <regularFrom> <regularTo> <lifetimeFrom>
//
// A — a range WITH drip sends: cost(ON) − cost(OFF) must equal the drip cost
//     computed here by hand from stage_sends + opt_out_attributions (each send
//     at COALESCE(snapshot, the number's current rate), each opt-out reply at
//     the rate of the send it answered).
// B — a regular-only range: cost(ON) ≡ cost(OFF).
// C — <lifetimeFrom>..today covers every send of the live drip stages, so their
//     summed per-day cost must equal the stage cost model recomputed from the
//     stage's OWN counters: stage phone rate × (sent rows + opt_out_count).
//     Stored total_cost is printed beside it; it lags for drip stages (drip
//     sends don't trigger recomputeStageTotalCost, only opt-outs/PATCH do).
import "./_env-preload";

import { sql } from "drizzle-orm";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";

const [dripFrom, dripTo, regFrom, regTo, lifeFrom] = process.argv.slice(2);
if (!lifeFrom) throw new Error("usage: <dripFrom> <dripTo> <regularFrom> <regularTo> <lifetimeFrom>");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}
const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
const usd = (n: number) => `$${n.toFixed(4)}`;

function utcBounds(from: string, to: string) {
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    fromUtc: fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString(),
    toUtc: fromZonedTime(`${next}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString(),
  };
}

async function handDripCost(orgId: string, from: string, to: string): Promise<number> {
  const { fromUtc, toUtc } = utcBounds(from, to);
  const [r] = (await db.execute(sql`
    SELECT
      (SELECT coalesce(sum(COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)), 0)
         FROM stage_sends ss
         JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
         JOIN campaign_stages cs ON cs.id = ss.stage_id AND cs.archived_at IS NULL
         LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
        WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
          AND ss.sent_at >= ${fromUtc}::timestamptz AND ss.sent_at < ${toUtc}::timestamptz)
    + (SELECT coalesce(sum(COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)), 0)
         FROM opt_out_attributions oa
         JOIN campaigns c ON c.id = oa.campaign_id AND c.type = 'drip'
         JOIN campaign_stages cs ON cs.id = oa.stage_id AND cs.archived_at IS NULL
         JOIN stage_sends ss ON ss.id = oa.stage_send_id
         LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
        WHERE oa.org_id = ${orgId}::uuid
          AND oa.created_at >= ${fromUtc}::timestamptz AND oa.created_at < ${toUtc}::timestamptz)
    AS cost
  `)) as unknown as { cost: string }[];
  return Number(r.cost);
}

async function main() {
  const today = formatInTimeZone(new Date(), CAMPAIGN_TIMEZONE, "yyyy-MM-dd");
  const orgs = (await db.execute(sql`SELECT id FROM organizations`)) as unknown as { id: string }[];
  for (const { id: orgId } of orgs) {
    console.log(`\norg ${orgId}`);
    const t0 = Date.now();
    const [onA, offA, handA] = await Promise.all([
      getStageMetricsInRange(orgId, dripFrom, dripTo, { excludeDrip: false }),
      getStageMetricsInRange(orgId, dripFrom, dripTo, { excludeDrip: true }),
      handDripCost(orgId, dripFrom, dripTo),
    ]);
    const diffA = onA.grand.cost - offA.grand.cost;
    console.log(`A ${dripFrom}..${dripTo}: ON ${usd(onA.grand.cost)}  OFF ${usd(offA.grand.cost)}  (${Date.now() - t0} ms)`);
    check("A  cost(ON) − cost(OFF) = hand-computed drip cost", close(diffA, handA), `${usd(diffA)} vs ${usd(handA)}`);
    if (handA > 0) check("A  drip cost is non-zero in this range", diffA > 0);

    const [onB, offB, handB] = await Promise.all([
      getStageMetricsInRange(orgId, regFrom, regTo, { excludeDrip: false }),
      getStageMetricsInRange(orgId, regFrom, regTo, { excludeDrip: true }),
      handDripCost(orgId, regFrom, regTo),
    ]);
    check(`B  ${regFrom}..${regTo} has no drip cost (hand)`, handB === 0, usd(handB));
    check("B  cost(ON) ≡ cost(OFF)", onB.grand.cost === offB.grand.cost, `${usd(onB.grand.cost)} / ${usd(offB.grand.cost)}`);

    // C: live drip stages first sent on/after lifeFrom; every send is inside lifeFrom..today.
    const stored = (await db.execute(sql`
      SELECT cs.id, cs.total_cost::float8 AS total_cost,
             (COALESCE(pp.cost_per_sms, 0) * (cs.opt_out_count +
               (SELECT count(*) FROM stage_sends ss WHERE ss.stage_id = cs.id AND ss.status = 'sent')))::float8 AS model
      FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id AND c.type = 'drip'
      LEFT JOIN provider_phones pp ON pp.id = cs.provider_phone_id
      WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL AND cs.total_cost_manual = false
        AND cs.sent_at >= ${utcBounds(lifeFrom, lifeFrom).fromUtc}::timestamptz
    `)) as unknown as { id: number; total_cost: number; model: number }[];
    if (stored.length === 0) continue;
    const onC = await getStageMetricsInRange(orgId, lifeFrom, today, { excludeDrip: false });
    for (const s of stored) {
      const got = onC.stages.find((x) => x.stage_id === Number(s.id))?.tally.cost ?? 0;
      check(
        `C  stage ${s.id} Σ per-day cost = rate × (sends + opt-outs)`,
        close(got, s.model),
        `${usd(got)} vs ${usd(s.model)} (stored total_cost ${usd(s.total_cost)})`,
      );
    }
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
