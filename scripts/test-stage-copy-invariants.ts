// Stage-copy invariants test (Fix 1 + Fix 2). Exercises the behavioral-split
// core (a representative copy path) and the kickoff no_schedule guard, under a
// dedicated throwaway org. Mirrors scripts/test-behavioral-split.ts for fixture
// safety: scoped teardown + real-data drift check.
//
// Asserts:
//   • a copied/lane stage gets scheduled_at = NULL (never inherits the date)
//   • a copied stage's full_url has sub_id3 rewritten to its OWN tracking id,
//     while sub_id1 (L2 attribution) and other params are preserved
//   • kickoffStageSend refuses a null-scheduled stage with reason 'no_schedule'
//   • a scheduled (non-null) stage does NOT trip the no_schedule guard
//
// Run: npx tsx scripts/test-stage-copy-invariants.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { performBehavioralSplit } from "@/lib/stages/behavioral-split";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { STAGE_TRACKING_PARAM } from "@/lib/stage-url";

const ORG_MARKER = "__STAGECOPY_TEST__";
const COUNTED_TABLES = [
  "organizations", "campaigns", "campaign_stages", "creatives",
] as const;

// Pull the value of a query param out of a URL (test-side mirror of what the
// rewrite should have produced).
function paramOf(url: string, key: string): string | null {
  const q = url.indexOf("?");
  if (q < 0) return null;
  for (const seg of url.slice(q + 1).split("&")) {
    const [k, v] = seg.split("=");
    if (decodeURIComponent(k) === key) return v ?? "";
  }
  return null;
}

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
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
  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    const orgRows = (await db.execute(sql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    orgId = orgRows[0].id;

    const crRows = (await db.execute(sql`
      INSERT INTO creatives (org_id, slug, text, status)
      VALUES (${orgId}::uuid, ${`scopy-cr-${unique}`}, ${"hello"}, ${"active"})
      RETURNING id
    `)) as unknown as { id: number }[];
    const creativeId = crRows[0].id;

    const campTid = `scopy-${unique}`;
    const campRows = (await db.execute(sql`
      INSERT INTO campaigns (org_id, slug, name, tracking_id, link_mode)
      VALUES (${orgId}::uuid, ${`scopy-${unique}`}, ${"SCopy Camp"}, ${campTid}, ${"tracked"})
      RETURNING id
    `)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;

    // Source stage: a stale PAST date + a tracking URL carrying sub_id1 (L2) and
    // a parent sub_id3. Both are the things a copy must NOT carry over verbatim.
    const parentSubId3 = `${campTid}_s1_c${creativeId}`;
    const sourceFullUrl =
      `https://lp.example.com/orv?sub_id1=L2FORWARD&` +
      `${STAGE_TRACKING_PARAM}=${parentSubId3}&subid5=facebook`;
    const srcRows = (await db.execute(sql`
      INSERT INTO campaign_stages
        (org_id, campaign_id, stage_number, creative_id, scheduled_at, full_url, tracking_id)
      VALUES
        (${orgId}::uuid, ${campaignId}::int, 1, ${creativeId},
         now() - interval '2 days', ${sourceFullUrl}, ${parentSubId3})
      RETURNING id
    `)) as unknown as { id: number }[];
    const sourceId = srcRows[0].id;

    // ── CASE 1: behavioral split (copy path) ────────────────────────────────
    console.log("\nCase 1 — lane split blanks date + rewrites sub_id3:");
    const r1 = await performBehavioralSplit({ orgId, campaignId, stageId: sourceId });
    check("split returned ok with 3 lanes", r1.ok && r1.lane_stage_ids.length === 3, JSON.stringify(r1));

    const lanes = (await db.execute(sql`
      SELECT id, scheduled_at, full_url, tracking_id
      FROM campaign_stages
      WHERE parent_stage_id = ${sourceId}::int AND org_id = ${orgId}::uuid
      ORDER BY behavioral_tier
    `)) as unknown as {
      id: number; scheduled_at: string | null; full_url: string | null; tracking_id: string | null;
    }[];

    check("every lane has scheduled_at = NULL", lanes.every((l) => l.scheduled_at === null),
      lanes.map((l) => l.scheduled_at).join(","));
    check(
      "every lane's full_url sub_id3 == its OWN tracking id",
      lanes.every((l) => l.full_url && l.tracking_id && paramOf(l.full_url, STAGE_TRACKING_PARAM) === l.tracking_id),
      lanes.map((l) => `${paramOf(l.full_url ?? "", STAGE_TRACKING_PARAM)} vs ${l.tracking_id}`).join(" | "),
    );
    check(
      "no lane carries the parent's sub_id3",
      lanes.every((l) => l.full_url && paramOf(l.full_url, STAGE_TRACKING_PARAM) !== parentSubId3),
    );
    check(
      "sub_id1 (L2 attribution) preserved on every lane",
      lanes.every((l) => l.full_url && paramOf(l.full_url, "sub_id1") === "L2FORWARD"),
    );
    check(
      "subid5 (other param) preserved on every lane",
      lanes.every((l) => l.full_url && paramOf(l.full_url, "subid5") === "facebook"),
    );
    check("source stage's own date/url untouched (only copies blanked)", await (async () => {
      const s = (await db.execute(sql`
        SELECT scheduled_at, full_url FROM campaign_stages WHERE id = ${sourceId}::int
      `)) as unknown as { scheduled_at: string | null; full_url: string }[];
      return s[0].scheduled_at !== null && paramOf(s[0].full_url, STAGE_TRACKING_PARAM) === parentSubId3;
    })());

    // ── CASE 2: kickoff no_schedule guard ───────────────────────────────────
    console.log("\nCase 2 — kickoff refuses a null-scheduled stage:");
    // A lane (scheduled_at NULL, has creative) — must be refused as no_schedule.
    const laneId = lanes[0].id;
    const kNull = await kickoffStageSend(db, { orgId, campaignId, stageId: laneId });
    check(
      "null-scheduled stage → reason 'no_schedule'",
      !kNull.ok && kNull.reason === "no_schedule",
      JSON.stringify(kNull),
    );

    // Give that lane a future date — it must now get PAST the no_schedule guard
    // (it'll refuse for a downstream reason like no_recipients, never no_schedule).
    await db.execute(sql`
      UPDATE campaign_stages SET scheduled_at = now() + interval '1 day'
      WHERE id = ${laneId}::int
    `);
    const kDated = await kickoffStageSend(db, { orgId, campaignId, stageId: laneId });
    check(
      "scheduled (non-null) stage does NOT trip no_schedule",
      kDated.ok || kDated.reason !== "no_schedule",
      JSON.stringify(kDated),
    );
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const nameRows = (await db.execute(sql`
          SELECT name FROM organizations WHERE id = ${orgId}::uuid
        `)) as unknown as { name: string }[];
        const name = nameRows[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(`Refusing teardown: org ${orgId} name "${name}" is not the test marker.`);
        }
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM creatives WHERE org_id = ${orgId}::uuid`);
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
