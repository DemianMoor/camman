import "./_env-preload";

// HYBRID TOTAL SENT vs the LIVE count — every row, four windows, ONE snapshot.
//
// The hybrid reads closed ET days from stage_delivery_rollup and counts today
// live. This proves the two agree per stage against the query it replaces.
//
// ⚠️ ONE `REPEATABLE READ READ ONLY` TRANSACTION for all of it: both sides must
// see the SAME database, or a send landing mid-run reads as drift. now() is
// frozen at transaction start, which is also what "today" must mean for both.
//
// ⚠️ ZERO ROWS COMPARED IS A FAILURE, NOT A PASS. A window that returns nothing
// proves nothing, so each window asserts it compared a non-zero number of rows.
//
// ⚠️ HEAVY BY DESIGN at 92 days: the LIVE side is the count(*) over stage_sends
// this change exists to avoid (measured 1.6-1.7 GB, 10-12 s on prod). Run it in
// the quiet window (~05:00-06:00 UTC), never in ET send hours.
//
// Run: npx tsx --conditions=react-server scripts/verify-hybrid-sent.ts

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("@/db/client");
  const { formatInCampaignTimezone } = await import("@/lib/campaign-timezone");
  const { sentCountsByStage, addEtDays, etDayBounds } = await import("@/lib/reporting/delivery-rollup");

  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '280s'`);

    const now = new Date(
      ((await tx.execute(sql`SELECT now()::text AS t`)) as unknown as { t: string }[])[0].t,
    );
    const todayEt = formatInCampaignTimezone(now, "yyyy-MM-dd");
    const [{ id: orgId }] = (await tx.execute(
      sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    )) as unknown as { id: string }[];
    console.log(`org ${orgId}\nsnapshot now() = ${now.toISOString()} (today ET ${todayEt})\n`);

    // The 1-day grain must be verified against a day that HAS sends. Early in
    // the ET morning "today" is legitimately empty, and an empty window proves
    // nothing — so the latest day with sends is compared as well, and the
    // today-window is reported as VACUOUS rather than quietly passing.
    const [{ d: latestDay }] = (await tx.execute(sql`
      SELECT to_char(max(sent_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid AND status = 'sent'
        AND sent_at >= ${etDayBounds({ from: addEtDays(todayEt, -14), to: todayEt }).fromUtc.toISOString()}::timestamptz
    `)) as unknown as { d: string }[];

    const windows: { label: string; fromEtDay: string; toEtDay: string }[] = [
      { label: "1d today", fromEtDay: todayEt, toEtDay: todayEt },
      { label: `1d latest day with sends`, fromEtDay: latestDay, toEtDay: latestDay },
      { label: "7d", fromEtDay: addEtDays(todayEt, -6), toEtDay: todayEt },
      { label: "14d", fromEtDay: addEtDays(todayEt, -13), toEtDay: todayEt },
      { label: "92d", fromEtDay: addEtDays(todayEt, -91), toEtDay: todayEt },
    ];

    for (const w of windows) {
      const { fromEtDay, toEtDay } = w;
      const { fromUtc, toExclusiveUtc } = etDayBounds({ from: fromEtDay, to: toEtDay });

      const t0 = Date.now();
      const liveRows = (await tx.execute(sql`
        SELECT stage_id, count(*)::int AS sent
        FROM stage_sends
        WHERE org_id = ${orgId}::uuid AND status = 'sent'
          AND sent_at >= ${fromUtc.toISOString()}::timestamptz
          AND sent_at <  ${toExclusiveUtc.toISOString()}::timestamptz
        GROUP BY stage_id`)) as unknown as { stage_id: number; sent: number }[];
      const liveMs = Date.now() - t0;
      const live = new Map(liveRows.map((r) => [Number(r.stage_id), Number(r.sent)]));

      const t1 = Date.now();
      const hybrid = await sentCountsByStage(
        tx,
        { orgId, stageIds: [...live.keys()], fromEtDay, toEtDay, toExclusiveUtc },
        now,
      );
      const hybridMs = Date.now() - t1;

      // Union of keys: a stage the hybrid invents is as wrong as one it drops.
      const keys = new Set<number>([...live.keys(), ...hybrid.keys()]);
      const diffs: string[] = [];
      let liveTotal = 0;
      let hybridTotal = 0;
      for (const k of keys) {
        const a = live.get(k) ?? 0;
        const b = hybrid.get(k) ?? 0;
        liveTotal += a;
        hybridTotal += b;
        if (a !== b) diffs.push(`stage ${k}: live ${a} vs hybrid ${b}`);
      }

      const label = `${w.label} [${fromEtDay} -> ${toEtDay}]`;
      console.log(
        `${label}
    rows compared ${keys.size}  live total ${liveTotal.toLocaleString()}  hybrid total ${hybridTotal.toLocaleString()}` +
          `
    live ${liveMs} ms | hybrid ${hybridMs} ms | speedup ${(liveMs / Math.max(hybridMs, 1)).toFixed(1)}x`,
      );
      if (keys.size === 0) {
        // Only the today-window may legitimately be empty, and only because the
        // ET send day has not started. Any OTHER empty window is a FAILURE.
        const vacuousOk = fromEtDay === todayEt;
        bar(
          `${label}: VACUOUS - nothing to compare`,
          vacuousOk,
          vacuousOk
            ? `no sends yet today at ${formatInCampaignTimezone(now, "HH:mm")} ET; the 1-day grain is verified on ${latestDay} instead, and today's LIVE half is covered by scripts/test-hybrid-sent-boundary.ts`
            : "an empty window proves nothing - this is a FAILURE, not a pass",
        );
        continue;
      }
      bar(
        `${label}: every row identical`,
        diffs.length === 0,
        diffs.length === 0
          ? `${keys.size} rows, 0 diffs`
          : `${diffs.length} diffs - ${diffs.slice(0, 5).join("; ")}`,
      );
    }
  });

  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} RED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
