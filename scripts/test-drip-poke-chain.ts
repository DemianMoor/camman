import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { leadToSendLatency } from "@/lib/drip/lead-latency";
import {
  POKE_MIN_GAP_MS,
  requestPoke,
  resetPokeFlagCacheForTests,
  runLeasedJob,
  type PokeJob,
} from "@/lib/drip/poke";
import { selectDrainableStages } from "@/lib/sends/scheduled";

// Drip poke chain (migration 0206), against the PREVIEW DB.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-poke-chain.ts
//
// HTTP is stubbed (globalThis.fetch records dispatches) — nothing is woken.
//
//   P1  flag off ⇒ requestPoke writes nothing and dispatches nothing
//   P2  flag on, idle job ⇒ exactly ONE dispatch; a second request while it is
//       unconsumed records the request but does not dispatch again
//   P3  lease held ⇒ request recorded, NO dispatch (the holder re-runs)
//   P4  a run started after the dispatch consumed it ⇒ the next request dispatches
//   P5  a dispatch older than POKE_MIN_GAP_MS and never consumed is re-sent
//   P6  ⭐ NO NEW CONCURRENCY: a cron run and a poked run of one job never
//       overlap; the poke that met the held lease is honoured as a re-run
//   P7  re-runs are spaced ≥ POKE_MIN_GAP_MS apart (start to start)
//   P8  flag off ⇒ runLeasedJob runs once and stamps nothing (the old path)
//   P9  a lease held by someone else ⇒ the step does not run at all
//   D1  ⭐ dripOnly drain selector returns the drip stage and NO regular stage
//   L1  lead-to-send counts only leads routed on arrival (not deferred, not carried)
// The org (and everything under it) is deleted and cron_locks restored at the end.

