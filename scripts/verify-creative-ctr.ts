// Lib-level verification for the per-creative CTR snapshot
// (lib/creatives/ctr-rollup.ts). READ-ONLY against the database in .env.local
// (production).
//
// ⚠️ The snapshot statement and an INDEPENDENT recount run inside ONE REPEATABLE
// READ, READ ONLY transaction, so both see the same rows and the same now() —
// live sends cannot race the exact comparison. The recount shares no statement
// with the snapshot: per-stage send counts with no join, and the stage → creative
// mapping, manual-stage rule and clicker de-duplication all done in JS.
// Run: npx tsx --conditions=react-server scripts/verify-creative-ctr.ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { computeCreativeCtr, type CreativeCtrRow } from "@/lib/creatives/ctr-rollup";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

type Counts = Omit<CreativeCtrRow, "creative_id" | "offer_id">;
const FIELDS: (keyof Counts)[] = [
  "sent_7d",
  "clicks_7d",
  "sent_30d",
  "clicks_30d",
  "sent_lifetime",
  "clicks_lifetime",
];
const pct = (clicks: number, sent: number) => (sent > 0 ? `${((clicks / sent) * 100).toFixed(2)}%` : "—");

async function main() {
  const [{ org_id: orgId }] = (await db.execute(sql`
    SELECT org_id FROM campaigns GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`)) as unknown as {
    org_id: string;
  }[];

  await db.transaction(
    async (tx) => {
      // The snapshot and the per-stage recount are each a full stage_sends pass.
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '600s'"));

      console.log("A. computeCreativeCtr");
      const t = Date.now();
      const allRows = await computeCreativeCtr(tx, orgId);
      // The all-offers rows; sections C-E check these. B checks every row.
      const snapshot = allRows.filter((r) => r.offer_id === null);
      console.log(
        `    ${Date.now() - t}ms, ${snapshot.length} creatives, ${allRows.length - snapshot.length} creative × offer rows`,
      );

      console.log("\nB. independent recount");
      const stages = (await tx.execute(sql`
        SELECT cs.id, cs.creative_id, cs.sms_count, cs.click_count, c.link_mode,
               coalesce(c.offer_id, 0) AS offer_key,
               coalesce(cs.sent_at <= now() - interval '6 hours', false) AS mature,
               coalesce(cs.sent_at >= (((now() AT TIME ZONE 'America/New_York')::date - 6)::timestamp AT TIME ZONE 'America/New_York'), false) AS in_7d,
               coalesce(cs.sent_at >= (((now() AT TIME ZONE 'America/New_York')::date - 29)::timestamp AT TIME ZONE 'America/New_York'), false) AS in_30d,
               (cs.sent_at IS NOT NULL AND cs.archived_at IS NULL) AS in_report
        FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.org_id = ${orgId}::uuid`)) as unknown as {
        id: number;
        creative_id: number | null;
        offer_key: number;
        mature: boolean;
        sms_count: number;
        click_count: number;
        link_mode: string;
        in_7d: boolean;
        in_30d: boolean;
        in_report: boolean;
      }[];
      const sendRows = (await tx.execute(sql`
        SELECT stage_id,
               count(*) FILTER (WHERE sent_at >= (((now() AT TIME ZONE 'America/New_York')::date - 6)::timestamp AT TIME ZONE 'America/New_York'))::int AS d7,
               count(*) FILTER (WHERE sent_at >= (((now() AT TIME ZONE 'America/New_York')::date - 29)::timestamp AT TIME ZONE 'America/New_York'))::int AS d30,
               count(*)::int AS life
        FROM stage_sends
        WHERE org_id = ${orgId}::uuid AND status = 'sent'
        GROUP BY stage_id`)) as unknown as { stage_id: number; d7: number; d30: number; life: number }[];
      const clickRows = (await tx.execute(sql`
        SELECT stage_id, contact_id,
               coalesce(first_click_at >= (((now() AT TIME ZONE 'America/New_York')::date - 6)::timestamp AT TIME ZONE 'America/New_York'), false) AS in_7d,
               coalesce(first_click_at >= (((now() AT TIME ZONE 'America/New_York')::date - 29)::timestamp AT TIME ZONE 'America/New_York'), false) AS in_30d
        FROM counted_clickers
        WHERE org_id = ${orgId}::uuid`)) as unknown as {
        stage_id: number;
        contact_id: string;
        in_7d: boolean;
        in_30d: boolean;
      }[];
      // Keitaro clean/raw landing visits per stage and window (stat_date = ET day).
      const visitRows = (await tx.execute(sql`
        SELECT stage_id, stat_date > (now() AT TIME ZONE 'America/New_York')::date - 7 AS in_7d,
               stat_date > (now() AT TIME ZONE 'America/New_York')::date - 30 AS in_30d,
               visit_clicks_raw AS raw, visit_clicks_clean AS clean
        FROM keitaro_stage_results
        WHERE org_id = ${orgId}::uuid`)) as unknown as {
        stage_id: number;
        in_7d: boolean;
        in_30d: boolean;
        raw: number;
        clean: number;
      }[];
      console.log(
        `    ${stages.length} stages, ${sendRows.length} stages with sends, ${clickRows.length} counted-clicker rows`,
      );

      const stageById = new Map(stages.map((s) => [s.id, s]));
      // Keyed "creative:offer" ("creative:all" = every offer). Each stage feeds
      // its total key and, when its campaign has an offer, its offer key.
      const keysOf = (s: { creative_id: number; offer_key: number }) =>
        s.offer_key === 0 ? [`${s.creative_id}:all`] : [`${s.creative_id}:all`, `${s.creative_id}:${s.offer_key}`];
      const truth = new Map<string, Counts>();
      const acc = (key: string): Counts => {
        let c = truth.get(key);
        if (!c) {
          c = { sent_7d: 0, clicks_7d: 0, sent_30d: 0, clicks_30d: 0, sent_lifetime: 0, clicks_lifetime: 0 };
          truth.set(key, c);
        }
        return c;
      };
      for (const r of sendRows) {
        const s = stageById.get(r.stage_id);
        if (!s?.creative_id || s.link_mode !== "tracked") continue;
        for (const k of keysOf({ creative_id: s.creative_id, offer_key: s.offer_key })) {
          const c = acc(k);
          c.sent_7d += r.d7;
          c.sent_30d += r.d30;
          c.sent_lifetime += r.life;
        }
      }
      // Manual-mode stages: operator-entered sms_count and Keitaro click_count,
      // windowed by the stage's own send time.
      for (const s of stages) {
        if (!s.creative_id || s.link_mode === "tracked") continue;
        for (const k of keysOf({ creative_id: s.creative_id, offer_key: s.offer_key })) {
          const c = acc(k);
          c.sent_lifetime += s.sms_count;
          c.clicks_lifetime += s.click_count;
          if (s.in_30d) {
            c.sent_30d += s.sms_count;
            c.clicks_30d += s.click_count;
          }
          if (s.in_7d) {
            c.sent_7d += s.sms_count;
            c.clicks_7d += s.click_count;
          }
        }
      }
      // Tracked stages: the Overview tab's clickers, per stage and window —
      // Keitaro clean visits, or the stage's counted clickers when Keitaro has
      // no visits (raw AND clean 0) and the stage is past the 6 h maturity gate.
      type W = { raw: number; clean: number; counted: number };
      const zero = (): [W, W, W] => [
        { raw: 0, clean: 0, counted: 0 },
        { raw: 0, clean: 0, counted: 0 },
        { raw: 0, clean: 0, counted: 0 },
      ];
      const perStage = new Map<number, [W, W, W]>(); // [7d, 30d, lifetime]
      const slot = (id: number) => {
        let w = perStage.get(id);
        if (!w) perStage.set(id, (w = zero()));
        return w;
      };
      for (const r of visitRows) {
        const w = slot(r.stage_id);
        const add = (x: W) => { x.raw += Number(r.raw); x.clean += Number(r.clean); };
        if (r.in_7d) add(w[0]);
        if (r.in_30d) add(w[1]);
        add(w[2]);
      }
      for (const r of clickRows) {
        const w = slot(r.stage_id);
        if (r.in_7d) w[0].counted++;
        if (r.in_30d) w[1].counted++;
        w[2].counted++;
      }
      for (const [stageId, [w7, w30, wl]] of perStage) {
        const s = stageById.get(stageId);
        if (!s?.creative_id || s.link_mode !== "tracked") continue;
        const pick = (w: W) => (w.raw === 0 && w.clean === 0 && s.mature ? w.counted : w.clean);
        for (const k of keysOf({ creative_id: s.creative_id, offer_key: s.offer_key })) {
          const c = acc(k);
          c.clicks_7d += pick(w7);
          c.clicks_30d += pick(w30);
          c.clicks_lifetime += pick(wl);
        }
      }

      const snapById = new Map(
        allRows.map((r) => [`${r.creative_id}:${r.offer_id ?? "all"}`, r]),
      );
      check(
        "same creative × offer set as the recount (totals + per offer)",
        snapById.size === truth.size && [...truth.keys()].every((id) => snapById.has(id)),
        { snapshot: snapById.size, recount: truth.size },
      );
      const mismatches: string[] = [];
      for (const [id, want] of truth) {
        const got = snapById.get(id);
        for (const f of FIELDS) {
          if (!got || got[f] !== want[f]) mismatches.push(`#${id} ${f} ${got?.[f]}≠${want[f]}`);
        }
      }
      check(
        `every creative/offer row × field (${truth.size} × ${FIELDS.length}) matches the recount exactly`,
        mismatches.length === 0,
        { count: mismatches.length, first: mismatches.slice(0, 5) },
      );

      console.log("\nC. invariants");
      check(
        "windows nest: 7d ≤ 30d ≤ all time, for sends and for clickers",
        snapshot.every(
          (r) =>
            r.sent_7d <= r.sent_30d &&
            r.sent_30d <= r.sent_lifetime &&
            r.clicks_7d <= r.clicks_30d &&
            r.clicks_30d <= r.clicks_lifetime,
        ),
      );
      const overHundred = snapshot.filter((r) => r.sent_lifetime > 0 && r.clicks_lifetime > r.sent_lifetime);
      check("no creative has more all-time clickers than messages sent", overHundred.length === 0, overHundred.slice(0, 5));

      console.log("\nD. the reported bug — CTR divided by delivered_count");
      const [{ delivered }] = (await tx.execute(sql`
        SELECT coalesce(sum(delivered_count), 0)::int AS delivered
        FROM campaign_stages
        WHERE org_id = ${orgId}::uuid AND creative_id IS NOT NULL
          AND created_at >= (((now() AT TIME ZONE 'America/New_York')::date - 29)::timestamp AT TIME ZONE 'America/New_York')`)) as unknown as { delivered: number }[];
      const sum = (f: keyof Counts) => snapshot.reduce((n, r) => n + r[f], 0);
      console.log(`    old 30-day denominator, Σ delivered_count: ${delivered}`);
      console.log(
        `    creatives with sends — 7d: ${snapshot.filter((r) => r.sent_7d > 0).length}, 30d: ${snapshot.filter((r) => r.sent_30d > 0).length}, all time: ${snapshot.filter((r) => r.sent_lifetime > 0).length}`,
      );
      console.log(
        `    Σ over creatives — 7d ${sum("clicks_7d")}/${sum("sent_7d")} = ${pct(sum("clicks_7d"), sum("sent_7d"))}, 30d ${sum("clicks_30d")}/${sum("sent_30d")} = ${pct(sum("clicks_30d"), sum("sent_30d"))}, all time ${sum("clicks_lifetime")}/${sum("sent_lifetime")} = ${pct(sum("clicks_lifetime"), sum("sent_lifetime"))}`,
      );
      check(
        "input scope: the comparison above covered creatives with real 30-day sends",
        snapshot.some((r) => r.sent_30d > 0),
      );

      console.log(
        "\nE. all-time sends vs the operator-API creative lifetime rollup (lib/reporting/stage-funnel.ts — a different implementation, stored earlier)",
      );
      // The report counts only stages with sent_at stamped and not archived
      // (getStageMetricsInRange's cohort), and its totals span every stage, with
      // or without a creative. The snapshot also counts manual stages whose
      // sent_at was never stamped (measured 2026-09-14: 112,348 manual sms_count
      // + 4 tracked sends = exactly the 112,352 gap). So compare over the
      // report's stage set, rebuilt from the recount inputs; what remains can only
      // be sends that landed after the stored rollup started.
      const [stored] = (await tx.execute(sql`
        SELECT (r.data->'bases'->'send_date'->'totals'->>'sent')::bigint AS sent,
               to_char(r.computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS computed_at,
               (SELECT count(*) FROM stage_sends ss
                 WHERE ss.org_id = r.org_id AND ss.status = 'sent'
                   AND ss.sent_at >= r.computed_at)::int AS sent_after_end,
               (SELECT count(*) FROM stage_sends ss
                 WHERE ss.org_id = r.org_id AND ss.status = 'sent'
                   AND ss.sent_at >= r.computed_at - make_interval(secs => r.duration_ms / 1000.0))::int AS sent_after_start
        FROM operator_rollups r
        WHERE r.org_id = ${orgId}::uuid AND r.rollup_key = 'performance_creative_lifetime'`)) as unknown as {
        sent: string | null;
        computed_at: string;
        sent_after_end: number;
        sent_after_start: number;
      }[];
      if (stored?.sent == null) {
        console.log("    (no stored lifetime rollup — skipped)");
      } else {
        const sentByStage = new Map(sendRows.map((r) => [r.stage_id, r.life]));
        let reportSet = 0;
        let unstamped = 0;
        for (const s of stages) {
          const n = s.link_mode === "tracked" ? sentByStage.get(s.id) ?? 0 : s.sms_count;
          if (s.in_report) reportSet += n;
          else if (s.creative_id) unstamped += n;
        }
        const other = Number(stored.sent);
        const gap = reportSet - other;
        console.log(
          `    snapshot all-time sends ${sum("sent_lifetime")} = report stage set ${reportSet} + unstamped/archived creative stages ${unstamped}: ${sum("sent_lifetime") === reportSet + unstamped}`,
        );
        console.log(
          `    report stage set ${reportSet} vs stored ${other} at ${stored.computed_at} UTC: gap ${gap}, sends since the stored run started ${stored.sent_after_start} / ended ${stored.sent_after_end}`,
        );
        check(
          "the snapshot is the report's stage set plus the named unstamped/archived stages",
          sum("sent_lifetime") === reportSet + unstamped,
        );
        check(
          "over the report's stage set the implementations differ only by sends after the stored run",
          gap >= stored.sent_after_end && gap <= stored.sent_after_start,
          { gap, sent_after_end: stored.sent_after_end, sent_after_start: stored.sent_after_start },
        );
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  console.log(`\n${failures === 0 ? "verify-creative-ctr OK." : `verify-creative-ctr: ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
