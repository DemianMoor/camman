import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { evaluateLeadRouting } from "@/lib/drip/routing-eval";
import { runDripRoutingBatch } from "@/lib/drip/routing";

// Production proof for Drip Phase 4 routing.
//
// ⭐ EVERY RULE IS ASSERTED IN BOTH DIRECTIONS. A routing rule tested only on
// its reject path is indistinguishable from a rule that rejects everything, and
// one tested only on its admit path is indistinguishable from no rule at all.
// So each filter gets an ADMIT case, a REJECT case, and — where the rule has the
// third state — a SKIP-IF-MISSING case, which is NOT the same as reject: the fix
// for "missing" is the partner sending the field, the fix for "mismatch" is the
// targeting.
//
// ⭐ POSTURE IS TURNED ON AND RESTORED IN A finally BLOCK. Drip posture also
// gates the SQL shape of the in-use CTE in the LIVE regular-campaign activation
// path, so leaving it on would change plans for real campaigns. The window is
// seconds and the restore is unconditional.
//
// Synthetic only: PHONE_PREFIX numbers, probe campaigns, probe partner keys. Nothing
// real is read or written. Cleaned up BY ID, residue re-checked.

const PHONE_PREFIX = "+1993";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function one<T>(s: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(s)) as unknown as T[])[0];
}

