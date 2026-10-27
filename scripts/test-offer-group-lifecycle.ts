// Fixture test for migration 0226 (offer_group_lifecycle_v2_mv — Hot and Warm
// SEPARATE; 0214/0215's offer_group_lifecycle_mv merged them). PREVIEW DATABASE
// ONLY — it rewrites contacts.lifecycle_status and stage_sends.sent_at inside a
// transaction that is ALWAYS rolled back, so it leaves no residue.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-offer-group-lifecycle.ts
//
// What it proves: the matview's defining SELECT (read from the migration file,
// so the test tracks the shipped SQL) returns, for every (org, offer, group),
// exactly the twelve numbers an independent per-row computation in TypeScript
// derives from the raw tables. The fixture spreads statuses over
// hot/warm/cold/freeze/new and send dates over 0–119 days so every cohort, both
// windows, the >30d exclusion and the `new` exclusion are all exercised; a
// column whose total is zero is a FAILURE, not a pass.
//
// PART O runs 0215's OLD defining SELECT over the same fixture, in the same
// transaction, and asserts what the production fill must show: the same rows,
// Cold and Freeze identical, and Hot + Warm = the old Hot/Warm on every cell.
import "./_env-preload";
import "./_require-preview-db";

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const COLS = [
  "hot_sent_14d", "hot_sent_30d", "hot_fresh_pool",
  "warm_sent_14d", "warm_sent_30d", "warm_fresh_pool",
  "cold_sent_14d", "cold_sent_30d", "cold_fresh_pool",
  "freeze_sent_14d", "freeze_sent_30d", "freeze_fresh_pool",
] as const;
type Row = Record<(typeof COLS)[number], number>;
const zero = (): Row => Object.fromEntries(COLS.map((c) => [c, 0])) as Row;
const cohortOf = (s: string) =>
  s === "hot" || s === "warm" || s === "cold" || s === "freeze" ? s : null;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROLLBACK = new Error("rollback");

