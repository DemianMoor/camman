import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE SEND-TIME RE-CHECK (PR 4c Task 1) against the PREVIEW DB.
//
// This is the last gate before a real message goes out, so the bars are about
// two things in equal measure: that it drops the right people, and that it
// CANNOT stop a send when something goes wrong with it.
//
// ⭐ Why this exists at all, and why it is not a copy of the Prepare-time
// layers: `contact_engagement.last_sent_at` is written by a cron and is up to
// 15 minutes stale, so it cannot see a message ANOTHER campaign sent to the
// same freeze contact ten minutes ago. The send-time freeze check therefore
// reads `stage_sends` directly. J2/J3/J4 are built to fail if someone "tidies"
// it back into reading contact_engagement.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-send-recheck.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const NOW = Date.now();
const MARKER = "__LIFECYCLE_RECHECK_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { recheckLifecycleEligibility, LIFECYCLE_SKIP_REASONS } =
    await import("@/lib/sends/lifecycle-recheck");
  const { LIFECYCLE_EXCLUSION_KEYS } = await import("@/lib/sends/eligibility");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `rechk-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const net = await one<{ id: number }>(
      sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`,
    );
    const brand = await one<{ id: number }>(
      sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
    );
    const offer = await one<{ id: number }>(
      sql`INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`o-${tag}`}, ${net.id}, ${`O ${tag}`}) RETURNING id`,
    );
    const etSale = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);

    const mkCampaign = async (lifecycle: boolean, slugSuffix: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id, lifecycle_rules)
          VALUES (${org}, ${`rc-${slugSuffix}-${tag}`}, ${`RC ${slugSuffix} ${tag}`},
                  'active', 'manual', ${brand.id}, ${offer.id}, ${lifecycle})
          RETURNING id`)
      ).id;
    const mkStage = async (campaignId: number) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
          VALUES (${org}, ${campaignId}, 1, 'STOP') RETURNING id`)
      ).id;

    const campLifecycle = await mkCampaign(true, "lc");
    const stageLifecycle = await mkStage(campLifecycle);
    const campLegacy = await mkCampaign(false, "lg");
    const stageLegacy = await mkStage(campLegacy);
    // A DIFFERENT campaign, whose already-'sent' rows are what the send-time
    // freeze check reads. This is the cross-campaign case the whole re-check
    // exists for, so it must not be the same campaign under test.
    const campOther = await mkCampaign(false, "ot");
    const stageOther = await mkStage(campOther);

    const phones = fictionalPhones(8);
    await refuseIfPhonesInUse(db, phones);

    const mk = async (
      i: number,
      lifecycle: string,
      eng?: { freeze_cadence_days: number },
    ) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
          VALUES (${org}, ${phones[i]}, ${lifecycle}, 'mobile') RETURNING id`)
      ).id;
      if (eng) {
        await db.execute(sql`
          INSERT INTO contact_engagement
            (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
             msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at,
             freeze_cadence_days, thresholds)
          VALUES (${id}::uuid, ${org}, ${lifecycle}, now(), 5, 5, 0, 0, 0, 0,
                  NULL::timestamptz, NULL::timestamptz, ${eng.freeze_cadence_days}, '{}'::jsonb)`);
      }
      return id;
    };

    // ⚠️ last_sent_at is deliberately NULL on every fixture. If the send-time
    // check ever reads contact_engagement instead of stage_sends, J2 and J4
    // both go red — which is exactly the regression worth catching.
    const cSuppressed = await mk(0, "suppressed");
    const cFreezeInside = await mk(1, "freeze", { freeze_cadence_days: 30 });
    const cFreezeOutside = await mk(2, "freeze", { freeze_cadence_days: 30 });
    // The cadence pair: SAME recent send, cadence 45 vs 14.
    const cFreezeLong = await mk(3, "freeze", { freeze_cadence_days: 45 });
    const cFreezeShort = await mk(4, "freeze", { freeze_cadence_days: 14 });
    const cBuyer = await mk(5, "cold");
    const cEligible = await mk(6, "cold");
    // Suppressed AND inside a freeze window — priority must pick suppressed.
    const cBoth = await mk(7, "suppressed", { freeze_cadence_days: 30 });

    const names: Record<string, string> = {
      [cSuppressed]: "suppressed",
      [cFreezeInside]: "freeze-inside",
      [cFreezeOutside]: "freeze-outside",
      [cFreezeLong]: "freeze-cad45",
      [cFreezeShort]: "freeze-cad14",
      [cBuyer]: "buyer",
      [cEligible]: "eligible",
      [cBoth]: "both",
    };

    // Prior sends from ANOTHER campaign — the facts the re-check reads.
    const priorSend = async (
      contactId: string,
      phone: string,
      daysAgo: number,
    ) =>
      db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${org}, ${campOther}, ${stageOther}, ${contactId}::uuid, ${phone},
                'prior', 'sent', ${ago(daysAgo)}::timestamptz)`);

    await priorSend(cFreezeInside, phones[1], 10); // 10d ago, cadence 30 ⇒ inside
    await priorSend(cFreezeOutside, phones[2], 60); // 60d ago, cadence 30 ⇒ due
    await priorSend(cFreezeLong, phones[3], 20); // 20d ago, cadence 45 ⇒ inside
    await priorSend(cFreezeShort, phones[4], 20); // 20d ago, cadence 14 ⇒ due
    await priorSend(cBoth, phones[7], 10); // inside, but suppressed wins

    await db.execute(sql`
      INSERT INTO conversion_events
        (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
         campaign_id, event_type_id, status, revenue, occurred_at)
      VALUES (${org}, ${`${tag}-buy`}, 'sale', 'sale', ${cBuyer}::uuid,
              ${campOther}, ${etSale.id}, 'approved', '10.0000', now())`);

    // The claimed batch: one pending row per contact, on the lifecycle stage.
    const claimedRows: { id: string; phone: string; contact_id: string }[] = [];
    for (const [i, cid] of [
      cSuppressed,
      cFreezeInside,
      cFreezeOutside,
      cFreezeLong,
      cFreezeShort,
      cBuyer,
      cEligible,
      cBoth,
    ].entries()) {
      const r = await one<{ id: string }>(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${org}, ${campLifecycle}, ${stageLifecycle}, ${cid}::uuid, ${phones[i]},
                'hi', 'pending')
        RETURNING id`);
      claimedRows.push({ id: r.id, phone: phones[i], contact_id: cid });
    }

    const run = (campaignId: number, lifecycleRules: boolean) =>
      recheckLifecycleEligibility(db, {
        orgId,
        campaignId,
        offerId: offer.id,
        lifecycleRules,
        rows: claimedRows,
      });

    console.log("PART J — the send-time lifecycle re-check");

    const skips = await run(campLifecycle, true);
    const reasonFor = (cid: string) => {
      const row = claimedRows.find((r) => r.contact_id === cid)!;
      return skips.get(row.id) ?? null;
    };
    const summary = claimedRows
      .filter((r) => skips.has(r.id))
      .map((r) => `${names[r.contact_id]}=${skips.get(r.id)}`)
      .join(" · ");

    bar(
      "J1 a contact suppressed AFTER materialization is skipped",
      reasonFor(cSuppressed) === "suppressed",
      String(reasonFor(cSuppressed)),
    );
    bar(
      "J2 freeze + messaged INSIDE the cadence since Prepare is skipped",
      reasonFor(cFreezeInside) === "freeze_not_due",
      String(reasonFor(cFreezeInside)),
    );
    bar(
      "J3 freeze + messaged OUTSIDE it is NOT skipped",
      reasonFor(cFreezeOutside) === null,
      String(reasonFor(cFreezeOutside)),
    );
    // ⭐ Both from ONE pair whose only difference is freeze_cadence_days.
    bar(
      "J4 the cadence is read PER CONTACT, not from a constant",
      reasonFor(cFreezeLong) === "freeze_not_due" &&
        reasonFor(cFreezeShort) === null,
      "same 20d-old send, cadence 45 skipped / 14 sent",
    );
    bar(
      "J5 a contact who bought the offer is skipped",
      reasonFor(cBuyer) === "bought_offer",
      String(reasonFor(cBuyer)),
    );
    // The control. Without it every bar above passes on a function that
    // skips everybody.
    bar(
      "J6 an eligible contact is left alone",
      reasonFor(cEligible) === null,
      summary || "(nothing skipped)",
    );

    // ⭐ A legacy campaign must not even run the query.
    const legacySkips = await run(campLegacy, false);
    bar(
      "J7 a LEGACY campaign returns an empty map",
      legacySkips.size === 0,
      `${legacySkips.size} skip(s)`,
    );

    bar(
      "J8 a lead caught by TWO layers reports the first in priority order",
      reasonFor(cBoth) === "suppressed",
      `${names[cBoth]} ⇒ ${reasonFor(cBoth)}`,
    );

    // Derived, not retyped — the same discipline as PR 4b's drift bar.
    const reasons = new Set(Object.values(LIFECYCLE_SKIP_REASONS));
    bar(
      "J9 every reason string comes from LIFECYCLE_EXCLUSION_KEYS",
      [...skips.values()].every((r) => reasons.has(r)) &&
        [...reasons].sort().join(",") ===
          [...LIFECYCLE_EXCLUSION_KEYS].sort().join(","),
      [...reasons].join(","),
    );

    // ── J10: it must FAIL OPEN ─────────────────────────────────────────────
    // A re-check that throws must not strand a stage mid-drain. Force a real
    // failure by handing it a runner whose execute() rejects.
    const brokenDb = {
      execute: async () => {
        throw new Error("injected failure");
      },
    } as unknown as typeof db;
    let threw = false;
    let openResult: Map<string, string> | null = null;
    try {
      openResult = await recheckLifecycleEligibility(brokenDb, {
        orgId,
        campaignId: campLifecycle,
        offerId: offer.id,
        lifecycleRules: true,
        rows: claimedRows,
      });
    } catch {
      threw = true;
    }
    bar(
      "J10 ⭐ a failing re-check THROWS, so the drain's catch decides",
      threw && openResult === null,
      "the module surfaces the failure; failing open is the drain's call, asserted in J11",
    );

    // ── J11–J13: THE DRAIN ITSELF ──────────────────────────────────────────
    // Through the REAL runStageDrain, with an injected sender so nothing
    // leaves the building. Everything below runs inside a transaction that is
    // always rolled back, so the fixtures above are untouched by it.
    console.log("\n  the drain, end to end (rolled back)");

    const { runStageDrain } = await import("@/lib/sends/drain");
    type Sender = Parameters<typeof runStageDrain>[1]["sendSms"] & object;
    // Shape copied from scripts/verify-drain.ts — every field matters: an
    // omitted one renders as empty SQL in the send_attempts insert.
    const okSender: Sender = async () => ({
      ok: true,
      messageId: "TEST-1",
      response: "queued",
      providerStatus: null,
      suppressed: false,
      rawBody: '{"response":"queued","id":"TEST-1"}',
      error: null,
      status: 200,
      timedOut: false,
    });

    // The drain needs an approved stage with a provider + phone to dispatch.
    const prov = await one<{ id: number }>(sql`
      INSERT INTO sms_providers
        (sms_provider_id, org_id, name, adapter_code, supports_api_send, sends_enabled, send_paused)
      VALUES (${`p-${tag}`}, ${org}, ${`P ${tag}`}, 'txh', true, true, false) RETURNING id`);
    const senderPhone = fictionalPhones(9)[8];
    const pphone = await one<{ id: number }>(sql`
      INSERT INTO provider_phones (org_id, provider_id, phone_number, number_type, status)
      VALUES (${org}, ${prov.id}, ${senderPhone}, '10dlc', 'active') RETURNING id`);
    // The drain refuses with no_credentials unless a key is reachable for the
    // stage's phone, so seed one (never read back — hasResolvableCredential
    // only checks reachability).
    const cred = await one<{ id: number }>(sql`
      INSERT INTO provider_credentials (org_id, provider_id, api_key)
      VALUES (${org}, ${prov.id}, ${`k-${tag}`}) RETURNING id`);
    await db.execute(sql`
      UPDATE provider_phones SET credential_id = ${cred.id} WHERE id = ${pphone.id}`);
    await db.execute(sql`
      UPDATE campaign_stages
      SET send_approved = true, sms_provider_id = ${prov.id}, provider_phone_id = ${pphone.id}
      WHERE id = ${stageLifecycle}`);

    const drainOnce = async (
      inject?: Parameters<typeof runStageDrain>[1]["recheckEligibility"],
    ) => {
      let res: Awaited<ReturnType<typeof runStageDrain>> | null = null;
      let after: {
        status: string;
        last_error: string | null;
        contact_id: string;
      }[] = [];
      await db
        .transaction(async (tx) => {
          res = await runStageDrain(tx, {
            stageId: stageLifecycle,
            sendSms: okSender,
            isEnabled: () => true,
            isOrgEnabled: async () => true,
            isOrgPaused: async () => false,
            ...(inject ? { recheckEligibility: inject } : {}),
          });
          after = (await tx.execute(sql`
            SELECT status, last_error, contact_id::text AS contact_id
            FROM stage_sends WHERE stage_id = ${stageLifecycle}
          `)) as unknown as typeof after;
          throw new Error("__ROLLBACK__");
        })
        .catch((e) => {
          if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
        });
      return { res: res!, after };
    };

    const real = await drainOnce();
    // A refusal here means the fixture is wrong, not the gate — say which.
    if (!real.res.ok) {
      console.log(`     (drain refused: ${JSON.stringify(real.res.reason)})`);
    }
    const skippedRows = real.after.filter(
      (r) => r.status === "skipped_ineligible",
    );
    const sentRows = real.after.filter((r) => r.status === "sent");
    bar(
      "J11 the drain marks the ineligible rows skipped_ineligible, reason in last_error",
      skippedRows.length === 5 &&
        skippedRows.every((r) => reasons.has(r.last_error as never)),
      skippedRows
        .map((r) => `${names[r.contact_id]}=${r.last_error}`)
        .join(" · "),
    );
    bar(
      "J12 the eligible rows still SEND — the gate narrows, it does not stop",
      sentRows.length === 3 &&
        real.res.skippedIneligible === 5 &&
        real.res.sent === 3,
      `sent ${real.res.sent}, skipped_ineligible ${real.res.skippedIneligible}, by reason ${JSON.stringify(real.res.skippedIneligibleByReason)}`,
    );

    // ⭐ The footing bar. A reason bucket that does not sum to the total means
    // the drain wrote a last_error the reporting surfaces cannot name — and an
    // unnamed reason renders as a silent zero, not as an error.
    const byReasonSum = Object.values(
      real.res.skippedIneligibleByReason,
    ).reduce((a, b) => a + b, 0);
    bar(
      "J14 the per-reason split FOOTS to skipped_ineligible",
      byReasonSum === real.res.skippedIneligible &&
        Object.keys(real.res.skippedIneligibleByReason).every((k) =>
          reasons.has(k as never),
        ),
      `${byReasonSum} vs ${real.res.skippedIneligible}`,
    );

    // ⭐ THE FAIL-OPEN BAR. A re-check that throws must not stop the send.
    // Asserted on the RESULT (rows dispatched + the failure counted), not on
    // the absence of an exception — "it didn't throw" is also true of a check
    // that silently did nothing.
    const broken = await drainOnce(async () => {
      throw new Error("injected recheck failure");
    });
    bar(
      "J13 ⭐ a THROWING re-check still dispatches the batch, and is counted",
      broken.res.recheckFailedBatches > 0 &&
        broken.res.sent === 8 &&
        broken.res.skippedIneligible === 0 &&
        broken.after.filter((r) => r.status === "skipped_ineligible").length ===
          0,
      `sent ${broken.res.sent} of 8, recheckFailedBatches ${broken.res.recheckFailedBatches}` +
        ` — the numbers are MISSING for that batch, not zero`,
    );
  } finally {
    if (orgId) {
      const name =
        (
          await all<{ name: string }>(
            sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`,
          )
        )[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(
          `REFUSING TEARDOWN: org ${orgId} lacks the marker (${JSON.stringify(name)})`,
        );
        fail++;
      } else {
        await db.execute(
          sql`DELETE FROM conversion_events WHERE org_id = ${orgId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`,
        );
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM conversion_events WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
