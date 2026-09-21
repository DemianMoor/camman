// Behavioural lanes: INDEPENDENCE + the sibling exclusion that replaces the
// all-or-nothing release gate. (2026-09-07)
//
// WHY THIS EXISTS. Until now a split released all-or-nothing: Phase B refused to
// drain any lane until the WHOLE group reached 'materialized'. That coupling had
// no timeout — Phase A only selects `send_approved AND scheduled_at IS NOT NULL`,
// so ONE never-scheduled sibling could never materialize, the group could never
// settle, and every other lane was held forever without even being marked missed.
// It froze 650 built messages for ~13h on 2026-09-05.
//
// The gate is gone. But the gate was also, silently, the thing keeping lanes from
// double-messaging: a lane's audience is an EXACT match on a HIGH-WATER tier that
// only rises, and each lane snapshots when IT materializes. Simultaneous release
// kept any collision inside the drain's 1-hour dedup window. Independent lanes can
// be staggered by days, so the disjointness has to stop depending on timing.
//
// `stageRecipientsSql` "Block 3" now excludes any contact already taken by a
// SIBLING lane of the same group. This test pins BOTH properties:
//   * a contact whose tier RISES between two lanes materializing is claimed once
//   * a legacy lane (no split_group_id) is completely unaffected
//
// TEST-DATA SAFETY: everything is seeded under a throwaway org carrying the marker
// below; teardown is scoped to that org_id only, asserted against the marker first.
//
// Run: npx tsx scripts/test-lane-sibling-exclusion.ts
import "./_env-preload"; // MUST be first
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { stageRecipientsSql, type StageRecipientFilters } from "@/lib/sends/recipients";

// ⚠️ This script SEEDS FIXTURES (a throwaway org, campaigns, stages, split
// groups, contacts, links, clicks) and deletes them again — it is NOT
// transaction-wrapped. `./_env-preload` loads `.env.local`, which is
// PRODUCTION, whenever DATABASE_URL is not already set, so the refusal is not
// optional. Run it as:
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-lane-sibling-exclusion.ts
// The refusal itself is the `_require-preview-db` import above — an allowlist,
// and early enough that nothing can query ahead of it.

