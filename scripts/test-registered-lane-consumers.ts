import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { computeLaneAudienceCountsBatch } from "@/lib/audience-snapshot";
import { getDripFunnel } from "@/lib/drip/funnel";
import { countStageRecipients, stageRecipientsSql } from "@/lib/sends/recipients";
import { previewSplitLanes } from "@/lib/stages/split-group";

import { seedConversionEvent } from "./_conversion-fixture";

// The three renumbered exit guards that a rolled-back transaction cannot reach:
//   lib/audience-snapshot.ts:1058  computeLaneAudienceCountsBatch
//   lib/stages/split-group.ts:390  previewSplitLanes
//   lib/drip/funnel.ts:101         getDripFunnel
// Left at the old literal, each one is silently wrong and nothing else notices.
//
// ⚠️ NOT TRANSACTION-ROLLED-BACK, and that is FORCED, not sloppy: all three
// functions bind the module-level `db` and take no `tx`, so rows written inside a
// rolled-back transaction are invisible to them. The throwaway-org model is used
// instead (the same one scripts/test-recipients-lanes.ts uses): a dedicated org
// carrying ORG_MARKER, teardown scoped to that org_id ONLY (asserted against the
// marker first — never a phone or name prefix), and real-table count snapshots
// before and after to prove nothing else moved.
//
// PREVIEW DB ONLY.
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-registered-lane-consumers.ts
//
// Flags:
//   --explain            also EXPLAIN the tier-3 lane query (Step 7a — a SHAPE check)
//   SHAPE_BARS_ARMED=1   turn X1/X2 from informational into assertions. Only
//                        meaningful against a ledger big enough for a Seq Scan to
//                        be a real finding — see the note at the bars.
//   KEEP=1               skip teardown (leaves the throwaway org behind; preview
//                        only). C0 then reds on the next run, correctly.
// The refusal itself is the `_require-preview-db` import above — an allowlist,
// and early enough that nothing can query ahead of it.
const ORG_MARKER = "__P4_CONSUMERS_TEST__";

// Tables we snapshot to prove real data is untouched.
const COUNTED_TABLES = [
  "organizations", "brands", "contacts", "campaigns", "campaign_stages",
  "campaign_audience_pool", "stage_sends", "links", "clicks", "opt_outs",
  "short_domains", "link_destinations", "conversion_events", "event_types",
  "drip_journeys", "lead_events", "partner_keys",
] as const;

const WANT_EXPLAIN = process.argv.includes("--explain");
const KEEP = process.env.KEEP === "1";

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

