import "./_env-preload";
import "./_require-preview-db"; // second — refuses production; a scale project must be allow-listed there

// ⚠️ UNUSED BY THE OWNER'S DECISION (2026-10-05): the 5× speed gate was replaced
// by monitoring on live data, at no cost; option C (a paid throwaway project) was
// cancelled. Kept for reference only — do not run it against any paid resource.
//
// Task 3 speed gate (plan §6, owner 2026-10-03): the campaign audience preview
// must stay under 2 s at 5x today's data. Option C (owner, 2026-10-05): a
// throwaway Supabase project on Large, SYNTHETIC data only — no production row
// is copied; only production's aggregate SHAPES (planner statistics, read
// 2026-10-05) are reproduced. The project is deleted at the end of the session.
//
//   --generate --scale=5   build one synthetic org (server-side generate_series)
//   --measure              time the form's two preview parts on five recipes
//                          shaped like production's; FAIL if a part > 2 s
//   --teardown             delete the synthetic org (cascade) and the helper table
//
// Production shapes at scale 1 (2026-10-05): 1,047,204 contacts (91.3% eligible;
// lifecycle cold 52.9 / new 23.6 / freeze 15.2 / warm 4.9 / hot 3.5 %), 20
// contact groups with 1,129,787 memberships (sizes below), 769 campaigns, a
// 2,834,873-row audience pool, 6,040,791 stage_sends (95.1% sent), 39 offers,
// 272,312 opt-outs, 133,705 clickers.
//
// Run against the scale project with its own env file (gitignored):
//   npx tsx --env-file=.env.scale --conditions=react-server scripts/speed-gate-5x.ts --generate --scale=5
// Small validation on the preview DB:
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/speed-gate-5x.ts --generate --scale=0.002 --measure --teardown

import { sql } from "drizzle-orm";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k: string) => process.argv.includes(`--${k}`);
const SCALE = Number(arg("scale") ?? "5");
const ORG_NAME = "SYNTHETIC speed-gate org";
const GATE_MS = 2000;
const ROUNDS = 3;

// Contact-group membership shares (production rank order, 2026-10-05).
const GROUP_SHARES = [
  0.2034, 0.1666, 0.1328, 0.1223, 0.0835, 0.0627, 0.0511, 0.0348, 0.0317, 0.0252,
  0.0181, 0.0167, 0.0165, 0.009, 0.008, 0.0061, 0.0047, 0.0032, 0.0028, 0.0009,
];
const OFFER_SHARES = [0.216, 0.174, 0.158, 0.13, 0.071, 0.049, 0.043, 0.029, 0.022, 0.013];

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