async function main() {
  if (process.env.DRIP_PROD_PROBE !== "yes") {
    console.error(
      "REFUSING to run. This probe writes to PRODUCTION and briefly turns drip posture ON " +
        "(which changes the in-use SQL shape for regular campaign activation). " +
        "Re-run with DRIP_PROD_PROBE=yes if that is what you intend.",
    );
    process.exit(1);
  }

  const sfx = String(Date.now()).slice(-7);

  // ⚠️ The prefix must start EMPTY. A previous phase left 78 contacts under
  // +1995 dating back to July, and a fixture prefix that collides with existing
  // data makes cleanup either dangerous (delete someone else's rows) or
  // impossible to verify (residue that was never mine). Refuse rather than guess.
  const pre = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM contacts WHERE phone_number LIKE ${PHONE_PREFIX + "%"}`);
  if (pre.n !== 0) {
    console.error(`REFUSING: ${pre.n} contacts already use the ${PHONE_PREFIX} fixture prefix.`);
    process.exit(1);
  }

  const orgId = (await one<{ id: string }>(sql`
    SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
  console.log(`org ${orgId}`);

  const priorPosture = await one<{ drip_enabled: boolean }>(sql`
    SELECT drip_enabled FROM org_settings WHERE org_id = ${orgId}::uuid`);
  console.log(`drip posture before: ${priorPosture.drip_enabled}`);

  const created = { campaigns: [] as number[], keys: [] as number[], contacts: [] as string[] };

  try {
    // ── fixtures ─────────────────────────────────────────────────────────
    const keyA = (await one<{ id: number }>(sql`
      INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
      VALUES (${orgId}, ${"zz-p4a-" + sfx}, 'p4 A', ${"tp4a" + sfx}, 'h') RETURNING id`)).id;
    const keyB = (await one<{ id: number }>(sql`
      INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
      VALUES (${orgId}, ${"zz-p4b-" + sfx}, 'p4 B', ${"tp4b" + sfx}, 'h') RETURNING id`)).id;
    created.keys.push(keyA, keyB);

    const mkCampaign = async (
      name: string,
      cfg: {
        tag?: string; priority?: number; partnerKeyId?: number | null;
        startAt?: string | null; endAt?: string | null;
        filters?: Record<string, unknown>; campaignCap?: number | null;
        admissionCap?: number | null; carrier?: string[] | null;
      } = {},
    ) => {
      const id = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, audience_filters)
        VALUES (${orgId}, ${"zz-p4-" + sfx + "-" + name}, ${"P4 " + name}, 'active', 'drip',
                ${cfg.carrier ? JSON.stringify({ carrier_filter: cfg.carrier }) : "{}"}::jsonb)
        RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_campaign_configs
          (campaign_id, org_id, interest_tag, partner_key_id, start_at, end_at,
           priority, filters, campaign_cap, routing_daily_admission_cap)
        VALUES (${id}, ${orgId}, ${cfg.tag ?? "ZZP4"}, ${cfg.partnerKeyId ?? null},
                ${cfg.startAt ?? null}::timestamptz, ${cfg.endAt ?? null}::timestamptz,
                ${cfg.priority ?? 100}, ${JSON.stringify(cfg.filters ?? {})}::jsonb,
                ${cfg.campaignCap ?? null}, ${cfg.admissionCap ?? null})`);
      created.campaigns.push(id);
      return id;
    };

    let phoneSeq = 0;
    const mkLead = async (opts: {
      keyId?: number; tag?: string; attrs?: Record<string, unknown>;
      contactAgeDays?: number; priorEvents?: number; optOut?: boolean; carrier?: string;
    } = {}) => {
      phoneSeq += 1;
      const phone = `${PHONE_PREFIX}${sfx}${String(phoneSeq).padStart(2, "0")}`.slice(0, 15);
      const ageDays = opts.contactAgeDays ?? 30;
      const contactId = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, carrier_norm, created_at)
        VALUES (${orgId}, ${phone}, ${opts.carrier ?? "Verizon"},
                now() - make_interval(days => ${ageDays}))
        RETURNING id`)).id;
      created.contacts.push(contactId);
      if (opts.attrs) {
        const a = opts.attrs;
        await db.execute(sql`
          INSERT INTO contact_attributes (contact_id, org_id, gender, state, country,
                                          income_band, kids, married, dob)
          VALUES (${contactId}, ${orgId}, ${a.gender ?? null}, ${a.state ?? null},
                  ${a.country ?? null}, ${a.income_band ?? null}, ${a.kids ?? null},
                  ${a.married ?? null}, ${(a.dob as string) ?? null}::date)`);
      }
      if (opts.optOut) {
        await db.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
          VALUES (${orgId}, ${contactId}, ${phone}, 'sms_inbound')
          ON CONFLICT DO NOTHING`);
      }
      for (let i = 0; i < (opts.priorEvents ?? 0); i++) {
        await db.execute(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
          VALUES (${orgId}, ${contactId}, ${opts.keyId ?? keyA}, 'zz',
                  now() - make_interval(days => ${2 + i}))`);
      }
      const evId = (await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug,
                                 interest_tag, received_at, line_type)
        VALUES (${orgId}, ${contactId}, ${opts.keyId ?? keyA}, 'zz',
                ${opts.tag ?? "ZZP4"}, now(), 'mobile')
        RETURNING id`)).id;
      return { contactId, evId, phone };
    };

    const verdictFor = async (evId: string) =>
      evaluateLeadRouting(db, { orgId, leadEventId: evId });

    // ── posture ON (restored in finally) ─────────────────────────────────
    await db.execute(sql`
      UPDATE org_settings SET drip_enabled = true, drip_paused = false
      WHERE org_id = ${orgId}::uuid`);
    console.log("drip posture: ON (temporarily)");

    // ── 1. tag match: admit + reject ─────────────────────────────────────
    console.log("\n1. interest tag — admit and reject:");
    const cMain = await mkCampaign("main", { tag: "ZZP4", priority: 100 });
    const good = await mkLead({ tag: "ZZP4" });
    const bad = await mkLead({ tag: "ZZOTHER" });
    check("matching tag ⇒ eligible", (await verdictFor(good.evId))!.winner?.campaign_id, cMain);
    const vBad = (await verdictFor(bad.evId))!;
    check("non-matching tag ⇒ NO winner", vBad.winner, null);
    check("...and the reason names the tag rule",
          vBad.candidates.find((c) => c.campaign_id === cMain)?.rules.interest_tag, "mismatch");

    // ── 2. priority + tie-break ──────────────────────────────────────────
    console.log("\n2. priority resolution and tie-break:");
    const cHi = await mkCampaign("hi", { tag: "ZZP4", priority: 10 });
    const pr = await mkLead({ tag: "ZZP4" });
    check("⭐ lower priority number WINS", (await verdictFor(pr.evId))!.winner?.campaign_id, cHi);

    const cTieA = await mkCampaign("tieA", { tag: "ZZTIE", priority: 5 });
    const cTieB = await mkCampaign("tieB", { tag: "ZZTIE", priority: 5 });
    const tie = await mkLead({ tag: "ZZTIE" });
    const tieWinner = (await verdictFor(tie.evId))!.winner?.campaign_id;
    check("⭐ tie ⇒ NEWEST campaign wins", tieWinner, Math.max(cTieA, cTieB));
    check("...and the newest really is the later id", cTieB > cTieA, true);

    // ── 3. partner filter ────────────────────────────────────────────────
    console.log("\n3. partner filter — admit and reject:");
    const cPartner = await mkCampaign("partner", { tag: "ZZPART", partnerKeyId: keyA });
    const pOk = await mkLead({ tag: "ZZPART", keyId: keyA });
    const pNo = await mkLead({ tag: "ZZPART", keyId: keyB });
    check("matching partner ⇒ routes", (await verdictFor(pOk.evId))!.winner?.campaign_id, cPartner);
    check("other partner ⇒ no winner", (await verdictFor(pNo.evId))!.winner, null);

    // ── 4. hard window ───────────────────────────────────────────────────
    console.log("\n4. start/end window:");
    const cFuture = await mkCampaign("future", {
      tag: "ZZWIN", startAt: new Date(Date.now() + 86400000).toISOString() });
    const cPast = await mkCampaign("past", {
      tag: "ZZWIN2", endAt: new Date(Date.now() - 86400000).toISOString() });
    const wFuture = await mkLead({ tag: "ZZWIN" });
    const wPast = await mkLead({ tag: "ZZWIN2" });
    check("before start_at ⇒ not eligible", (await verdictFor(wFuture.evId))!.winner, null);
    check("after end_at ⇒ not eligible", (await verdictFor(wPast.evId))!.winner, null);
    const cOpen = await mkCampaign("open", { tag: "ZZWIN3" });
    const wOpen = await mkLead({ tag: "ZZWIN3" });
    check("no window set ⇒ eligible (control)",
          (await verdictFor(wOpen.evId))!.winner?.campaign_id, cOpen);

    // ── 5. every demographic filter: admit / reject / skip-if-missing ────
    console.log("\n5. demographic filters — admit, reject, and skip-if-missing:");
    const cases: { f: string; filter: Record<string, unknown>; ok: Record<string, unknown>;
                   no: Record<string, unknown> }[] = [
      { f: "gender", filter: { gender: ["female"] }, ok: { gender: "female" }, no: { gender: "male" } },
      { f: "state", filter: { state: ["TX", "FL"] }, ok: { state: "TX" }, no: { state: "CA" } },
      { f: "country", filter: { country: ["US"] }, ok: { country: "US" }, no: { country: "CA" } },
      { f: "income_band", filter: { income_band: ["50k_75k"] },
        ok: { income_band: "50k_75k" }, no: { income_band: "lt_25k" } },
      { f: "kids", filter: { kids: true }, ok: { kids: true }, no: { kids: false } },
      { f: "married", filter: { married: false }, ok: { married: false }, no: { married: true } },
      { f: "age_band", filter: { age_band: ["35_44"] },
        ok: { dob: "1986-01-01" }, no: { dob: "2000-01-01" } },
    ];
    for (const c of cases) {
      const tag = "ZZF" + c.f.slice(0, 4).toUpperCase();
      const camp = await mkCampaign("f" + c.f, { tag, filters: c.filter });
      const admit = await mkLead({ tag, attrs: c.ok });
      const reject = await mkLead({ tag, attrs: c.no });
      const missing = await mkLead({ tag }); // no attributes row at all
      check(`${c.f}: matching value ⇒ ADMITTED`,
            (await verdictFor(admit.evId))!.winner?.campaign_id, camp);
      const vr = (await verdictFor(reject.evId))!;
      check(`${c.f}: wrong value ⇒ rejected`, vr.winner, null);
      check(`${c.f}: ...reported as 'mismatch'`,
            vr.candidates.find((x) => x.campaign_id === camp)?.rules[`filter_${c.f}`], "mismatch");
      const vm = (await verdictFor(missing.evId))!;
      check(`${c.f}: MISSING value ⇒ skipped`, vm.winner, null);
      check(`⭐ ${c.f}: ...reported as 'missing', NOT 'mismatch'`,
            vm.candidates.find((x) => x.campaign_id === camp)?.rules[`filter_${c.f}`], "missing");
    }

    // ── 6. carrier filter ────────────────────────────────────────────────
    console.log("\n6. carrier filter:");
    const cCar = await mkCampaign("carrier", { tag: "ZZCAR", carrier: ["Verizon"] });
    const carOk = await mkLead({ tag: "ZZCAR", carrier: "Verizon" });
    const carNo = await mkLead({ tag: "ZZCAR", carrier: "AT&T" });
    const carUnk = await mkLead({ tag: "ZZCAR", carrier: "Unidentified" });
    check("matching carrier ⇒ admitted", (await verdictFor(carOk.evId))!.winner?.campaign_id, cCar);
    check("other carrier ⇒ rejected", (await verdictFor(carNo.evId))!.winner, null);
    check("⭐ unidentified carrier ⇒ 'missing', not silently admitted",
          (await verdictFor(carUnk.evId))!.candidates.find((x) => x.campaign_id === cCar)?.rules.carrier,
          "missing");

    // ── 7. opt-out and the week rule ─────────────────────────────────────
    console.log("\n7. opt-out and the >1-week re-entry rule:");
    const cWeek = await mkCampaign("week", { tag: "ZZWEEK" });
    const optedOut = await mkLead({ tag: "ZZWEEK", optOut: true });
    check("opted-out contact ⇒ blocked", (await verdictFor(optedOut.evId))!.winner, null);
    check("...reported globally, not per campaign",
          (await verdictFor(optedOut.evId))!.global.opted_out, "blocked");

    const freshRepeat = await mkLead({ tag: "ZZWEEK", contactAgeDays: 2, priorEvents: 1 });
    const vFresh = (await verdictFor(freshRepeat.evId))!;
    check("⭐ repeat lead, contact only 2 days old ⇒ BLOCKED by the week rule",
          vFresh.global.week_rule, "blocked");
    const oldRepeat = await mkLead({ tag: "ZZWEEK", contactAgeDays: 20, priorEvents: 1 });
    check("⭐ repeat lead, contact 20 days old ⇒ ALLOWED (control)",
          (await verdictFor(oldRepeat.evId))!.winner?.campaign_id, cWeek);
    const firstTime = await mkLead({ tag: "ZZWEEK", contactAgeDays: 1, priorEvents: 0 });
    check("first-ever arrival on a 1-day-old contact ⇒ allowed (not a repeat)",
          (await verdictFor(firstTime.evId))!.global.week_rule, "pass");

    // ── 8. the worker: one campaign only, and caps ───────────────────────
    console.log("\n8. the worker — one journey per contact, and cap admission:");
    const runA = await runDripRoutingBatch();
    console.log(`        routed=${runA.routed} unrouted=${runA.unrouted} lostRace=${runA.lostRace}`);
    check("worker reports posture on", runA.postureOn, true);

    const perContact = await one<{ n: number }>(sql`
      SELECT COALESCE(max(cnt), 0)::int AS n FROM (
        SELECT count(*) AS cnt FROM drip_journeys
        WHERE org_id = ${orgId}::uuid AND state IN ('routed','active')
        GROUP BY contact_id) x`);
    check("⭐ NO contact has more than one LIVE journey", perContact.n <= 1, true);

    const capCamp = await mkCampaign("cap", { tag: "ZZCAP", campaignCap: 1 });
    const cap1 = await mkLead({ tag: "ZZCAP" });
    const cap2 = await mkLead({ tag: "ZZCAP" });
    await runDripRoutingBatch();
    const capCount = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM drip_journeys
      WHERE campaign_id = ${capCamp} AND state <> 'unroutable'`);
    check("⭐ campaign_cap=1 admits exactly ONE journey", capCount.n, 1);
    const capBlocked = (await verdictFor(cap2.evId))!;
    const capRule = capBlocked.candidates.find((c) => c.campaign_id === capCamp)?.rules.campaign_cap;
    check("...and the second lead is blocked BY THE CAP", capRule, "blocked");
    void cap1;

    // ── 9. re-running the worker must not duplicate ──────────────────────
    console.log("\n9. idempotency:");
    const before = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
    await runDripRoutingBatch();
    const after = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
    check("a second worker run creates no new journeys", after.n, before.n);

    // ── 10. reason JSONB is actually useful ──────────────────────────────
    console.log("\n10. the reason recorded on a real journey:");
    const j = await one<{ reason: Record<string, unknown> }>(sql`
      SELECT reason FROM drip_journeys
      WHERE org_id = ${orgId}::uuid AND state = 'routed' LIMIT 1`);
    check("reason records why it won", typeof j?.reason?.won_by, "string");
    check("reason carries the deferred-creative marker", j?.reason?.creative_check, "deferred_p5");
    check("reason lists the skipped candidates", Array.isArray(j?.reason?.skipped), true);
  } finally {
    // ── restore posture FIRST, then clean up ─────────────────────────────
    await db.execute(sql`
      UPDATE org_settings SET drip_enabled = ${priorPosture.drip_enabled}
      WHERE org_id = ${orgId}::uuid`);
    const restored = await one<{ drip_enabled: boolean }>(sql`
      SELECT drip_enabled FROM org_settings WHERE org_id = ${orgId}::uuid`);
    check("⭐ drip posture RESTORED to its prior value", restored.drip_enabled,
          priorPosture.drip_enabled);

    console.log("\ncleanup (by id):");
    if (created.campaigns.length) {
      const list = sql.join(created.campaigns.map((i) => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM drip_journeys WHERE campaign_id IN (${list})`);
      await db.execute(sql`DELETE FROM drip_campaign_configs WHERE campaign_id IN (${list})`);
      await db.execute(sql`DELETE FROM campaigns WHERE id IN (${list})`);
    }
    if (created.contacts.length) {
      // ⚠️ BATCHED, WITH A RAISED TIMEOUT. Deleting a contact cascades to
      // stage_sends (3.47M rows), and none of the three indexes mentioning
      // contact_id is usable for a bare contact_id lookup — they are partial or
      // lead with another column. So each delete pays a scan, and one big
      // statement reliably exceeds the default statement_timeout, leaving
      // residue behind exactly when the run is trying to clean up after itself.
      for (let i = 0; i < created.contacts.length; i += 5) {
        const batch = created.contacts.slice(i, i + 5);
        const cl = sql.join(batch.map((x) => sql`${x}::uuid`), sql`, `);
        await db.execute(sql`SET statement_timeout = '120s'`);
        await db.execute(sql`DELETE FROM drip_journeys WHERE contact_id IN (${cl})`);
        await db.execute(sql`DELETE FROM lead_events WHERE contact_id IN (${cl})`);
        await db.execute(sql`DELETE FROM opt_outs WHERE contact_id IN (${cl})`);
        await db.execute(sql`DELETE FROM contact_attributes WHERE contact_id IN (${cl})`);
        await db.execute(sql`DELETE FROM contacts WHERE id IN (${cl})`);
      }
    }
    if (created.keys.length) {
      const kl = sql.join(created.keys.map((i) => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM lead_events WHERE partner_key_id IN (${kl})`);
      await db.execute(sql`DELETE FROM partner_keys WHERE id IN (${kl})`);
    }

    const residue = await one<Record<string, number>>(sql`
      SELECT (SELECT count(*)::int FROM drip_journeys)         AS journeys,
             (SELECT count(*)::int FROM drip_campaign_configs) AS configs,
             (SELECT count(*)::int FROM campaigns WHERE type='drip') AS drip_campaigns,
             (SELECT count(*)::int FROM lead_events)           AS lead_events,
             (SELECT count(*)::int FROM contacts
               WHERE phone_number LIKE ${PHONE_PREFIX + '%'}) AS synth`);
    console.log(`        production now: ${JSON.stringify(residue)}`);
    check("no probe journeys left", residue.journeys, 0);
    check("no probe configs left", residue.configs, 0);
    check("no probe drip campaigns left", residue.drip_campaigns, 0);
    check("no probe lead events left", residue.lead_events, 0);
    check("no synthetic contacts left", residue.synth, 0);
  }

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
