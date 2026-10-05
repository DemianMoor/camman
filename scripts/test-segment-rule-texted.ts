import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Task 3 T2: the "Texted in the last…" segment rule (texted_in_last_period).
// Plan: docs/superpowers/plans/2026-10-02-task3-texted-rule-plan.md §2, §4, §4b.
//
// Synthetic contacts, each reachable through exactly ONE source, so every
// source is proven on its own:
//   A    contact_engagement.last_sent_at 2 days ago (the fact only)
//   A10  contact_engagement.last_sent_at 10 days ago (the fact only)
//   B    stage_sends 'sent' 10 min ago, NO engagement row (the lag tail only)
//   B2   stage_sends 'sent' 2 h ago, NO engagement row — with the watermark
//        5 min old the tail starts 35 min ago, so B2 is OUTSIDE it: proves the
//        tail is bounded by the watermark (the fact would carry B2 in reality)
//   C    stage_manual_recipients stamped 1 day ago (manual send only)
//   C0   stage_manual_recipients exported, NOT stamped (not texted)
//   F    stage_sends 'failed' 1 hour ago (not a send)
//   D    never texted
// Engine OFF (lifecycle_settings.engine_mode <> 'write'): the fact is ignored
// and the tail covers the whole window — A drops out, B2 comes in.
// Then the REAL builder (buildSegmentAudienceClause) with `is` and `is_not`:
// never-texted D is IN "not texted", texted ones are out.
//
// All fixture rows live in ONE transaction that is rolled back; the segment +
// rule rows the builder reads are committed (it reads them on its own
// connection) and deleted by id at the end.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-segment-rule-texted.ts

import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const ROLLBACK = "ROLLBACK_FIXTURE";

