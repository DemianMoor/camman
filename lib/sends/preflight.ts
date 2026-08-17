import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { resolveSendsPerSecond } from "@/lib/sends/circuit-breakers";
import { hasResolvableCredential } from "@/lib/sends/provider-credential";
import { stageRecipientsSql } from "@/lib/sends/recipients";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Read-only pre-flight validation for a stage send (WS2). Mirrors the structural
// refusal reasons of kickoffStageSend WITHOUT materializing, so the operator sees
// every blocker before committing — and the WS4 readiness checklist can render
// the same green/red live. Spam score is deliberately NOT a check (it's advisory,
// never a send gate). Kickoff remains the authoritative gate at commit time.
export type PreflightBlocker =
  | "no_creative"
  | "no_recipients"
  | "stage_not_ready" // tracking ids not generated yet
  | "no_provider"
  | "provider_not_api_capable"
  // sms_providers.sends_enabled is off (0138) — the operator's posture for this
  // account. Mirrors the kickoff refusal of the same name so the checklist and
  // the commit-time gate cannot disagree.
  | "provider_sends_disabled"
  | "no_sender_number" // API-send stage has no provider_phone_id assigned
  | "no_credentials"
  | "no_short_domain";

export interface PreflightCheck {
  key: string;
  ok: boolean;
  label: string;
}

export interface PreflightResult {
  ok: boolean;
  mode: "manual" | "tracked";
  recipient_count: number;
  blockers: PreflightBlocker[];
  checks: PreflightCheck[];
  // Creative body (link added per recipient at mint). Lets the shared Prepare
  // popup show a message preview + segment count BEFORE materialization, when no
  // per-recipient frozen text exists yet. Null when no creative is attached.
  preview_text: string | null;
  // Phase 4 throughput guardrail (tracked mode). The chosen sending number's HARD
  // per-second rate and the resulting estimated drain time, so the operator sees
  // BEFORE approving that a large audience on a low-rate number (e.g. a 3/s toll-
  // free) will take a long time — the operational trigger behind the 2026-07-24
  // head-of-line incident. Null when no sender number is assigned / manual mode.
  sender_sends_per_second: number | null;
  estimated_drain_seconds: number | null;
  // Non-blocking advisories (does NOT set ok=false). Currently the slow-number
  // warning; rendered next to the recipient count in the confirm UI.
  warnings: string[];
}

// Estimated drain time above which the slow-number warning fires (15 min). At a
// short code's 60/s that's ~54K messages; at a 3/s toll-free it's just ~2,700 —
// which is exactly the mismatch we want to surface at build time.
const SLOW_DRAIN_WARNING_SECONDS = 15 * 60;

// Human "≈ 2h 5m" / "≈ 45m" / "≈ 30s" from seconds.
export function formatDrainEstimate(seconds: number): string {
  if (seconds < 60) return `≈ ${Math.max(1, Math.round(seconds))}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `≈ ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `≈ ${h}h` : `≈ ${h}h ${m}m`;
}

interface MainRow {
  link_mode: string;
  brand_id: number | null;
  campaign_tracking_id: string | null;
  creative_text: string | null;
  creative_id: number | null;
  offer_id: number | null;
  exclude_prior_offer_contacts: boolean;
  stage_tracking_id: string | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  supports_api_send: boolean | null;
  provider_sends_enabled: boolean | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  sender_max_sends_per_second: number | null;
}