async function main() {
  // The SHIPPED SQL, read from the migration files — never a retyped copy.
  const src = fs.readFileSync(
    path.resolve(__dirname, "../db/migrations/0226_offer_group_lifecycle_v2.sql"),
    "utf8",
  );
  const body = src
    .split("CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_group_lifecycle_v2_mv AS")[1]
    .split("--> statement-breakpoint")[0]
    .trim()
    .replace(/;$/, "")
    .replace(/\s*WITH NO DATA$/i, "");
  const oldSrc = fs.readFileSync(
    path.resolve(__dirname, "../db/migrations/0215_lifecycle_cohort_sent_30d.sql"),
    "utf8",
  );
  const oldBody = oldSrc
    .split("CREATE MATERIALIZED VIEW public.offer_group_lifecycle_mv AS")[1]
    .split("--> statement-breakpoint")[0]
    .trim()
    .replace(/;$/, "");

  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await sql.begin(async (tx) => {
      // ── fixture ──────────────────────────────────────────────────────────
      await tx`
        update contacts set lifecycle_status =
          (array['hot','warm','cold','freeze','new'])[1 + abs(hashtext(id::text)) % 5]`;
      await tx`
        update stage_sends set sent_at = now() - make_interval(days => abs(hashtext(id::text)) % 120)
        where status = 'sent'`;
      // Target each tracked campaign at every group its recipients belong to
      // EXCEPT the highest-numbered one, so the "recipient in a group the
      // campaign did not target" exclusion is exercised too.
      await tx`
        update campaigns c set audience_contact_group_ids = coalesce((
          select array_agg(g order by g) from (
            select distinct ccg.contact_group_id as g
            from stage_sends ss
            join campaign_stages cs on cs.id = ss.stage_id
            join contact_contact_groups ccg on ccg.contact_id = ss.contact_id
            where cs.campaign_id = c.id
          ) x
          where g < (select max(ccg2.contact_group_id) from stage_sends ss2
                     join campaign_stages cs2 on cs2.id = ss2.stage_id
                     join contact_contact_groups ccg2 on ccg2.contact_id = ss2.contact_id
                     where cs2.campaign_id = c.id)
        ), '{}')
        where c.id in (select id from offer_report_tracked_campaigns)`;

      // ── the shipped SQL ──────────────────────────────────────────────────
      const got = await tx.unsafe(`select * from (${body}) v`);
      const old = await tx.unsafe(`select * from (${oldBody}) v`);

      // ── independent computation from raw rows ────────────────────────────
      const camps = await tx`select id, org_id, offer_id, gids from offer_report_tracked_campaigns`;
      const sends = await tx`
        select ss.contact_id, cs.campaign_id,
               ss.sent_at >= now() - interval '14 days' as in14,
               ss.sent_at >= now() - interval '30 days' as in30
        from stage_sends ss join campaign_stages cs on cs.id = ss.stage_id
        where ss.status = 'sent'`;
      const members = await tx`select contact_id, contact_group_id, org_id from contact_contact_groups`;
      const contacts = await tx`
        select c.id, c.org_id, c.lifecycle_status, c.messaging_status,
               exists (select 1 from opt_outs o where o.contact_id = c.id and o.org_id = c.org_id) as opted_out
        from contacts c`;
      const exposures = await tx`select contact_id, offer_id from offer_exposures`;

      const contactById = new Map(contacts.map((c) => [c.id as string, c]));
      const groupsOf = new Map<string, { group: number; org: string }[]>();
      for (const m of members) {
        const list = groupsOf.get(m.contact_id) ?? [];
        list.push({ group: Number(m.contact_group_id), org: m.org_id });
        groupsOf.set(m.contact_id, list);
      }
      const exposed = new Set(exposures.map((e) => `${e.contact_id}|${e.offer_id}`));
      const campById = new Map(camps.map((c) => [Number(c.id), c]));

      const want = new Map<string, Row>();
      const key = (org: string, offer: number, group: number) => `${org}|${offer}|${group}`;
      for (const c of camps)
        for (const g of c.gids as number[]) want.set(key(c.org_id, Number(c.offer_id), g), want.get(key(c.org_id, Number(c.offer_id), g)) ?? zero());

      for (const s of sends) {
        const camp = campById.get(Number(s.campaign_id));
        const ct = contactById.get(s.contact_id);
        if (!camp || !ct || !s.in30 || ct.org_id !== camp.org_id) continue;
        const cohort = cohortOf(ct.lifecycle_status);
        if (!cohort) continue;
        for (const m of groupsOf.get(s.contact_id) ?? []) {
          if (m.org !== camp.org_id || !(camp.gids as number[]).includes(m.group)) continue;
          const r = want.get(key(camp.org_id, Number(camp.offer_id), m.group))!;
          r[`${cohort}_sent_30d` as keyof Row]++;
          if (s.in14) r[`${cohort}_sent_14d` as keyof Row]++;
        }
      }
      for (const [k, r] of want) {
        const [org, offer, group] = k.split("|");
        for (const ct of contacts) {
          const cohort = cohortOf(ct.lifecycle_status);
          if (!cohort || ct.org_id !== org || ct.messaging_status !== "eligible" || ct.opted_out) continue;
          if (!(groupsOf.get(ct.id) ?? []).some((m) => m.group === Number(group) && m.org === org)) continue;
          if (exposed.has(`${ct.id}|${offer}`)) continue;
          r[`${cohort}_fresh_pool` as keyof Row]++;
        }
      }

      // ── compare ──────────────────────────────────────────────────────────
      console.log(`scope: ${camps.length} tracked campaign(s), ${sends.length} sent rows, ` +
        `${contacts.length} contacts, ${want.size} expected (offer, group) row(s), ${got.length} returned`);
      check("at least one (offer, group) row in scope", want.size > 0);
      check("row count matches", got.length === want.size, `got ${got.length}, want ${want.size}`);

      const mismatches: string[] = [];
      const totals = zero();
      for (const g of got) {
        const w = want.get(key(g.org_id, Number(g.offer_id), Number(g.group_id)));
        if (!w) { mismatches.push(`unexpected row ${g.offer_id}/${g.group_id}`); continue; }
        for (const c of COLS) {
          totals[c] += Number(g[c]);
          if (Number(g[c]) !== w[c]) mismatches.push(`${g.offer_id}/${g.group_id} ${c}: got ${g[c]} want ${w[c]}`);
        }
      }
      check("every cell equals the independent computation", mismatches.length === 0, mismatches.slice(0, 10).join("; "));
      for (const c of COLS) check(`fixture exercises ${c} (total ${totals[c]})`, totals[c] > 0);
      for (const cohort of ["hot", "warm", "cold", "freeze"])
        check(`${cohort}: 14d ≤ 30d on every row`,
          got.every((g) => Number(g[`${cohort}_sent_14d`]) <= Number(g[`${cohort}_sent_30d`])));

      // ── PART O: the new view vs 0215's merged one, same snapshot ─────────
      const oldBy = new Map(old.map((o) => [key(o.org_id, Number(o.offer_id), Number(o.group_id)), o]));
      check("O1 ⭐ same (offer, group) rows as the old view (0 lost, 0 added)",
        got.length === old.length && got.every((g) => oldBy.has(key(g.org_id, Number(g.offer_id), Number(g.group_id)))),
        `new ${got.length}, old ${old.length}`);
      const nulls = got.filter((g) => COLS.some((c) => g[c] === null || g[c] === undefined)).length;
      check("O2 zero NULL cells", nulls === 0, `${nulls} row(s) with a NULL`);
      const cfDiff: string[] = [];
      const hwDiff: string[] = [];
      for (const g of got) {
        const o = oldBy.get(key(g.org_id, Number(g.offer_id), Number(g.group_id)));
        if (!o) continue;
        for (const c of ["cold_sent_14d", "cold_sent_30d", "cold_fresh_pool", "freeze_sent_14d", "freeze_sent_30d", "freeze_fresh_pool"])
          if (Number(g[c]) !== Number(o[c])) cfDiff.push(`${g.offer_id}/${g.group_id} ${c} ${g[c]}≠${o[c]}`);
        for (const w of ["sent_14d", "sent_30d", "fresh_pool"])
          if (Number(g[`hot_${w}`]) + Number(g[`warm_${w}`]) !== Number(o[`hw_${w}`]))
            hwDiff.push(`${g.offer_id}/${g.group_id} ${w}: ${g[`hot_${w}`]}+${g[`warm_${w}`]}≠${o[`hw_${w}`]}`);
      }
      check("O3 ⭐ Cold and Freeze identical to the old view on every cell", cfDiff.length === 0, cfDiff.slice(0, 5).join("; "));
      check("O4 ⭐ Hot + Warm = the old Hot/Warm on every cell", hwDiff.length === 0, hwDiff.slice(0, 5).join("; "));
      check("O5 the fixture really splits a cohort (some cell has BOTH hot and warm sends)",
        got.some((g) => Number(g.hot_sent_30d) > 0 && Number(g.warm_sent_30d) > 0));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // Residue check: the fixture must be gone.
  const [after] = await sql`
    select count(*) filter (where lifecycle_status <> 'new')::int as non_new from contacts`;
  console.log(`after rollback: ${after.non_new} contact(s) not 'new' (preview baseline is 0)`);
  await sql.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
