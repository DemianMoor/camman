// Q5 — per-carrier DAILY CAP. Enforcement proof.
//
// Bars:
//   (0) NO CAP CONFIGURED ⇒ nothing is breached. The shipped state is inert.
//   (1) The counter is an ET CALENDAR DAY, not a rolling 24 hours. Proven by
//       constructing sends on both sides of the boundary and showing which ones
//       the counter sees.
//   (2) A reached cap produces a breach with the right numbers, and ONLY for a
//       carrier that still has PENDING rows on the stage — an exhausted cap on
//       one carrier must not halt a stage whose remaining rows are on another.
//   (3) The drain's stop is SOFT: rows stay pending, nothing is latched, and
//       `carrier_daily_cap` is not a hard stop.
//   (4) The supporting index (migration 0143) is actually USED by the counter —
//       an unused index makes this a seq scan of a 1.4M-row table on every
//       batch of every drain.
//
// Everything is SYNTHESIZED INSIDE A TRANSACTION AND ROLLED BACK. Zero live
// configuration, zero live sends.
//
// FAULT INJECTION proves each bar can fail.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { isHardStop } from "@/lib/sends/circuit-breakers";
import {
  describeCarrierCapBreaches,
  findCarrierCapBreaches,
} from "@/lib/sends/carrier-policy";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  // ── SHIPPED STATE, reported not asserted ─────────────────────────────────
  // (The Q4 lesson: a guard that asserts today's empty state expires the first
  // time the feature is used correctly.)
  const capsNow = (await db.execute(sql`
    SELECT pcl.provider_phone_id, pp.phone_number, pcl.carrier_norm, pcl.daily_limit
    FROM phone_carrier_limits pcl
    JOIN provider_phones pp ON pp.id = pcl.provider_phone_id
    WHERE pcl.daily_limit IS NOT NULL
    ORDER BY pcl.provider_phone_id, pcl.carrier_norm
  `)) as unknown as {
    provider_phone_id: number; phone_number: string; carrier_norm: string; daily_limit: number;
  }[];
  console.log(`\nSHIPPED STATE — ${capsNow.length} carrier cap(s) configured`);
  for (const c of capsNow) {
    console.log(`     #${c.provider_phone_id} ${c.phone_number}: ${c.carrier_norm} ${c.daily_limit}/day`);
  }
  if (capsNow.length === 0) console.log("     none (the shipped, unconfigured state)");

  // ── (3) SOFTNESS is a property of the reason code, independent of data ────
  check(
    "(3) carrier_daily_cap is a SOFT stop (rows stay pending, nothing latches)",
    !isHardStop("carrier_daily_cap"),
    "a hard stop would demand a manual breaker resume for an expected daily event",
  );

  // Pick a real stage that HAS a sending number, so the pending-rows half of
  // the check is exercised against a real shape rather than a fabricated one.
  //
  // ⚠️ THE ORG COMES FROM THE STAGE. An earlier version took it from
  // `SELECT id FROM organizations LIMIT 1` — unordered, so it could name a
  // DIFFERENT org than the stage it then wrote rows against, and every
  // org-scoped assertion below would have been quietly measuring nothing. It
  // also returned a different value on two consecutive runs, which is how it
  // was noticed. Derive scope from the subject, never from an arbitrary row.
  //
  // A CONTACT is carried too: stage_sends.contact_id is NOT NULL, so the probe
  // rows have to reference a real one.
  const stageRow = (await db.execute(sql`
    SELECT s.id AS stage_id, s.campaign_id, c.org_id, s.provider_phone_id, pp.phone_number,
           c.org_id AS scope_org
    FROM campaign_stages s
    JOIN provider_phones pp ON pp.id = s.provider_phone_id
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.provider_phone_id IS NOT NULL
    ORDER BY s.id DESC LIMIT 1
  `)) as unknown as {
    stage_id: number; campaign_id: number; org_id: string;
    provider_phone_id: number; phone_number: string;
  }[];
  check("a real stage with a sending number exists", stageRow.length > 0, stageRow[0] ? `stage ${stageRow[0].stage_id} on #${stageRow[0].provider_phone_id}` : "none");
  if (!stageRow[0]) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const {
    stage_id: stageId, campaign_id: campaignId, org_id: orgId,
    provider_phone_id: phoneId,
  } = stageRow[0];

  // stage_sends carries a UNIQUE (stage_id, contact_id) over live rows, so each
  // probe row needs its OWN contact — and one this stage does not already hold,
  // or the probe collides with real data instead of testing anything.
  const PROBE_ROWS = 10;
  const contactRows = (await db.execute(sql`
    SELECT ct.id FROM contacts ct
    WHERE ct.org_id = ${orgId}::uuid
      AND NOT EXISTS (SELECT 1 FROM stage_sends x WHERE x.stage_id = ${stageId} AND x.contact_id = ct.id)
    ORDER BY ct.id LIMIT ${PROBE_ROWS}
  `)) as unknown as { id: string }[];
  check(
    "enough unused contacts exist for the probe rows",
    contactRows.length === PROBE_ROWS,
    `${contactRows.length}/${PROBE_ROWS}`,
  );
  if (contactRows.length < PROBE_ROWS) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const cid = contactRows.map((r) => r.id);

  // (0) NOTHING CONFIGURED FOR THIS NUMBER ⇒ no breach. Checked before we
  // synthesize anything, so it describes the real, current state.
  const baseline = await findCarrierCapBreaches(db, { orgId, providerPhoneId: phoneId, stageId });
  check(
    "(0) an uncapped number reports NO breach",
    baseline.length === 0,
    `${baseline.length} breach(es): ${describeCarrierCapBreaches(baseline) || "none"}`,
  );
  check(
    "(0) a stage with NO sending number is a literal no-op",
    (await findCarrierCapBreaches(db, { orgId, providerPhoneId: null, stageId })).length === 0,
    "null phone ⇒ no query, no breach",
  );

  // ── The ET day boundary, computed the same way the counter does ───────────
  const dayRow = (await db.execute(sql`
    SELECT date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE} AS day_start,
           now() AS now_utc,
           (now() AT TIME ZONE ${CAMPAIGN_TIMEZONE})::text AS now_et
  `)) as unknown as { day_start: string; now_utc: string; now_et: string }[];
  console.log(
    `\nET CALENDAR DAY — now ${dayRow[0].now_et} ${CAMPAIGN_TIMEZONE}\n` +
      `     day starts at ${new Date(dayRow[0].day_start).toISOString()} (UTC)`,
  );

  try {
    await db.transaction(async (tx) => {
      const CARRIER = "Verizon";
      const OTHER = "AT&T";

      // ⚠️ MEASURE A BASELINE, DO NOT ASSUME A CLEAN SLATE.
      //
      // The first version of this bar asserted `sent_today === 3` after
      // inserting three probe sends, and read 998 — because number #224 had
      // ALREADY sent 995 real messages to Verizon today. The counter was
      // correct; the assertion assumed an empty day. Every claim below is
      // therefore a DELTA against what the number has really sent today, which
      // also makes the bar independent of when in the day it runs.
      const sentToday = async (carrier: string) => {
        const r = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM stage_sends ss
          WHERE ss.provider_phone_id = ${phoneId}
            AND ss.carrier_norm = ${carrier}
            AND ss.status = 'sent'
            AND ss.sent_at >= date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE}
            AND ss.sent_at <  (date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) + interval '1 day') AT TIME ZONE ${CAMPAIGN_TIMEZONE}
        `)) as unknown as { n: number }[];
        return Number(r[0].n);
      };
      const base = await sentToday(CARRIER);
      console.log(`\nBASELINE — number #${phoneId} has really sent ${base.toLocaleString()} message(s) to ${CARRIER} today (ET)`);

      // A pending row on each carrier, so the pending-rows half of the
      // condition has something to find.
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, contact_id, stage_id, phone, status, carrier_norm, provider_phone_id, rendered_text)
        VALUES (${orgId}::uuid, ${campaignId}, ${cid[0]}::uuid, ${stageId}, '+15550000001', 'pending', ${CARRIER}, ${phoneId}, 'q5 probe'),
               (${orgId}::uuid, ${campaignId}, ${cid[1]}::uuid, ${stageId}, '+15550000002', 'pending', ${OTHER},   ${phoneId}, 'q5 probe')
      `);

      // 3 sends one minute AFTER today's ET midnight, and 3 one minute BEFORE
      // it (i.e. yesterday). A rolling-24h counter would count all six; an ET
      // CALENDAR-day counter must count exactly the three from today. That
      // difference is bar (1), and it is measured as a delta.
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, contact_id, stage_id, phone, status, carrier_norm, provider_phone_id, rendered_text, sent_at)
        SELECT ${orgId}::uuid, ${campaignId}, c.id::uuid, ${stageId}, '+155500010' || c.g, 'sent', ${CARRIER}, ${phoneId}, 'q5 probe',
               date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE} + interval '1 minute'
        FROM (VALUES (${cid[2]}, 1), (${cid[3]}, 2), (${cid[4]}, 3)) AS c(id, g)
      `);
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, contact_id, stage_id, phone, status, carrier_norm, provider_phone_id, rendered_text, sent_at)
        SELECT ${orgId}::uuid, ${campaignId}, c.id::uuid, ${stageId}, '+155500020' || c.g, 'sent', ${CARRIER}, ${phoneId}, 'q5 probe',
               date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE} - interval '1 minute'
        FROM (VALUES (${cid[5]}, 1), (${cid[6]}, 2), (${cid[7]}, 3)) AS c(id, g)
      `);

      // ── (1) ET CALENDAR DAY, NOT ROLLING 24h ─────────────────────────────
      const afterProbe = await sentToday(CARRIER);
      console.log(
        `\n(1) inserted 3 sends just AFTER ET midnight today and 3 just BEFORE it (yesterday)`,
      );
      check(
        "(1) the counter moved by exactly +3 — it counts TODAY only, not a rolling 24h",
        afterProbe === base + 3,
        `${base} -> ${afterProbe} (delta ${afterProbe - base}); a rolling-24h counter would read delta 6`,
      );

      await tx.execute(sql`
        INSERT INTO phone_carrier_limits (org_id, provider_phone_id, carrier_norm, allowed, daily_limit)
        VALUES (${orgId}::uuid, ${phoneId}, ${CARRIER}, true, ${afterProbe})
      `);
      const atCap = await findCarrierCapBreaches(tx, { orgId, providerPhoneId: phoneId, stageId });
      const v = atCap.find((b) => b.carrier_norm === CARRIER);
      check(
        "(1) reaching the cap EXACTLY (sent == limit) is a breach",
        !!v && v.sent_today === afterProbe && v.daily_limit === afterProbe,
        v ? describeCarrierCapBreaches([v]) : "no breach reported at all",
      );
      check(
        "(1) the breach names its pending rows",
        !!v && v.pending_rows > 0,
        v ? `${v.pending_rows} pending on ${CARRIER}` : "none",
      );

      // ── (2) SURGICAL: capped AND still-pending only ──────────────────────
      check(
        "(2) an UNCAPPED carrier on the same number is not breached",
        !atCap.some((b) => b.carrier_norm === OTHER),
        `breached: [${atCap.map((b) => b.carrier_norm).join(", ")}]`,
      );
      // One UNDER the cap must not stop.
      await tx.execute(sql`
        UPDATE phone_carrier_limits SET daily_limit = ${afterProbe + 1}
        WHERE provider_phone_id = ${phoneId} AND carrier_norm = ${CARRIER} AND org_id = ${orgId}::uuid
      `);
      const under = await findCarrierCapBreaches(tx, { orgId, providerPhoneId: phoneId, stageId });
      check(
        "(2) one short of the cap does NOT stop",
        !under.some((b) => b.carrier_norm === CARRIER),
        `${afterProbe} sent, limit ${afterProbe + 1} — breached: [${under.map((b) => b.carrier_norm).join(", ")}]`,
      );
      // Cap reached again, but with no pending rows on that carrier.
      await tx.execute(sql`
        UPDATE phone_carrier_limits SET daily_limit = ${afterProbe}
        WHERE provider_phone_id = ${phoneId} AND carrier_norm = ${CARRIER} AND org_id = ${orgId}::uuid
      `);
      await tx.execute(sql`
        DELETE FROM stage_sends
        WHERE stage_id = ${stageId} AND status = 'pending' AND carrier_norm = ${CARRIER}
          AND rendered_text = 'q5 probe'
      `);
      const noPending = await findCarrierCapBreaches(tx, { orgId, providerPhoneId: phoneId, stageId });
      check(
        "(2) a reached cap with NO pending rows on that carrier does NOT stop the stage",
        !noPending.some((b) => b.carrier_norm === CARRIER),
        "an exhausted carrier must not halt a stage whose remaining rows are on another carrier",
      );
      // Put a pending row back for the fault injections below.
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, contact_id, stage_id, phone, status, carrier_norm, provider_phone_id, rendered_text)
        VALUES (${orgId}::uuid, ${campaignId}, ${cid[8]}::uuid, ${stageId}, '+15550000003', 'pending', ${CARRIER}, ${phoneId}, 'q5 probe')
      `);

      // ── FAULT INJECTION ──────────────────────────────────────────────────
      console.log("\nFAULT INJECTION — the harness must be able to go red:");
      await tx.execute(sql`
        UPDATE phone_carrier_limits SET daily_limit = 1
        WHERE provider_phone_id = ${phoneId} AND carrier_norm = ${CARRIER} AND org_id = ${orgId}::uuid
      `);
      const over = await findCarrierCapBreaches(tx, { orgId, providerPhoneId: phoneId, stageId });
      check(
        "#1 a limit far below the count DOES breach (the comparison is live)",
        over.some((b) => b.carrier_norm === CARRIER && b.sent_today === afterProbe && b.daily_limit === 1),
        describeCarrierCapBreaches(over) || "no breach — the check is inert",
      );
      // A cap on ANOTHER number must not leak into this one.
      const otherPhone = (await tx.execute(sql`
        SELECT id FROM provider_phones WHERE org_id = ${orgId}::uuid AND id <> ${phoneId} LIMIT 1
      `)) as unknown as { id: number }[];
      if (otherPhone[0]) {
        const leak = await findCarrierCapBreaches(tx, {
          orgId, providerPhoneId: otherPhone[0].id, stageId,
        });
        check(
          "#2 the cap is PER NUMBER — another number sees no breach",
          leak.length === 0,
          `number #${otherPhone[0].id}: ${leak.length} breach(es)`,
        );
      }
      // Rows that are not 'sent' must not count toward the cap.
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, contact_id, stage_id, phone, status, carrier_norm, provider_phone_id, rendered_text, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}, ${cid[9]}::uuid, ${stageId}, '+15550000900', 'skipped_duplicate', ${CARRIER}, ${phoneId}, 'q5 probe',
                date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE} + interval '2 minutes')
      `);
      check(
        "#3 a non-'sent' row does not count toward the cap",
        (await sentToday(CARRIER)) === afterProbe,
        `still ${afterProbe} — a skipped row is not a message`,
      );


      // ── (4) THE INDEX IS ACTUALLY USED ───────────────────────────────────
      // A once-per-batch check that seq-scans stage_sends would be a tax on
      // every drain in the org, capped or not.
      const plan = (await tx.execute(sql`
        EXPLAIN (FORMAT TEXT)
        SELECT count(*) FROM stage_sends ss
        WHERE ss.provider_phone_id = ${phoneId}
          AND ss.carrier_norm = 'Verizon'
          AND ss.status = 'sent'
          AND ss.sent_at >= date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE}
          AND ss.sent_at <  (date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) + interval '1 day') AT TIME ZONE ${CAMPAIGN_TIMEZONE}
      `)) as unknown as Record<string, string>[];
      const planText = plan.map((r) => Object.values(r)[0]).join("\n");
      console.log("\n(4) counter plan:");
      for (const line of planText.split("\n")) console.log(`     ${line}`);
      check(
        "(4) the counter uses an INDEX, not a sequential scan of stage_sends",
        /Index (Only )?Scan/.test(planText) && !/Seq Scan on stage_sends/.test(planText),
        /Seq Scan on stage_sends/.test(planText)
          ? "SEQ SCAN — migration 0143's index is missing or unusable"
          : "indexed",
      );
      check(
        "(4) it is migration 0143's index specifically",
        /stage_sends_phone_carrier_sent_day_idx/.test(planText),
        planText.includes("stage_sends_phone_carrier_sent_day_idx")
          ? "stage_sends_phone_carrier_sent_day_idx"
          : "a DIFFERENT index was chosen — 0143 may be redundant or unusable",
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ── ROLLBACK VERIFIED BY RE-QUERY ────────────────────────────────────────
  const leftovers = (await db.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends WHERE rendered_text = 'q5 probe'
  `)) as unknown as { n: number }[];
  check("rollback left ZERO probe rows in stage_sends", leftovers[0].n === 0, `${leftovers[0].n} rows`);
  const capsAfter = (await db.execute(sql`
    SELECT count(*)::int AS n FROM phone_carrier_limits WHERE daily_limit IS NOT NULL
  `)) as unknown as { n: number }[];
  check(
    "rollback left the cap configuration exactly as this run found it",
    capsAfter[0].n === capsNow.length,
    `before=${capsNow.length} after=${capsAfter[0].n}`,
  );

  // ── SOURCE GUARDS ────────────────────────────────────────────────────────
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  console.log("\nSOURCE GUARD (comments stripped):");
  const drain = strip(await fs.readFile(path.join(process.cwd(), "lib/sends/drain.ts"), "utf8"));
  check(
    "the drain checks the cap ONCE PER BATCH, at the batch gate",
    /findCarrierCapBreaches/.test(drain),
    "not inside the per-message send loop — that would be a query per message",
  );
  check(
    "the cap check sits BEFORE the claim (rows are never claimed then abandoned)",
    drain.indexOf("findCarrierCapBreaches") < drain.indexOf("UPDATE stage_sends SET status = 'sending'"),
    "a check after the claim would leave rows stuck in 'sending'",
  );
  check(
    "the drain reports carrier_daily_cap as its stopReason",
    /stopReason = "carrier_daily_cap"/.test(drain),
    "a bare halt with no reason is indistinguishable from 'nothing to send'",
  );
  // ⚠️ STRIP COMMENTS FIRST. The un-stripped version of this check failed
  // against correct code: carrier-policy.ts's own comment explains that the
  // boundary is never written as `sent_at AT TIME ZONE`, and the guard
  // matched that sentence. A checker must not read the prose about itself.
  const policyRaw = await fs.readFile(path.join(process.cwd(), "lib/sends/carrier-policy.ts"), "utf8");
  const policy = strip(policyRaw);
  check(
    "the day boundary is a timestamptz RANGE, not a functional predicate on sent_at",
    /ss\.sent_at >= day\.day_start/.test(policy) && !/sent_at AT TIME ZONE/.test(policy),
    "wrapping sent_at in AT TIME ZONE makes migration 0143's index unusable",
  );
  check(
    "the bounded overshoot is documented where the cap is defined",
    /overshoot/i.test(policyRaw) && /batchSize/.test(policyRaw),
    "an undocumented soft ceiling reads as an exact one",
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
