import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
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
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  behavioral_tier: number | null;
  parent_stage_id: number | null;
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
      s.include_no_status AS include_no_status,
      s.include_clickers  AS include_clickers,
      s.exclude_clickers  AS exclude_clickers,
      s.split_index       AS split_index,
      s.split_total       AS split_total,
      s.behavioral_tier   AS behavioral_tier,
      s.parent_stage_id   AS parent_stage_id
    FROM campaigns c
    JOIN campaign_stages s ON s.id = ${stageId} AND s.campaign_id = c.id
    LEFT JOIN creatives cr ON cr.id = s.creative_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id AND p.org_id = ${orgId}
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

  return {
    ok: blockers.length === 0,
    mode,
    recipient_count: recipientCount,
    blockers,
    checks,
    preview_text: row.creative_text ?? null,
  };
}
