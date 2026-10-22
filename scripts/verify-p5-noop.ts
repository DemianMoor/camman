// scripts/verify-p5-noop.ts — P5 owner rule: on every live DRIP campaign the
// backend must change nothing. READ ONLY (one READ ONLY transaction; bodies
// built in memory). Safe on production.
//
//   npx tsx --conditions=react-server scripts/verify-p5-noop.ts [sinceIso] [maxRows]
//
//   P1 every live drip campaign (active/paused) resolves to NO_TAG_RULES
//      (loadCampaignTagRules — the routing rule is therefore absent)
//   P2 every drip stage behind the rows resolves to NO_TAG_RULES
//   P3 the P5 per-lead render (renderDripBody, the recipient's OWN attributes,
//      the sending number's footer) == the pre-P5 render (NO_RECIPIENT)
//   P4 == the stored rendered_text
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { renderDripBody } from "@/lib/drip/personalize-drip";
import { NO_TAG_RULES, renderMessage, shapeFromStage } from "@/lib/messages/render";
import { NO_RECIPIENT } from "@/lib/messages/tags";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { loadRecipientAttributes } from "@/lib/sends/personalize";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { loadCampaignTagRules, loadStageTagRules } from "@/lib/sends/tag-rules";

const since = process.argv[2] ?? "2026-10-20T10:31:15Z"; // P2 prod deploy: rows carry the format stamp
const maxRows = Number(process.argv[3] ?? 50000);

type Row = {
  stage_id: number; org_id: string; contact_id: string; brand_name: string | null;
  creative_text: string | null; allow_multi_segment: boolean | null; link_url: string | null; stop_text: string | null;
  phone_footer: string | null; provider_footer: string | null; adapter_code: string | null;
  format_template: string | null; message_format_id: number | null; custom_text: string | null; format_custom: boolean;
  rendered_text: string;
};

class Done extends Error {}
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  const t0 = Date.now();
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof db;
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);

      const live = (await tx.execute(sql`
        SELECT id, org_id FROM campaigns WHERE type = 'drip' AND status IN ('active', 'paused')`)) as unknown as { id: number; org_id: string }[];
      let taggedCampaigns = 0;
      for (const [orgId, cs] of Map.groupBy(live, (c) => c.org_id)) {
        for (const r of (await loadCampaignTagRules(T, orgId, cs.map((c) => Number(c.id)))).values()) {
          if (r !== NO_TAG_RULES) taggedCampaigns++;
        }
      }
      bar(`P1 all ${live.length} live drip campaigns resolve to NO_TAG_RULES (routing rule absent)`, taggedCampaigns === 0, `${taggedCampaigns} do not`);

      const rows = (await tx.execute(sql`
        SELECT ss.stage_id, ss.org_id, ss.contact_id,
               b.name AS brand_name,
               COALESCE(lcr.text, scr.text) AS creative_text,
               COALESCE(lcr.allow_multi_segment, scr.allow_multi_segment) AS allow_multi_segment,
               CASE WHEN l.id IS NOT NULL THEN 'https://' || sd.domain || '/r/' || l.code ELSE s.short_url END AS link_url,
               s.stop_text,
               pp.opt_out_footer AS phone_footer,
               dprov.opt_out_footer AS provider_footer,
               dprov.adapter_code,
               mf.template AS format_template,
               ss.message_format_id, s.custom_text, ss.format_custom,
               ss.rendered_text
        FROM stage_sends ss
        JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
        JOIN campaign_stages s ON s.id = ss.stage_id
        LEFT JOIN brands b ON b.id = c.brand_id
        LEFT JOIN links l ON l.id = ss.link_id
        LEFT JOIN short_domains sd ON sd.id = l.short_domain_id
        LEFT JOIN creatives lcr ON lcr.id = l.creative_id
        LEFT JOIN creatives scr ON scr.id = s.creative_id
        LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
        LEFT JOIN sms_providers dprov ON dprov.id = pp.provider_id
        LEFT JOIN message_formats mf ON mf.id = ss.message_format_id
        WHERE ss.created_at >= ${since}::timestamptz
          AND ss.status NOT IN ('rejected', 'skipped_ineligible')
        ORDER BY ss.created_at DESC
        LIMIT ${maxRows}
      `)) as unknown as Row[];
      const stages = [...new Map(rows.map((r) => [r.stage_id, r.org_id])).entries()];
      console.log(`${rows.length.toLocaleString()} drip rows sent since ${since} · ${stages.length} stages`);
      bar("precondition: rows to compare", rows.length > 0);

      let taggedStages = 0;
      for (const [stageId, orgId] of stages) {
        if ((await loadStageTagRules(T, { orgId, stageId })) !== NO_TAG_RULES) taggedStages++;
      }
      bar(`P2 all ${stages.length} drip stages resolve to NO_TAG_RULES`, taggedStages === 0, `${taggedStages} do not`);

      const attrs = new Map<string, Awaited<ReturnType<typeof loadRecipientAttributes>> extends Map<string, infer V> ? V : never>();
      for (const [orgId, rs] of Map.groupBy(rows, (r) => r.org_id)) {
        for (const [k, v] of await loadRecipientAttributes(T, orgId, [...new Set(rs.map((r) => r.contact_id))])) attrs.set(k, v);
      }
      let withAttrs = 0, vsLegacy = 0, vsStored = 0;
      const byStage = new Map<number, number>();
      for (const r of rows) {
        const a = attrs.get(r.contact_id);
        if (a) withAttrs++;
        const footer = resolveOptOutFooter({
          numberFooter: r.phone_footer,
          providerFooter: r.provider_footer,
          stageStopText: r.stop_text,
          providerAppendsOwnOptOut: (r.adapter_code ? getDescriptor(r.adapter_code) : null)?.appendsOwnOptOut === true,
        });
        const shape = shapeFromStage({
          message_format_id: r.format_custom ? null : r.message_format_id,
          custom_text: r.format_custom ? r.custom_text : null,
          format_template: r.format_template,
        });
        const base = { shape, brandName: r.brand_name ?? "", creativeText: r.creative_text, linkUrl: r.link_url, stopText: footer.text };
        const p5 = renderDripBody({ ...base, recipient: a ?? NO_RECIPIENT, allowMultiSegment: r.allow_multi_segment === true });
        const legacy = renderMessage({ ...base, recipient: NO_RECIPIENT });
        const body = p5.ok ? p5.body : `<skip ${p5.reason}>`;
        if (!legacy.ok || body !== legacy.body) vsLegacy++;
        if (body !== r.rendered_text) { vsStored++; byStage.set(r.stage_id, (byStage.get(r.stage_id) ?? 0) + 1); }
      }
      console.log(`  (${withAttrs.toLocaleString()} of these recipients HAVE contact_attributes)`);
      bar(`P3 P5 render with the lead's own data == pre-P5 render, all ${rows.length.toLocaleString()} rows`, vsLegacy === 0, `${vsLegacy} differ`);
      bar("P4 P5 render == stored rendered_text", vsStored === 0, `${vsStored} differ, by stage ${JSON.stringify(Object.fromEntries(byStage))}`);
      throw new Done();
    });
  } catch (e) {
    if (!(e instanceof Done)) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(`\n${fail === 0 ? "ALL GREEN" : `${fail} FAILED`} (${((Date.now() - t0) / 1000).toFixed(1)} s, read-only)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
