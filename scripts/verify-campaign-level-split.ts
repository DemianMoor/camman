// Campaign-level behavioural split — enforcement proof (migration 0174).
//
// Ten bars. Every synthetic bar seeds under a DEDICATED throwaway organization
// carrying the marker below; teardown is scoped to that org_id ONLY (asserted to
// match the marker first), and real-data table counts are captured before seeding
// and re-checked after teardown.
//
//   (1) SCOPE is printed and non-empty. A run with zero source stages or zero
//       sends is a FAILURE, not a pass.
//   (2) The three lanes PARTITION the source set: they sum to the sent contacts
//       minus exclusions, and no contact appears in two lanes.
//   (3) CROSS-STAGE precedence: clicked in stage 1, did nothing in a later stage
//       => Clicked. (This is the behaviour the whole change exists for.)
//   (4) OFFER beats Clicked: reached the offer in ANY stage => Reached offer.
//   (5) OLD is a strict SUBSET of NEW — on synthetic data AND on real production
//       campaigns that carry legacy single-parent lanes.
//   (6) A stage that completes BETWEEN the split's creation and the recompute IS
//       in the source set (the reason source_stage_ids is resolved late).
//   (7) A click landing AFTER the split is created but BEFORE materialization
//       moves the contact into Clicked and OUT of Ignored.
//   (8) FROZEN after materialization: a later click changes no materialized row,
//       and Phase A will not re-select the lane.
//   (9) A FAILED group releases NOTHING — Phase B excludes all three lanes — and
//       a recompute that fails before any lane materialized leaves zero rows.
//  (10) A lane that resolves to ZERO recipients is skipped_empty (terminal,
//       benign), still SATISFIES its group, and is not re-selected by Phase A.
//
// Run: npx tsx --conditions=react-server scripts/verify-campaign-level-split.ts
// (the react-server condition is required: this pulls in lib/sends/scheduled.ts,
//  which transitively imports a module guarded by `server-only`.)
import "./_env-preload"; // MUST be first — loads .env.local before db/client init

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { campaignTierExpr } from "@/lib/campaign-tier";
import { stageRecipientsSql } from "@/lib/sends/recipients";
import { resolveCompletedStages } from "@/lib/sends/stage-complete";
import {
  selectDrainableStages,
  selectDueScheduledStages,
} from "@/lib/sends/scheduled";
import {
  ensureGroupSourceResolved,
  failSplitGroup,
  markLaneSkippedEmpty,
  previewSplitLanes,
  settleSplitGroup,
} from "@/lib/stages/split-group";
import { performBehavioralSplit } from "@/lib/stages/behavioral-split";

