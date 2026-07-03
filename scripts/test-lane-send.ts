// Step 6: behavioral lanes send through the EXISTING kickoff + drain pipeline.
// Proves the SENT set == the PREVIEWED set, and that every gate still applies.
// Nothing is transmitted: kickoff only materializes stage_sends (no provider
// call), and the drain is exercised with the SEND_ENABLED gate OFF + a mock
// dispatcher that throws if ever invoked.
//
// TEST-DATA SAFETY: seeded under a dedicated throwaway org (marker below);
// teardown scoped to that org_id only (marker-guarded); real-data table counts
// captured before and re-asserted after.
//
// Run: npx tsx scripts/test-lane-send.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { runStageDrain, type Sender } from "@/lib/sends/drain";
import {
  countStageRecipients,
  enumerateStageRecipients,
} from "@/lib/sends/recipients";

const ORG_MARKER = "__LANE_SEND_TEST__";
const COUNTED_TABLES = [
  "organizations", "brands", "contacts", "campaigns", "campaign_stages",
  "campaign_audience_pool", "stage_sends", "links", "clicks", "opt_outs",
  "short_domains", "link_destinations", "creatives", "send_attempts",
] as const;

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
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

  const unique = Date.now();
  let orgId = "";
  let campaignId = 0;
  const cid: Record<string, string> = {};
  const lane: Record<number, { id: number }> = {};

  async function previewSet(stageId: number, tier: number, parentStageId: number) {
    const rows = await enumerateStageRecipients(db, {
      campaignId,
      orgId,
      filters: {
        includeNoStatus: true,
        includeClickers: true,
        excludeClickers: false,
        splitIndex: null,
        splitTotal: null,
        behavioralTier: tier,
        parentStageId,
      },
    });
    return new Set(rows.map((r) => r.contact_id));
  }
  async function materializedSet(stageId: number) {
    const rows = (await db.execute(sql`
      SELECT contact_id::text AS contact_id FROM stage_sends
      WHERE stage_id = ${stageId}::int AND status = 'pending'
    `)) as unknown as { contact_id: string }[];
    return new Set(rows.map((r) => r.contact_id));
  }
  const roleOf = (set: Set<string>) =>
    Object.entries(cid).filter(([, id]) => set.has(id)).map(([r]) => r).sort();

  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    orgId = (
      (await db.execute(sql`
        INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[]
    )[0].id;

    const brandId = (
      (await db.execute(sql`
        INSERT INTO brands (org_id, brand_id, name)
        VALUES (${orgId}::uuid, ${`LS-${unique}`}, ${`LaneSend ${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const creativeId = (
      (await db.execute(sql`
        INSERT INTO creatives (org_id, slug, text, status)
        VALUES (${orgId}::uuid, ${`ls-cr-${unique}`}, ${"Hello from {brand}"}, ${"active"})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const shortDomainId = (
      (await db.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain)
        VALUES (${orgId}::uuid, ${brandId}::int, ${`ls-${unique}.test`})
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

    // Manual-mode campaign — kickoff materializes without minting/transmitting.
    campaignId = (
      (await db.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, brand_id, link_mode, status)
        VALUES (${orgId}::uuid, ${`ls-${unique}`}, ${"LaneSend"}, ${brandId}::int, ${"manual"}, ${"active"})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;

    async function newStage(opts: {
      tier?: number | null;
      parent?: number | null;
    }): Promise<{ id: number }> {
      const r = (await db.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, include_no_status,
           include_clickers, exclude_clickers, stop_text, behavioral_tier, parent_stage_id)
        VALUES
          (${orgId}::uuid, ${campaignId}::int,
           (SELECT coalesce(max(stage_number), 0) + 1 FROM campaign_stages WHERE campaign_id = ${campaignId}::int),
           ${creativeId}::int, true, true, false, ${"Stop to END"},
           ${opts.tier ?? null}, ${opts.parent ?? null})
        RETURNING id
      `)) as unknown as { id: number }[];
      return { id: r[0].id };
    }

    const parent = await newStage({});
    const ord = await newStage({}); // ordinary stage for row-shape comparison
    lane[0] = await newStage({ tier: 0, parent: parent.id });
    lane[1] = await newStage({ tier: 1, parent: parent.id });
    lane[2] = await newStage({ tier: 2, parent: parent.id });

    // Contacts + frozen pool (all no_status so the base filter passes everyone).
    const roles = ["ign", "clk", "rch", "cnv", "opt", "nal"];
    for (const role of roles) {
      const phone = `+1996${String(unique).slice(-6)}${roles.indexOf(role)}`;
      cid[role] = (
        (await db.execute(sql`
          INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
          VALUES (${orgId}::uuid, ${phone}, now(), now())
          RETURNING id::text AS id
        `)) as unknown as { id: string }[]
      )[0].id;
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
           was_opt_in_at_snapshot, was_no_status_at_snapshot)
        VALUES (${campaignId}::int, ${cid[role]}::uuid, ${orgId}::uuid, false, false, true)
      `);
    }

    // "Received the parent" markers (aliveness) — parent stage_sends status='sent'.
    async function receivedParent(role: string, reached: boolean, sale: boolean) {
      await db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
           sale_status, offer_reached_at, offer_reach_event_id, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${parent.id}::int, ${cid[role]}::uuid,
                ${"x"}, ${"parent body"}, ${"sent"}, ${sale ? "sale" : null},
                ${reached ? sql`now()` : sql`NULL`}, ${reached ? `e-${role}` : null}, now())
      `);
    }
    let codeSeq = 0;
    async function cleanClick(role: string) {
      codeSeq += 1;
      const linkId = (
        (await db.execute(sql`
          INSERT INTO links
            (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
             contact_id, send_token, campaign_tracking_id, stage_tracking_id)
          VALUES (${orgId}::uuid, ${`ls-${unique}-${codeSeq}`}, ${shortDomainId}::int,
                  ${destId}::int, ${campaignId}::int, ${parent.id}::int, ${cid[role]}::uuid,
                  ${randomUUID()}, ${`ct-${unique}`}, ${`st-${unique}`})
          RETURNING id
        `)) as unknown as { id: number }[]
      )[0].id;
      await db.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification)
        VALUES (${orgId}::uuid, ${linkId}::bigint, ${"human"})
      `);
    }

    await receivedParent("ign", false, false); // tier 0
    await receivedParent("clk", false, false); // tier 1 (click below)
    await receivedParent("rch", true, false); // tier 2
    await receivedParent("cnv", true, true); // tier 3
    await receivedParent("opt", false, false); // tier 1 but opted out
    // nal: NO parent send → not alive
    await cleanClick("clk");
    await cleanClick("rch");
    await cleanClick("opt");
    await cleanClick("nal");
    await db.execute(sql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source, reason)
      VALUES (${orgId}::uuid, ${cid.opt}::uuid,
              (SELECT phone_number FROM contacts WHERE id = ${cid.opt}::uuid), ${"t"}, ${"opt_out"})
    `);

    // ====================================================================
    // 1) preview recipients == send recipients, per lane.
    // ====================================================================
    console.log("\nPreview == send (kickoff materializes the previewed set):");
    const expected: Record<number, string[]> = {
      0: ["ign"],
      1: ["clk"],
      2: ["rch"],
    };
    for (const tier of [0, 1, 2]) {
      const preview = await previewSet(lane[tier].id, tier, parent.id);
      const r = await kickoffStageSend(db, { orgId, campaignId, stageId: lane[tier].id });
      check(`tier-${tier} kickoff ok`, r.ok === true, JSON.stringify(r));
      const sent = await materializedSet(lane[tier].id);
      const sameAsPreview =
        sent.size === preview.size && [...preview].every((x) => sent.has(x));
      check(
        `tier-${tier}: SENT set == PREVIEW set (${roleOf(preview).join(",") || "∅"})`,
        sameAsPreview,
        `preview=${roleOf(preview).join(",")} sent=${roleOf(sent).join(",")}`,
      );
      check(
        `tier-${tier}: equals expected {${expected[tier].join(",")}}`,
        JSON.stringify(roleOf(sent)) === JSON.stringify(expected[tier]),
        roleOf(sent).join(","),
      );
    }

    // ====================================================================
    // 2) opt-out / converted excluded at SEND resolution (not just preview).
    // ====================================================================
    console.log("\nExclusions at send resolution:");
    const allLaneSent = new Set<string>();
    for (const tier of [0, 1, 2]) for (const x of await materializedSet(lane[tier].id)) allLaneSent.add(x);
    check("converted (cnv) materialized into NO lane", !allLaneSent.has(cid.cnv));
    check("opted-out (opt) materialized into NO lane", !allLaneSent.has(cid.opt));
    check("not-alive (nal) materialized into NO lane", !allLaneSent.has(cid.nal));

    // ====================================================================
    // 3) Send gate: with SEND_ENABLED off, the drain dispatches NOTHING.
    // ====================================================================
    console.log("\nSend gate (drain, gate OFF, mock dispatcher):");
    let dispatchCalls = 0;
    const mockSend: Sender = async () => {
      dispatchCalls++;
      throw new Error("mock dispatcher invoked — must not happen with gate off");
    };
    // Approve the lane so we get PAST the not_approved check and actually hit the
    // SEND_ENABLED gate (the thing under test).
    await db.execute(sql`UPDATE campaign_stages SET send_approved = true WHERE id = ${lane[0].id}::int`);
    const drainOff = await runStageDrain(db, {
      stageId: lane[0].id,
      isEnabled: () => false,
      sendSms: mockSend,
    });
    check("env SEND_ENABLED is OFF by default in this run", process.env.SEND_ENABLED !== "true");
    check("drain refuses with reason 'send_disabled'", !drainOff.ok && drainOff.reason === "send_disabled", JSON.stringify(drainOff));
    check("drain dispatched 0 sends", drainOff.sent === 0);
    check("mock dispatcher was NEVER invoked", dispatchCalls === 0);
    // Lane rows are untouched by the refused drain (still pending).
    check("lane rows remain pending after refused drain", (await materializedSet(lane[0].id)).size === 1);

    // ====================================================================
    // 4) At-most-once at materialization: re-running kickoff doesn't duplicate.
    // ====================================================================
    console.log("\nAt-most-once (re-kickoff):");
    const before1 = (await materializedSet(lane[1].id)).size;
    const rAgain = await kickoffStageSend(db, { orgId, campaignId, stageId: lane[1].id });
    check(
      "re-kickoff is a no-op once fully materialized (complete, 0 new)",
      rAgain.ok && rAgain.complete && rAgain.materialized === 0,
      JSON.stringify(rAgain),
    );
    check("no duplicate rows materialized", (await materializedSet(lane[1].id)).size === before1);

    // ====================================================================
    // 5) A lane records stage_sends rows equivalently to an ordinary stage.
    // ====================================================================
    console.log("\nRow shape equivalence (lane vs ordinary stage):");
    const rOrd = await kickoffStageSend(db, { orgId, campaignId, stageId: ord.id });
    check("ordinary-stage kickoff ok", rOrd.ok === true, JSON.stringify(rOrd));
    async function oneRow(stageId: number) {
      const rows = (await db.execute(sql`
        SELECT contact_id, phone, rendered_text, status, lead_id, link_id
        FROM stage_sends WHERE stage_id = ${stageId}::int LIMIT 1
      `)) as unknown as {
        contact_id: string; phone: string; rendered_text: string;
        status: string; lead_id: string | null; link_id: number | null;
      }[];
      return rows[0];
    }
    const laneRow = await oneRow(lane[1].id);
    const ordRow = await oneRow(ord.id);
    const shapeOk = (r: typeof laneRow) =>
      !!r && r.status === "pending" && !!r.contact_id && !!r.phone &&
      r.rendered_text.length > 0 && r.lead_id != null && r.link_id == null;
    check("lane row has the standard stage_sends shape (pending, lead_id, no link in manual)", shapeOk(laneRow));
    check("ordinary row has the same shape", shapeOk(ordRow));

    // ====================================================================
    // 6) A lane send feeds downstream tier/aliveness reads (position N → N+1).
    //    Mark the tier-0 lane's row 'sent'; a hypothetical next lane parented on
    //    it now sees that recipient as alive.
    // ====================================================================
    console.log("\nLane send feeds downstream aliveness:");
    await db.execute(sql`UPDATE stage_sends SET status = 'sent', sent_at = now() WHERE stage_id = ${lane[0].id}::int`);
    const downstream = await countStageRecipients(db, {
      campaignId,
      orgId,
      filters: {
        includeNoStatus: true,
        includeClickers: true,
        excludeClickers: false,
        splitIndex: null,
        splitTotal: null,
        behavioralTier: 0,
        parentStageId: lane[0].id,
      },
    });
    check("contact who received the lane is alive for a next-position read (count=1)", downstream === 1, `got ${downstream}`);
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const name =
          (
            (await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[]
          )[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(`Refusing teardown: org ${orgId} name "${name}" is not the test marker.`);
        }
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM link_destinations WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM short_domains WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM opt_outs WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM creatives WHERE org_id = ${orgId}::uuid`);
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
      await pgConn.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
