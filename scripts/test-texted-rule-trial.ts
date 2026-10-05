import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Task 3 T5: the nightly trial of the "Texted in the last…" rule
// (lib/segments/texted-rule-trial.ts, /api/cron/texted-rule-trial).
//
//   S1-S6  the streak: consecutive clean nights count, a second run on the same
//          day counts once, a missed night restarts at 1, drift resets to 0,
//          and night 14 produces the "may switch" message
//   R1     red proof — a contact_engagement row with NO send behind it is
//          drift (only_fact +1 in every window)
//   R2     red proof — a send with NO engagement row, outside the lag tail, is
//          drift (only_direct +1)
//   R3     a manual stage marked sent with no recorded recipients is a gap
//   R4     the drift message names it
// R1-R4 measure DELTAS against a baseline taken in the same transaction (the
// preview org's own data need not be consistent), then roll everything back.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-texted-rule-trial.ts

import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const ROLLBACK = "ROLLBACK_FIXTURE";

async function main() {
  const { db } = await import("@/db/client");
  const T = await import("@/lib/segments/texted-rule-trial");
  const { ENGAGEMENT_JOB } = await import("@/lib/engagement/constants");

  // ── S: the streak (pure) ──────────────────────────────────────────────────
  const rep = (day: string, drift: boolean) =>
    ({ org_id: "o", ran_at: `${day}T05:20:00.000Z`, periods: [], drift, manual_gaps: [], segments: [] }) as never;
  let s = T.nextTrialState(null, rep("2026-10-06", false));
  bar("S1 first clean night → streak 1", s.streak === 1, `${s.streak}`);
  s = T.nextTrialState(s, rep("2026-10-07", false));
  bar("S2 next day clean → 2", s.streak === 2, `${s.streak}`);
  s = T.nextTrialState(s, rep("2026-10-07", false));
  bar("S3 a second run the same day counts once → still 2", s.streak === 2, `${s.streak}`);
  s = T.nextTrialState(s, rep("2026-10-09", false));
  bar("S4 a missed night restarts at 1", s.streak === 1, `${s.streak}`);
  s = T.nextTrialState(s, rep("2026-10-10", true));
  bar("S5 drift resets to 0", s.streak === 0 && s.last_drift_at !== null, `${s.streak}`);
  let day = Date.parse("2026-10-11T00:00:00Z");
  let msg: string | null = null;
  for (let i = 1; i <= T.TEXTED_TRIAL_TARGET_NIGHTS; i++, day += 86_400_000) {
    const r = rep(new Date(day).toISOString().slice(0, 10), false);
    s = T.nextTrialState(s, r);
    msg = T.trialMessage(r, s);
    if (i < T.TEXTED_TRIAL_TARGET_NIGHTS && msg) break;
  }
  bar(
    `S6 night ${T.TEXTED_TRIAL_TARGET_NIGHTS} says so, and only then`,
    s.streak === T.TEXTED_TRIAL_TARGET_NIGHTS && !!msg && msg.includes("consecutive clean nights"),
    `streak ${s.streak}`,
  );

  // ── R: red proofs on the preview DB ─────────────────────────────────────
  const [{ org_id: orgId }] = (await db.execute(sql`
    select m.org_id from org_members m join auth.users u on u.id = m.user_id
    where u.email = ${process.env.TEST_USER_EMAIL!} limit 1`)) as unknown as { org_id: string }[];
  const tag = String(Date.now()).slice(-6);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into lifecycle_settings (org_id, engine_mode) values (${orgId}::uuid, 'write')
        on conflict (org_id) do update set engine_mode = 'write'`);
      await tx.execute(sql`
        insert into cron_locks (job_name, watermark) values (${ENGAGEMENT_JOB}, now() - interval '5 minutes')
        on conflict (job_name) do update set watermark = excluded.watermark`);
      const base = await T.runTextedRuleTrial(tx as never, orgId);

      const mk = async (i: number) =>
        ((await tx.execute(sql`
          insert into contacts (org_id, phone_number, messaging_status)
          values (${orgId}::uuid, ${`+1555${tag}${i}`}, 'eligible') returning id`)) as unknown as { id: string }[])[0].id;
      const ghost = await mk(1); // engagement row, no send
      const silent = await mk(2); // send, no engagement row, outside the tail
      await tx.execute(sql`
        insert into contact_engagement (org_id, contact_id, status, status_changed_at, freeze_cadence_days, thresholds, last_sent_at)
        values (${orgId}::uuid, ${ghost}::uuid, 'cold', now(), 7, '{}'::jsonb, now() - interval '1 day')`);
      const [camp] = (await tx.execute(sql`
        insert into campaigns (org_id, slug, name, status, link_mode)
        values (${orgId}::uuid, ${"trial-" + tag}, 'trial probe', 'active', 'manual') returning id`)) as unknown as { id: number }[];
      const [stg] = (await tx.execute(sql`
        insert into campaign_stages (org_id, campaign_id, stage_number, status, status_changed_at)
        values (${orgId}::uuid, ${camp.id}, 1, 'sent', now()) returning id`)) as unknown as { id: number }[];
      await tx.execute(sql`
        insert into stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        values (${orgId}::uuid, ${camp.id}, ${stg.id}, ${silent}::uuid, ${`+1555${tag}2`}, 'x', 'sent', now() - interval '2 hours')`);

      const after = await T.runTextedRuleTrial(tx as never, orgId);
      for (const p of ["3d", "1w", "2w"]) {
        const b = base.periods.find((x) => x.period === p)!;
        const a = after.periods.find((x) => x.period === p)!;
        bar(`R1 ${p}: an engagement row with no send is drift (only_fact +1)`, a.only_fact - b.only_fact === 1, `${b.only_fact} → ${a.only_fact}`);
        bar(`R2 ${p}: a send outside the tail with no engagement row is drift (only_direct +1)`, a.only_direct - b.only_direct === 1, `${b.only_direct} → ${a.only_direct}`);
      }
      // The seeded stage DID send through stage_sends, so it is NOT a manual gap;
      // a second manual stage marked sent with nothing recorded IS.
      const [gap] = (await tx.execute(sql`
        insert into campaign_stages (org_id, campaign_id, stage_number, status, status_changed_at)
        values (${orgId}::uuid, ${camp.id}, 2, 'success', now()) returning id`)) as unknown as { id: number }[];
      const withGap = await T.runTextedRuleTrial(tx as never, orgId);
      const ids = withGap.manual_gaps.map((g) => g.stage_id);
      bar("R3 a manual stage marked texted with nothing recorded is a gap", ids.includes(gap.id) && !ids.includes(stg.id), JSON.stringify(ids));
      const text = T.trialMessage(withGap, T.nextTrialState(null, withGap)) ?? "";
      bar("R4 the message says DRIFT and names the gap stage", text.includes("DRIFT") && text.includes(`stage ${gap.id}`), text.slice(0, 120));
      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if ((e as Error).message !== ROLLBACK) throw e;
    console.log("\n  (fixture rolled back)");
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