async function main() {
  const { db } = await import("@/db/client");
  const { buildSegmentAudienceClause, ruleInnerQuery } = await import("@/lib/segment-rules-eval");
  const { ENGAGEMENT_JOB } = await import("@/lib/engagement/constants");
  const { RULE_TYPES } = await import("@/lib/validators/segment-rule-types");

  bar(
    "registered: texted_in_last_period is/is_not on the period picker",
    JSON.stringify(RULE_TYPES.texted_in_last_period?.operators) === JSON.stringify(["is", "is_not"]) &&
      RULE_TYPES.texted_in_last_period?.value_shape === "campaign_use_period",
  );

  const [{ org_id: orgId }] = (await db.execute(sql`
    select m.org_id from org_members m join auth.users u on u.id = m.user_id
    where u.email = ${process.env.TEST_USER_EMAIL!} limit 1`)) as unknown as { org_id: string }[];
  const tag = String(Date.now()).slice(-6);

  // Committed: two segments whose only rule is texted 3d (is / is_not).
  const segIds: number[] = [];
  for (const op of ["is", "is_not"] as const) {
    const [s] = (await db.execute(sql`
      insert into segments (org_id, segment_id, name)
      values (${orgId}::uuid, ${`txt-${op}-${tag}`}, ${`texted probe ${op} ${tag}`}) returning id`)) as unknown as { id: number }[];
    segIds.push(s.id);
    await db.execute(sql`
      insert into segment_rules (org_id, segment_id, rule_type, operator, value, position, is_active)
      values (${orgId}::uuid, ${s.id}, 'texted_in_last_period', ${op}, '"3d"'::jsonb, 0, true)`);
  }

  try {
    await db.transaction(async (tx) => {
      const names = ["A", "A10", "B", "B2", "C", "C0", "F", "D"] as const;
      const id: Record<string, string> = {};
      for (const [i, n] of names.entries()) {
        const [c] = (await tx.execute(sql`
          insert into contacts (org_id, phone_number, messaging_status)
          values (${orgId}::uuid, ${`+1555${tag}${i}`}, 'eligible') returning id`)) as unknown as { id: string }[];
        id[n] = c.id;
      }
      const [camp] = (await tx.execute(sql`
        insert into campaigns (org_id, slug, name, status) values (${orgId}::uuid, ${"txt-" + tag}, 'texted probe', 'completed') returning id`)) as unknown as { id: number }[];
      const [stg] = (await tx.execute(sql`
        insert into campaign_stages (org_id, campaign_id, stage_number, status) values (${orgId}::uuid, ${camp.id}, 1, 'sent') returning id`)) as unknown as { id: number }[];
      const send = (who: string, status: string, ago: string) => tx.execute(sql`
        insert into stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        values (${orgId}::uuid, ${camp.id}, ${stg.id}, ${id[who]}::uuid, ${`+1555${tag}${who}`}, 'x', ${status}, now() - ${ago}::interval)`);
      await send("B", "sent", "10 minutes");
      await send("B2", "sent", "2 hours");
      await send("F", "failed", "1 hour");
      const eng = (who: string, ago: string) => tx.execute(sql`
        insert into contact_engagement (org_id, contact_id, status, status_changed_at, freeze_cadence_days, thresholds, last_sent_at)
        values (${orgId}::uuid, ${id[who]}::uuid, 'cold', now(), 7, '{}'::jsonb, now() - ${ago}::interval)
        on conflict (contact_id) do update set last_sent_at = excluded.last_sent_at`);
      await eng("A", "2 days");
      await eng("A10", "10 days");
      await tx.execute(sql`
        insert into stage_manual_recipients (org_id, stage_id, contact_id, sent_at) values
          (${orgId}::uuid, ${stg.id}, ${id.C}::uuid, now() - interval '1 day'),
          (${orgId}::uuid, ${stg.id}, ${id.C0}::uuid, null)`);
      // The engagement job ran 5 minutes ago (tail starts 35 minutes ago).
      await tx.execute(sql`
        insert into cron_locks (job_name, watermark) values (${ENGAGEMENT_JOB}, now() - interval '5 minutes')
        on conflict (job_name) do update set watermark = excluded.watermark`);
      const setEngine = (mode: "write" | "off") => tx.execute(sql`
        insert into lifecycle_settings (org_id, engine_mode) values (${orgId}::uuid, ${mode})
        on conflict (org_id) do update set engine_mode = excluded.engine_mode`);

      const ids = Object.values(id);
      const texted = async (period: string) => {
        const rows = (await tx.execute(sql`
          select contact_id from (${ruleInnerQuery({ rule_type: "texted_in_last_period", operator: "is", value: period }, 0, orgId)}) t
          where contact_id = any(${`{${ids.join(",")}}`}::uuid[])`)) as unknown as { contact_id: string }[];
        const set = new Set(rows.map((r) => r.contact_id));
        return names.filter((n) => set.has(id[n])).join(",");
      };

      await setEngine("write");
      const w3 = await texted("3d");
      bar("engine ON, 3d: A (fact), B (tail), C (manual) — not A10, B2, C0, F, D", w3 === "A,B,C", w3);
      const w2w = await texted("2w");
      bar("engine ON, 2w: A10 joins via the fact", w2w === "A,A10,B,C", w2w);
      bar("the tail is bounded by the watermark: B2 (2 h ago, no fact row) is out", !w3.split(",").includes("B2"));
      bar("a 'failed' send is not a send (F out)", !w2w.split(",").includes("F"));
      bar("an exported-but-unmarked manual row is not a send (C0 out)", !w2w.split(",").includes("C0"));

      await setEngine("off");
      const o3 = await texted("3d");
      bar("engine OFF, 3d: the fact is ignored (A out), the tail covers the window (B2 in)", o3 === "B,B2,C", o3);

      await setEngine("write");
      const inSeg = async (segId: number) => {
        const clause = await buildSegmentAudienceClause(segId, orgId);
        const rows = (await tx.execute(sql`
          select contact_id from (${clause}) s where contact_id = any(${`{${ids.join(",")}}`}::uuid[])`)) as unknown as { contact_id: string }[];
        const set = new Set(rows.map((r) => r.contact_id));
        return names.filter((n) => set.has(id[n])).join(",");
      };
      const segIs = await inSeg(segIds[0]);
      bar("builder, texted 3d IS: A, B, C", segIs === "A,B,C", segIs);
      const segNot = await inSeg(segIds[1]);
      bar("builder, texted 3d IS NOT: everyone else, incl. never-texted D", segNot === "A10,B2,C0,F,D", segNot);

      // T4 kill switch: AUDIENCE_RULE_TEXTED=direct reads the sends themselves.
      process.env.AUDIENCE_RULE_TEXTED = "direct";
      const d3 = await texted("3d");
      bar("KILL SWITCH direct, 3d: the fact is not read (A out), sends over the whole window (B2 in)", d3 === "B,B2,C", d3);
      // A CONSISTENT fixture — every engagement row backed by a real send, as
      // the job leaves it — must give the same set either way, every window.
      await send("A", "sent", "2 days");
      await send("A10", "sent", "10 days");
      await eng("B", "10 minutes");
      await eng("B2", "2 hours");
      for (const p of ["3d", "1w", "2w"]) {
        process.env.AUDIENCE_RULE_TEXTED = "direct";
        const direct = await texted(p);
        delete process.env.AUDIENCE_RULE_TEXTED;
        const fact = await texted(p);
        bar(`KILL SWITCH: direct = fact on a consistent fixture, ${p}`, direct === fact && direct.length > 0, `${direct} vs ${fact}`);
      }
      delete process.env.AUDIENCE_RULE_TEXTED;

      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if ((e as Error).message !== ROLLBACK) throw e;
    console.log("\n  (fixture rolled back)");
  } finally {
    await db.execute(sql`delete from segment_rules where segment_id = any(${`{${segIds.join(",")}}`}::int[])`);
    await db.execute(sql`delete from segments where id = any(${`{${segIds.join(",")}}`}::int[])`);
    const [left] = (await db.execute(sql`
      select count(*)::int n from segments where id = any(${`{${segIds.join(",")}}`}::int[])`)) as unknown as { n: number }[];
    console.log(`  teardown: ${left.n === 0 ? "probe segments deleted" : "PROBE SEGMENTS STILL PRESENT"}`);
    if (left.n !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
