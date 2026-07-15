import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { CODE_LENGTH, mintLinksBatch } from "@/lib/links/mint-link";
import { hasResolvableCredential } from "@/lib/sends/provider-credential";
import { enumerateStageRecipients } from "@/lib/sends/recipients";
import { countSegments, MAX_SEGMENTS } from "@/lib/sends/segments";
import { buildStageSms } from "@/lib/sends/stage-sms";
import {
  buildStageFullUrl,
  isGuideknLpUrl,
  validateDestination,
} from "@/lib/stage-url";
import { loadStageUrlContext } from "@/lib/stage-url-context";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Kickoff materializes one stage_sends row per recipient and, in tracked mode,
// mints one unique link per recipient (send_token = the row id). It does NOT
// send anything — the Step-3 owner-gated drain does. campaign_stages.status /
// sent_at are left untouched.
//
// RESUMABLE (WS5): materialization is done in COMMITTED WINDOWS, not one atomic
// transaction, so a huge audience can't blow the request/cron time budget and
// roll everything back. The completeness signal is campaign_stages.materialized_at
// — set ONLY when the last window lands. The scheduler resumes any due stage with
// materialized_at IS NULL, and only DRAINS (sends) stages with materialized_at
// IS NOT NULL, so a partially-built audience can never be sent. Re-runs are
// idempotent: the recipient query excludes already-materialized contacts, and the
// stage_sends insert is ON CONFLICT DO NOTHING against stage_sends_active_contact_uniq.
//
// kickoffStageSend takes the base `db` (NOT a tx) because it opens one
// transaction PER WINDOW. Callers must NOT wrap it in an outer transaction.

// One window = one committed transaction (mint + insert). 2000 keeps the link
// mint (11 cols) and stage_sends insert (10 cols) well under Postgres's param cap.
const MATERIALIZE_WINDOW = 2000;
// Per-invocation time budget. When exceeded mid-materialization we stop and leave
// materialized_at NULL; the next invocation (cron tick, or a re-Prepare) resumes
// from the committed rows. 45s comfortably fits a manual Prepare inside its 300s
// route ceiling while returning promptly; the cron passes a larger budget.
export const DEFAULT_MATERIALIZE_BUDGET_MS = 45_000;

export type KickoffRefusal =
  | "not_found"
  | "no_creative"
  | "no_schedule"
  | "no_recipients"
  // tracked-only:
  | "stage_not_ready"
  | "no_provider"
  | "provider_not_api_capable"
  | "no_credentials"
  | "no_short_domain"
  | "no_destination"
  // The resolved destination is a malformed guidekn URL — refuse rather than
  // ship a 404 that silently loses attribution.
  | "invalid_destination"
  // Rendered text (creative + brand prefix + tracked link + stop text)
  // exceeds 1 SMS segment and the creative hasn't opted in
  // (allow_multi_segment=false). Spec §4.
  | "multi_segment_not_allowed"
  // G8 hard ceiling: text exceeds MAX_SEGMENTS regardless of the creative's
  // allow_multi_segment override — never runaway multipart.
  | "segment_ceiling_exceeded";

export type KickoffResult =
  | {
      ok: true;
      mode: "manual" | "tracked";
      // Recipients materialized in THIS invocation (0 when already complete).
      materialized: number;
      // True when the stage is now FULLY materialized (materialized_at set). False
      // when the time budget was hit mid-way — the remainder resumes next tick.
      complete: boolean;
      shortDomain: string | null;
    }
  | { ok: false; reason: KickoffRefusal };

interface MainRow {
  link_mode: string;
  scheduled_at: string | null;
  materialized_at: string | null;
  brand_id: number | null;
  offer_id: number | null;
  campaign_tracking_id: string | null;
  brand_name: string | null;
  creative_id: number | null;
  stage_tracking_id: string | null;
  short_url: string | null;
  full_url: string | null;
  stop_text: string;
  sales_page_label: string | null;
  utm_tag_ids: number[];
  sms_provider_id: number | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  creative_text: string | null;
  creative_allow_multi_segment: boolean;
  exclude_prior_offer_contacts: boolean;
}

