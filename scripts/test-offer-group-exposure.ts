// Fixture test for migration 0227 (offer_group_exposure_mv — offer exposure per
// lifecycle cohort). PREVIEW DATABASE ONLY — it rewrites contacts,
// contact_offer_campaigns, conversion_events, contact_engagement and campaign
// targeting inside a transaction that is ALWAYS rolled back, so it leaves no
// residue.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-offer-group-exposure.ts
//
// What it proves: the matview's defining SELECT (read from the migration file,
// so the test tracks the shipped SQL) returns, for every (org, offer, group),
// exactly the sixteen numbers an independent per-contact computation in
// TypeScript derives from the raw rows. The fixture spreads contacts over
// hot/warm/cold/freeze/new, gives them 0–3 campaigns of an offer, puts last
// sends exactly ON the 14-day cooldown boundary (eligible — the send path blocks
// only `last_sent_at > now() - 14 days`) and one second inside it (blocked),
// seeds buyers of every status (approved and pending count,
// rejected and non-purchase events do not), and resting vs due Freeze
// contacts. A column whose total is zero is a FAILURE, not a pass.
import "./_env-preload";
import "./_require-preview-db";

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import { checkExposureView } from "../lib/reporting/offer-group-exposure-checks";

const COHORTS = ["hot", "warm", "cold", "freeze"] as const;
const BUCKETS = ["x0", "x1", "x2plus", "eligible"] as const;
const COLS = COHORTS.flatMap((c) => BUCKETS.map((b) => `${c}_${b}`));
type Row = Record<string, number>;
const zero = (): Row => Object.fromEntries(COLS.map((c) => [c, 0]));

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROLLBACK = new Error("rollback");

