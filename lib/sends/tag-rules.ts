// P4: the DB side of a stage's TagRules (spec §C). Loads exactly the inputs
// kickoff renders with — the shape, the creative, the brand, the RESOLVED
// opt-out footer and the link (the stored short URL, or a length-exact
// representative tracked link) — and hands them to the pure stageTagRules.
// Every path that counts or selects recipients reads its rules from here, so a
// preview's "would be skipped" and the send's per-recipient skip are the same
// rule. A message with no contact tag short-circuits to NO_TAG_RULES.
import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { buildRepresentativeTrackedLinkUrl } from "@/lib/links/tracked-link";
import {
  NO_TAG_RULES,
  campaignTagRules,
  isTagRulesRefusal,
  requiredContactTags,
  shapeFromStage,
  stageTagRules,
  type TagRules,
  type TagRulesRefusal,
} from "@/lib/messages/render";
import { tagMissingSql } from "@/lib/messages/tag-sql";
import type { TagKey } from "@/lib/messages/tags";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { resolveShortDomainForSend } from "@/lib/sends/resolve-short-domain";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The stage's message inputs — a saved stage's columns, or the stage form's unsaved values. */
export interface TagRulesSource {
  orgId: string;
  campaignId: number;
  creativeId: number | null;
  /** NULL with customText NULL ⇒ the org's default format (what the insert trigger assigns). */
  messageFormatId: number | null;
  customText: string | null;
  stopText: string | null;
  smsProviderId: number | null;
  providerPhoneId: number | null;
  shortUrl: string | null;
}

export async function loadTagRules(dbc: DbOrTx, s: TagRulesSource): Promise<TagRules | TagRulesRefusal> {
  if (s.creativeId == null) return NO_TAG_RULES;
  const rows = (await dbc.execute(sql`
    SELECT cr.text AS tag_creative_text, cr.allow_multi_segment,
           c.link_mode, c.brand_id, b.name AS brand_name,
           coalesce(mf.template, dmf.template) AS format_template,
           coalesce(mf.id, dmf.id) AS format_id,
           pp.opt_out_footer AS phone_footer,
           prov.opt_out_footer AS provider_footer,
           prov.adapter_code
    FROM campaigns c
    JOIN creatives cr ON cr.id = ${s.creativeId} AND cr.org_id = c.org_id
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN message_formats mf ON mf.id = ${s.messageFormatId} AND mf.org_id = c.org_id
    LEFT JOIN message_formats dmf ON dmf.org_id = c.org_id AND dmf.is_default
    LEFT JOIN provider_phones pp ON pp.id = ${s.providerPhoneId} AND pp.org_id = c.org_id
    LEFT JOIN sms_providers prov ON prov.id = ${s.smsProviderId} AND prov.org_id = c.org_id
    WHERE c.id = ${s.campaignId} AND c.org_id = ${s.orgId}::uuid
    LIMIT 1
  `)) as unknown as {
    tag_creative_text: string | null;
    allow_multi_segment: boolean | null;
    link_mode: string;
    brand_id: number | null;
    brand_name: string | null;
    format_template: string | null;
    format_id: number | null;
    phone_footer: string | null;
    provider_footer: string | null;
    adapter_code: string | null;
  }[];
  const r = rows[0];
  if (!r) return NO_TAG_RULES;
  const shape = shapeFromStage({
    message_format_id: s.customText != null ? null : r.format_id,
    custom_text: s.customText,
    format_template: r.format_template,
  });
  // Cheap exit BEFORE any footer / domain lookup: the common case, and the
  // guarantee that a tag-less stage is untouched.
  if (requiredContactTags({ shape, creativeText: r.tag_creative_text }).length === 0) return NO_TAG_RULES;

  const descriptor = r.adapter_code ? getDescriptor(r.adapter_code) : null;
  const footer = resolveOptOutFooter({
    numberFooter: r.phone_footer,
    providerFooter: r.provider_footer,
    stageStopText: s.stopText,
    providerAppendsOwnOptOut: descriptor?.appendsOwnOptOut === true,
  });
  let linkUrl: string | null = s.shortUrl;
  if (r.link_mode === "tracked") {
    const sd = await resolveShortDomainForSend(dbc, {
      orgId: s.orgId,
      brandId: r.brand_id,
      providerPhoneId: s.providerPhoneId,
    });
    // No domain ⇒ kickoff refuses the stage (no_short_domain) before any
    // recipient matters; the representative link only needs a real length.
    linkUrl = sd ? buildRepresentativeTrackedLinkUrl(sd.domain) : null;
  }
  return stageTagRules({
    shape,
    brandName: r.brand_name ?? "",
    creativeText: r.tag_creative_text,
    linkUrl,
    stopText: footer.text,
    allowMultiSegment: r.allow_multi_segment === true,
  });
}