const ORG_MARKER = "__SPLIT_GROUP_VERIFY__";
const COUNTED_TABLES = [
  "organizations", "brands", "contacts", "campaigns", "campaign_stages",
  "campaign_audience_pool", "stage_sends", "links", "clicks", "opt_outs",
  "short_domains", "link_destinations", "campaign_stage_split_groups",
] as const;

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}
function skip(name: string, why: string) {
  console.log(`  \x1b[33m—\x1b[0m ${name}  (SKIPPED: ${why})`);
  skipped++;
}

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    const r = (await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`,
    )) as unknown as { n: number }[];
    out[t] = Number(r[0]?.n ?? -1);
  }
  return out;
}

async function main() {
  const unique = Date.now();
  let orgId = "";
  const cid: Record<string, string> = {};
  const phoneOf: Record<string, string> = {};

  // The live lane audience, straight through the SHARED recipient query — the
  // same SQL kickoff materializes from. Never a re-implementation.
  async function laneSet(
    campaignId: number,
    tier: number,
    opts: { parentStageId?: number | null; sourceStageIds?: number[] | null },
  ): Promise<Set<string>> {
    const rows = (await db.execute(
      stageRecipientsSql({
        campaignId,
        orgId,
        filters: {
          includeNoStatus: true,
          includeClickers: true,
          excludeClickers: false,
          splitIndex: null,
          splitTotal: null,
          behavioralTier: tier,
          parentStageId: opts.parentStageId ?? null,
          sourceStageIds: opts.sourceStageIds ?? null,
        },
      }),
    )) as unknown as { contact_id: string }[];
    return new Set(rows.map((r) => r.contact_id));
  }
  const rolesOf = (s: Set<string>) =>
    Object.entries(cid).filter(([, id]) => s.has(id)).map(([r]) => r).sort();

  const before = await tableCounts();
  console.log("Baseline counts captured.\n");

  // A throw inside the try must NOT be swallowed by the finally's process.exit —
  // that turns a real failure into a silent "1 passed". It did exactly that once.
  let fatal: unknown = null;
  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    const orgRows = (await db.execute(sql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    orgId = orgRows[0].id;

    const brandId = (
      (await db.execute(sql`
        INSERT INTO brands (org_id, brand_id, name)
        VALUES (${orgId}::uuid, ${`SG-${unique}`}, ${`SplitGroup ${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const shortDomainId = (
      (await db.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain)
        VALUES (${orgId}::uuid, ${brandId}::int, ${`sg-${unique}.test`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const destId = (
      (await db.execute(sql`
        INSERT INTO link_destinations (org_id, url, url_hash)
        VALUES (${orgId}::uuid, ${"https://example.test/o"}, ${`h-${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const creativeId = (
      (await db.execute(sql`
        INSERT INTO creatives (org_id, slug, text, status)
        VALUES (${orgId}::uuid, ${`sg-cr-${unique}`}, ${"hi"}, ${"active"})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;

    const campaignId = (
      (await db.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, brand_id, link_mode, status, tracking_id)
        VALUES (${orgId}::uuid, ${`sg-${unique}`}, ${"SplitGroup Camp"},
                ${brandId}::int, ${"tracked"}, ${"active"}, ${`sg${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;

    async function newStage(n: number, completed: boolean): Promise<number> {
      const r = (await db.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${n}::int, ${creativeId}::int,
                ${completed ? sql`now() - (${n}::int * interval '1 hour')` : sql`NULL`})
        RETURNING id
      `)) as unknown as { id: number }[];
      return r[0].id;
    }
    // S1, S2 completed. S3 deliberately NOT yet — bar (6) completes it later.
    const s1 = await newStage(1, true);
    const s2 = await newStage(2, true);
    const s3 = await newStage(3, false);

    const roles = ["ign", "clk_s1", "rch_s2", "both", "cnv", "opt", "s3only", "bot"];
    for (const role of roles) {
      const phone = `+1999${String(unique).slice(-6)}${roles.indexOf(role)}`;
      const r = (await db.execute(sql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${phone}, now(), now())
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      cid[role] = r[0].id;
      phoneOf[role] = phone;
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
           was_opt_in_at_snapshot, was_no_status_at_snapshot)
        VALUES (${campaignId}::int, ${r[0].id}::uuid, ${orgId}::uuid, false, false, true)
      `);
    }

    let codeSeq = 0;
    async function sent(
      role: string,
      stageId: number,
      o: { reached?: boolean; purchased?: boolean } = {},
    ) {
      await db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
           sale_status, offer_reached_at, offer_reach_event_id)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${cid[role]}::uuid,
                ${"x"}, ${"body"}, ${"sent"},
                ${o.purchased ? "lead" : null},
                ${o.reached ? sql`now()` : sql`NULL`},
                ${o.reached ? `evt-${role}-${stageId}` : null})
      `);
    }
    async function clicked(role: string, stageId: number, classification = "human") {
      codeSeq++;
      const link = (await db.execute(sql`
        INSERT INTO links
          (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES (${orgId}::uuid, ${`sg-${unique}-${codeSeq}`}, ${shortDomainId}::int,
                ${destId}::int, ${campaignId}::int, ${stageId}::int, ${cid[role]}::uuid,
                ${randomUUID()}, ${`ct-${unique}`}, ${`st-${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[];
      await db.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification)
        VALUES (${orgId}::uuid, ${link[0].id}::bigint, ${classification})
      `);
    }

    // Everyone except s3only received a COMPLETED stage.
    await sent("ign", s1);
    await sent("ign", s2);            // received twice, never acted -> tier 0
    await sent("clk_s1", s1);
    await sent("clk_s1", s2);         // clicked in S1, did NOTHING in S2 -> bar (3)
    await clicked("clk_s1", s1);
    await sent("rch_s2", s2, { reached: true });
    await sent("both", s1);
    await clicked("both", s1);        // clicked AND...
    await sent("both", s2, { reached: true }); // ...reached -> Offer wins, bar (4)
    await sent("cnv", s1, { purchased: true }); // tier 3, exits
    await sent("opt", s1);
    await db.execute(sql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
      VALUES (${orgId}::uuid, ${cid["opt"]}::uuid, ${phoneOf["opt"]}, ${"manual"})
    `);
    await sent("bot", s1);
    await clicked("bot", s1, "bot");  // dirty click must NOT promote to tier 1
    await sent("s3only", s3);         // S3 is not completed yet -> bar (6)

    // ── (1) SCOPE ────────────────────────────────────────────────────────────
    console.log("(1) SCOPE — the run must have something to measure");
    const sources = await resolveCompletedStages(db, campaignId, orgId);
    const sourceIds = sources.map((s) => Number(s.id));
    const sendScope = (
      (await db.execute(sql`
        SELECT count(*)::int AS rows_, count(DISTINCT contact_id)::int AS contacts
        FROM stage_sends
        WHERE campaign_id = ${campaignId}::int AND org_id = ${orgId}::uuid AND status = 'sent'
      `)) as unknown as { rows_: number; contacts: number }[]
    )[0];
    console.log(
      `      org=${orgId}  campaign=${campaignId}\n` +
        `      completed source stages: ${sourceIds.length} (${sourceIds.join(", ")}) of 3 seeded\n` +
        `      sent rows: ${sendScope.rows_}   distinct contacts: ${sendScope.contacts}`,
    );
    check("source stage set is NON-EMPTY", sourceIds.length > 0, `got ${sourceIds.length}`);
    check("sent-row scope is NON-EMPTY", sendScope.rows_ > 0, `got ${sendScope.rows_}`);
    check("S1 and S2 are sources; S3 (unfinished) is NOT",
      sourceIds.includes(s1) && sourceIds.includes(s2) && !sourceIds.includes(s3),
      `sources=${sourceIds.join(",")} s1=${s1} s2=${s2} s3=${s3}`);

    // ── (2) PARTITION ────────────────────────────────────────────────────────
    console.log("\n(2) The three lanes PARTITION the source set");
    const L0 = await laneSet(campaignId, 0, { sourceStageIds: sourceIds });
    const L1 = await laneSet(campaignId, 1, { sourceStageIds: sourceIds });
    const L2 = await laneSet(campaignId, 2, { sourceStageIds: sourceIds });
    console.log(`      Ignored=${rolesOf(L0)}  Clicked=${rolesOf(L1)}  Offer=${rolesOf(L2)}`);

    const inTwo = [...L0].filter((c) => L1.has(c) || L2.has(c))
      .concat([...L1].filter((c) => L2.has(c)));
    check("NO contact appears in two lanes", inTwo.length === 0, `overlap: ${inTwo.length}`);

    const pv = await previewSplitLanes(db, campaignId, orgId);
    const laneSum = pv.lanes.reduce((n, l) => n + l.count, 0);
    check(
      "lanes + converted == source contacts (post opt-out)",
      laneSum + pv.converted_excluded === pv.source_contacts,
      `${laneSum} + ${pv.converted_excluded} != ${pv.source_contacts}`,
    );
    check("preview lane counts match the recipient query",
      pv.lanes[0].count === L0.size && pv.lanes[1].count === L1.size && pv.lanes[2].count === L2.size,
      `preview=${pv.lanes.map((l) => l.count).join("/")} query=${L0.size}/${L1.size}/${L2.size}`);
    check("opted-out contact is in NO lane",
      !L0.has(cid["opt"]) && !L1.has(cid["opt"]) && !L2.has(cid["opt"]));
    check("converted contact EXITS (in no lane)",
      !L0.has(cid["cnv"]) && !L1.has(cid["cnv"]) && !L2.has(cid["cnv"]));
    check("contact who only received an UNFINISHED stage is in no lane",
      !L0.has(cid["s3only"]) && !L1.has(cid["s3only"]) && !L2.has(cid["s3only"]));
    check("a BOT click does not promote out of Ignored", L0.has(cid["bot"]));

    // ── (3) CROSS-STAGE PRECEDENCE ───────────────────────────────────────────
    console.log("\n(3) Clicked in stage 1, did nothing in stage 2 => Clicked");
    check("clk_s1 is in the Clicked lane", L1.has(cid["clk_s1"]));
    check("clk_s1 is NOT in the Ignored lane", !L0.has(cid["clk_s1"]));

    // ── (4) OFFER BEATS CLICKED ──────────────────────────────────────────────
    console.log("\n(4) Reached offer in ANY stage => Reached offer");
    check("rch_s2 is in the Offer lane", L2.has(cid["rch_s2"]));
    check("'both' (clicked AND reached) lands in Offer, not Clicked",
      L2.has(cid["both"]) && !L1.has(cid["both"]));

    // ── (5) OLD IS A STRICT SUBSET OF NEW ────────────────────────────────────
    console.log("\n(5) OLD (single parent) is a SUBSET of NEW (all completed)");
    for (const tier of [0, 1, 2]) {
      const oldSet = await laneSet(campaignId, tier, { parentStageId: s2 });
      const newSet =
        tier === 0 ? L0 : tier === 1 ? L1 : L2;
      const escaped = [...oldSet].filter((c) => !newSet.has(c));
      check(
        `synthetic tier ${tier}: old \\ new is EMPTY (old=${oldSet.size}, new=${newSet.size})`,
        escaped.length === 0,
        `escaped ${escaped.length}`,
      );
    }

    // ── (6) A STAGE COMPLETING LATE IS INCLUDED ──────────────────────────────
    console.log("\n(6) A stage completing AFTER the split is created is in the source set");
    const split = await performBehavioralSplit({ orgId, campaignId }, db);
    check("split created", split.ok, JSON.stringify(split));
    if (!split.ok) throw new Error("split failed; cannot continue");
    const groupId = split.split_group_id;
    const laneIds = split.lane_stage_ids;

    // S3 finishes sending in the window between the split and the recompute.
    await db.execute(sql`UPDATE campaign_stages SET sent_at = now() WHERE id = ${s3}::int`);
    const resolved = await ensureGroupSourceResolved(db, groupId);
    check("group moved pending -> materializing", resolved?.state === "materializing", resolved?.state);
    check("recomputed_at stamped", resolved?.recomputed_at != null);
    check(
      "S3 IS in the resolved source set (it completed after the split)",
      (resolved?.source_stage_ids ?? []).map(Number).includes(s3),
      `source=${(resolved?.source_stage_ids ?? []).join(",")} s3=${s3}`,
    );
    const resolvedIds = (resolved?.source_stage_ids ?? []).map(Number);
    const L0b = await laneSet(campaignId, 0, { sourceStageIds: resolvedIds });
    check("s3only now classifies into Ignored", L0b.has(cid["s3only"]));

    // ── (7) A CLICK BEFORE MATERIALIZATION MOVES THE CONTACT ─────────────────
    console.log("\n(7) A click landing before materialization re-routes the contact");
    check("ign starts in Ignored", L0b.has(cid["ign"]));
    await clicked("ign", s1);
    const L0c = await laneSet(campaignId, 0, { sourceStageIds: resolvedIds });
    const L1c = await laneSet(campaignId, 1, { sourceStageIds: resolvedIds });
    check("after the click, ign is in Clicked", L1c.has(cid["ign"]));
    check("after the click, ign is GONE from Ignored", !L0c.has(cid["ign"]));

    // ── (8) FROZEN AFTER MATERIALIZATION ─────────────────────────────────────
    console.log("\n(8) FROZEN after materialization");
    // Materialize the Ignored lane the way kickoff does: one stage_sends row per
    // qualifying recipient, then stamp materialized_at.
    const ignLane = laneIds[0];
    for (const c of L0c) {
      await db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${ignLane}::int, ${c}::uuid,
                ${"x"}, ${"body"}, ${"pending"})
      `);
    }
    await db.execute(sql`
      UPDATE campaign_stages
      SET materialized_at = now(), send_approved = true, scheduled_at = now() - interval '1 minute'
      WHERE id = ${ignLane}::int
    `);
    const frozenBefore = (
      (await db.execute(sql`
        SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${ignLane}::int
      `)) as unknown as { n: number }[]
    )[0].n;
    // A brand-new click on a materialized recipient.
    const stillIgnored = [...L0c].find((c) => c !== cid["ign"]);
    if (stillIgnored) {
      const role = Object.entries(cid).find(([, v]) => v === stillIgnored)?.[0] ?? "?";
      await clicked(role, s1);
    }
    const frozenAfter = (
      (await db.execute(sql`
        SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${ignLane}::int
      `)) as unknown as { n: number }[]
    )[0].n;
    check("materialized rows are UNCHANGED by a later click",
      frozenBefore === frozenAfter && frozenBefore > 0,
      `${frozenBefore} -> ${frozenAfter}`);
    const dueNow = await selectDueScheduledStages(db, { now: new Date(), orgId, maxStages: 50 });
    check("Phase A does NOT re-select a materialized lane",
      !dueNow.some((r) => Number(r.stage_id) === ignLane),
      dueNow.map((r) => r.stage_id).join(","));

    // ── (9) A FAILED GROUP RELEASES NOTHING ──────────────────────────────────
    console.log("\n(9) A FAILED group releases nothing");
    await db.execute(sql`
      UPDATE campaign_stages
      SET send_approved = true, scheduled_at = now() - interval '1 minute'
      WHERE split_group_id = ${groupId}::uuid
    `);
    await failSplitGroup(db, groupId, "verify_forced_failure");
    const drainFailed = await selectDrainableStages(db, { now: new Date(), orgId, maxStages: 50 });
    const releasedWhileFailed = drainFailed.filter((r) => laneIds.includes(Number(r.stage_id)));
    check("NO lane of a failed group is drainable",
      releasedWhileFailed.length === 0,
      `released ${releasedWhileFailed.map((r) => r.stage_id).join(",")}`);
    // And the counterfactual: the ONLY thing holding them is the group state.
    await db.execute(sql`
      UPDATE campaign_stage_split_groups SET state = 'materialized' WHERE id = ${groupId}::uuid
    `);
    const drainOk = await selectDrainableStages(db, { now: new Date(), orgId, maxStages: 50 });
    check("the same lane IS drainable once the group is materialized",
      drainOk.some((r) => Number(r.stage_id) === ignLane),
      drainOk.map((r) => r.stage_id).join(","));

    // A recompute that fails BEFORE any lane materialized leaves zero rows.
    const camp2 = (
      (await db.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, brand_id, link_mode, status, tracking_id)
        VALUES (${orgId}::uuid, ${`sg2-${unique}`}, ${"SplitGroup Camp 2"},
                ${brandId}::int, ${"tracked"}, ${"active"}, ${`sg2${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const g2 = (
      (await db.execute(sql`
        INSERT INTO campaign_stage_split_groups (org_id, campaign_id, state)
        VALUES (${orgId}::uuid, ${camp2}::int, ${"pending"})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[]
    )[0].id;
    for (const t of [0, 1, 2]) {
      await db.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, behavioral_tier, parent_stage_id, split_group_id)
        VALUES (${orgId}::uuid, ${camp2}::int, ${t + 1}::int, ${t}::int, ${s1}::int, ${g2}::uuid)
      `);
    }
    // camp2 has NO completed stage of its own, so the recompute must fail.
    const g2after = await ensureGroupSourceResolved(db, g2);
    check("a group with no completed sources FAILS the recompute",
      g2after?.state === "failed", g2after?.state);
    const g2rows = (
      (await db.execute(sql`
        SELECT count(*)::int AS n FROM stage_sends ss
        JOIN campaign_stages s ON s.id = ss.stage_id
        WHERE s.split_group_id = ${g2}::uuid
      `)) as unknown as { n: number }[]
    )[0].n;
    check("zero pending rows across all three lanes of the failed group",
      Number(g2rows) === 0, `got ${g2rows}`);

    // ── (10) EMPTY LANE IS SKIPPED, NOT BURNED ───────────────────────────────
    console.log("\n(10) A zero-recipient lane is skipped_empty, not schedule_missed_at");
    const emptyLane = laneIds[2];
    await db.execute(sql`
      UPDATE campaign_stage_split_groups SET state = 'materializing' WHERE id = ${groupId}::uuid
    `);
    await markLaneSkippedEmpty(db, emptyLane);
    const markers = (
      (await db.execute(sql`
        SELECT skipped_empty_at, schedule_missed_at, sent_at
        FROM campaign_stages WHERE id = ${emptyLane}::int
      `)) as unknown as { skipped_empty_at: string | null; schedule_missed_at: string | null; sent_at: string | null }[]
    )[0];
    check("skipped_empty_at is stamped", markers.skipped_empty_at != null);
    check("schedule_missed_at is NOT stamped (no false Red)", markers.schedule_missed_at == null);
    const dueAfterSkip = await selectDueScheduledStages(db, { now: new Date(), orgId, maxStages: 50 });
    check("Phase A no longer selects the skipped lane",
      !dueAfterSkip.some((r) => Number(r.stage_id) === emptyLane));
    // It must SATISFY the group: mark the third lane done, then settle.
    await db.execute(sql`
      UPDATE campaign_stages SET materialized_at = now() WHERE id = ${laneIds[1]}::int
    `);
    const settled = await settleSplitGroup(db, groupId);
    check("a skipped-empty lane SATISFIES its group (it can still settle)", settled);

    // ── (5b) REAL DATA: old lanes are a subset of the widened source set ─────
    console.log("\n(5b) REAL DATA — legacy single-parent lanes vs the widened set");
    const realParents = (await db.execute(sql`
      SELECT DISTINCT s.campaign_id, s.parent_stage_id, c.org_id::text AS org_id
      FROM campaign_stages s
      JOIN campaigns c ON c.id = s.campaign_id
      WHERE s.behavioral_tier IS NOT NULL
        AND s.parent_stage_id IS NOT NULL
        AND s.split_group_id IS NULL
        AND c.org_id <> ${orgId}::uuid
      ORDER BY s.campaign_id DESC
      LIMIT 8
    `)) as unknown as { campaign_id: number; parent_stage_id: number; org_id: string }[];
    console.log(`      legacy lane parents found: ${realParents.length}`);
    if (realParents.length === 0) {
      skip("real-data subset check", "this database has no legacy single-parent lanes");
    } else {
      let subsetChecked = 0;
      let emptyChecked = 0;
      for (const rp of realParents) {
        const r = (await db.execute(sql`
          WITH completed AS (
            SELECT s.id FROM campaign_stages s
            WHERE s.campaign_id = ${rp.campaign_id}::int
              AND s.org_id = ${rp.org_id}::uuid
              AND s.archived_at IS NULL
              AND s.behavioral_tier IS NULL
              AND s.sent_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM stage_sends x
                WHERE x.stage_id = s.id AND x.status IN ('pending','sending')
              )
          ),
          old_src AS (
            SELECT DISTINCT ss.contact_id FROM stage_sends ss
            WHERE ss.stage_id = ${rp.parent_stage_id}::int
              AND ss.org_id = ${rp.org_id}::uuid AND ss.status = 'sent'
          ),
          new_src AS (
            SELECT DISTINCT ss.contact_id FROM stage_sends ss
            WHERE ss.campaign_id = ${rp.campaign_id}::int
              AND ss.org_id = ${rp.org_id}::uuid AND ss.status = 'sent'
              AND ss.stage_id IN (SELECT id FROM completed)
          )
          SELECT (SELECT count(*)::int FROM completed) AS completed_n,
                 (SELECT count(*)::int FROM old_src) AS old_n,
                 (SELECT count(*)::int FROM new_src) AS new_n,
                 (SELECT count(*)::int FROM (
                    SELECT contact_id FROM old_src EXCEPT SELECT contact_id FROM new_src
                  ) z) AS escaped
        `)) as unknown as {
          completed_n: number; old_n: number; new_n: number; escaped: number;
        }[];
        const { completed_n, old_n, new_n, escaped } = r[0];

        // ── The one case where old is NOT a subset of new ────────────────────
        // If the campaign's COMPLETED stages reached nobody, the new source set
        // is empty and the comparison is meaningless (old vs nothing). Measured
        // on production 2026-08-27: 3 of 206 legacy lane parents. The cause is
        // always the same — the stage that actually sent is EXCLUDED from the
        // source set because it still carries stranded 'pending' rows, so it is
        // not "complete" by the shared predicate (the same one the P4
        // parent-complete gate already uses, so this is not new behaviour).
        //
        // What protects the operator here is not the subset property but the
        // PREVIEW: it must report 0 before they confirm, so they never create
        // three lanes that can reach nobody without being told. Assert that.
        if (Number(new_n) === 0) {
          const pv2 = await previewSplitLanes(db, Number(rp.campaign_id), rp.org_id);
          check(
            `campaign ${rp.campaign_id}: completed stages reached 0 contacts => preview reports 0 up front`,
            pv2.source_contacts === 0 && pv2.lanes.every((l) => l.count === 0),
            `completed=${completed_n} old=${old_n} preview.source_contacts=${pv2.source_contacts} lanes=${pv2.lanes.map((l) => l.count).join("/")}`,
          );
          emptyChecked++;
          continue;
        }
        subsetChecked++;
        check(
          `campaign ${rp.campaign_id} parent ${rp.parent_stage_id}: old(${old_n}) \\ new(${new_n}) is EMPTY`,
          Number(escaped) === 0,
          `escaped ${escaped}`,
        );
      }
      console.log(
        `      ${subsetChecked} subset comparisons, ${emptyChecked} empty-source assertions`,
      );
      // Neither category may be empty on a database that has legacy lanes at all
      // — a run where every parent fell into the "refused" branch would report
      // green while proving nothing about the subset property.
      check("at least one REAL subset comparison actually ran", subsetChecked > 0,
        `subsetChecked=${subsetChecked}`);
    }

    // Silence the unused-import lint for a fragment we deliberately do not
    // re-implement here (the lane sets above go through stageRecipientsSql).
    void campaignTierExpr;
  } catch (e) {
    fatal = e;
    console.log("\n  \x1b[31m✗\x1b[0m FATAL — the run aborted before finishing");
    failed++;
  } finally {
    console.log("\nCleanup (scoped to the test org only)");
    try {
      if (orgId) {
        const nameRows = (await db.execute(sql`
          SELECT name FROM organizations WHERE id = ${orgId}::uuid
        `)) as unknown as { name: string }[];
        const name = nameRows[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(`Refusing teardown: org ${orgId} name "${name}" is not the test marker.`);
        }
        await db.execute(sql`DELETE FROM clicks WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM links WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM link_destinations WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM short_domains WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM creatives WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM opt_outs WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM brands WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
        console.log("  cleanup complete");
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED_TABLES) {
        if (before[t] !== after[t]) {
          drift = true;
          console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: before=${before[t]} after=${after[t]}`);
        }
      }
      check("real-data table counts unchanged after teardown", !drift);
      if (fatal) console.error("\nFATAL ERROR:\n", fatal);
      console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
      await pgConn.end({ timeout: 5 });
      process.exit(failed > 0 ? 1 : 0);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