export async function preflightStageSend(
  dbc: DbOrTx,
  { orgId, campaignId, stageId }: { orgId: string; campaignId: number; stageId: number },
): Promise<PreflightResult> {
  const rows = (await dbc.execute(sql`
    SELECT
      c.link_mode         AS link_mode,
      c.brand_id          AS brand_id,
      c.tracking_id       AS campaign_tracking_id,
      cr.text             AS creative_text,
      s.creative_id       AS creative_id,
      c.offer_id          AS offer_id,
      c.exclude_prior_offer_contacts AS exclude_prior_offer_contacts,
      s.tracking_id       AS stage_tracking_id,
      s.sms_provider_id   AS sms_provider_id,
      s.provider_phone_id AS provider_phone_id,
      p.supports_api_send AS supports_api_send,
      p.sends_enabled     AS provider_sends_enabled,
      s.include_no_status AS include_no_status,
      s.include_clickers  AS include_clickers,
      s.exclude_clickers  AS exclude_clickers,
      s.split_index       AS split_index,
      s.split_total       AS split_total,
      s.behavioral_tier   AS behavioral_tier,
      s.parent_stage_id   AS parent_stage_id,
      pp.max_sends_per_second AS sender_max_sends_per_second
    FROM campaigns c
    JOIN campaign_stages s ON s.id = ${stageId} AND s.campaign_id = c.id
    LEFT JOIN creatives cr ON cr.id = s.creative_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id AND p.org_id = ${orgId}
    LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id AND pp.org_id = ${orgId}
    WHERE c.id = ${campaignId} AND c.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as MainRow[];

  const row = rows[0];
  const mode: "manual" | "tracked" =
    row?.link_mode === "tracked" ? "tracked" : "manual";

  if (!row) {
    return {
      ok: false,
      mode,
      recipient_count: 0,
      blockers: ["no_creative"],
      checks: [{ key: "stage", ok: false, label: "Stage not found" }],
      preview_text: null,
      sender_sends_per_second: null,
      estimated_drain_seconds: null,
      warnings: [],
    };
  }

  // Recipient count via the SAME builder the kickoff materializes from.
  const cnt = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM (
      ${stageRecipientsSql({
        campaignId,
        orgId,
        filters: {
          includeNoStatus: row.include_no_status,
          includeClickers: row.include_clickers,
          excludeClickers: row.exclude_clickers,
          splitIndex: row.split_index ?? null,
          splitTotal: row.split_total ?? null,
          // Lane overlay → preflight's recipient count matches the lane the
          // kickoff will materialize (and the stages-list live preview).
          behavioralTier: row.behavioral_tier ?? null,
          parentStageId: row.parent_stage_id ?? null,
        },
        // Match the kickoff's content-dedup so the previewed recipient count
        // equals what will actually materialize.
        eligibility: {
          creativeId: row.creative_id ?? null,
          offerId: row.offer_id ?? null,
          excludePriorOffer: row.exclude_prior_offer_contacts,
        },
      })}
    ) q
  `)) as unknown as { n: number }[];
  const recipientCount = Number(cnt[0]?.n ?? 0);

  const checks: PreflightCheck[] = [];
  const blockers: PreflightBlocker[] = [];
  const add = (key: string, ok: boolean, label: string, blocker?: PreflightBlocker) => {
    checks.push({ key, ok, label });
    if (!ok && blocker) blockers.push(blocker);
  };

  add("creative", !!row.creative_text, "Creative attached", "no_creative");
  add("recipients", recipientCount > 0, `Recipients: ${recipientCount.toLocaleString()}`, "no_recipients");

  if (mode === "tracked") {
    add(
      "tracking_id",
      !!row.stage_tracking_id && !!row.campaign_tracking_id,
      "Tracking IDs generated",
      "stage_not_ready",
    );
    const hasProvider = row.sms_provider_id != null;
    add("provider", hasProvider, "SMS provider set", "no_provider");
    add(
      "provider_api",
      hasProvider && row.supports_api_send === true,
      "Provider supports API send",
      "provider_not_api_capable",
    );
    // Posture, checked after capability for the same reason kickoff does it in
    // that order: "this provider can't API-send at all" is the more fundamental
    // answer than "it's switched off". `=== true` so a NULL (no provider row
    // joined) does not read as enabled — the no_provider blocker owns that case.
    add(
      "provider_sends_enabled",
      hasProvider && row.provider_sends_enabled === true,
      "Provider sending is switched on",
      "provider_sends_disabled",
    );
    add(
      "sender",
      row.provider_phone_id != null,
      "Sending number assigned",
      "no_sender_number",
    );

    const hasCred = hasProvider
      ? await hasResolvableCredential(dbc, {
          orgId,
          providerId: row.sms_provider_id!,
          brandId: row.brand_id,
          providerPhoneId: row.provider_phone_id,
        })
      : false;
    add("credential", hasCred, "API credential resolvable", "no_credentials");

    const sd = (await dbc.execute(sql`
      SELECT 1 AS ok FROM short_domains
      WHERE org_id = ${orgId} AND brand_id = ${row.brand_id} AND status = 'active'
      LIMIT 1
    `)) as unknown as { ok: number }[];
    add("short_domain", sd.length > 0, "Active short domain", "no_short_domain");
  }

  // Phase 4 throughput guardrail (tracked, sender assigned). Estimate the drain
  // time at the number's HARD per-second rate and warn when it's long, so a large
  // audience on a low-rate number is caught at build time, not at send time.
  let senderRate: number | null = null;
  let estimatedDrainSeconds: number | null = null;
  const warnings: string[] = [];
  if (mode === "tracked" && row.provider_phone_id != null) {
    senderRate = resolveSendsPerSecond(row.sender_max_sends_per_second);
    if (recipientCount > 0) {
      estimatedDrainSeconds = Math.ceil(recipientCount / senderRate);
      if (estimatedDrainSeconds > SLOW_DRAIN_WARNING_SECONDS) {
        warnings.push(
          `At ${senderRate}/s, this number takes ${formatDrainEstimate(estimatedDrainSeconds)} to send ` +
            `${recipientCount.toLocaleString()} messages. Consider a faster sending number for large audiences.`,
        );
      }
    }
  }

  return {
    ok: blockers.length === 0,
    mode,
    recipient_count: recipientCount,
    blockers,
    checks,
    preview_text: row.creative_text ?? null,
    sender_sends_per_second: senderRate,
    estimated_drain_seconds: estimatedDrainSeconds,
    warnings,
  };
}
