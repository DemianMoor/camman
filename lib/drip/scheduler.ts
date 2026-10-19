import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { isCampaignPaused, isDripSendingHalted } from "@/lib/sends/circuit-breakers";
import { getDescriptor } from "@/lib/sends/providers/registry";
import {
  bodyCarriesStop,
  optOutGateSubject,
  resolveOptOutFooter,
} from "@/lib/sends/opt-out-footer";
import { formatStamp, renderMessage, shapeFromStage } from "@/lib/messages/render";
import { NO_RECIPIENT } from "@/lib/messages/tags";
import { skipIfTagged } from "./skip-send";
import { orderForHour } from "./hourly-cap";
import {
  clearIneligibleHourAssignments, prepareHourly, realHasHeadroom, recordSendRefusal,
  type HourlyRoomMap,
} from "./hourly-maintenance";
import { dripDailySendsPredicate } from "./daily-sends";
import { mintDripLeadLink } from "./mint";
import { isDripPostureOn } from "./in-use";

/** Rolls back the mint transaction when a component cannot be resolved, so a
 *  refusal skips ONE lead instead of aborting the batch. */
/** Rolls back the send transaction when the opt-out footer cannot be verified. */
class GateRefused extends Error {}

/** Rolls back the send transaction when the journey already has its first send
 *  — another run got there first, so this lead's message must not be queued. */
class JourneyAlreadyQueued extends Error {}

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
  /** Journeys another run had already given their first send — rolled back. */
  alreadyQueued: number;
  /** Leads left for a later run because their campaign's hour was already full. */
  hourlyCapBlocked: number;
  /** Assigned leads dropped by the hourly-cap maintenance (cap / closed / blocked). */
  hourlyDropped: number;
  /** 0216 interim: leads whose stage message uses a tag — skip row written once, journey left routed. */
  tagsSkipped: number;
}

export interface DueRow {
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
  brand_landing_path: string | null;
  hour_start: string | null;
  hour_fresh: boolean | null;
  routed_at: string;
}