export async function kickoffStageSend(
  dbc: typeof db,
  {
    orgId,
    campaignId,
    stageId,
    budgetMs = DEFAULT_MATERIALIZE_BUDGET_MS,
  }: { orgId: string; campaignId: number; stageId: number; budgetMs?: number },
): Promise<KickoffResult> {
  const deadline = Date.now() + budgetMs;

  const main = (await dbc.execute(sql`
    SELECT
      c.link_mode                AS link_mode,
      s.scheduled_at             AS scheduled_at,
      s.materialized_at          AS materialized_at,
      c.brand_id                 AS brand_id,
      c.offer_id                 AS offer_id,
      c.tracking_id              AS campaign_tracking_id,
      b.name                     AS brand_name,
      s.creative_id              AS creative_id,
      s.tracking_id              AS stage_tracking_id,
      s.short_url                AS short_url,
      s.full_url                 AS full_url,
      s.stop_text                AS stop_text,
      s.sales_page_label         AS sales_page_label,
      s.utm_tag_ids              AS utm_tag_ids,
      s.sms_provider_id          AS sms_provider_id,
      s.include_no_status        AS include_no_status,
      s.include_clickers         AS include_clickers,
      s.exclude_clickers         AS exclude_clickers,
      s.split_index              AS split_index,
      s.split_total              AS split_total,
      s.behavioral_tier          AS behavioral_tier,
      s.parent_stage_id          AS parent_stage_id,
      cr.text                    AS creative_text,
      cr.allow_multi_segment     AS creative_allow_multi_segment,
      c.exclude_prior_offer_contacts AS exclude_prior_offer_contacts
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

  // HARD GUARD: a stage with no send date is NEVER sent. A null scheduled_at is
  // not "send now" — it means the stage hasn't been scheduled. Shared chokepoint
  // for every send/materialize entry point (cron Phase A, the manual kickoff
  // route, Approve-Send). "Send now" stamps scheduled_at = now() BEFORE calling.
  if (row.scheduled_at == null) return { ok: false, reason: "no_schedule" };

  // Already fully materialized ⇒ idempotent no-op (resume/re-Prepare is a no-op).
  if (row.materialized_at != null) {
    return {
      ok: true,
      mode,
      materialized: 0,
      complete: true,
      shortDomain: null,
    };
  }

  // ---- Resolve mode-specific send context (guards) BEFORE materializing, so a
  // misconfigured stage refuses cheaply without inserting partial rows.
  let shortDomain: { id: number; domain: string } | null = null;
  let destinationUrl = "";
  let manualText = "";

  if (mode === "manual") {
    // Freeze the pasted short_url into every row, no minting.
    manualText = buildStageSms({
      brandName,
      creativeText: row.creative_text,
      linkUrl: row.short_url,
      stopText: row.stop_text,
    });
  } else {
    // Tracked: enforce readiness + resolve provider/credential/domain/destination.
    if (!row.stage_tracking_id || !row.campaign_tracking_id) {
      return { ok: false, reason: "stage_not_ready" };
    }
    if (row.sms_provider_id == null) return { ok: false, reason: "no_provider" };

    const provider = (await dbc.execute(sql`
      SELECT supports_api_send FROM sms_providers
      WHERE id = ${row.sms_provider_id} AND org_id = ${orgId} LIMIT 1
    `)) as unknown as { supports_api_send: boolean }[];
    if (!provider[0]?.supports_api_send) {
      return { ok: false, reason: "provider_not_api_capable" };
    }

    // Brand-aware: require a key resolvable for (provider, this campaign's brand)
    // or the provider-default. Matches what the Step-3 drain will use to send.
    const hasCred = await hasResolvableCredential(dbc, {
      orgId,
      providerId: row.sms_provider_id,
      brandId: row.brand_id,
    });
    if (!hasCred) return { ok: false, reason: "no_credentials" };

    // Deterministic short-domain pick: active, brand-scoped, stable order so a
    // brand always mints under the same domain.
    const sd = (await dbc.execute(sql`
      SELECT id, domain FROM short_domains
      WHERE org_id = ${orgId} AND brand_id = ${row.brand_id} AND status = 'active'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `)) as unknown as { id: number; domain: string }[];
    if (!sd[0]) return { ok: false, reason: "no_short_domain" };
    shortDomain = sd[0];

    // Bug 3 fix: mint against the stage's stored Full URL — the exact value the
    // operator controls — NOT a server-side rebuild. But trust it ONLY when it
    // actually carries this stage's tracking id in a WELL-FORMED way: for a
    // guidekn /lp/ URL that means passing the shape guard. A bare `includes()`
    // check (the old logic) was fooled by the id-glued-into-the-path defect
    // (…/lp/knd8_62_…), minting a 404 and silently killing attribution — the
    // exact bug this guards against. A malformed / bare / non-carrying full_url
    // falls back to the canonical rebuild, which attaches tracking under sub_id3.
    const storedFull = (row.full_url ?? "").trim();
    const storedCarriesTracking =
      !!row.stage_tracking_id && storedFull.includes(row.stage_tracking_id);
    const storedGuideknWellFormed =
      !isGuideknLpUrl(storedFull) ||
      validateDestination(storedFull, row.stage_tracking_id) === null;
    destinationUrl =
      storedCarriesTracking && storedGuideknWellFormed ? storedFull : "";
    if (!destinationUrl) {
      const ctxResult = await loadStageUrlContext({
        orgId,
        offerId: row.offer_id,
        salesPageLabel: row.sales_page_label,
        utmTagIds: row.utm_tag_ids ?? [],
        dbc,
      });
      if (!ctxResult.ok) return { ok: false, reason: "stage_not_ready" };
      destinationUrl = buildStageFullUrl({
        salesPageUrl: ctxResult.ctx.salesPageUrl,
        trackingId: row.stage_tracking_id,
        utmTags: ctxResult.ctx.utmTags,
      });
    }
    if (!destinationUrl) return { ok: false, reason: "no_destination" };
    // Defense in depth: never mint a malformed guidekn destination — a 404 that
    // silently loses attribution. Non-guidekn destinations pass through.
    if (validateDestination(destinationUrl, row.stage_tracking_id)) {
      return { ok: false, reason: "invalid_destination" };
    }
  }

  // ---- Segment policy preflight (G8 + spec §4). Rendered text is
  // recipient-invariant WITHIN a stage — see the plan's design note — so one
  // representative count is accurate for every recipient. Checked BEFORE any
  // recipient enumeration/materialization so a misconfigured creative refuses
  // cheaply, same pattern as the mode-specific guards above.
  const representativeText =
    mode === "manual"
      ? manualText
      : buildStageSms({
          brandName,
          creativeText: row.creative_text,
          linkUrl: `https://${shortDomain!.domain}/r/${"X".repeat(CODE_LENGTH)}`,
          stopText: row.stop_text,
        });
  const segCheck = countSegments(representativeText);
  if (segCheck.segments > MAX_SEGMENTS) {
    return { ok: false, reason: "segment_ceiling_exceeded" };
  }
  if (segCheck.segments > 1 && !row.creative_allow_multi_segment) {
    return { ok: false, reason: "multi_segment_not_allowed" };
  }

  // ---- Enumerate the recipients NOT YET materialized (resumable). Behavioral-
  // lane fields flow into the SAME stageRecipientsSql the preview count uses, so
  // the people SENT are byte-identical to the people PREVIEWED. Opt-out + converted
  // exclusion happen inside that query (live at resolution time).
  const recipients = await enumerateStageRecipients(dbc, {
    campaignId,
    orgId,
    filters: {
      includeNoStatus: row.include_no_status,
      includeClickers: row.include_clickers,
      excludeClickers: row.exclude_clickers,
      splitIndex: row.split_index ?? null,
      splitTotal: row.split_total ?? null,
      behavioralTier: row.behavioral_tier ?? null,
      parentStageId: row.parent_stage_id ?? null,
    },
    eligibility: {
      creativeId: row.creative_id ?? null,
      offerId: row.offer_id ?? null,
      excludePriorOffer: row.exclude_prior_offer_contacts,
    },
    excludeMaterializedStageId: stageId,
  });

  if (recipients.length === 0) {
    // Nothing left to materialize. Either everything is already done (rows exist —
    // a prior run inserted all but was killed before stamping), or the stage
    // genuinely has no recipients.
    const existing = (await dbc.execute(sql`
      SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stageId}
    `)) as unknown as { n: number }[];
    if (Number(existing[0]?.n ?? 0) > 0) {
      await markMaterialized(dbc, stageId);
      return { ok: true, mode, materialized: 0, complete: true, shortDomain: null };
    }
    return { ok: false, reason: "no_recipients" };
  }

  // ---- Materialize in committed windows until done or the budget is hit.
  let materialized = 0;
  let complete = true;
  for (let i = 0; i < recipients.length; i += MATERIALIZE_WINDOW) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    const slice = recipients.slice(i, i + MATERIALIZE_WINDOW);
    await dbc.transaction(async (tx) => {
      let rows: StageSendInsertRow[];
      if (mode === "manual") {
        rows = slice.map((r) => {
          const id = randomUUID();
          return {
            id,
            orgId,
            campaignId,
            stageId,
            contactId: r.contact_id,
            phone: r.phone_number,
            linkId: null,
            renderedText: manualText,
            leadId: id,
            carrierNorm: r.carrier_norm ?? null,
          };
        });
      } else {
        const sd = shortDomain!;
        const tokens = slice.map((r) => ({
          contactId: r.contact_id,
          phone: r.phone_number,
          sendToken: randomUUID(),
          carrierNorm: r.carrier_norm ?? null,
        }));
        const minted = await mintLinksBatch(tx, {
          orgId,
          campaignId,
          stageId,
          creativeId: row.creative_id,
          shortDomainId: sd.id,
          destinationUrl,
          campaignTrackingId: row.campaign_tracking_id,
          stageTrackingId: row.stage_tracking_id,
          items: tokens.map((t) => ({ contactId: t.contactId, sendToken: t.sendToken })),
        });
        rows = tokens.map((t) => {
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
              linkUrl: `https://${sd.domain}/r/${link.code}`,
              stopText: row.stop_text,
            }),
            leadId: t.sendToken,
            carrierNorm: t.carrierNorm,
          };
        });
      }
      const inserted = await bulkInsertStageSends(tx, rows);
      materialized += inserted;
    });
  }

  // Fully materialized ⇒ stamp the completeness marker (idempotent, only if all
  // windows landed). If the budget was hit, materialized_at stays NULL and the
  // next invocation resumes.
  if (complete) {
    await markMaterialized(dbc, stageId);
  }

  return {
    ok: true,
    mode,
    materialized,
    complete,
    shortDomain: mode === "tracked" ? (shortDomain?.domain ?? null) : null,
  };
}

