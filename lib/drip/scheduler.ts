import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { optOutGateSubject, resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { mintDripLeadLink } from "./mint";
import { isDripPostureOn } from "./in-use";

/** Rolls back the mint transaction when a component cannot be resolved, so a
 *  refusal skips ONE lead instead of aborting the batch. */
/** Rolls back the send transaction when the opt-out footer cannot be verified. */
class GateRefused extends Error {}

class MintRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Either the pooled client or an open transaction — the stamp needs the SAME
 *  connection as the stage_sends insert, so callers pass their `tx`. */
type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
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
  /** Leads skipped because their tracked link could not be minted (ruling D). */
  mintRefused: number;
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
  brand_id: number | null;
  campaign_tracking_id: string | null;
  brand_landing_host: string | null;
}

export async function runDripSchedulerBatch(now: Date = new Date()): Promise<SchedulerResult> {
  const res: SchedulerResult = {
    postureOn: false, considered: 0, inserted: 0, waitingForWindow: 0,
    gateRefused: 0, mintRefused: 0, capBlocked: 0, numbersExhausted: 0, pausedSkipped: 0,
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
             c.brand_id, c.tracking_id AS campaign_tracking_id,
             b.landing_host AS brand_landing_host,
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
               s.tracking_id AS stage_tracking_id,
               cr.text AS creative_text,
               lp.kind AS lp_kind, lp.slug AS lp_slug,
               lp.external_url AS lp_external_url, lp.status AS lp_status
        FROM campaign_stages s
        LEFT JOIN creatives cr ON cr.id = s.creative_id
        LEFT JOIN offer_landing_pages lp
               ON lp.id = s.landing_page_id AND lp.org_id = s.org_id
        WHERE s.campaign_id = ${campaignId}
          AND s.drip_active IS TRUE
          AND s.archived_at IS NULL
        ORDER BY s.window_start_min
      `)) as unknown as (StageWindow & {
        stage_id: number; creative_id: number | null; stop_text: string | null;
        short_url: string | null; landing_page_id: number | null; creative_text: string | null;
        stage_tracking_id: string | null;
        lp_kind: string | null; lp_slug: string | null;
        lp_external_url: string | null; lp_status: string | null;
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

        // ⭐ ONE LINK PER LEAD, MINTED BEFORE THE BODY EXISTS (ruling D).
        // The rendered text cannot be built until the link code is known, and
        // the link cannot be minted without the destination, so resolution and
        // minting happen here rather than reading a static column. The mint
        // shares its transaction with the stage_sends insert below, so a failure
        // at any point leaves neither an orphan link nor a linkless message.
        // ⭐ ONE TRANSACTION: MINT, RENDER, GATE, INSERT, STAMP, JOURNEY.
        // The body cannot be built before the link code exists, and the gate
        // must judge the text that will ACTUALLY be sent, so all of it lives
        // inside one transaction. Any refusal rolls the whole thing back --
        // no orphan link for a message that was never sent, and no message
        // without its link.
        const sendToken = randomUUID();
        try {
          await db.transaction(async (tx) => {
            const r = await mintDripLeadLink(tx, {
              orgId,
              campaignId,
              stageId: stage.stage_id,
              contactId: lead.contact_id,
              creativeId: stage.creative_id,
              brandId: head.brand_id,
              providerPhoneId: number.provider_phone_id,
              sendToken,
              campaignTrackingId: head.campaign_tracking_id,
              stageTrackingId: stage.stage_tracking_id,
              brandLandingHost: head.brand_landing_host,
              landingPage: {
                id: stage.landing_page_id,
                kind: stage.lp_kind,
                slug: stage.lp_slug,
                external_url: stage.lp_external_url,
                status: stage.lp_status,
              },
            });
            if (!r.ok) throw new MintRefused(r.reason, r.message);

            const body = buildStageSms({
              brandName: head.brand_name ?? "",
              creativeText: stage.creative_text!,
              linkUrl: r.linkUrl,
              stopText: footer.text,
            });

            // ⭐ THE GATE, PER MESSAGE, ON THE FINAL TEXT.
            const gate = optOutGateSubject({
              renderedBody: body,
              resolved: footer,
              providerKnownAppendedText: descriptor?.defaultOptOutFooter ?? null,
            });
            const hasStop = /STOP/i.test(gate.subject);
            if (!gate.verifiable || (!hasStop && pr?.adapter_code === "txr")) {
              throw new GateRefused(
                !gate.verifiable ? "footer unverifiable" : "no STOP in rendered body",
              );
            }

            // id = sendToken so the row and its link share one identity, the
            // same pairing kickoff uses; link_id is what makes the /r/ click
            // resolvable back to this exact message.
            const ins = (await tx.execute(sql`
              INSERT INTO stage_sends
                (id, org_id, campaign_id, stage_id, contact_id, phone, provider_phone_id,
                 link_id, rendered_text, status, created_at)
              VALUES (${sendToken}::uuid, ${orgId}::uuid, ${campaignId}, ${stage.stage_id},
                      ${lead.contact_id}::uuid, ${lead.phone}, ${number.provider_phone_id},
                      ${r.linkId}, ${body}, 'pending', now())
              RETURNING id
            `)) as unknown as { id: string }[];

            await stampDripStageDrainable(tx, { stageId: stage.stage_id, orgId });

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
          // ⚠️ FAIL CLOSED, ONE LEAD AT A TIME. Every refusal below leaves the
          // journey 'routed', so fixing the configuration lets the next tick
          // pick this lead up unchanged — nothing is lost, nothing half-sent.
          if (e instanceof MintRefused) {
            console.error(
              `[drip-scheduler] MINT REFUSED lead ${lead.journey_id} ` +
                `(campaign ${campaignId}, stage ${stage.stage_id}): ${e.reason} — ${e.message}`,
            );
            res.mintRefused++;
            continue;
          }
          if (e instanceof GateRefused) {
            console.error(
              `[drip-scheduler] opt-out gate REFUSED lead ${lead.journey_id} ` +
                `(campaign ${campaignId}, stage ${stage.stage_id}, ` +
                `provider ${pr?.adapter_code ?? "?"}): ${e.message}`,
            );
            res.gateRefused++;
            continue;
          }
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

// ── stamp the stage drainable (Drip P5, ruling C) ───────────
//
// The drain requires send_approved = true AND materialized_at IS NOT
// NULL AND (sent_at IS NOT NULL OR scheduled_at <= now()). Nothing
// else in the drip path writes those, so without this the rows
// inserted just above would sit 'pending' for ever.
//
// ⚠️ THIS IS WHERE DRIP'S HUMAN APPROVAL LIVES. For a regular stage
// send_approved is a person pressing approve. A drip stage has no
// such moment -- leads arrive unattended -- so the approval is the
// three deliberate acts that had to happen before this line could
// run: drip_active on the stage, posture on for the org, and the
// campaign moved to active. `drip_active IS TRUE` in the WHERE is
// what keeps that bargain: this statement can NEVER approve a
// regular stage, whatever else goes wrong upstream.
//
// ⚠️ TWO-WRITER HAZARD ON sent_at. campaign_stages.sent_at is also
// written by the "Mark as sent" status action, and the scheduled-send
// path uses it as a fire-lock -- stamping it out from under that path
// once silently cancelled a scheduled send. Hence COALESCE, never a
// bare assignment: this only ever fills a NULL, so whichever writer
// arrives first wins and neither can erase the other. The trailing
// predicate makes the second pass a true no-op rather than a
// same-value rewrite.
export async function stampDripStageDrainable(
  tx: DripTx,
  { stageId, orgId }: { stageId: number; orgId: string },
) {
  await tx.execute(sql`
    UPDATE campaign_stages
    SET send_approved  = true,
        materialized_at = COALESCE(materialized_at, now()),
        sent_at         = COALESCE(sent_at, now())
    WHERE id = ${stageId}
      AND org_id = ${orgId}::uuid
      AND drip_active IS TRUE
      AND (send_approved IS NOT TRUE
           OR materialized_at IS NULL
           OR sent_at IS NULL)
  `);
}
