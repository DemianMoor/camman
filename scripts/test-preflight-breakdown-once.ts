import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import {
  computePreflightBreakdown,
  type PreflightBreakdown,
} from "@/lib/sends/preflight-breakdown";
import { computePreflightBreakdownLegacy } from "./_legacy-preflight-breakdown";

// EQUALITY BAR for the 2026-11-13 "recipient set once" rewrite of
// computePreflightBreakdown. For every fixture stage it computes the breakdown
// with the FROZEN pre-rewrite implementation (scripts/_legacy-preflight-
// breakdown.ts) and with the new one, in the same transaction (same snapshot,
// same now()), and asserts the two are deep-equal apart from computed_at.
//
// Fixtures: plain tracked stage (opt-out + 1h dedup + blockers), split stage,
// lane child (parent aliveness), split-group lane with a sibling claim, carrier
// policy (blocked carrier + allow_unknown_carrier=false + NULL carrier), tag
// rules (missing first_name), lifecycle_rules on AND off over the same pool,
// prior-offer exclusion (legacy rule and offer rules), a missing stage.
//
// Each fixture also asserts the path it is meant to exercise is non-trivial
// (e.g. carrier map non-empty) — equal-and-empty proves nothing.
// Plus: the new call leaves the caller's transaction as it found it (no
// statement_timeout change, no temp table), and source guards.
//
// Rolled-back tx. Run: npx tsx scripts/test-preflight-breakdown-once.ts