const MARKER = "__DRIP_POKE_CHAIN_TEST__";
const JOB: PokeJob = "drip-routing";
const JOBS: PokeJob[] = ["lead-enrichment", "lookup-worker", "drip-routing", "drip-scheduler", "drip-drain"];
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dispatched: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => {
  dispatched.push(String(url));
  return new Response(null, { status: 202 });
}) as typeof fetch;
process.env.NEXT_PUBLIC_SITE_URL ??= "https://poke-test.invalid";
process.env.CRON_SECRET ??= "poke-test-secret";

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const lockRow = (job: string) =>
    one<{ lease_until: string | null; poke_requested_at: string | null; poke_dispatched_at: string | null;
          last_run_started_at: string | null } | undefined>(
      sql`SELECT lease_until, poke_requested_at, poke_dispatched_at, last_run_started_at
          FROM cron_locks WHERE job_name = ${job}`);
  const resetJob = (job: string) => db.execute(sql`
    UPDATE cron_locks SET lease_until = NULL, poke_requested_at = NULL,
           poke_dispatched_at = NULL, last_run_started_at = NULL WHERE job_name = ${job}`);
  const setFlag = async (on: boolean) => {
    await db.execute(sql`UPDATE org_settings SET drip_poke_enabled = ${on} WHERE org_id = ${orgId}::uuid`);
    resetPokeFlagCacheForTests();
  };

  const others = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM org_settings WHERE drip_poke_enabled = true`)).n;
  if (others > 0) throw new Error(`REFUSING: ${others} org(s) on preview already have drip_poke_enabled`);
  const saved = (await db.execute(sql`
    SELECT * FROM cron_locks WHERE job_name IN (${sql.join(JOBS.map((j) => sql`${j}`), sql`, `)})
  `)) as unknown as Record<string, unknown>[];

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused, drip_poke_enabled)
      VALUES (${org}, true, false, false)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false, drip_poke_enabled = false`);
    await db.execute(sql`INSERT INTO cron_locks (job_name) VALUES (${JOB}) ON CONFLICT DO NOTHING`);

    // ── P1 ────────────────────────────────────────────────────────────────
    await setFlag(false);
    await resetJob(JOB);
    dispatched.length = 0;
    await requestPoke(JOB, "test");
    const p1 = await lockRow(JOB);
    bar("P1 flag off ⇒ nothing recorded, nothing dispatched",
      dispatched.length === 0 && p1?.poke_requested_at == null, `dispatched ${dispatched.length}`);

    // ── P2 ────────────────────────────────────────────────────────────────
    await setFlag(true);
    await resetJob(JOB);
    dispatched.length = 0;
    await requestPoke(JOB, "test");
    const first = await lockRow(JOB);
    await requestPoke(JOB, "test");
    const second = await lockRow(JOB);
    bar("P2 ⭐ idle job ⇒ exactly one dispatch; the second request is recorded only",
      dispatched.length === 1 && dispatched[0].endsWith("/api/cron/drip-routing")
        && new Date(second!.poke_requested_at!) > new Date(first!.poke_requested_at!),
      `dispatched ${JSON.stringify(dispatched)}`);

    // ── P3 ────────────────────────────────────────────────────────────────
    await resetJob(JOB);
    await db.execute(sql`UPDATE cron_locks SET lease_until = now() + interval '1 minute' WHERE job_name = ${JOB}`);
    dispatched.length = 0;
    await requestPoke(JOB, "test");
    const p3 = await lockRow(JOB);
    bar("P3 lease held ⇒ request recorded, no dispatch",
      dispatched.length === 0 && p3?.poke_requested_at != null, `dispatched ${dispatched.length}`);

    // ── P4 ────────────────────────────────────────────────────────────────
    await resetJob(JOB);
    dispatched.length = 0;
    await requestPoke(JOB, "test"); // dispatch #1
    await db.execute(sql`UPDATE cron_locks SET last_run_started_at = now() WHERE job_name = ${JOB}`); // consumed
    await requestPoke(JOB, "test"); // dispatch #2
    bar("P4 a run that started after the dispatch consumed it ⇒ next request dispatches",
      dispatched.length === 2, `dispatched ${dispatched.length}`);

    // ── P5 ────────────────────────────────────────────────────────────────
    await resetJob(JOB);
    await db.execute(sql`
      UPDATE cron_locks SET poke_dispatched_at = now() - interval '1 millisecond' * ${POKE_MIN_GAP_MS + 1000}
      WHERE job_name = ${JOB}`);
    dispatched.length = 0;
    await requestPoke(JOB, "test");
    bar("P5 an old unconsumed dispatch is presumed lost and re-sent", dispatched.length === 1,
      `dispatched ${dispatched.length}`);

    // ── P6 + P7 ───────────────────────────────────────────────────────────
    await resetJob(JOB);
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const runOnce = async ({ trigger, run }: { trigger: string; run: number }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      starts.push(Date.now());
      // Mid-run: the "poked" invocation arrives and meets the held lease.
      if (trigger === "cron" && run === 1) {
        const poked = await runLeasedJob(JOB, {
          trigger: "poke", budgetMs: 30_000, minRunMs: 0,
          runOnce: async () => { active++; maxActive = Math.max(maxActive, active); active--; },
        });
        pokedRan = poked.ran;
        await requestPoke(JOB, "test"); // what the poked caller recorded
      }
      await sleep(300);
      active--;
    };
    let pokedRan: boolean | null = null;
    const cron = await runLeasedJob(JOB, { trigger: "cron", budgetMs: 30_000, minRunMs: 0, runOnce });
    const gap = starts.length >= 2 ? starts[1] - starts[0] : -1;
    bar("P6 ⭐ the poked run met the held lease and did not run (no overlap)",
      pokedRan === false && maxActive === 1, `poked ran ${pokedRan}, max concurrent ${maxActive}`);
    bar("P6 the recorded poke was honoured as a re-run by the holder",
      cron.ran && cron.result === 2, `runs ${cron.ran ? cron.result : "skipped"}`);
    bar(`P7 re-runs spaced ≥ ${POKE_MIN_GAP_MS} ms start to start`, gap >= POKE_MIN_GAP_MS - 50, `gap ${gap} ms`);

    // ── P8 ────────────────────────────────────────────────────────────────
    await setFlag(false);
    await resetJob(JOB);
    let p8Runs = 0;
    const off = await runLeasedJob(JOB, { trigger: "cron", budgetMs: 30_000, minRunMs: 0, runOnce: async () => { p8Runs++; } });
    const p8 = await lockRow(JOB);
    bar("P8 flag off ⇒ one run, no stamps (the old cron path)",
      off.ran && p8Runs === 1 && p8?.last_run_started_at == null && p8?.lease_until == null,
      `runs ${p8Runs}, last_run_started_at ${p8?.last_run_started_at}`);

    // ── P9 ────────────────────────────────────────────────────────────────
    await setFlag(true);
    await resetJob(JOB);
    await db.execute(sql`UPDATE cron_locks SET lease_until = now() + interval '1 minute' WHERE job_name = ${JOB}`);
    let p9Runs = 0;
    const blocked = await runLeasedJob(JOB, { trigger: "poke", budgetMs: 30_000, minRunMs: 0, runOnce: async () => { p9Runs++; } });
    bar("P9 lease held by someone else ⇒ the step does not run", !blocked.ran && p9Runs === 0);
    await resetJob(JOB);

    // ── D1: drip-only drain selector ───────────────────────────────────────
    const prov = (await one<{ id: number }>(sql`
      INSERT INTO sms_providers (sms_provider_id, org_id, name, adapter_code, supports_api_send, sends_enabled, send_paused)
      VALUES (${"pk" + sfx}, ${org}, ${"PK " + sfx}, 'txh', true, true, false) RETURNING id`)).id;
    const contact = (await one<{ id: string }>(sql`
      INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${`+1996${sfx}0001`}) RETURNING id`)).id;
    let seq = 1;
    const pendingStage = async (campaignId: number, drip: boolean) => {
      const s = (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, send_approved, sms_provider_id,
                                     materialized_at, scheduled_at, sent_at, drip_active)
        VALUES (${org}, ${campaignId}, ${seq++}, true, ${prov}, now(),
                ${drip ? null : sql`now() - interval '10 minutes'`},
                ${drip ? sql`now() - interval '10 minutes'` : null}, ${drip ? true : null})
        RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${org}, ${campaignId}, ${s}, ${contact}::uuid, '+10000000000', 'x', 'pending')`);
      return s;
    };
    const regularCampaign = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${org}, ${"pkr-" + sfx}, 'pk regular', 'active', 'regular', 'tracked') RETURNING id`)).id;
    const dripCampaign = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${org}, ${"pkd-" + sfx}, 'pk drip', 'active', 'drip', 'tracked') RETURNING id`)).id;
    const regularStage = await pendingStage(regularCampaign, false);
    const dripStage = await pendingStage(dripCampaign, true);
    const all = (await selectDrainableStages(db, { now: new Date(), maxStages: 50, orgId })).map((r) => Number(r.stage_id));
    const dripOnly = (await selectDrainableStages(db, { now: new Date(), maxStages: 50, orgId, dripOnly: true }))
      .map((r) => Number(r.stage_id));
    bar("D1 control: the normal selector sees both stages",
      all.includes(regularStage) && all.includes(dripStage), JSON.stringify(all));
    bar("D1 ⭐ dripOnly sees the drip stage and NO regular stage",
      dripOnly.includes(dripStage) && !dripOnly.includes(regularStage), JSON.stringify(dripOnly));

    // ── L1: lead-to-send definition ────────────────────────────────────────
    const keyId = (await createPartnerWithKey(db, { orgId, slug: "pk-" + sfx, name: "pk", token: "tokpk" + sfx })).keyId;
    const lead = async (n: number, opts: { deferred?: boolean; carried?: number; sentSecAfter: number }) => {
      const cid = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${`+1997${sfx}${String(n).padStart(4, "0")}`})
        RETURNING id`)).id;
      const inbox = (await one<{ id: string }>(sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, status, processed_at)
        VALUES (${org}, ${keyId}, ${"pk-" + sfx}, now() - interval '20 minutes', '{}'::jsonb,
                ${`+1997${sfx}${String(n).padStart(4, "0")}`}, 'processed', now() - interval '20 minutes' + interval '10 seconds')
        RETURNING id`)).id;
      const ev = (await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at, inbox_id, drip_recheck_at)
        VALUES (${org}, ${cid}::uuid, ${keyId}, ${"pk-" + sfx}, now() - interval '20 minutes', ${inbox}::uuid,
                ${opts.deferred ? sql`now() - interval '5 minutes'` : null})
        RETURNING id`)).id;
      const send = (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${org}, ${dripCampaign}, ${dripStage}, ${cid}::uuid, '+10000000001', 'x', 'sent',
                now() - interval '20 minutes' + make_interval(secs => ${opts.sentSecAfter}))
        RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at,
                                   first_send_at, first_stage_id, first_send_id, carried_days)
        VALUES (${org}, ${dripCampaign}, ${cid}::uuid, ${ev}::uuid, 'active',
                now() - interval '20 minutes' + interval '20 seconds',
                now() - interval '20 minutes' + interval '30 seconds', ${dripStage}, ${send}::uuid, ${opts.carried ?? 0})`);
    };
    await lead(1, { sentSecAfter: 40 });
    await lead(2, { sentSecAfter: 60 });
    await lead(3, { sentSecAfter: 900, deferred: true });
    await lead(4, { sentSecAfter: 900, carried: 1 });
    const lat = await leadToSendLatency(db, {
      orgId, from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000),
    });
    bar("L1 ⭐ only the two leads routed on arrival count", lat.n === 2, `n ${lat.n}`);
    bar("L1 median over them is 50 s (40 s and 60 s)", lat.p50Sec === 50, `p50 ${lat.p50Sec}`);
    bar("L1 hop medians: lookup 10 s · route 10 s · queue 10 s",
      lat.stepP50Sec.lookup === 10 && lat.stepP50Sec.route === 10 && lat.stepP50Sec.queue === 10,
      JSON.stringify(lat.stepP50Sec));
  } finally {
    // cron_locks: put back exactly what was there.
    for (const job of JOBS) {
      const row = saved.find((r) => r.job_name === job);
      if (!row) {
        await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${job}`);
      } else {
        await db.execute(sql`
          UPDATE cron_locks SET lease_until = ${row.lease_until as string | null}::timestamptz,
                 poke_requested_at = NULL, poke_dispatched_at = NULL, last_run_started_at = NULL
          WHERE job_name = ${job}`);
      }
    }
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM stage_sends WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_inbox WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM org_settings WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