// Every node of an EXPLAIN (FORMAT JSON) plan, flattened.
interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Parent Relationship"?: string;
  "Plan Rows"?: number;
  Plans?: PlanNode[];
}
function flatten(n: PlanNode): PlanNode[] {
  return [n, ...(n.Plans ?? []).flatMap(flatten)];
}
function printPlan(n: PlanNode, depth = 0): void {
  const rel = n["Relation Name"] ? ` on ${n["Relation Name"]}` : "";
  const idx = n["Index Name"] ? ` using ${n["Index Name"]}` : "";
  const par = n["Parent Relationship"] ? ` [${n["Parent Relationship"]}]` : "";
  console.log(`  ${"  ".repeat(depth)}${n["Node Type"]}${rel}${idx}${par} rows=${n["Plan Rows"]}`);
  for (const c of n.Plans ?? []) printPlan(c, depth + 1);
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const before = await tableCounts();
  console.log(
    `Baseline: organizations=${before.organizations}, conversion_events=${before.conversion_events}, ` +
      `event_types=${before.event_types}, contacts=${before.contacts}`,
  );

  // ⭐ C0 — THE RESIDUE BAR. Teardown deletes `conversion_events` and
  // `event_types` explicitly because `conversion_events.event_type_id` is
  // ON DELETE RESTRICT while `campaign_id` is ON DELETE SET NULL: deleting the
  // campaigns leaves the ledger rows behind with their org_id intact, so the org
  // delete would only succeed if PostgreSQL happened to fire the
  // conversion_events cascade before the event_types one. If that ordering ever
  // fails — or an exception aborts teardown part-way — the marked org survives
  // and THIS bar is red on the NEXT run, instead of the leak going unnoticed.
  // World-state: red is also the correct answer after a deliberate `KEEP=1` run;
  // delete that org by id and re-run.
  const leftover = (
    (await db.execute(sql`
      SELECT count(*)::int AS n FROM organizations WHERE starts_with(name, ${ORG_MARKER})
    `)) as unknown as { n: number }[]
  )[0].n;
  check("C0 ⭐ no residue from a previous run (no org carries the test marker)", leftover === 0, `${leftover} marked org(s) left behind`);

  let orgId = "";
  try {
    const sfx = String(Date.now()).slice(-7);
    orgId = (
      (await db.execute(sql`
        INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${sfx}`})
        RETURNING id::text AS id`)) as unknown as { id: string }[]
    )[0].id;
    // 0181's event_types seed is a one-time backfill over the orgs that existed
    // then; a brand-new org gets none, so seedConversionEvent's key lookup would
    // throw. Mirror it here — it cascades away with the org on teardown.
    await db.execute(sql`
      INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
      VALUES (${orgId}::uuid, 'purchase', 'Purchase', 10, true, true, false),
             (${orgId}::uuid, 'registration', 'Registration', 20, false, false, true)`);

    const brandId = (
      (await db.execute(sql`
        INSERT INTO brands (org_id, brand_id, name)
        VALUES (${orgId}::uuid, ${"P4C-" + sfx}, ${"P4 Consumers " + sfx}) RETURNING id`)) as unknown as { id: number }[]
    )[0].id;
    const campaignId = (
      (await db.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, brand_id, status, link_mode)
        VALUES (${orgId}::uuid, ${"p4c-" + sfx}, 'P4 consumers', ${brandId}::int, 'active', 'tracked')
        RETURNING id`)) as unknown as { id: number }[]
    )[0].id;

    // The parent must be COMPLETE or previewSplitLanes returns an empty source
    // set: sent_at stamped, no 'pending'/'sending' rows (lib/sends/stage-complete.ts).
    const parentStageId = (
      (await db.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}::int, 1, now()) RETURNING id`)) as unknown as { id: number }[]
    )[0].id;
    // One tier-3 lane, so computeLaneAudienceCountsBatch has a lane to count.
    // (Migration 0184 is what lets a 3 be stored here at all.)
    const laneStageId = (
      (await db.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, behavioral_tier, parent_stage_id)
        VALUES (${orgId}::uuid, ${campaignId}::int, 2, 3, ${parentStageId}::int) RETURNING id`)) as unknown as { id: number }[]
    )[0].id;

    // The SMALLEST fixture that distinguishes the three consumers:
    // two registrants and one buyer, all alive on the complete parent and all
    // having reached the offer (so C7's cumulative bar has something to count).
    const roles = ["reg1", "reg2", "buy1"] as const;
    const cid: Record<string, string> = {};
    for (const [i, role] of roles.entries()) {
      cid[role] = (
        (await db.execute(sql`
          INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
          VALUES (${orgId}::uuid, ${"+1887" + sfx + i}, now(), now())
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
           was_opt_in_at_snapshot, was_no_status_at_snapshot)
        VALUES (${campaignId}::int, ${cid[role]}::uuid, ${orgId}::uuid, false, false, true)`);
      const sendId = (
        (await db.execute(sql`
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
             offer_reached_at, offer_reach_event_id)
          VALUES (${orgId}::uuid, ${campaignId}::int, ${parentStageId}::int,
                  ${cid[role]}::uuid, ${"+1887" + sfx + i}, 'body', 'sent',
                  now(), ${`evt-${role}-${sfx}`})
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      // ONE-SIDED: a registrant carries ONLY a registration, the buyer ONLY a
      // purchase. A contact holding both reads the same under either numbering.
      await seedConversionEvent(db, {
        orgId, stageSendId: sendId, contactId: cid[role], campaignId, stageId: parentStageId,
        eventKey: role === "buy1" ? "purchase" : "registration",
        status: "approved",
        revenue: role === "buy1" ? 100 : 0,
        keitaroType: role === "buy1" ? "sale" : "lead",
      });
      // A journey per contact, so getDripFunnel has something to aggregate
      // (contact → partner_keys → lead_events → drip_journeys).
      const pk = (
        (await db.execute(sql`
          INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
          VALUES (${orgId}::uuid, ${"p4c" + sfx + i}, 'probe', ${"tok" + sfx + i}, 'h')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const le = (
        (await db.execute(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
          VALUES (${orgId}::uuid, ${cid[role]}::uuid, ${pk}::int, 'probe', now()) RETURNING id`)) as unknown as { id: string }[]
      )[0].id;
      await db.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id,
                                   state, first_send_at, first_stage_id)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${cid[role]}::uuid, ${le}::uuid,
                'active', now(), ${parentStageId}::int)`);
    }

    console.log("\nConsumers:");

    // ⭐ C1 — lib/audience-snapshot.ts:1058. Left at `<> 3`, the tier-3 lane's
    // displayed count collapses to 0 while the lane really sends to 2 people:
    // the stages list would show "0" next to a lane about to message two
    // contacts. Cross-checked against countStageRecipients, which is the path
    // the batch replaced, so this also re-proves batch == single for a tier
    // that did not exist when verify-lane-batch.ts was written.
    const batch = await computeLaneAudienceCountsBatch(campaignId, orgId, [
      {
        stageId: laneStageId, behavioralTier: 3, parentStageId,
        include_no_status: true, include_clickers: true, exclude_clickers: false,
        split_index: null, split_total: null,
      },
    ]);
    const single = await countStageRecipients(db, {
      campaignId, orgId,
      filters: {
        includeNoStatus: true, includeClickers: true, excludeClickers: false,
        splitIndex: null, splitTotal: null, behavioralTier: 3, parentStageId,
      },
    });
    check("C1 ⭐ the batched lane count for a tier-3 lane is 2", batch.get(laneStageId) === 2, `got ${batch.get(laneStageId)}`);
    check("C2 ...and it equals the per-lane countStageRecipients path", batch.get(laneStageId) === single, `batch ${batch.get(laneStageId)} vs single ${single}`);

    // ⭐ C3/C4 — lib/stages/split-group.ts:390 + the new t3 counter. Left at
    // `tier = 3`, converted_excluded reports the two REGISTRANTS as buyers and
    // the Registered row of the confirm dialog reads 0 — the operator declines
    // a lane the UI says is empty.
    const preview = await previewSplitLanes(db, campaignId, orgId);
    check("C3 ⭐ previewSplitLanes reports 2 in the Registered lane", preview.lanes.find((l) => l.tier === 3)?.count === 2, JSON.stringify(preview.lanes));
    check("C4 ⭐ converted_excluded counts the BUYER only, not the registrants", preview.converted_excluded === 1, String(preview.converted_excluded));
    check("C5 the preview still offers exactly the four lane tiers", preview.lanes.map((l) => l.tier).join(",") === "0,1,2,3", preview.lanes.map((l) => l.tier).join(","));

    // ⭐ C6/C7 — lib/drip/funnel.ts:101. Left at `>= 3`, both registrants are
    // reported as drip CONVERSIONS: a $0 registration inflates the one number
    // the operator reads as revenue-bearing.
    const funnel = await getDripFunnel(orgId, campaignId);
    check("C6 ⭐ the drip funnel counts 1 conversion (the buyer), not 3", funnel.progression.converted === 1, String(funnel.progression.converted));
    check("C7 reached_offer still counts all 3 — a high-water funnel is cumulative", funnel.progression.reached_offer === 3, String(funnel.progression.reached_offer));

    // ── Step 7a: the SHAPE check ──────────────────────────────────────────────
    // camman-v2's tables are tiny, so this proves SHAPE, not cost — the real
    // measurement is Task 7 Step 3a on prod, after the migration gate.
    if (WANT_EXPLAIN) {
      console.log("\nEXPLAIN — tier-3 lane query shape:");
      const laneQuery = stageRecipientsSql({
        campaignId, orgId,
        filters: {
          includeNoStatus: true, includeClickers: true, excludeClickers: false,
          splitIndex: null, splitTotal: null, behavioralTier: 3, parentStageId,
        },
      });
      const explained = (await db.execute(
        sql`EXPLAIN (FORMAT JSON) ${laneQuery}`,
      )) as unknown as { "QUERY PLAN": { Plan: PlanNode }[] }[];
      const plan = explained[0]["QUERY PLAN"][0].Plan;
      const nodes = flatten(plan);
      printPlan(plan);

      const ceSeqScans = nodes.filter(
        (n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "conversion_events",
      );
      // "Inner side" = the subtree hanging off a Nested Loop's INNER child, which
      // is what re-executes once per outer row.
      const ceNestedLoops = nodes.filter(
        (n) =>
          n["Node Type"] === "Nested Loop" &&
          (n.Plans ?? [])
            .filter((c) => c["Parent Relationship"] === "Inner")
            .flatMap(flatten)
            .some((i) => i["Relation Name"] === "conversion_events"),
      );
      const ceIndexes = [
        ...new Set(
          nodes
            .filter((n) => n["Relation Name"] === "conversion_events" && n["Index Name"])
            .map((n) => n["Index Name"] as string),
        ),
      ];
      console.log(`\n  conversion_events indexes chosen: ${ceIndexes.join(", ") || "(none)"}`);

      // ⚠️ THE BAR NAMES ITS WORLD-STATE, AND THE WORLD-STATE IS DECLARED BY THE
      // RUNNER — NOT GUESSED FROM A ROW COUNT. These two bars used to arm
      // themselves at `conversion_events >= 500`, which was a number nobody had
      // measured: at 500 rows a Seq Scan on the ledger is still very plausibly
      // the OPTIMAL plan, so the bars were positioned to go red the day the
      // preview ledger crossed an arbitrary line, and a bar that reds for being
      // correct gets deleted by whoever meets it next.
      //
      // Nothing here can supply the missing evidence: camman-v2's ledger is
      // ~0 rows, and finding the real index/seq crossover means seeding tens of
      // thousands of fixture rows into a shared preview DB. So the bars stay
      // UNARMED unless a runner asserts a world-state in which a plan SHAPE is
      // meaningful — `SHAPE_BARS_ARMED=1`, i.e. "I am pointed at a ledger large
      // enough that a Seq Scan would be a real finding". The REAL measurement is
      // Task 7 Step 3a's EXPLAIN (ANALYZE, BUFFERS) on prod, after the migration
      // gate opens; until then this block prints the plan and the row count so a
      // reader can judge, and asserts nothing it cannot back.
      const ledgerRows = Number(
        (
          (await db.execute(
            sql`SELECT count(*)::int AS n FROM conversion_events`,
          )) as unknown as { n: number }[]
        )[0]?.n ?? 0,
      );
      const armed = process.env.SHAPE_BARS_ARMED === "1";
      console.log(
        `  world-state: conversion_events holds ${ledgerRows} row(s) on this DB; ` +
          `the shape bars are ${armed ? "ARMED (SHAPE_BARS_ARMED=1)" : "INFORMATIONAL (no SHAPE_BARS_ARMED=1)"}.`,
      );
      if (!armed) {
        console.log(
          `  On a ledger this small a Seq Scan / Nested Loop IS the optimal plan, so their\n` +
            `  presence here is NOT evidence of a regression and their absence would NOT be\n` +
            `  evidence of safety. Observed: ${ceSeqScans.length} seq scan(s), ` +
            `${ceNestedLoops.length} nested loop(s) with the ledger on the inner side.\n` +
            `  The cost question is deferred to Task 7 Step 3a on prod — it is NOT answered here.`,
        );
      }
      check(
        "X1 no Seq Scan on conversion_events (armed only with SHAPE_BARS_ARMED=1)",
        !armed || ceSeqScans.length === 0,
        `${ceSeqScans.length} seq scan(s) at ${ledgerRows} rows`,
      );
      check(
        "X2 ⭐ no Nested Loop whose INNER side is conversion_events (armed only with SHAPE_BARS_ARMED=1)",
        !armed || ceNestedLoops.length === 0,
        `${ceNestedLoops.length} nested loop(s) over the ledger at ${ledgerRows} rows`,
      );
    }
  } finally {
    console.log("\nCleanup (scoped to the test org only)");
    try {
      if (orgId && !KEEP) {
        // Safety: refuse to delete unless this really is the marked test org.
        const nameRows = (await db.execute(sql`
          SELECT name FROM organizations WHERE id = ${orgId}::uuid
        `)) as unknown as { name: string }[];
        const name = nameRows[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(
            `Refusing teardown: org ${orgId} name "${name}" is not the test marker.`,
          );
        }
        // EXPLICIT DEPENDENCY ORDER, all scoped to orgId, and deliberately NOT
        // leaning on the `organizations` cascade to reach these tables in a
        // workable order. `conversion_events.event_type_id` is ON DELETE
        // RESTRICT and its `campaign_id` is ON DELETE SET NULL, so the ledger
        // rows OUTLIVE the campaign delete and then block `event_types` unless
        // they go first. Relying on cascade ordering worked in practice but is
        // not a promise PostgreSQL makes; C0 catches it if it ever stops.
        // Every statement below is idempotent (a DELETE that matches nothing is
        // a no-op), so this teardown is also correct when seeding threw
        // part-way and only some of the rows exist.
        await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM partner_keys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM brands WHERE org_id = ${orgId}::uuid`);
        // After the ledger, never before it (RESTRICT).
        await db.execute(sql`DELETE FROM event_types WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
        console.log("  cleanup complete");
      } else if (KEEP) {
        console.log(`  KEEP=1 — org ${orgId} left in place on the PREVIEW db.`);
      }
    } finally {
      if (!KEEP) {
        const after = await tableCounts();
        let drift = false;
        for (const t of COUNTED_TABLES) {
          if (before[t] !== after[t]) {
            drift = true;
            console.log(`  DRIFT ${t}: before=${before[t]} after=${after[t]}`);
          }
        }
        check("C8 real-data table counts unchanged after teardown", !drift);
      }
      await pgConn.end();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