async function main() {
  const { db } = await import("@/db/client");
  const ex = (q: ReturnType<typeof sql>) => db.execute(q);
  const t = (label: string, t0: number) => console.log(`  ${label} — ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const orgRow = async () =>
    ((await ex(sql`select id from organizations where name = ${ORG_NAME} limit 1`)) as unknown as { id: string }[])[0]?.id;

  if (has("generate")) {
    if (await orgRow()) throw new Error("synthetic org already exists — run --teardown first");
    let N = Math.round(1_047_204 * SCALE);
    const STRIDE = 104_729;
    while (gcd(N, STRIDE) !== 1) N++;
    const C = Math.max(10, Math.round(769 * SCALE));
    // Per campaign, as in production — but never more than 90% of the contacts
    // (a tiny validation scale would otherwise repeat contacts within a pool).
    // Total pool rows stay at production's 2,834,873 x scale whatever C is (C
    // has a floor of 10), so a small validation run keeps production's density.
    const POOL = Math.max(1, Math.min(Math.round((2_834_873 * SCALE) / C), Math.floor(N * 0.9)));
    console.log(`GENERATE scale ${SCALE}: ${N} contacts, ${C} campaigns x ${POOL} pool`);
    let t0 = Date.now();
    const [{ id: org }] = (await ex(sql`insert into organizations (name) values (${ORG_NAME}) returning id`)) as unknown as { id: string }[];
    await ex(sql`insert into lifecycle_settings (org_id, engine_mode) values (${org}::uuid, 'write') on conflict (org_id) do update set engine_mode = 'write'`);
    const [{ id: brand }] = (await ex(sql`insert into brands (org_id, brand_id, name) values (${org}::uuid, 'SYN-B', 'Synthetic brand') returning id`)) as unknown as { id: number }[];
    const [{ id: net }] = (await ex(sql`insert into affiliate_networks (org_id, network_id, name) values (${org}::uuid, 'SYN-N', 'Synthetic network') returning id`)) as unknown as { id: number }[];
    const offers: number[] = [];
    for (let k = 0; k < 39; k++) {
      const [{ id }] = (await ex(sql`insert into offers (org_id, offer_id, name, network_id) values (${org}::uuid, ${`SYN-O-${k}`}, ${`Synthetic offer ${k}`}, ${net}) returning id`)) as unknown as { id: number }[];
      offers.push(id);
    }
    const groups: number[] = [];
    for (let k = 0; k < GROUP_SHARES.length; k++) {
      const [{ id }] = (await ex(sql`insert into contact_groups (org_id, contact_group_id, name) values (${org}::uuid, ${`SYN-G-${k + 1}`}, ${`Synthetic group ${k + 1}`}) returning id`)) as unknown as { id: number }[];
      groups.push(id);
    }
    t("org, brand, network, 39 offers, 20 groups", t0);

    // Contacts. h(i, salt) is a deterministic 0..9999 pseudo-random draw.
    t0 = Date.now();
    await ex(sql`drop table if exists _synth_idx`);
    await ex(sql`create table _synth_idx (i int primary key, id uuid not null, phone text not null)`);
    await ex(sql`
      with g as (select i, abs(hashint4(i * 7 + 1)) % 10000 as r1, abs(hashint4(i * 7 + 2)) % 10000 as r2,
                        abs(hashint4(i * 7 + 3)) % 10000 as r3 from generate_series(1, ${N}) i),
      ins as (
        insert into contacts (org_id, phone_number, messaging_status, lifecycle_status, carrier_norm)
        select ${org}::uuid, '+1' || (2010000000 + i)::text,
          case when r1 < 9126 then 'eligible' else 'not_applicable' end,
          case when r2 < 5288 then 'cold' when r2 < 7646 then 'new' when r2 < 9169 then 'freeze' when r2 < 9654 then 'warm' else 'hot' end,
          case when r3 < 3363 then 'Verizon' when r3 < 5804 then 'AT&T' when r3 < 7992 then 'T-Mobile' when r3 < 8883 then 'Unknown'
               when r3 < 9624 then 'Unidentified' when r3 < 9857 then 'VoIP' when r3 < 9976 then 'Other Mobile' else 'Unmapped' end
        from g returning id, phone_number)
      insert into _synth_idx (i, id, phone) select (substr(phone_number, 3)::bigint - 2010000000)::int, id, phone_number from ins`);
    t(`${N} contacts`, t0);

    // Group memberships: one weighted group each, plus ~8% a second one.
    t0 = Date.now();
    const cum: number[] = [];
    GROUP_SHARES.reduce((a, s, k) => ((cum[k] = a + s), a + s), 0);
    const total = cum[cum.length - 1];
    const caseFor = (expr: string) =>
      "case " + cum.map((c, k) => `when ${expr} < ${Math.round((c / total) * 10000)} then ${groups[k]}`).join(" ") + ` else ${groups[groups.length - 1]} end`;
    await ex(sql.raw(`
      insert into contact_contact_groups (org_id, contact_id, contact_group_id)
      select '${org}'::uuid, x.id, ${caseFor("abs(hashint4(x.i * 11 + 5)) % 10000")} from _synth_idx x
      union
      select '${org}'::uuid, x.id, ${caseFor("abs(hashint4(x.i * 13 + 9)) % 10000")} from _synth_idx x where abs(hashint4(x.i * 17)) % 100 < 8
      on conflict do nothing`));
    t("group memberships", t0);

    // Campaigns over the last 180 days; those created in the last 10 days are active.
    t0 = Date.now();
    const ocum: number[] = [];
    OFFER_SHARES.reduce((a, s, k) => ((ocum[k] = a + s), a + s), 0);
    const offerCase = "case " + ocum.map((c, k) => `when (abs(hashint4(k * 3)) % 1000) < ${Math.round(c * 1000)} then ${offers[k]}`).join(" ") +
      ` else ${offers[10]} + (k % 29) end`;
    await ex(sql.raw(`
      insert into campaigns (org_id, slug, name, status, brand_id, offer_id, link_mode, created_at)
      select '${org}'::uuid, 'syn-c-' || k, 'Synthetic campaign ' || k,
        case when k > ${C} - ${Math.max(1, Math.round(C * 10 / 180))} then 'active' else 'completed' end,
        ${brand}, ${offerCase}, 'tracked', now() - make_interval(secs => (${C} - k) * (180 * 86400.0 / ${C}))
      from generate_series(1, ${C}) k`));
    await ex(sql`update campaigns set offer_id = ${offers[0]} where org_id = ${org}::uuid and offer_id not in (select id from offers where org_id = ${org}::uuid)`);
    await ex(sql.raw(`
      insert into campaign_stages (org_id, campaign_id, stage_number, status, sent_at, scheduled_at)
      select c.org_id, c.id, s.n,
        case when c.created_at + make_interval(days => s.d) <= now() then 'sent' else 'pending' end,
        case when c.created_at + make_interval(days => s.d) <= now() then c.created_at + make_interval(days => s.d) end,
        c.created_at + make_interval(days => s.d)
      from campaigns c cross join (values (1, 1), (2, 3), (3, 7)) s(n, d)
      where c.org_id = '${org}'::uuid`));
    t(`${C} campaigns, ${C * 3} stages`, t0);

    // Pools: campaign k takes POOL distinct contacts ((k*7919 + j*STRIDE) mod N) + 1.
    t0 = Date.now();
    await ex(sql.raw(`
      insert into campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
      select '${org}'::uuid, c.id, x.id, abs(hashint4(x.i + c.id)) % 100 >= 5, abs(hashint4(x.i + c.id)) % 100 < 5
      from (select id, row_number() over (order by id) as k from campaigns where org_id = '${org}'::uuid) c
      cross join generate_series(1, ${POOL}) j
      join _synth_idx x on x.i = ((c.k * 7919 + j::bigint * ${STRIDE}) % ${N}) + 1`));
    t("audience pools", t0);

    // Sends: stage 1 all, stage 2 70%, stage 3 40% of the pool, for stages already sent.
    t0 = Date.now();
    await ex(sql.raw(`
      insert into stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
      select p.org_id, p.campaign_id, s.id, p.contact_id, x.phone, 'synthetic',
        case when r < 9511 then 'sent' when r < 9869 then 'rejected' when r < 9974 then 'filtered' else 'failed' end,
        case when r < 9511 then s.sent_at + make_interval(secs => abs(hashint4(x.i * 5 + s.stage_number)) % 21600) end
      from campaign_audience_pool p
      join campaign_stages s on s.campaign_id = p.campaign_id and s.sent_at is not null
      join _synth_idx x on x.id = p.contact_id
      cross join lateral (select abs(hashint4(x.i * 29 + s.id)) % 10000 as r) rr
      where p.org_id = '${org}'::uuid
        and (s.stage_number = 1 or (s.stage_number = 2 and abs(hashint4(x.i * 3 + s.id)) % 100 < 70)
             or (s.stage_number = 3 and abs(hashint4(x.i * 3 + s.id)) % 100 < 40))`));
    t("stage_sends", t0);

    t0 = Date.now();
    await ex(sql`
      insert into contact_engagement (org_id, contact_id, status, status_changed_at, freeze_cadence_days, thresholds, last_sent_at, first_sent_at)
      select ${org}::uuid, c.id, c.lifecycle_status, now(), 7, '{}'::jsonb, s.last_sent, s.first_sent
      from contacts c
      left join (select contact_id, max(sent_at) last_sent, min(sent_at) first_sent from stage_sends
                 where org_id = ${org}::uuid and status = 'sent' group by contact_id) s on s.contact_id = c.id
      where c.org_id = ${org}::uuid`);
    await ex(sql`
      insert into contact_offer_campaigns (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
      select ss.org_id, ss.contact_id, c.offer_id, ss.campaign_id, min(ss.sent_at), max(ss.sent_at), count(*)
      from stage_sends ss join campaigns c on c.id = ss.campaign_id
      where ss.org_id = ${org}::uuid and ss.status = 'sent'
      group by ss.org_id, ss.contact_id, c.offer_id, ss.campaign_id`);
    await ex(sql`
      insert into offer_exposures (org_id, contact_id, offer_id, campaign_id, first_sent_at)
      select org_id, contact_id, offer_id, min(campaign_id), min(first_sent_at)
      from contact_offer_campaigns where org_id = ${org}::uuid group by org_id, contact_id, offer_id
      on conflict do nothing`);
    t("contact_engagement, contact_offer_campaigns, offer_exposures", t0);

    t0 = Date.now();
    await ex(sql`
      insert into opt_outs (org_id, contact_id, phone_number, reason)
      select ${org}::uuid, id, phone, 'opt_out' from _synth_idx where abs(hashint4(i * 19 + 7)) % 10000 < 2600
      on conflict do nothing`);
    await ex(sql`
      insert into clickers (org_id, contact_id, phone_number, brand_id, source)
      select ${org}::uuid, id, phone, ${brand}, 'synthetic' from _synth_idx where abs(hashint4(i * 23 + 3)) % 10000 < 1277
      on conflict do nothing`);
    // Segments shaped like 223 / 195 / 196, and their texted-rule twins.
    for (const [name, type, period] of [
      ["SYN not used 3d", "in_use_in_campaign_last_period", "3d"], ["SYN not used 1w", "in_use_in_campaign_last_period", "1w"],
      ["SYN not used 2w", "in_use_in_campaign_last_period", "2w"], ["SYN not texted 3d", "texted_in_last_period", "3d"],
    ] as const) {
      const [{ id }] = (await ex(sql`insert into segments (org_id, segment_id, name) values (${org}::uuid, ${name.replace(/ /g, "-")}, ${name}) returning id`)) as unknown as { id: number }[];
      await ex(sql`insert into segment_rules (org_id, segment_id, rule_type, operator, value, position, is_active)
                   values (${org}::uuid, ${id}, ${type}, 'is_not', ${JSON.stringify(period)}::jsonb, 0, true)`);
    }
    // The texted rule's lag tail needs an engagement watermark; never overwrite a real one.
    await ex(sql`insert into cron_locks (job_name, watermark) values ('contact-engagement', now()) on conflict (job_name) do nothing`);
    t("opt-outs, clickers, segments", t0);
    t0 = Date.now();
    for (const tb of ["contacts", "contact_contact_groups", "campaigns", "campaign_stages", "campaign_audience_pool", "stage_sends",
      "contact_engagement", "contact_offer_campaigns", "offer_exposures", "opt_outs", "clickers"]) await ex(sql.raw(`analyze ${tb}`));
    t("ANALYZE", t0);
    const sizes = (await ex(sql`
      select relname, reltuples::bigint as rows, pg_size_pretty(pg_total_relation_size(oid)) total from pg_class
      where relname in ('contacts','contact_contact_groups','campaign_audience_pool','stage_sends','contact_engagement','contact_offer_campaigns','offer_exposures','opt_outs')
      order by relname`)) as unknown as { relname: string; rows: string; total: string }[];
    for (const r of sizes) console.log(`    ${r.relname.padEnd(26)} ${String(r.rows).padStart(11)} rows  ${r.total}`);
  }

  if (has("measure")) {
    const org = await orgRow();
    if (!org) throw new Error("no synthetic org — run --generate first");
    const { previewAudienceBase, previewAudienceAudiencePart } = await import("@/lib/audience-snapshot");
    const ids = async (q: ReturnType<typeof sql>) => ((await ex(q)) as unknown as { id: number }[]).map((r) => r.id);
    const groups = await ids(sql`select id from contact_groups where org_id = ${org}::uuid order by contact_group_id collate "C"`);
    const byRank = (ranks: number[]) => ranks.map((r) => groups.find((_, k) => k === r - 1)!).filter(Boolean);
    const segs = Object.fromEntries(((await ex(sql`select id, name from segments where org_id = ${org}::uuid`)) as unknown as { id: number; name: string }[]).map((s) => [s.name, s.id]));
    const offer = (await ids(sql`select offer_id as id from campaigns where org_id = ${org}::uuid group by offer_id order by count(*) desc limit 1`))[0];
    const base = {
      orgId: org, lifecycleRules: true, excludeSegmentIds: [] as number[], cap: 1000, excludeInUse: true,
      excludePriorOffer: true, offerRulesEnabled: true, offerCooldownDays: 14, offerLimitTimes: 5, offerId: offer,
    };
    // The audience filters production campaigns carry (1429 / 1560 / 1568,
    // read 2026-10-05); legacy previews include nobody without them.
    const F = { carrier_filter: [], include_opt_in: false, include_clickers: true, include_no_status: true, include_not_clicked: true };
    const recipes = [
      { label: "1568-like (seg not-used 3d, 4 small groups, hot/warm, offer rules)", input: { ...base, segmentIds: [segs["SYN not used 3d"]], contactGroupIds: byRank([16, 9, 17, 8]), filters: { ...F, lifecycle_statuses: ["hot", "warm"] } } },
      { label: "1521-like (seg not-used 3d, 3 large groups, hot/warm)", input: { ...base, cap: 1500, segmentIds: [segs["SYN not used 3d"]], contactGroupIds: byRank([4, 5, 7]), filters: { ...F, lifecycle_statuses: ["hot", "warm"] } } },
      { label: "1429-like (legacy, 2 segments, 12 groups)", input: { ...base, lifecycleRules: false, offerRulesEnabled: false, excludePriorOffer: false, cap: 2000, segmentIds: [segs["SYN not used 1w"], segs["SYN not used 3d"]], contactGroupIds: byRank([3, 8, 17, 20, 1, 2, 9, 16, 4, 5, 11, 7]), filters: { ...F } } },
      { label: "1560-like (freeze chip, 4 groups, offer rules)", input: { ...base, cap: 2500, segmentIds: [], contactGroupIds: byRank([9, 16, 17, 8]), filters: { ...F, lifecycle_statuses: ["freeze"] } } },
      { label: "1568-like with the TEXTED rule (not texted 3d)", input: { ...base, segmentIds: [segs["SYN not texted 3d"]], contactGroupIds: byRank([16, 9, 17, 8]), filters: { ...F, lifecycle_statuses: ["hot", "warm"] } } },
    ];
    console.log(`\nMEASURE — ${ROUNDS} rounds each, median, gate: each part ≤ ${GATE_MS} ms (the form runs both parts in parallel)`);
    let failures = 0;
    for (const r of recipes) {
      const tb: number[] = []; const ta: number[] = [];
      let matching = 0;
      for (let k = 0; k < ROUNDS; k++) {
        let s = performance.now();
        await db.transaction((tx) => previewAudienceBase(r.input as never, tx as never), { isolationLevel: "repeatable read" });
        tb.push(performance.now() - s);
        s = performance.now();
        const part = (await db.transaction((tx) => previewAudienceAudiencePart(r.input as never, tx as never), { isolationLevel: "repeatable read" })) as { total_matching?: number };
        matching = part?.total_matching ?? 0;
        ta.push(performance.now() - s);
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const b = med(tb); const a = med(ta);
      // A fast preview of an EMPTY audience proves nothing.
      const ok = b <= GATE_MS && a <= GATE_MS && matching > 0;
      if (!ok) failures++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${r.label}: base ${Math.round(b)} ms · audience ${Math.round(a)} ms · audience ${matching} contacts${matching > 0 ? "" : " (EMPTY — not a valid measurement)"}`);
    }
    console.log(failures === 0 ? `\nSpeed gate PASSED at scale ${SCALE}.` : `\nSpeed gate FAILED: ${failures} recipe(s) over ${GATE_MS} ms.`);
    process.exitCode = failures === 0 ? 0 : 1;
  }

  if (has("teardown")) {
    const org = await orgRow();
    if (org) {
      const t0 = Date.now();
      await ex(sql`delete from stage_sends where org_id = ${org}::uuid`);
      await ex(sql`delete from organizations where id = ${org}::uuid`);
      t("synthetic org deleted (cascade)", t0);
    }
    await ex(sql`drop table if exists _synth_idx`);
    await ex(sql`delete from cron_locks where job_name = 'contact-engagement' and not exists (select 1 from organizations o where o.name <> ${ORG_NAME})`);
    console.log("  teardown done");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