class Rollback extends Error {}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
function strip(b: PreflightBreakdown): string {
  const { computed_at: _ignored, ...rest } = b;
  void _ignored;
  return JSON.stringify(canon(rest));
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof dbType;
      const one = async <X>(q: Parameters<typeof tx.execute>[0]): Promise<X> =>
        ((await tx.execute(q)) as unknown as X[])[0];
      const tag = Date.now().toString(36);
      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`)).id;

      const compare = async (
        label: string,
        campaignId: number,
        stageId: number,
        nonTrivial?: (b: PreflightBreakdown) => [boolean, string],
      ) => {
        const oldB = await computePreflightBreakdownLegacy(T, { orgId, campaignId, stageId });
        const newB = await computePreflightBreakdown(T, { orgId, campaignId, stageId });
        const a = strip(oldB);
        const b = strip(newB);
        assert(a === b, `${label}: new == legacy`);
        if (a !== b) {
          console.log(`    legacy: ${a}`);
          console.log(`    new:    ${b}`);
        }
        if (nonTrivial) {
          const [ok, why] = nonTrivial(newB);
          assert(ok, `${label}: exercises its path — ${why}`);
        }
        return newB;
      };

      // ── shared fixtures ─────────────────────────────────────────────────────
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"pbx-" + tag}, ${"Acme"}) RETURNING id`);
      const net = await one<{ id: number }>(sql`
        INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${orgId}, ${"pbx-n-" + tag}, ${"N"}) RETURNING id`);
      const offer = await one<{ id: number }>(sql`
        INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${orgId}, ${"pbx-o-" + tag}, ${net.id}, ${"O"}) RETURNING id`);
      const provider = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (org_id, sms_provider_id, name, supports_api_send, sends_enabled)
        VALUES (${orgId}, ${"pbx-p-" + tag}, ${"P"}, true, true) RETURNING id`);
      const mkPhone = async (allowUnknown: boolean) =>
        (await one<{ id: number }>(sql`
          INSERT INTO provider_phones (org_id, provider_id, phone_number, allow_unknown_carrier)
          VALUES (${orgId}, ${provider.id}, ${"+1565" + Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}, ${allowUnknown})
          RETURNING id`)).id;
      const phoneOpen = await mkPhone(true);
      const creative = (await one<{ id: number }>(sql`
        INSERT INTO creatives (slug, org_id, text, status) VALUES (${"pbx-c-" + tag}, ${orgId}, ${"Deal inside"}, 'active') RETURNING id`)).id;

      let cSeq = 0;
      const mkContact = async (o: { carrier?: string; lifecycle?: string } = {}) => {
        const phone = `+1566${tag.slice(-3).replace(/\D/g, "3").padStart(3, "3")}${String(cSeq++).padStart(4, "0")}`;
        const id = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, carrier_norm, lifecycle_status, line_type)
          VALUES (${orgId}, ${phone}, ${o.carrier ?? "Verizon"}, ${o.lifecycle ?? "cold"}, 'mobile') RETURNING id`)).id;
        return { id, phone };
      };
      let campSeq = 0;
      const mkCampaign = async (o: {
        mode?: "tracked" | "manual";
        offer?: boolean;
        priorOffer?: boolean;
        offerRules?: boolean;
        lifecycle?: boolean;
      } = {}) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, brand_id, offer_id, link_mode, status,
                                 exclude_prior_offer_contacts, offer_rules_enabled, offer_cooldown_days,
                                 offer_limit_times, lifecycle_rules, tracking_id)
          VALUES (${orgId}, ${"pbx-camp-" + tag + "-" + campSeq}, 'pbx', ${brand.id}, ${o.offer ? offer.id : null},
                  ${o.mode ?? "tracked"}, 'active', ${o.priorOffer ?? false}, ${o.offerRules ?? false}, 7, 5,
                  ${o.lifecycle ?? false}, ${"pbx_" + tag + "_" + campSeq++})
          RETURNING id`)).id;
      let sSeq = 0;
      const mkStage = async (
        campId: number,
        o: {
          tier?: number | null;
          parent?: number | null;
          splitIndex?: number | null;
          splitTotal?: number | null;
          phone?: number | null;
          creativeId?: number | null;
          splitGroup?: string | null;
        } = {},
      ) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, send_approved, include_no_status, include_clickers,
             exclude_clickers, behavioral_tier, parent_stage_id, split_index, split_total,
             sms_provider_id, provider_phone_id, creative_id, tracking_id, short_url, stop_text, split_group_id)
          VALUES (${orgId}, ${campId}, ${sSeq}, true, true, true, false, ${o.tier ?? null}, ${o.parent ?? null},
                  ${o.splitIndex ?? null}, ${o.splitTotal ?? null}, ${provider.id},
                  ${o.phone === undefined ? phoneOpen : o.phone}, ${o.creativeId === undefined ? creative : o.creativeId},
                  ${"pbx_st_" + tag + "_" + sSeq++}, ${"https://ex.co/abc"}, ${"Reply STOP to opt out"},
                  ${o.splitGroup ?? null}::uuid)
          RETURNING id`)).id;
      const addPool = async (campId: number, contactId: string) =>
        tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
          VALUES (${orgId}, ${campId}, ${contactId}, true, false, false)`);
      const addSend = async (campId: number, stageId: number, c: { id: string; phone: string }, ago: string, status = "sent") =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          VALUES (${orgId}, ${campId}, ${stageId}, ${c.id}, ${c.phone}, ${"x"}, ${status}, now() - ${ago}::interval)`);
      const many = async (n: number, campId: number, o: { carrier?: string; lifecycle?: string } = {}) => {
        const out: { id: string; phone: string }[] = [];
        for (let i = 0; i < n; i++) {
          const c = await mkContact(o);
          await addPool(campId, c.id);
          out.push(c);
        }
        return out;
      };

      // ── F1 plain tracked: opt-out, 1h dedup, blockers ──────────────────────
      console.log("F1 plain tracked stage (opt-out + 1h dedup + blockers):");
      {
        const camp = await mkCampaign();
        const hist = await mkStage(camp);
        const st = await mkStage(camp);
        const cs = await many(5, camp);
        await tx.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number, source) VALUES (${orgId}, ${cs[0].id}, ${cs[0].phone}, 'sms_inbound')`);
        await addSend(camp, hist, cs[1], "20 minutes");
        await compare("F1", camp, st, (b) => [
          b.excluded.opt_out === 1 && b.excluded.dedup_1h_predicted === 1 && b.blockers.length > 0,
          `opt_out=${b.excluded.opt_out} dedup=${b.excluded.dedup_1h_predicted} blockers=${b.blockers.join(",")}`,
        ]);
        // No sending number → no drain estimate, no carrier block, extra blocker.
        const st2 = await mkStage(camp, { phone: null });
        await compare("F1b no sender number", camp, st2, (b) => [
          b.blockers.includes("no_sender_number") && b.sender_sends_per_second === null,
          `blockers=${b.blockers.join(",")}`,
        ]);
        // No creative.
        const st3 = await mkStage(camp, { creativeId: null });
        await compare("F1c no creative", camp, st3, (b) => [b.blockers[0] === "no_creative", `blockers=${b.blockers.join(",")}`]);
      }

      // ── F2 split stage ─────────────────────────────────────────────────────
      console.log("F2 split stage (1 of 2, 2 of 2):");
      {
        const camp = await mkCampaign();
        await many(12, camp);
        const s1 = await mkStage(camp, { splitIndex: 1, splitTotal: 2 });
        const s2 = await mkStage(camp, { splitIndex: 2, splitTotal: 2 });
        await compare("F2 split 1/2", camp, s1, (b) => [b.excluded.split > 0, `split=${b.excluded.split}`]);
        await compare("F2 split 2/2", camp, s2, (b) => [b.excluded.split > 0, `split=${b.excluded.split}`]);
      }

      // ── F3 lane child + split-group lane with a sibling claim ──────────────
      console.log("F3 lane child (aliveness) + split-group lane (sibling exclusion):");
      {
        const camp = await mkCampaign();
        const parent = await mkStage(camp);
        const cs = await many(6, camp);
        for (const c of cs.slice(0, 4)) await addSend(camp, parent, c, "3 hours");
        const child = await mkStage(camp, { tier: 0, parent });
        await compare("F3 lane child", camp, child, (b) => [b.excluded.lane > 0, `lane=${b.excluded.lane}`]);

        const grp = (await one<{ id: string }>(sql`
          INSERT INTO campaign_stage_split_groups (org_id, campaign_id, source_stage_ids)
          VALUES (${orgId}, ${camp}, array[${parent}]::int[]) RETURNING id`)).id;
        const laneA = await mkStage(camp, { tier: 0, parent, splitGroup: grp });
        const laneB = await mkStage(camp, { tier: 0, parent, splitGroup: grp });
        await addSend(camp, laneA, cs[0], "2 hours", "pending"); // laneA already claims cs[0]
        await compare("F3 split-group lane B", camp, laneB, (b) => [b.excluded.lane >= 3, `lane=${b.excluded.lane}`]);
      }

      // ── F4 carrier policy ─────────────────────────────────────────────────
      console.log("F4 carrier policy (blocked carrier, unknown off, Unmapped/Unknown carriers):");
      {
        const camp = await mkCampaign();
        await many(3, camp, { carrier: "T-Mobile" });
        await many(2, camp, { carrier: "Verizon" });
        await many(2, camp, { carrier: "Unmapped" });
        await many(1, camp, { carrier: "Unknown" });
        const strict = await mkPhone(false);
        await tx.execute(sql`
          INSERT INTO phone_carrier_limits (org_id, provider_phone_id, carrier_norm, allowed)
          VALUES (${orgId}, ${strict}, 'T-Mobile', false)`);
        const st = await mkStage(camp, { phone: strict });
        await compare("F4 strict number", camp, st, (b) => [
          Object.keys(b.excluded.carrier).length === 3 && b.materialized_audience === 2,
          `carrier=${JSON.stringify(b.excluded.carrier)} materialized=${b.materialized_audience}`,
        ]);
        const lax = await mkPhone(true);
        await tx.execute(sql`
          INSERT INTO phone_carrier_limits (org_id, provider_phone_id, carrier_norm, allowed)
          VALUES (${orgId}, ${lax}, 'Verizon', false)`);
        const st2 = await mkStage(camp, { phone: lax });
        await compare("F4 lax number", camp, st2, (b) => [
          b.excluded.carrier.Verizon === 2 && b.materialized_audience === 6,
          `carrier=${JSON.stringify(b.excluded.carrier)}`,
        ]);
      }

      // ── F5 tag rules ──────────────────────────────────────────────────────
      console.log("F5 tag rules ({first_name}):");
      for (const mode of ["manual", "tracked"] as const) {
        const tagCreative = (await one<{ id: number }>(sql`
          INSERT INTO creatives (slug, org_id, text, status)
          VALUES (${"pbx-tc-" + mode + tag}, ${orgId}, ${"Hi {first_name} we have news"}, 'active') RETURNING id`)).id;
        const camp = await mkCampaign({ mode });
        const cs = await many(4, camp);
        await tx.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, first_name) VALUES (${cs[0].id}, ${orgId}, 'Mary')`);
        await tx.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, first_name) VALUES (${cs[1].id}, ${orgId}, 'N/A')`);
        const st = await mkStage(camp, { creativeId: tagCreative });
        await compare(`F5 tag rules (${mode})`, camp, st, (b) => [
          (b.missing_by_tag.first_name ?? 0) > 0 && b.excluded.missing_tag_data > 0,
          `missing_by_tag=${JSON.stringify(b.missing_by_tag)} missing_tag_data=${b.excluded.missing_tag_data}`,
        ]);
      }

      // ── F6 lifecycle rules on / off over the same shape ────────────────────
      console.log("F6 lifecycle rules on / off:");
      {
        const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
        const build = async (lifecycle: boolean) => {
          const camp = await mkCampaign({ lifecycle, offer: true });
          await many(3, camp, { lifecycle: "cold" });
          const sup = await many(2, camp, { lifecycle: "suppressed" });
          const frz = await many(2, camp, { lifecycle: "freeze" });
          for (const c of sup) {
            await tx.execute(sql`
              INSERT INTO contact_engagement (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
                msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at, freeze_cadence_days, thresholds)
              VALUES (${c.id}::uuid, ${orgId}, 'suppressed', now(), 5, 5, 0, 0, 0, 0, ${ago(90)}::timestamptz, null, 14, '{}'::jsonb)`);
          }
          for (const c of frz) {
            await tx.execute(sql`
              INSERT INTO contact_engagement (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
                msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at, freeze_cadence_days, thresholds)
              VALUES (${c.id}::uuid, ${orgId}, 'freeze', now(), 5, 5, 0, 0, 0, 0, ${ago(3)}::timestamptz, null, 45, '{}'::jsonb)`);
          }
          return { camp, st: await mkStage(camp) };
        };
        const on = await build(true);
        await compare("F6 lifecycle ON", on.camp, on.st, (b) => {
          const lc = b.excluded.suppressed + b.excluded.freeze_not_due;
          return [lc > 0, `suppressed=${b.excluded.suppressed} freeze_not_due=${b.excluded.freeze_not_due}`];
        });
        const off = await build(false);
        await compare("F6 lifecycle OFF", off.camp, off.st, (b) => [
          b.excluded.suppressed === 0 && b.excluded.freeze_not_due === 0 && b.materialized_audience === 7,
          `materialized=${b.materialized_audience}`,
        ]);
      }

      // ── F7 prior-offer exclusion (legacy rule + offer rules) ───────────────
      console.log("F7 prior-offer exclusion:");
      for (const offerRules of [false, true]) {
        const camp = await mkCampaign({ offer: true, priorOffer: true, offerRules });
        const prev = await mkCampaign({ offer: true });
        const cs = await many(4, camp);
        for (const [i, days] of [[0, 30], [1, 2]] as const) {
          await tx.execute(sql`
            INSERT INTO offer_exposures (org_id, contact_id, offer_id, campaign_id, first_sent_at)
            VALUES (${orgId}, ${cs[i].id}, ${offer.id}, ${prev}, now() - ${days + " days"}::interval)`);
          await tx.execute(sql`
            INSERT INTO contact_offer_campaigns (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
            VALUES (${orgId}, ${cs[i].id}, ${offer.id}, ${prev}, now() - ${days + " days"}::interval, now() - ${days + " days"}::interval, 1)`);
        }
        const st = await mkStage(camp);
        await compare(`F7 prior offer (offer_rules=${offerRules})`, camp, st, (b) => [
          b.excluded.content_dedup > 0,
          `content_dedup=${b.excluded.content_dedup} cooldown=${b.excluded.offer_cooldown}`,
        ]);
      }

      // ── F8 missing stage ──────────────────────────────────────────────────
      console.log("F8 stage that does not exist:");
      await compare("F8 missing stage", 2147483000, 2147483000, (b) => [
        b.blockers.join(",") === "no_creative" && b.pool_total === 0,
        `blockers=${b.blockers.join(",")}`,
      ]);

      // ── The caller's transaction is left as found ──────────────────────────
      console.log("Caller transaction hygiene:");
      const to = await one<{ v: string }>(sql`SELECT current_setting('statement_timeout') AS v`);
      const tt = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'preflight_recipients' AND relpersistence = 't'`);
      console.log(`  (statement_timeout after the calls: ${to.v})`);
      assert(to.v !== "1min", `statement_timeout restored after the savepoint (got ${to.v})`);
      assert(tt.n === 0, `no preflight_recipients temp table left behind (got ${tt.n})`);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  } finally {
    await pg.end({ timeout: 5 });
  }

  // ── Source guards ────────────────────────────────────────────────────────
  console.log("Source guards:");
  const pfSrc = readFileSync("lib/sends/preflight.ts", "utf8");
  const bdSrc = readFileSync("lib/sends/preflight-breakdown.ts", "utf8");
  const union = pfSrc.slice(pfSrc.indexOf("export type PreflightBlocker"), pfSrc.indexOf(";", pfSrc.indexOf("export type PreflightBlocker")));
  const literals = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert(literals.length >= 10, `read ${literals.length} PreflightBlocker literals from preflight.ts`);
  const missing = literals.filter((l) => !bdSrc.includes(l));
  assert(missing.length === 0, `every PreflightBlocker literal appears in preflight-breakdown.ts (missing: ${missing.join(",") || "none"})`);
  assert(/SET LOCAL statement_timeout/.test(bdSrc), "breakdown sets its timeout with SET LOCAL");
  assert(!/[^_]SET statement_timeout/i.test(bdSrc.replace(/SET LOCAL statement_timeout/g, "")), "breakdown never issues a session SET statement_timeout");
  assert(/ON COMMIT DROP/.test(bdSrc) && /ANALYZE preflight_recipients/.test(bdSrc), "temp table is ON COMMIT DROP and ANALYZEd");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
