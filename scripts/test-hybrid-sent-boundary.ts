import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// HYBRID TOTAL SENT — the ET-midnight boundary, on the PREVIEW DB.
//
// The hybrid reads CLOSED ET days from stage_delivery_rollup and counts TODAY
// live. The only way it can be wrong is at that seam: a send counted by both
// halves, or by neither.
//
// ⚠️ THE ROLLUP CELL FOR TODAY IS DELIBERATELY POISONED with a wrong value.
// Correct code never reads today from the rollup, so the poison is invisible;
// any code that does read it fails loudly instead of being off by a plausible
// amount. Same idea as a canary: the fixture makes the bug LOUD, not subtle.
//
// Everything runs inside ONE transaction that is always rolled back.
// ⚠️ now() is frozen at transaction start, so "today" is staged from the SAME
// clock the code under test uses — the transaction's now(), passed in explicitly.
//
// Run: npx tsx --conditions=react-server scripts/test-hybrid-sent-boundary.ts

import { sql } from "drizzle-orm";

const ROLLBACK = "__rollback__";
const POISON = 999_999; // a today-cell value no live count could ever equal

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } = await import("@/lib/campaign-timezone");
  const { sentCountsByStage, addEtDays, etDayBounds } = await import("@/lib/reporting/delivery-rollup");
  const { fromZonedTime } = await import("date-fns-tz");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };

  await db
    .transaction(async (tx) => {
      const now = new Date(
        ((await tx.execute(sql`SELECT now()::text AS t`)) as unknown as { t: string }[])[0].t,
      );
      const todayEt = formatInCampaignTimezone(now, "yyyy-MM-dd");
      const yestEt = addEtDays(todayEt, -1);

      const [{ id: orgId }] = (await tx.execute(
        sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
      )) as unknown as { id: string }[];

      // A campaign + stage to hang the sends on. campaign_stages needs a
      // campaign; both are removed by the rollback.
      const [{ id: campaignId }] = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, name, slug, status)
        VALUES (${orgId}::uuid, '__hybrid_boundary_test__',
                '__hybrid_boundary_test__' || floor(random() * 1e9)::text, 'draft')
        RETURNING id`)) as unknown as { id: number }[];
      const [{ id: stageId }] = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, status)
        VALUES (${orgId}::uuid, ${campaignId}, 1, 'draft')
        RETURNING id`)) as unknown as { id: number }[];
      const [{ id: contactId }] = (await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number)
        VALUES (${orgId}::uuid, '+1555' || floor(random() * 1e7)::text)
        RETURNING id`)) as unknown as { id: string }[];

      // Sends STRADDLING ET midnight: 23:50 ET yesterday and 00:10 ET today.
      // In UTC these are only 20 minutes apart; in ET they are different days,
      // which is the whole point.
      const at = (day: string, hhmm: string) =>
        fromZonedTime(`${day}T${hhmm}:00`, CAMPAIGN_TIMEZONE).toISOString();
      const mk = async (whenIso: string, n: number) => {
        for (let i = 0; i < n; i++) {
          await tx.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at, created_at)
            VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${contactId}::uuid, '+15550000000', 'x', 'sent',
                    ${whenIso}::timestamptz, ${whenIso}::timestamptz)`);
        }
      };
      const YEST_LATE = 3; // 23:50 ET yesterday  → closed day, must come from the rollup
      const TODAY_EARLY = 2; // 00:10 ET today    → must be counted LIVE
      const TODAY_NOON = 4; // 09:00 ET today     → must be counted LIVE
      await mk(at(yestEt, "23:50"), YEST_LATE);
      await mk(at(todayEt, "00:10"), TODAY_EARLY);
      await mk(at(todayEt, "09:00"), TODAY_NOON);

      // A send that is NOT status='sent' — must never be counted by either half.
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at, created_at)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${contactId}::uuid, '+15550000001', 'x', 'pending',
                ${at(todayEt, "09:30")}::timestamptz, ${at(todayEt, "09:30")}::timestamptz)`);

      // The rollup: a TRUE cell for yesterday, a POISONED cell for today.
      const cell = async (day: string, sent: number) =>
        tx.execute(sql`
          INSERT INTO stage_delivery_rollup
            (org_id, stage_id, provider_phone_id, sent_date_et, sent, delivered, undelivered, no_receipt)
          VALUES (${orgId}::uuid, ${stageId}, NULL, ${day}::date, ${sent}, 0, 0, ${sent})`);
      await cell(yestEt, YEST_LATE);
      await cell(todayEt, POISON);

      const total = async (fromEtDay: string, toEtDay: string) => {
        const m = await sentCountsByStage(
          tx,
          {
            orgId,
            stageIds: [stageId],
            fromEtDay,
            toEtDay,
            toExclusiveUtc: etDayBounds({ from: toEtDay, to: toEtDay }).toExclusiveUtc,
          },
          now,
        );
        return m.get(stageId) ?? 0;
      };
      const live = async (fromEtDay: string, toEtDay: string) => {
        const b = etDayBounds({ from: fromEtDay, to: toEtDay });
        const r = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM stage_sends
          WHERE org_id = ${orgId}::uuid AND status = 'sent' AND stage_id = ${stageId}
            AND sent_at >= ${b.fromUtc.toISOString()}::timestamptz
            AND sent_at <  ${b.toExclusiveUtc.toISOString()}::timestamptz`)) as unknown as { n: number }[];
        return Number(r[0].n);
      };

      // B1 — the spanning window. The seam must neither double-count nor drop.
      const spanHybrid = await total(yestEt, todayEt);
      const spanLive = await live(yestEt, todayEt);
      bar(
        "B1 window spanning ET midnight: hybrid == live, no double count, no drop",
        spanHybrid === spanLive && spanHybrid === YEST_LATE + TODAY_EARLY + TODAY_NOON,
        `hybrid ${spanHybrid} vs live ${spanLive} (expected ${YEST_LATE + TODAY_EARLY + TODAY_NOON})`,
      );

      // B2 — yesterday only: served entirely by the rollup, today untouched.
      const yHybrid = await total(yestEt, yestEt);
      bar("B2 closed day only: rollup value, today not pulled in", yHybrid === YEST_LATE,
        `${yHybrid} (expected ${YEST_LATE})`);

      // B3 — today only: counted LIVE. The poisoned cell proves the rollup was
      // not consulted; reading it would return 999,999.
      const tHybrid = await total(todayEt, todayEt);
      bar("B3 today only: counted live, poisoned rollup cell ignored", tHybrid === TODAY_EARLY + TODAY_NOON,
        `${tHybrid} (expected ${TODAY_EARLY + TODAY_NOON}; poison is ${POISON})`);

      // B4 — the 00:10 ET send belongs to TODAY, not to yesterday. A UTC-day
      // split would put it on the wrong side (it is 04:10/05:10 UTC).
      bar("B4 a 00:10 ET send lands on today, not on the closed day",
        yHybrid === YEST_LATE && tHybrid >= TODAY_EARLY,
        `closed ${yHybrid}, today ${tHybrid}`);

      // B5 — a non-'sent' row is counted by neither half.
      bar("B5 a pending row is never counted", spanHybrid === YEST_LATE + TODAY_EARLY + TODAY_NOON,
        `${spanHybrid} with one pending row present`);

      throw new Error(ROLLBACK);
    })
    .catch((e: unknown) => {
      if (!(e instanceof Error) || !e.message.includes(ROLLBACK)) throw e;
    });

  const [{ n }] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM campaigns WHERE name = '__hybrid_boundary_test__'`,
  )) as unknown as { n: number }[];
  bar("B6 zero residue after rollback", Number(n) === 0, `${n} fixture campaigns`);

  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} RED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
