// scripts/verify-p4-noop.ts — P4 owner rule: the backend is not gated, so on
// every live REGULAR stage it must change nothing. READ ONLY (one READ ONLY
// transaction; builds bodies in memory; writes nothing). Safe on production.
//
//   npx tsx --conditions=react-server scripts/verify-p4-noop.ts [sinceIso] [maxRows]
//
// Bars, over every regular stage_sends row prepared since `sinceIso`:
//   N1 every stage behind those rows resolves to NO_TAG_RULES (loadStageTagRules)
//   N2 the P4 kickoff render WITH the recipient's own contact_attributes is
//      byte-identical to the pre-P4 render (NO_RECIPIENT) — personalization
//      cannot touch a tag-less body, whoever the recipient is
//   N3 that body equals the stored rendered_text (reported; a stage edited since
//      its rows were prepared is listed, not hidden)
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { NO_TAG_RULES, renderMessage, shapeFromStage } from "@/lib/messages/render";
import { NO_RECIPIENT } from "@/lib/messages/tags";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { loadRecipientAttributes } from "@/lib/sends/personalize";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { loadStageTagRules } from "@/lib/sends/tag-rules";

const since = process.argv[2] ?? "2026-10-20T10:31:15Z"; // P2 prod deploy: rows carry the format stamp
const maxRows = Number(process.argv[3] ?? 50000);

type Row = {
  id: string; stage_id: number; org_id: string; contact_id: string; brand_name: string | null;
  creative_text: string | null; link_url: string | null; stop_text: string | null;
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
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      const rows = (await tx.execute(sql`
        SELECT ss.id, ss.stage_id, ss.org_id, ss.contact_id,
               b.name AS brand_name,
               COALESCE(lcr.text, scr.text) AS creative_text,
               CASE WHEN l.id IS NOT NULL THEN 'https://' || sd.domain || '/r/' || l.code ELSE s.short_url END AS link_url,
               s.stop_text,
               pp.opt_out_footer AS phone_footer,
               sprov.opt_out_footer AS provider_footer,
               sprov.adapter_code,
               mf.template AS format_template,
               ss.message_format_id, s.custom_text, ss.format_custom,
               ss.rendered_text
        FROM stage_sends ss
        JOIN campaigns c ON c.id = ss.campaign_id AND c.type <> 'drip'
        JOIN campaign_stages s ON s.id = ss.stage_id
        LEFT JOIN brands b ON b.id = c.brand_id
        LEFT JOIN links l ON l.id = ss.link_id
        LEFT JOIN short_domains sd ON sd.id = l.short_domain_id
        LEFT JOIN creatives lcr ON lcr.id = l.creative_id
        LEFT JOIN creatives scr ON scr.id = s.creative_id
        LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
        LEFT JOIN sms_providers sprov ON sprov.id = s.sms_provider_id
        LEFT JOIN message_formats mf ON mf.id = ss.message_format_id
        WHERE ss.created_at >= ${since}::timestamptz AND ss.status <> 'rejected'
        ORDER BY ss.created_at DESC
        LIMIT ${maxRows}
      `)) as unknown as Row[];
      const stages = [...new Map(rows.map((r) => [r.stage_id, r.org_id])).entries()];
      console.log(`${rows.length.toLocaleString()} regular rows prepared since ${since} · ${stages.length} stages`);
      bar("precondition: rows to compare", rows.length > 0);

      let tagged = 0;
      for (const [stageId, orgId] of stages) {
        const r = await loadStageTagRules(tx as unknown as typeof db, { orgId, stageId });
        if (r !== NO_TAG_RULES) tagged++;
      }
      bar(`N1 all ${stages.length} stages resolve to NO_TAG_RULES`, tagged === 0, `${tagged} do not`);

      const attrs = new Map<string, Awaited<ReturnType<typeof loadRecipientAttributes>> extends Map<string, infer V> ? V : never>();
      const ids = [...new Set(rows.map((r) => r.contact_id))];
      for (let i = 0; i < ids.length; i += 5000) {
        for (const [k, v] of await loadRecipientAttributes(tx as unknown as typeof db, ids.slice(i, i + 5000))) attrs.set(k, v);
      }
      let withAttrs = 0, p4VsLegacy = 0, p4VsStored = 0;
      const storedDiffStages = new Map<number, number>();
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
        const p4 = renderMessage({ ...base, recipient: a ?? NO_RECIPIENT });
        const legacy = renderMessage({ ...base, recipient: NO_RECIPIENT });
        const p4Body = p4.ok ? p4.body : `<refused ${p4.tag}>`;
        if (!legacy.ok || p4Body !== legacy.body) p4VsLegacy++;
        if (p4Body !== r.rendered_text) {
          p4VsStored++;
          storedDiffStages.set(r.stage_id, (storedDiffStages.get(r.stage_id) ?? 0) + 1);
        }
      }
      console.log(`  (${withAttrs.toLocaleString()} of these recipients HAVE contact_attributes — the rows personalization could have touched)`);
      bar(`N2 P4 render with the recipient's data == pre-P4 render, all ${rows.length.toLocaleString()} rows`, p4VsLegacy === 0, `${p4VsLegacy} differ`);
      bar(`N3 P4 render == stored rendered_text`, p4VsStored === 0,
        `${p4VsStored} differ, by stage: ${JSON.stringify(Object.fromEntries(storedDiffStages))}`);
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
