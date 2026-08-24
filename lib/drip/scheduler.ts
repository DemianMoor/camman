import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { optOutGateSubject, resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { isDripPostureOn } from "./in-use";
import { numbersWithHeadroom, pickNumber, reportExhaustion } from "./numbers";
import { etMinutesOfDay, pickStage, type StageWindow } from "./windows";

// The drip scheduler (Drip Phase 5). Turns due journeys into pending
// stage_sends rows. **It does not send anything** — the EXISTING drain does.
//
// ⭐ G1: kickoff.ts and drain.ts are NOT modified, and the reason is one
// property of the two selectors:
//
//     Phase A (materialize) selects  materialized_at IS NULL AND sent_at IS NULL
//     Phase B (drain)       selects  materialized_at IS NOT NULL
//
// A drip stage is created with BOTH stamped, so Phase A never sees it and Phase
// B always does. Rows inserted here are picked up because Phase B's only
// freshness test is `EXISTS (… status='pending')`. Pinned by
// scripts/test-drip-sends-schema.ts — nothing in either file mentions drip, so
// nothing in either file would fail if the property broke.
//
// ⭐ THE COMPLIANCE GATE RUNS PER MESSAGE, AND FAILS CLOSED PER ROW.
// kickoff.ts checks opt-out language once per stage, because every recipient of
// a regular stage gets the same body. Drip renders per lead, so the check moves
// inside the loop. A refusal drops THAT lead and leaves its journey untouched,
// so the next tick retries after a fix — refusing the whole batch would let one
// bad render block 199 good leads.
//
// ⭐ POSTURE OFF ⇒ ONE READ AND RETURN. This ships live and inert.

const BATCH = 200;

export interface SchedulerResult {
  postureOn: boolean;
  considered: number;
  inserted: number;
  waitingForWindow: number;
  gateRefused: number;
  capBlocked: number;
  numbersExhausted: number;
  pausedSkipped: number;
}

interface DueRow {
  journey_id: string;
  org_id: string;
  campaign_id: number;
  campaign_name: string | null;
  contact_id: string;
  phone: string;
  brand_name: string | null;
  daily_cap: number | null;
  campaign_cap: number | null;
  campaign_paused: boolean;
  drip_paused: boolean;
  link_mode: string;
}

export async function runDripSchedulerBatch(now: Date = new Date()): Promise<SchedulerResult> {
  const res: SchedulerResult = {
    postureOn: false, considered: 0, inserted: 0, waitingForWindow: 0,
    gateRefused: 0, capBlocked: 0, numbersExhausted: 0, pausedSkipped: 0,
  };

  const orgs = (await db.execute(sql`
    SELECT org_id FROM org_settings WHERE drip_enabled = true AND drip_paused = false
  `)) as unknown as { org_id: string }[];
  if (orgs.length === 0) return res;
  res.postureOn = true;

  const nowMin = etMinutesOfDay(now);
  const { start: dayStart, end: dayEnd } = campaignDayBoundsUtc(now);

  for (const { org_id: orgId } of orgs) {
    if (!(await isDripPostureOn(orgId))) continue;

    const due = (await db.execute(sql`
      SELECT j.id AS journey_id, j.org_id, j.campaign_id, j.contact_id,
             c.name AS campaign_name, c.link_mode,
             (c.send_paused IS TRUE) AS campaign_paused,
             false AS drip_paused,
             ct.phone_number AS phone,
             b.name AS brand_name,
             cfg.daily_cap, cfg.campaign_cap
      FROM drip_journeys j
      JOIN campaigns c  ON c.id = j.campaign_id
      JOIN contacts ct  ON ct.id = j.contact_id
      LEFT JOIN brands b ON b.id = c.brand_id
      LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
      WHERE j.org_id = ${orgId}::uuid
        AND j.state = 'routed'
        AND j.first_send_at IS NULL
        AND c.type = 'drip'
        AND c.status = 'active'
      ORDER BY j.routed_at
      LIMIT ${BATCH}
    `)) as unknown as DueRow[];

    // Group by campaign — stages, numbers and caps are per campaign, and
    // re-reading them per lead would be N queries for one answer.
    const byCampaign = new Map<number, DueRow[]>();
    for (const d of due) {
      res.considered++;
      const list = byCampaign.get(d.campaign_id) ?? [];
      list.push(d);
      byCampaign.set(d.campaign_id, list);
    }

    for (const [campaignId, leads] of byCampaign) {
      const head = leads[0];

      // ⚠️ The campaign latch is checked BEFORE any insert, not after. A paused
      // campaign accumulates journeys; it must not accumulate pending sends,
      // because the drain would ship them the moment someone unpauses.
      if (head.campaign_paused) {
        res.pausedSkipped += leads.length;
        continue;
      }

      const stages = (await db.execute(sql`
        SELECT s.id AS stage_id, s.window_start_min, s.window_end_min,
               s.creative_id, s.stop_text, s.short_url, s.landing_page_id,
               cr.text AS creative_text
        FROM campaign_stages s
        LEFT JOIN creatives cr ON cr.id = s.creative_id
        WHERE s.campaign_id = ${campaignId}
          AND s.drip_active IS TRUE
          AND s.archived_at IS NULL
        ORDER BY s.window_start_min
      `)) as unknown as (StageWindow & {
        stage_id: number; creative_id: number | null; stop_text: string | null;
        short_url: string | null; landing_page_id: number | null; creative_text: string | null;
      })[];
      if (stages.length === 0) continue;

      const pick = pickStage(stages, nowMin);
      // Not in a window right now ⇒ the whole campaign waits. Nothing is lost:
      // the journeys stay 'routed' and the next tick re-evaluates.
      if (!pick || pick.opens_at_min !== null) {
        res.waitingForWindow += leads.length;
        continue;
      }
      const stage = stages.find((s) => s.stage_id === pick.stage_id)!;
      if (!stage.creative_text) continue;

      // ── caps, counted over the ET day as a RANGE (never a functional
      // predicate on sent_at — R15) ──────────────────────────────────────
      const counts = (await db.execute(sql`
        SELECT
          COALESCE((SELECT count(*)::int FROM stage_sends ss
                    WHERE ss.campaign_id = ${campaignId}
                      AND ss.status IN ('sent','sending','pending')
                      AND ss.created_at >= ${dayStart.toISOString()}::timestamptz
                      AND ss.created_at <  ${dayEnd.toISOString()}::timestamptz), 0) AS today,
          COALESCE((SELECT count(*)::int FROM drip_journeys dj
                    WHERE dj.campaign_id = ${campaignId}
                      AND dj.first_send_at IS NOT NULL), 0) AS lifetime
      `)) as unknown as { today: number; lifetime: number }[];
      let todayCount = Number(counts[0]?.today ?? 0);
      const lifetime = Number(counts[0]?.lifetime ?? 0);

      const dailyCap = head.daily_cap;
      const campaignCap = head.campaign_cap;
      if (campaignCap != null && lifetime >= campaignCap) {
        res.capBlocked += leads.length;
        continue;
      }
      // ≥90% of the daily cap warns, once, per campaign per day.
      if (dailyCap != null && todayCount >= Math.floor(dailyCap * 0.9)) {
        await notifyDailyCapNear(orgId, campaignId, head.campaign_name, todayCount, dailyCap);
      }

      const numbers = await numbersWithHeadroom(db, { campaignId, now });
      if (numbers.length === 0) continue;

      // ── the footer resolves ONCE per stage per tick, and the winner is used
      // for BOTH the body and the gate. Resolving twice would let the gate
      // validate one string while a different one shipped (the Q3 rule).
      for (const lead of leads) {
        if (dailyCap != null && todayCount >= dailyCap) {
          res.capBlocked++;
          continue;
        }
        const number = pickNumber(await numbersWithHeadroom(db, { campaignId, now }));
        if (!number) {
          res.numbersExhausted++;
          await reportExhaustion(db, {
            orgId, campaignId, campaignName: head.campaign_name,
            exhausted: true, numbers,
          });
          break; // the whole campaign waits for the next ET day
        }

        const phoneRow = (await db.execute(sql`
          SELECT pp.opt_out_footer AS phone_footer,
                 prov.opt_out_footer AS provider_footer,
                 prov.adapter_code, prov.id AS provider_id
          FROM provider_phones pp
          LEFT JOIN sms_providers prov ON prov.id = pp.provider_id
          WHERE pp.id = ${number.provider_phone_id} LIMIT 1
        `)) as unknown as {
          phone_footer: string | null; provider_footer: string | null;
          adapter_code: string | null; provider_id: number;
        }[];
        const pr = phoneRow[0];
        const descriptor = pr?.adapter_code ? getDescriptor(pr.adapter_code) : null;
        const footer = resolveOptOutFooter({
          numberFooter: pr?.phone_footer ?? null,
          providerFooter: pr?.provider_footer ?? null,
          stageStopText: stage.stop_text,
          providerAppendsOwnOptOut: descriptor?.appendsOwnOptOut === true,
        });

        const body = buildStageSms({
          brandName: head.brand_name ?? "",
          creativeText: stage.creative_text,
          linkUrl: stage.short_url,
          stopText: footer.text,
        });

        // ⭐ THE GATE, PER MESSAGE, FAILING CLOSED.
        const gate = optOutGateSubject({
          renderedBody: body,
          resolved: footer,
          providerKnownAppendedText: descriptor?.defaultOptOutFooter ?? null,
        });
        const hasStop = /\bSTOP\b/i.test(gate.subject);
        if (!gate.verifiable || (!hasStop && pr?.adapter_code === "txr")) {
          // Refuse THIS lead only. Its journey stays 'routed', so a fix to the
          // creative or the footer is picked up on the next tick.
          console.error(
            `[drip-scheduler] opt-out gate REFUSED lead ${lead.journey_id} ` +
              `(campaign ${campaignId}, stage ${stage.stage_id}, provider ${pr?.adapter_code ?? "?"}): ` +
              `${!gate.verifiable ? "footer unverifiable" : "no STOP in rendered body"}`,
          );
          res.gateRefused++;
          continue;
        }

        try {
          await db.transaction(async (tx) => {
            const ins = (await tx.execute(sql`
              INSERT INTO stage_sends
                (org_id, campaign_id, stage_id, contact_id, phone, provider_phone_id,
                 rendered_text, status, created_at)
              VALUES (${orgId}::uuid, ${campaignId}, ${stage.stage_id}, ${lead.contact_id}::uuid,
                      ${lead.phone}, ${number.provider_phone_id}, ${body}, 'pending', now())
              RETURNING id
            `)) as unknown as { id: string }[];

            await tx.execute(sql`
              UPDATE drip_journeys
              SET state = 'active', first_send_at = now(),
                  first_stage_id = ${stage.stage_id}, first_send_id = ${ins[0].id}::uuid
              WHERE id = ${lead.journey_id}::uuid AND first_send_at IS NULL
            `);
          });
          res.inserted++;
          todayCount++;
        } catch (e) {
          const code = (e as { cause?: { code?: string } })?.cause?.code;
          // 23505 = the (stage, contact) dedup index. Another tick beat us.
          if (code !== "23505") throw e;
        }
      }

      // Headroom returned ⇒ clear any standing exhaustion alert.
      const after = await numbersWithHeadroom(db, { campaignId, now });
      if (pickNumber(after)) {
        await reportExhaustion(db, {
          orgId, campaignId, campaignName: head.campaign_name,
          exhausted: false, numbers: after,
        });
      }
    }
  }

  return res;
}

async function notifyDailyCapNear(
  orgId: string, campaignId: number, name: string | null, today: number, cap: number,
) {
  const { notifyOnTransition } = await import("@/lib/alerts/alert-state");
  const { etDay } = await import("./counters");
  // Keyed by ET DAY so it re-arms every day rather than firing once forever.
  await notifyOnTransition(db, {
    alertKey: `drip:daily_cap_near:${campaignId}:${etDay()}`,
    orgId,
    text:
      `⚠️ Drip campaign "${name ?? campaignId}" has used ${today}/${cap} of today's send cap ` +
      `(${Math.round((today / cap) * 100)}%). Leads beyond the cap wait for the next ET day.`,
  });
}
