import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { mintLinksBatch } from "@/lib/links/mint-link";
import { hasResolvableCredential } from "@/lib/sends/provider-credential";
import { enumerateStageRecipients } from "@/lib/sends/recipients";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { buildStageFullUrl } from "@/lib/stage-url";
import { loadStageUrlContext } from "@/lib/stage-url-context";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Kickoff materializes one stage_sends row per recipient and, in tracked mode,
// mints one unique link per recipient (send_token = the row id). It does NOT
// send anything — the Step-3 owner-gated drain does. campaign_stages.status /
// sent_at are intentionally left untouched.

export type KickoffRefusal =
  | "not_found"
  | "no_creative"
  | "already_pending"
  | "no_recipients"
  // tracked-only:
  | "stage_not_ready"
  | "no_provider"
  | "provider_not_api_capable"
  | "no_credentials"
  | "no_short_domain"
  | "no_destination";

export type KickoffResult =
  | {
      ok: true;
      mode: "manual" | "tracked";
      materialized: number;
      shortDomain: string | null;
    }
  | { ok: false; reason: KickoffRefusal };

interface MainRow {
  link_mode: string;
  brand_id: number | null;
  offer_id: number | null;
  campaign_tracking_id: string | null;
  brand_name: string | null;
  creative_id: number | null;
  stage_tracking_id: string | null;
  short_url: string | null;
  stop_text: string;
  sales_page_label: string | null;
  utm_tag_ids: number[];
  sms_provider_id: number | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  creative_text: string | null;
}