export async function runDripSchedulerBatch(now: Date = new Date()): Promise<SchedulerResult> {
  const res: SchedulerResult = {
    postureOn: false, considered: 0, inserted: 0, waitingForWindow: 0,
    gateRefused: 0, mintRefused: 0, capBlocked: 0, numbersExhausted: 0, pausedSkipped: 0,
    alreadyQueued: 0, hourlyCapBlocked: 0, hourlyDropped: 0, tagsSkipped: 0,
  };

  // ⭐ HOURLY CAP step 0 (spec §4): org paused/off, flag off, campaign paused or
  // cap removed ⇒ assignments revert to waiting. Runs even when no org is live,
  // which is exactly when it matters (a paused org must not wake up to drops).
  await clearIneligibleHourAssignments(db);

  const orgs = (await db.execute(sql`
    SELECT org_id, drip_scheduler_fair FROM org_settings
    WHERE drip_enabled = true AND drip_paused = false
  `)) as unknown as { org_id: string; drip_scheduler_fair: boolean }[];
  if (orgs.length === 0) return res;
  res.postureOn = true;

  const nowMin = etMinutesOfDay(now);
  const { start: dayStart, end: dayEnd } = campaignDayBoundsUtc(now);

  for (const { org_id: orgId, drip_scheduler_fair: fair } of orgs) {
    if (!(await isDripPostureOn(orgId))) continue;

    const hourly = await prepareHourly(db, {
      orgId, now,
      notify: async (alertKey, oid, text) => {
        const { notifyOnTransition } = await import("@/lib/alerts/alert-state");
        await notifyOnTransition(db, { alertKey, orgId: oid, text });
      },
      deps: { hasHeadroom: (campaignId) => realHasHeadroom(campaignId, now) },
    });
    res.hourlyDropped += hourly.dropped.cap + hourly.dropped.closed + hourly.dropped.blocked;
    const due = await selectDueJourneys(db, { orgId, fair, batch: BATCH, hourly: hourly.rooms });

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
      const hourRoom = hourly.rooms.get(campaignId);
      if (hourRoom) leads.splice(0, leads.length, ...orderForHour(leads, hourRoom.carry));
      let hourSent = 0;

      // ⚠️ The campaign latch is checked BEFORE any insert, not after. A paused
      // campaign accumulates journeys; it must not accumulate pending sends,
      // because the drain would ship them the moment someone unpauses.
      // FRESH read too: the due list is as old as the tick, and a pause (campaign
      // latch or the org drip switches) can land while earlier campaigns insert.
      if (head.campaign_paused ||
          await isCampaignPaused(db, campaignId) ||
          await isDripSendingHalted(db, campaignId)) {
        res.pausedSkipped += leads.length;
        continue;
      }

      const stages = (await db.execute(sql`
        SELECT s.id AS stage_id, s.window_start_min, s.window_end_min,
               s.creative_id, s.stop_text, s.short_url, s.landing_page_id,
               s.tracking_id AS stage_tracking_id, s.full_url,
               s.message_format_id, s.custom_text, mf.template AS format_template,
               cr.text AS creative_text,
               lp.kind AS lp_kind, lp.slug AS lp_slug,
               lp.external_url AS lp_external_url, lp.status AS lp_status
        FROM campaign_stages s
        LEFT JOIN creatives cr ON cr.id = s.creative_id
        LEFT JOIN message_formats mf ON mf.id = s.message_format_id AND mf.org_id = s.org_id
        LEFT JOIN offer_landing_pages lp
               ON lp.id = s.landing_page_id AND lp.org_id = s.org_id
        WHERE s.campaign_id = ${campaignId}
          AND s.drip_active IS TRUE
          AND s.archived_at IS NULL
          -- ⚠️ FIRST-SEND STAGES ONLY. A behavioural lane (parent_stage_id set)
          -- fires off its parent's send via lib/drip/followups.ts and must never
          -- be picked as a lead's FIRST message — which pickStage would do the
          -- moment a lane carried a window.
          AND s.parent_stage_id IS NULL
        ORDER BY s.window_start_min
      `)) as unknown as (StageWindow & {
        stage_id: number; creative_id: number | null; stop_text: string | null;
        short_url: string | null; landing_page_id: number | null; creative_text: string | null;
        full_url: string | null;
        stage_tracking_id: string | null;
        message_format_id: number | null; custom_text: string | null; format_template: string | null;
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

      // 0216: the stage's message shape renders every body and stamps every row.
      const shape = shapeFromStage(stage);
      const stamp = formatStamp(shape);
      // INTERIM (P2 → P5): tag rendering is not built yet. Each lead gets ONE
      // skipped_ineligible row (idempotent) and its journey stays routed, so it
      // sends normally once the tag is removed from the creative / custom text.
      const tagged = await skipIfTagged(db, {
        orgId, campaignId, stageId: stage.stage_id, creativeText: stage.creative_text, shape, leads,
      });
      if (tagged !== null) {
        res.tagsSkipped += tagged;
        continue;
      }

      // ── caps, counted over the ET day as a RANGE (never a functional
      // predicate on sent_at — R15) ──────────────────────────────────────
      const counts = (await db.execute(sql`
        SELECT
          COALESCE((SELECT count(*)::int FROM stage_sends ss
                    WHERE ss.campaign_id = ${campaignId}
                      AND ${dripDailySendsPredicate(dayStart, dayEnd)}), 0) AS today,
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
        if (hourRoom && hourSent >= hourRoom.room) {
          res.hourlyCapBlocked++;
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
              brandLandingPath: head.brand_landing_path,
              handEditedUrl: stage.full_url,
              landingPage: {
                id: stage.landing_page_id,
                kind: stage.lp_kind,
                slug: stage.lp_slug,
                external_url: stage.lp_external_url,
                status: stage.lp_status,
              },
            });
            if (!r.ok) throw new MintRefused(r.reason, r.message);

            const rendered = renderMessage({
              shape,
              brandName: head.brand_name ?? "",
              creativeText: stage.creative_text!,
              linkUrl: r.linkUrl,
              stopText: footer.text,
              recipient: NO_RECIPIENT,
            });
            // Unreachable while the interim tag gate above holds.
            if (!rendered.ok) throw new GateRefused(`render refused: ${rendered.reason} ${rendered.tag}`);
            const body = rendered.body;

            // ⭐ THE GATE, PER MESSAGE, ON THE FINAL TEXT.
            const gate = optOutGateSubject({
              renderedBody: body,
              resolved: footer,
              providerKnownAppendedText: descriptor?.defaultOptOutFooter ?? null,
            });
            const hasStop = bodyCarriesStop(gate.subject);
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
                 link_id, rendered_text, status, created_at, cost_per_sms,
                 message_format_id, format_custom)
              VALUES (${sendToken}::uuid, ${orgId}::uuid, ${campaignId}, ${stage.stage_id},
                      ${lead.contact_id}::uuid, ${lead.phone}, ${number.provider_phone_id},
                      ${r.linkId}, ${body}, 'pending', now(),
                      -- Snapshot the number's rate at send time (0112), as
                      -- kickoff does: the partner report's Send Cost must not
                      -- move when the number's rate is edited later.
                      (SELECT pp.cost_per_sms FROM provider_phones pp
                       WHERE pp.id = ${number.provider_phone_id}),
                      ${stamp.messageFormatId}, ${stamp.formatCustom})
              RETURNING id
            `)) as unknown as { id: string }[];

            await stampDripStageDrainable(tx, { stageId: stage.stage_id, orgId });

            // ⭐ ZERO ROWS ⇒ ROLL BACK. The guards `first_send_at IS NULL AND state = 'routed'`
            // (a journey closed meanwhile is never resurrected); `first_send_at IS NULL` alone
            // would let this transaction COMMIT its stage_sends row even when
            // another run already gave the journey its first send (a different
            // stage after a window boundary, or the same stage once the other
            // row left 'pending' — the (stage, contact) unique only covers
            // live rows). Throwing undoes the link, the row and the stamp.
            const claimed = (await tx.execute(sql`
              UPDATE drip_journeys
              SET state = 'active', first_send_at = now(),
                  first_stage_id = ${stage.stage_id}, first_send_id = ${ins[0].id}::uuid
              WHERE id = ${lead.journey_id}::uuid AND first_send_at IS NULL AND state = 'routed'
              RETURNING id
            `)) as unknown as { id: string }[];
            if (claimed.length === 0) throw new JourneyAlreadyQueued();
          });
          res.inserted++;
          todayCount++;
          hourSent++;
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
            if (hourRoom) await recordSendRefusal(db, { journeyId: lead.journey_id, kind: "mint", now });
            continue;
          }
          if (e instanceof JourneyAlreadyQueued) {
            res.alreadyQueued++;
            continue;
          }
          if (e instanceof GateRefused) {
            console.error(
              `[drip-scheduler] opt-out gate REFUSED lead ${lead.journey_id} ` +
                `(campaign ${campaignId}, stage ${stage.stage_id}, ` +
                `provider ${pr?.adapter_code ?? "?"}): ${e.message}`,
            );
            res.gateRefused++;
            if (hourRoom) await recordSendRefusal(db, { journeyId: lead.journey_id, kind: "gate", now });
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

/**
 * The scheduler's batch of due first sends: routed journeys of ACTIVE drip
 * campaigns with no first send yet. Exported for scripts/test-drip-scheduler-fairness.ts.
 */
export async function selectDueJourneys(
  dbc: DripTx,
  { orgId, fair, batch, hourly }: { orgId: string; fair: boolean; batch: number; hourly: HourlyRoomMap },
): Promise<DueRow[]> {
  // ⭐ PER-CAMPAIGN FAIRNESS (0207, org_settings.drip_scheduler_fair). The
  // batch used to be the BATCH oldest routed journeys org-wide, so one
  // campaign's backlog took every slot: on 2026-10-12, 11.7K journeys of
  // campaign 1637 released at once held campaign 1683's fresh leads for up to
  // 20 min. With the flag on, each campaign's journeys are ranked oldest first
  // and the batch takes rank 1 of every campaign, then rank 2, … — so a
  // campaign with 5 fresh leads gets all 5 in the very next batch, whatever
  // another campaign has queued. Within a campaign the order is unchanged.
  // Flag off = the old order, byte for byte.
  //
  // ⭐ HOURLY CAP (0209). `hourly` holds every hourly-capped campaign with its
  // current hour and the room it has left THIS run. For those campaigns only
  // journeys already on an hour are due (waiting ones are not accumulating), the
  // per-campaign rank follows the hour order, and rank > room never enters the
  // batch — a full hour takes no slots from other campaigns. An EMPTY map takes
  // the pre-0209 query text (plus three selected columns).
  const recs = JSON.stringify([...hourly].map(([id, v]) => ({
    campaign_id: id, hour_start: v.hourStart.toISOString(), room: v.room, carry: v.carry,
  })));
  const hRecordset = sql`jsonb_to_recordset(${recs}::jsonb) AS h(campaign_id int, hour_start timestamptz, room int, carry boolean)`;
  const capped = hourly.size > 0;
  // Hourly-capped campaign ⇒ assigned journeys up to the current hour only.
  // sql.raw: `j` is always a hard-coded alias here ("j0" / "j"), never input.
  const dueFilter = (j: string) => sql.raw(
    `AND (h.campaign_id IS NULL OR (${j}.hour_start IS NOT NULL AND ${j}.hour_start <= h.hour_start AND h.room > 0))`);
  // ON: earlier hour first. OFF: fresh before backlog. Non-capped rows: both keys constant.
  const hourKeys = (j: string) => sql.raw(
    `CASE WHEN h.carry THEN ${j}.hour_start END ASC NULLS FIRST,
     CASE WHEN h.carry IS FALSE AND ${j}.hour_fresh IS FALSE THEN 1 ELSE 0 END,`);

  const pick = fair
    ? capped
      ? sql`
    FROM (
      SELECT r.id, r.fair_rank FROM (
        SELECT j0.id, h.room,
               row_number() OVER (PARTITION BY j0.campaign_id
                                  ORDER BY ${hourKeys("j0")} j0.routed_at, j0.id) AS fair_rank,
               j0.routed_at
        FROM drip_journeys j0
        JOIN campaigns c0 ON c0.id = j0.campaign_id
        LEFT JOIN ${hRecordset} ON h.campaign_id = j0.campaign_id
        WHERE j0.org_id = ${orgId}::uuid
          AND j0.state = 'routed'
          AND j0.first_send_at IS NULL
          AND c0.type = 'drip'
          AND c0.status = 'active'
          ${dueFilter("j0")}
      ) r
      WHERE r.room IS NULL OR r.fair_rank <= r.room
      ORDER BY r.fair_rank, r.routed_at, r.id
      LIMIT ${batch}
    ) f
    JOIN drip_journeys j ON j.id = f.id`
      : sql`
    FROM (
      SELECT j0.id,
             row_number() OVER (PARTITION BY j0.campaign_id ORDER BY j0.routed_at, j0.id) AS fair_rank
      FROM drip_journeys j0
      JOIN campaigns c0 ON c0.id = j0.campaign_id
      WHERE j0.org_id = ${orgId}::uuid
        AND j0.state = 'routed'
        AND j0.first_send_at IS NULL
        AND c0.type = 'drip'
        AND c0.status = 'active'
      ORDER BY fair_rank, j0.routed_at, j0.id
      LIMIT ${batch}
    ) f
    JOIN drip_journeys j ON j.id = f.id`
    : sql`
    FROM drip_journeys j`;
  const order = fair ? sql`ORDER BY f.fair_rank, j.routed_at, j.id` : sql`ORDER BY j.routed_at`;
  return (await dbc.execute(sql`
    SELECT j.id AS journey_id, j.org_id, j.campaign_id, j.contact_id,
           j.hour_start, j.hour_fresh, j.routed_at,
           c.name AS campaign_name, c.link_mode,
           (c.send_paused IS TRUE) AS campaign_paused,
           false AS drip_paused,
           ct.phone_number AS phone,
           b.name AS brand_name,
           c.brand_id, c.tracking_id AS campaign_tracking_id,
           b.landing_host AS brand_landing_host,
           b.landing_path AS brand_landing_path,
           cfg.daily_cap, cfg.campaign_cap
    ${pick}
    JOIN campaigns c  ON c.id = j.campaign_id
    JOIN contacts ct  ON ct.id = j.contact_id
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    ${capped && !fair ? sql`LEFT JOIN ${hRecordset} ON h.campaign_id = j.campaign_id` : sql``}
    WHERE j.org_id = ${orgId}::uuid
      AND j.state = 'routed'
      AND j.first_send_at IS NULL
      AND c.type = 'drip'
      AND c.status = 'active'
      ${capped && !fair ? dueFilter("j") : sql``}
    ${order}
    LIMIT ${batch}
  `)) as unknown as DueRow[];
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