async function main() {
  // The SHIPPED SQL, read from the migration file — never a retyped copy.
  const src = fs.readFileSync(path.resolve(__dirname, "../db/migrations/0227_offer_group_exposure.sql"), "utf8");
  const body = src
    .split("CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_group_exposure_mv AS")[1]
    .split("--> statement-breakpoint")[0]
    .trim()
    .replace(/;$/, "")
    .replace(/\s*WITH NO DATA$/i, "");
  const lifecycleSrc = fs.readFileSync(path.resolve(__dirname, "../db/migrations/0226_offer_group_lifecycle_v2.sql"), "utf8");
  const lifecycleBody = lifecycleSrc
    .split("CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_group_lifecycle_v2_mv AS")[1]
    .split("--> statement-breakpoint")[0]
    .trim()
    .replace(/;$/, "")
    .replace(/\s*WITH NO DATA$/i, "");

  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await sql.begin(async (tx) => {
      // ── fixture ──────────────────────────────────────────────────────────
      // One org, its tracked campaigns, two offers sharing groups.
      const camps = await tx`
        select c.id, c.org_id, c.offer_id from campaigns c
        where c.offer_id is not null and c.link_mode = 'tracked' order by c.id`;
      if (camps.length < 2) throw new Error("preview needs 2 tracked campaigns with an offer");
      const org = camps[0].org_id as string;
      const offers = [...new Set(camps.filter((c) => c.org_id === org).map((c) => Number(c.offer_id)))];
      if (offers.length < 2) throw new Error("preview needs 2 offers in one org");
      const [offerA, offerB] = offers;
      const groups = (await tx`
        select distinct contact_group_id g from contact_contact_groups where org_id = ${org} order by 1`).map((r) => Number(r.g));
      if (groups.length < 2) throw new Error("preview needs 2 contact groups");
      const campA = camps.find((c) => Number(c.offer_id) === offerA)!.id;
      const campB = camps.find((c) => Number(c.offer_id) === offerB)!.id;

      // Make one campaign per offer tracked-with-sends (the view's universe):
      // offer A targets every group, offer B all but the first, so the groups
      // after the first carry two offers each.
      await tx`update campaign_stages set sent_at = coalesce(sent_at, now()) where campaign_id in (${campA}, ${campB})`;
      const stages = await tx`select campaign_id from campaign_stages where campaign_id in (${campA}, ${campB}) and sent_at is not null`;
      if (new Set(stages.map((s) => s.campaign_id)).size < 2) throw new Error("both fixture campaigns need a stage");
      await tx`update campaigns set audience_contact_group_ids = ${groups}::int[] where id = ${campA}`;
      await tx`update campaigns set audience_contact_group_ids = ${groups.slice(1)}::int[] where id = ${campB}`;

      await tx`
        update contacts set lifecycle_status =
          (array['hot','warm','cold','freeze','new'])[1 + abs(hashtext(id::text)) % 5]
        where org_id = ${org}`;

      // Exposure: 0–3 campaigns of offer A per contact (h % 4), 0–2 of offer B.
      // Last-send age: (h / 4) % 30 days, except h % 7 = 0 → EXACTLY 14 days
      // ago (eligible) and h % 7 = 1 → one second less than 14 days ago
      // (inside the cooldown, blocked).
      const campIds = (await tx`select id from campaigns where org_id = ${org} order by id`).map((r) => Number(r.id));
      if (campIds.length < 3) throw new Error("preview org needs 3 campaigns for 3 exposures");
      await tx`delete from contact_offer_campaigns where org_id = ${org}`;
      await tx`
        insert into contact_offer_campaigns (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
        select ${org}::uuid, x.id, x.offer_id, x.campaign_id, x.ts, x.ts, 1
        from (
          select c.id, o.offer_id, k.campaign_id,
                 case when abs(hashtext(c.id::text)) % 7 = 0 then now() - interval '14 days'
                      when abs(hashtext(c.id::text)) % 7 = 1 then now() - interval '14 days' + interval '1 second'
                      else now() - make_interval(days => (abs(hashtext(c.id::text)) / 4) % 30)
                 end as ts,
                 k.ord,
                 case when o.offer_id = ${offerA}::int then abs(hashtext(c.id::text)) % 4
                      else abs(hashtext(c.id::text || 'b')) % 3 end as n
          from contacts c
          cross join (values (${offerA}::int), (${offerB}::int)) o(offer_id)
          cross join lateral (
            select campaign_id, ord from unnest(${campIds.slice(0, 3)}::int[]) with ordinality u(campaign_id, ord)
          ) k
          where c.org_id = ${org}
        ) x
        where x.ord <= x.n`;

      // Buyers of offer A (through the CAMPAIGN's offer): approved and pending
      // count; rejected, and a non-purchase event type, do not.
      const purchaseType = (await tx`select id from event_types where is_purchase order by id limit 1`)[0].id;
      const otherType = (await tx`select id from event_types where not is_purchase order by id limit 1`)[0].id;
      await tx`delete from conversion_events where org_id = ${org}`;
      await tx`
        insert into conversion_events (org_id, keitaro_event_id, keitaro_status, keitaro_type, occurred_at,
                                       contact_id, campaign_id, event_type_id, status)
        select ${org}::uuid, 'fx-' || c.id, 'sale', 'conversion', now(), c.id, ${campA},
               case when abs(hashtext(c.id::text || 'p')) % 9 = 2 then ${otherType}::int else ${purchaseType}::int end,
               case abs(hashtext(c.id::text || 'p')) % 9 when 0 then 'approved' when 1 then 'rejected'
                                                         when 2 then 'approved' else 'pending' end
        from contacts c
        where c.org_id = ${org} and abs(hashtext(c.id::text || 'p')) % 9 in (0, 1, 2, 3)`;

      // Freeze rest: cadence 7 days, last send 0–13 days ago → about half resting.
      const thresholds = (await tx`select thresholds from contact_engagement limit 1`)[0]?.thresholds ?? {};
      await tx`
        insert into contact_engagement (contact_id, org_id, status, status_changed_at, freeze_cadence_days, thresholds, last_sent_at)
        select c.id, c.org_id, 'freeze', now(), 7, ${tx.json(thresholds)},
               now() - make_interval(days => abs(hashtext(c.id::text || 'f')) % 14)
        from contacts c where c.org_id = ${org} and c.lifecycle_status = 'freeze'
        on conflict (contact_id) do update
          set status = 'freeze', freeze_cadence_days = 7, last_sent_at = excluded.last_sent_at`;

      // ── the shipped SQL ──────────────────────────────────────────────────
      const got = await tx.unsafe(`select * from (${body}) v`);
      const lifecycle = await tx.unsafe(`select * from (${lifecycleBody}) v`);

      // ── independent computation from raw rows ────────────────────────────
      const pairs = await tx`
        select distinct org_id, offer_id, unnest(gids) as group_id from offer_report_tracked_campaigns`;
      const contacts = await tx`
        select c.id, c.org_id, c.lifecycle_status, c.messaging_status,
               exists (select 1 from opt_outs o where o.contact_id = c.id and o.org_id = c.org_id) as opted_out
        from contacts c`;
      const members = await tx`select contact_id, contact_group_id, org_id from contact_contact_groups`;
      // Per exposure ROW. `cooled` is the NEGATION of the send path's own
      // offer_cooldown predicate, copied from lib/sends/eligibility.ts
      // (`last_sent_at > now() - make_interval(days => Y)`) — not the view's
      // `<=` — so a boundary that drifts from the send path turns this red.
      // Same transaction ⇒ same now(). Counting and max-of happen in TS.
      const coc = await tx`
        select contact_id, offer_id, org_id,
               not (last_sent_at > now() - make_interval(days => 14)) as cooled
        from contact_offer_campaigns`;
      const conv = await tx`
        select ce.contact_id, ce.org_id, ce.status, et.is_purchase, ca.offer_id
        from conversion_events ce
        join event_types et on et.id = ce.event_type_id
        join campaigns ca on ca.id = ce.campaign_id
        where ce.contact_id is not null`;
      const eng = await tx`
        select contact_id, org_id, status,
               last_sent_at > now() - make_interval(days => freeze_cadence_days) as within_cadence
        from contact_engagement`;

      const inGroup = new Set(members.map((m) => `${m.org_id}|${m.contact_id}|${m.contact_group_id}`));
      const expo = new Map<string, { n: number; allCooled: boolean }>();
      for (const r of coc) {
        const k = `${r.org_id}|${r.contact_id}|${r.offer_id}`;
        const e = expo.get(k) ?? { n: 0, allCooled: true };
        e.n++;
        e.allCooled &&= r.cooled; // max(last) <= cutoff ⇔ every row <= cutoff
        expo.set(k, e);
      }
      const buyers = new Set(
        conv.filter((r) => r.is_purchase && (r.status === "approved" || r.status === "pending"))
          .map((r) => `${r.org_id}|${r.contact_id}|${r.offer_id}`),
      );
      const resting = new Set(eng.filter((r) => r.status === "freeze" && r.within_cadence).map((r) => `${r.org_id}|${r.contact_id}`));

      const key = (org: string, offer: number, group: number) => `${org}|${offer}|${group}`;
      const want = new Map<string, Row>();
      let boundaryBlocked = 0;
      let boundaryEligible = 0;
      for (const p of pairs) {
        const w = zero();
        for (const c of contacts) {
          const cohort = c.lifecycle_status as string;
          if (!(COHORTS as readonly string[]).includes(cohort)) continue;
          if (c.org_id !== p.org_id || c.messaging_status !== "eligible" || c.opted_out) continue;
          if (!inGroup.has(`${p.org_id}|${c.id}|${p.group_id}`)) continue;
          const e = expo.get(`${p.org_id}|${c.id}|${p.offer_id}`);
          const n = e?.n ?? 0;
          w[`${cohort}_${n === 0 ? "x0" : n === 1 ? "x1" : "x2plus"}`]++;
          const isResting = cohort === "freeze" && resting.has(`${p.org_id}|${c.id}`);
          const isBuyer = buyers.has(`${p.org_id}|${c.id}|${p.offer_id}`);
          if (n <= 1 && (n === 0 || e!.allCooled) && !isBuyer && !isResting) w[`${cohort}_eligible`]++;
        }
        want.set(key(p.org_id, Number(p.offer_id), Number(p.group_id)), w);
      }
      // The boundary rows, counted for the exercise check: 1x, not a buyer, not resting.
      const boundary = await tx`
        select coc.last_sent_at = now() - interval '14 days' as exact
        from contact_offer_campaigns coc
        where coc.last_sent_at in (now() - interval '14 days', now() - interval '14 days' + interval '1 second')
          and (select count(*) from contact_offer_campaigns c2
               where c2.contact_id = coc.contact_id and c2.offer_id = coc.offer_id) = 1`;
      for (const b of boundary) {
        if (b.exact) boundaryEligible++;
        else boundaryBlocked++;
      }

      // ── compare ──────────────────────────────────────────────────────────
      console.log(`scope: ${pairs.length} (offer, group) pair(s), ${contacts.length} contacts, ` +
        `${coc.length} exposure rows, ${buyers.size} buyer pairs, ${resting.size} resting, ${got.length} rows returned`);
      check("at least two offers and two (offer, group) rows in scope", pairs.length >= 2 && new Set(pairs.map((p) => p.offer_id)).size >= 2);
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
      check("⭐ every cell equals the independent computation", mismatches.length === 0, mismatches.slice(0, 10).join("; "));
      for (const c of COLS) check(`fixture exercises ${c} (total ${totals[c]})`, totals[c] > 0);
      check("fixture has 1x rows exactly ON the 14-day boundary (eligible, as on the send path)", boundaryEligible > 0, `${boundaryEligible}`);
      check("fixture has 1x rows one second inside the cooldown (blocked)", boundaryBlocked > 0, `${boundaryBlocked}`);
      check("fixture has resting AND due Freeze contacts",
        resting.size > 0 && eng.some((r) => r.status === "freeze" && !r.within_cadence));
      check("fixture has buyers and non-counting conversions (rejected / non-purchase)",
        buyers.size > 0 && conv.some((r) => !(r.is_purchase && r.status !== "rejected")));

      // The verify bar over the same snapshot: E1–E4 must all hold.
      const r = checkExposureView(got, lifecycle);
      check("E1 same keys as the lifecycle v2 SELECT", r.lost.length === 0 && r.added.length === 0,
        `lost ${r.lost.length}, added ${r.added.length}`);
      check("E2 zero NULL / negative cells", r.nullCells === 0 && r.negativeCells === 0);
      check("E3 eligible <= 0x + 1x everywhere", r.eligibleOver.length === 0, r.eligibleOver.slice(0, 5).join("; "));
      check("E4 0x+1x+2x+ identical across the offers of each group", r.partitionMismatches.length === 0,
        r.partitionMismatches.slice(0, 5).join("; "));
      check("E4 is exercised: some group carries two offers",
        new Set(pairs.map((p) => p.group_id)).size < pairs.length);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // Residue check: the fixture must be gone.
  const [after] = await sql`
    select (select count(*) from contacts where lifecycle_status <> 'new')::int as non_new,
           (select count(*) from conversion_events where keitaro_event_id like 'fx-%')::int as fx_conv`;
  console.log(`after rollback: ${after.non_new} contact(s) not 'new', ${after.fx_conv} fixture conversion(s) (preview baseline 0 / 0)`);
  check("no residue after rollback", after.non_new === 0 && after.fx_conv === 0);
  await sql.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