// Stamp materialized_at exactly once (only when currently NULL).
async function markMaterialized(dbc: typeof db, stageId: number): Promise<void> {
  await dbc.execute(sql`
    UPDATE campaign_stages SET materialized_at = now()
    WHERE id = ${stageId} AND materialized_at IS NULL
  `);
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
  carrierNorm: string | null;
}

const STAGE_SENDS_CHUNK = 1000;

// Chunked multi-row INSERT. ON CONFLICT DO NOTHING against the active-contact
// unique index (stage_id, contact_id) WHERE status IN ('pending','sending') makes
// windowed materialization idempotent: a concurrent materializer (or a retried
// window) can't create a second active row for a contact. Returns the number of
// rows actually inserted (RETURNING count) so the caller's progress is accurate.
async function bulkInsertStageSends(
  tx: DbOrTx,
  rows: StageSendInsertRow[],
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < rows.length; start += STAGE_SENDS_CHUNK) {
    const chunk = rows.slice(start, start + STAGE_SENDS_CHUNK);
    const values = chunk.map(
      (r) => sql`(
        ${r.id}, ${r.orgId}, ${r.campaignId}, ${r.stageId}, ${r.contactId},
        ${r.phone}, ${r.linkId}, ${r.renderedText}, 'pending', ${r.leadId}, ${r.carrierNorm}
      )`,
    );
    const res = (await tx.execute(sql`
      INSERT INTO stage_sends
        (id, org_id, campaign_id, stage_id, contact_id, phone, link_id,
         rendered_text, status, lead_id, carrier_norm)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (stage_id, contact_id) WHERE status IN ('pending', 'sending')
      DO NOTHING
      RETURNING id
    `)) as unknown as { id: string }[];
    inserted += Array.isArray(res) ? res.length : 0;
  }
  return inserted;
}