export async function kickoffStageSend(
  tx: DbOrTx,
  { orgId, campaignId, stageId }: { orgId: string; campaignId: number; stageId: number },
): Promise<KickoffResult> {
  const main = (await tx.execute(sql`
    SELECT
      c.link_mode                AS link_mode,
      c.brand_id                 AS brand_id,
      c.offer_id                 AS offer_id,
      c.tracking_id              AS campaign_tracking_id,
      b.name                     AS brand_name,
      s.creative_id              AS creative_id,
      s.tracking_id              AS stage_tracking_id,
      s.short_url                AS short_url,
      s.stop_text                AS stop_text,
      s.sales_page_label         AS sales_page_label,
      s.utm_tag_ids              AS utm_tag_ids,
      s.sms_provider_id          AS sms_provider_id,
      s.include_no_status        AS include_no_status,
      s.include_clickers         AS include_clickers,
      s.exclude_clickers         AS exclude_clickers,
      s.split_index              AS split_index,
      s.split_total              AS split_total,
      cr.text                    AS creative_text
    FROM campaigns c
    JOIN campaign_stages s ON s.id = ${stageId} AND s.campaign_id = c.id
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN creatives cr ON cr.id = s.creative_id
    WHERE c.id = ${campaignId} AND c.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as MainRow[];

  const row = main[0];
  if (!row) return { ok: false, reason: "not_found" };

  const mode: "manual" | "tracked" = row.link_mode === "tracked" ? "tracked" : "manual";
  const brandName = row.brand_name ?? "";
  if (!row.creative_text) return { ok: false, reason: "no_creative" };

  // Guard against accidental double-materialization: refuse if this stage
  // already has un-sent (pending/sending) rows. A genuine resend clears/
  // resolves those first, then re-kicks (new run, new tokens).
  const existing = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE stage_id = ${stageId} AND status IN ('pending', 'sending')
  `)) as unknown as { n: number }[];
  if (Number(existing[0]?.n ?? 0) > 0) return { ok: false, reason: "already_pending" };

  const recipients = await enumerateStageRecipients(tx, {
    campaignId,
    orgId,
    filters: {
      includeNoStatus: row.include_no_status,
      includeClickers: row.include_clickers,
      excludeClickers: row.exclude_clickers,
      splitIndex: row.split_index ?? null,
      splitTotal: row.split_total ?? null,
    },
  });
  if (recipients.length === 0) return { ok: false, reason: "no_recipients" };

  // ---- Manual mode: freeze the pasted short_url into every row, no minting.
  if (mode === "manual") {
    const renderedText = buildStageSms({
      brandName,
      creativeText: row.creative_text,
      linkUrl: row.short_url,
      stopText: row.stop_text,
    });
    await bulkInsertStageSends(
      tx,
      recipients.map((r) => {
        const id = randomUUID();
        return {
          id,
          orgId,
          campaignId,
          stageId,
          contactId: r.contact_id,
          phone: r.phone_number,
          linkId: null,
          renderedText,
          leadId: id,
        };
      }),
    );
    return { ok: true, mode, materialized: recipients.length, shortDomain: null };
  }

  // ---- Tracked mode: enforce condition (b) + mint a unique link per recipient.
  if (!row.stage_tracking_id || !row.campaign_tracking_id) {
    return { ok: false, reason: "stage_not_ready" };
  }
  if (row.sms_provider_id == null) return { ok: false, reason: "no_provider" };

  const provider = (await tx.execute(sql`
    SELECT supports_api_send FROM sms_providers
    WHERE id = ${row.sms_provider_id} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as { supports_api_send: boolean }[];
  if (!provider[0]?.supports_api_send) {
    return { ok: false, reason: "provider_not_api_capable" };
  }

  // Brand-aware: require a key resolvable for (provider, this campaign's brand)
  // or the provider-default. Matches what the Step-3 drain will use to send.
  const hasCred = await hasResolvableCredential(tx, {
    orgId,
    providerId: row.sms_provider_id,
    brandId: row.brand_id,
  });
  if (!hasCred) return { ok: false, reason: "no_credentials" };

  // Deterministic short-domain pick: active, brand-scoped, stable order so a
  // brand always mints under the same domain. (No is_primary column exists; if
  // one is added later, ORDER BY it first.)
  const sd = (await tx.execute(sql`
    SELECT id, domain FROM short_domains
    WHERE org_id = ${orgId} AND brand_id = ${row.brand_id} AND status = 'active'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `)) as unknown as { id: number; domain: string }[];
  if (!sd[0]) return { ok: false, reason: "no_short_domain" };
  const shortDomain = sd[0];

  const ctxResult = await loadStageUrlContext({
    orgId,
    offerId: row.offer_id,
    salesPageLabel: row.sales_page_label,
    utmTagIds: row.utm_tag_ids ?? [],
    dbc: tx,
  });
  // utm ownership was already verified at stage save; treat a failure as not-ready.
  if (!ctxResult.ok) return { ok: false, reason: "stage_not_ready" };
  const destinationUrl = buildStageFullUrl({
    salesPageUrl: ctxResult.ctx.salesPageUrl,
    postfix: ctxResult.ctx.postfix,
    trackingId: row.stage_tracking_id,
    utmTags: ctxResult.ctx.utmTags,
  });
  if (!destinationUrl) return { ok: false, reason: "no_destination" };

  // One send_token (= the stage_sends row id) per recipient, minted in bulk.
  const tokens = recipients.map((r) => ({
    contactId: r.contact_id,
    phone: r.phone_number,
    sendToken: randomUUID(),
  }));
  const minted = await mintLinksBatch(tx, {
    orgId,
    campaignId,
    stageId,
    creativeId: row.creative_id,
    shortDomainId: shortDomain.id,
    destinationUrl,
    campaignTrackingId: row.campaign_tracking_id,
    stageTrackingId: row.stage_tracking_id,
    items: tokens.map((t) => ({ contactId: t.contactId, sendToken: t.sendToken })),
  });

  // Build each row's frozen text from the code that actually landed, then bulk
  // insert. The map is guaranteed complete — mintLinksBatch throws otherwise.
  await bulkInsertStageSends(
    tx,
    tokens.map((t) => {
      const link = minted.get(t.sendToken);
      if (!link) {
        throw new Error(`kickoff: missing minted link for send_token ${t.sendToken}`);
      }
      return {
        id: t.sendToken,
        orgId,
        campaignId,
        stageId,
        contactId: t.contactId,
        phone: t.phone,
        linkId: link.id,
        renderedText: buildStageSms({
          brandName,
          creativeText: row.creative_text!,
          linkUrl: `https://${shortDomain.domain}/r/${link.code}`,
          stopText: row.stop_text,
        }),
        leadId: t.sendToken,
      };
    }),
  );

  return {
    ok: true,
    mode,
    materialized: recipients.length,
    shortDomain: shortDomain.domain,
  };
}

interface StageSendInsertRow {
  id: string;
  orgId: string;
  campaignId: number;
  stageId: number;
  contactId: string;
  phone: string;
  linkId: number | null;
  renderedText: string;
  leadId: string;
}

const STAGE_SENDS_CHUNK = 500;

// Chunked multi-row INSERT — replaces the per-recipient round-trip loop that
// dominated kickoff latency at scale.
async function bulkInsertStageSends(
  tx: DbOrTx,
  rows: StageSendInsertRow[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += STAGE_SENDS_CHUNK) {
    const chunk = rows.slice(start, start + STAGE_SENDS_CHUNK);
    const values = chunk.map(
      (r) => sql`(
        ${r.id}, ${r.orgId}, ${r.campaignId}, ${r.stageId}, ${r.contactId},
        ${r.phone}, ${r.linkId}, ${r.renderedText}, 'pending', ${r.leadId}
      )`,
    );
    await tx.execute(sql`
      INSERT INTO stage_sends
        (id, org_id, campaign_id, stage_id, contact_id, phone, link_id,
         rendered_text, status, lead_id)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }
}