/** A saved stage's rules. */
export async function loadStageTagRules(
  dbc: DbOrTx,
  i: { orgId: string; stageId: number },
): Promise<TagRules | TagRulesRefusal> {
  const rows = (await dbc.execute(sql`
    SELECT campaign_id, creative_id, message_format_id, custom_text, stop_text,
           sms_provider_id, provider_phone_id, short_url
    FROM campaign_stages WHERE id = ${i.stageId} AND org_id = ${i.orgId}::uuid
  `)) as unknown as {
    campaign_id: number;
    creative_id: number | null;
    message_format_id: number | null;
    custom_text: string | null;
    stop_text: string | null;
    sms_provider_id: number | null;
    provider_phone_id: number | null;
    short_url: string | null;
  }[];
  const st = rows[0];
  if (!st) return NO_TAG_RULES;
  return loadTagRules(dbc, {
    orgId: i.orgId,
    campaignId: st.campaign_id,
    creativeId: st.creative_id,
    messageFormatId: st.message_format_id,
    customText: st.custom_text,
    stopText: st.stop_text,
    smsProviderId: st.sms_provider_id,
    providerPhoneId: st.provider_phone_id,
    shortUrl: st.short_url,
  });
}

/**
 * Rules for COUNTING (preview / preflight / reconcile). A refused stage sends
 * nobody — kickoff refuses it — so its counts only need who lacks the data:
 * the required tags without a length limit.
 */
export function countingTagRules(r: TagRules | TagRulesRefusal): TagRules {
  return isTagRulesRefusal(r) ? { required: r.required, firstNameMaxLength: null } : r;
}

/** Saved stage → counting rules, in one call. */
export async function loadStageCountingTagRules(
  dbc: DbOrTx,
  i: { orgId: string; stageId: number },
): Promise<TagRules> {
  return countingTagRules(await loadStageTagRules(dbc, i));
}

/**
 * How many of `base`'s contacts lack each required contact tag — NOT exclusive
 * (one contact can lack two tags), counted over the stage's audience before
 * the eligibility layers. `{}` for a tag-less stage, with no query.
 */
export async function countMissingByTag(
  dbc: DbOrTx,
  base: SQL,
  tagRules: TagRules,
): Promise<Partial<Record<TagKey, number>>> {
  const keys = tagRules.required.filter((k): k is Exclude<TagKey, "brand"> => k !== "brand");
  if (keys.length === 0) return {};
  const aggs = sql.join(
    keys.map(
      (k) => sql`count(*) filter (where ca.contact_id is null or ${tagMissingSql(k, "ca")})::int as ${sql.raw(`m_${k}`)}`,
    ),
    sql`, `,
  );
  const rows = (await dbc.execute(sql`
    select ${aggs} from (${base}) b left join contact_attributes ca on ca.contact_id = b.contact_id
  `)) as unknown as Record<string, number>[];
  return Object.fromEntries(keys.map((k) => [k, Number(rows[0]?.[`m_${k}`] ?? 0)]));
}

/**
 * P5: every live DRIP campaign's rules, from its ACTIVE FIRST-SEND stages only
 * (a follow-up child never decides routing). Built once per routing tick (the
 * worker's cache) or per call (the why-not-routed tool). Campaigns whose
 * stages are all tag-less map to NO_TAG_RULES — the routing rule is then absent.
 */
export async function loadCampaignTagRules(
  dbc: DbOrTx,
  orgId: string,
  campaignIds: number[],
): Promise<Map<number, TagRules | TagRulesRefusal>> {
  const out = new Map<number, TagRules | TagRulesRefusal>();
  if (campaignIds.length === 0) return out;
  const stages = (await dbc.execute(sql`
    SELECT s.id, s.campaign_id FROM campaign_stages s
    WHERE s.org_id = ${orgId}::uuid
      AND s.campaign_id = ANY(${`{${campaignIds.join(",")}}`}::int[])
      AND s.drip_active IS TRUE AND s.archived_at IS NULL AND s.parent_stage_id IS NULL
  `)) as unknown as { id: number; campaign_id: number }[];
  const per = new Map<number, (TagRules | TagRulesRefusal)[]>();
  for (const st of stages) {
    const r = await loadStageTagRules(dbc, { orgId, stageId: st.id });
    per.set(st.campaign_id, [...(per.get(st.campaign_id) ?? []), r]);
  }
  for (const id of campaignIds) out.set(id, campaignTagRules(per.get(id) ?? []));
  return out;
}