const ORG_MARKER = "__LANE_SIBLING_TEST__";
const COUNTED_TABLES = [
  "organizations", "campaigns", "campaign_stages", "contacts",
  "campaign_stage_split_groups", "stage_sends",
] as const;

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
  }
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`)) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }

  const unique = Date.now();
  let orgId = "";
  const cid: Record<string, string> = {};

  async function laneRecipients(
    campaignId: number,
    f: Partial<StageRecipientFilters> & { behavioralTier: number },
  ): Promise<Set<string>> {
    const rows = (await db.execute(
      stageRecipientsSql({
        campaignId,
        orgId,
        filters: {
          includeNoStatus: true, includeClickers: true, excludeClickers: false,
          splitIndex: null, splitTotal: null, ...f,
        } as StageRecipientFilters,
      }),
    )) as unknown as { contact_id: string }[];
    return new Set(rows.map((r) => r.contact_id));
  }
  const roleOf = (s: Set<string>) =>
    Object.entries(cid).filter(([, id]) => s.has(id)).map(([r]) => r).sort();

  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    orgId = ((await db.execute(sql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;

    const campaignId = ((await db.execute(sql`
      INSERT INTO campaigns (org_id, slug, name)
      VALUES (${orgId}::uuid, ${`ls-${unique}`}, ${"LaneSibling Camp"})
      RETURNING id`)) as unknown as { id: number }[])[0].id;

    const parentStageId = ((await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
      VALUES (${orgId}::uuid, ${campaignId}::int, 1)
      RETURNING id`)) as unknown as { id: number }[])[0].id;

    const groupId = ((await db.execute(sql`
      INSERT INTO campaign_stage_split_groups (org_id, campaign_id, anchor_stage_id, state)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${parentStageId}::int, 'materializing')
      RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;

    // Two lanes in the group (tier 0 "Ignored", tier 1 "Clicked") + one LEGACY
    // lane in NO group, to prove the overlay is off without a group id.
    async function newLane(n: number, tier: number, inGroup: boolean): Promise<number> {
      return ((await db.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, behavioral_tier, parent_stage_id, split_group_id)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${n}::int, ${tier}::int,
                ${parentStageId}::int, ${inGroup ? sql`${groupId}::uuid` : sql`NULL`})
        RETURNING id`)) as unknown as { id: number }[])[0].id;
    }
    const laneIgnored = await newLane(2, 0, true);
    const laneClicked = await newLane(3, 1, true);
    const laneLegacy = await newLane(4, 0, false);

    // Two contacts, both in the frozen pool, both alive (received the parent).
    for (const role of ["mover", "stayer"]) {
      const phone = `+1998${String(unique).slice(-6)}${role === "mover" ? 1 : 2}`;
      cid[role] = ((await db.execute(sql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${phone}, now(), now())
        RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
           was_opt_in_at_snapshot, was_no_status_at_snapshot)
        VALUES (${campaignId}::int, ${cid[role]}::uuid, ${orgId}::uuid, false, false, true)`);
      await db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${parentStageId}::int,
                ${cid[role]}::uuid, ${phone}, ${"body"}, ${"sent"})`);
    }

    // Both start with no behavioural signal ⇒ tier 0.
    console.log("\nBoth contacts start at tier 0 (no signal):");
    const t0Before = await laneRecipients(campaignId, {
      behavioralTier: 0, parentStageId, splitGroupId: groupId, laneStageId: laneIgnored,
    });
    check("tier-0 lane sees BOTH contacts", roleOf(t0Before).join(",") === "mover,stayer", roleOf(t0Before).join(","));

    // ── The Ignored lane materializes: it CLAIMS both contacts. ──────────────
    for (const role of ["mover", "stayer"]) {
      await db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${laneIgnored}::int,
                ${cid[role]}::uuid, ${"x"}, ${"body"}, ${"pending"})`);
    }

    // ── "mover" now reaches the offer ⇒ their high-water tier RISES to 2. ────
    // (offer_reached_at on the parent send is what campaignTierExpr reads.)
    await db.execute(sql`
      UPDATE stage_sends SET offer_reached_at = now(), offer_reach_event_id = ${`evt-${unique}`}
      WHERE stage_id = ${parentStageId}::int AND contact_id = ${cid.mover}::uuid`);

    console.log("\nAfter the Ignored lane claimed both, 'mover' rises to tier 2:");
    const tierNow = (await db.execute(sql`
      SELECT ss.contact_id::text AS id, ss.offer_reached_at IS NOT NULL AS reached
      FROM stage_sends ss WHERE ss.stage_id = ${parentStageId}::int`)) as unknown as
      { id: string; reached: boolean }[];
    check("fixture: exactly one contact reached the offer",
      tierNow.filter((r) => r.reached).length === 1);

    // THE REGRESSION THIS GUARDS. Without Block 3, the tier-2 lane materializing
    // later would re-take 'mover' — who the Ignored lane already has — and message
    // them twice for the same position.
    const t2WithGuard = await laneRecipients(campaignId, {
      behavioralTier: 2, parentStageId, splitGroupId: groupId, laneStageId: laneClicked,
    });
    check("sibling guard ON: the tier-2 lane does NOT re-take 'mover'",
      !t2WithGuard.has(cid.mover), `saw: ${roleOf(t2WithGuard).join(",") || "(none)"}`);

    const t2NoGuard = await laneRecipients(campaignId, { behavioralTier: 2, parentStageId });
    check("counterfactual: WITHOUT the guard the same query DOES take 'mover' (guard is load-bearing)",
      t2NoGuard.has(cid.mover), `saw: ${roleOf(t2NoGuard).join(",") || "(none)"}`);

    // ── A lane must not exclude its OWN rows. ───────────────────────────────
    const ownRows = await laneRecipients(campaignId, {
      behavioralTier: 0, parentStageId, splitGroupId: groupId, laneStageId: laneIgnored,
    });
    check("a lane does NOT exclude itself (own claims don't shrink its own audience)",
      ownRows.has(cid.stayer), `saw: ${roleOf(ownRows).join(",") || "(none)"}`);

    // ── Legacy lane (no group) is untouched by the overlay. ─────────────────
    const legacy = await laneRecipients(campaignId, {
      behavioralTier: 0, parentStageId, splitGroupId: null, laneStageId: laneLegacy,
    });
    check("legacy lane (split_group_id NULL) is unaffected — still sees 'stayer'",
      legacy.has(cid.stayer), `saw: ${roleOf(legacy).join(",") || "(none)"}`);

    // ── 'rejected' rows are the cancel audit trail, not a live claim. ───────
    await db.execute(sql`
      UPDATE stage_sends SET status = 'rejected'
      WHERE stage_id = ${laneIgnored}::int AND contact_id = ${cid.mover}::uuid`);
    const afterReject = await laneRecipients(campaignId, {
      behavioralTier: 2, parentStageId, splitGroupId: groupId, laneStageId: laneClicked,
    });
    check("a 'rejected' sibling row releases the claim (cancel audit trail, not a hold)",
      afterReject.has(cid.mover), `saw: ${roleOf(afterReject).join(",") || "(none)"}`);
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const name = ((await db.execute(sql`
          SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(`Refusing teardown: org ${orgId} name "${name}" is not the test marker.`);
        }
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
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

main().catch((err) => { console.error("Test runner crashed:", err); process.exit(1); });
