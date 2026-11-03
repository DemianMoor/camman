// 0229 bar (owner point 4): with the boxes unticked, every existing stage's
// redirect is BYTE-IDENTICAL to today. READ ONLY (withReadOnlyDb) — safe on prod
// once 0229 is applied there.
//
//   npx tsx --conditions=react-server scripts/verify-stage-url-geo-identical.ts            # prod (.env.local)
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/verify-stage-url-geo-identical.ts
//
// For the newest link of EVERY stage that has one (regular and drip):
//   today = main's resolver, verbatim: appendUrlParam(destination, "sub_id1", send_token)
//   new   = today + appendGeoParams(…, lookupGeoParams(<the real SQL, real rows>))
// and asserts today === new. The minted side needs no comparison: the mint code
// is untouched (guarded by scripts/test-stage-url-geo-params.ts S1).
import "./_env-preload";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { withReadOnlyDb } from "./_readonly-db";
import { appendGeoParams } from "@/lib/links/geo-params";
import { lookupGeoParams, RECIPIENT_SUB_ID_PARAM, type DbOrTx } from "@/lib/links/resolve-click";
import { appendUrlParam } from "@/lib/stage-url";

async function main() {
  const res = await withReadOnlyDb(async (tx) => {
    const flagged = await tx`SELECT count(*)::int AS n FROM campaign_stages WHERE url_add_zip OR url_add_state`;
    const links = await tx`
      SELECT DISTINCT ON (l.stage_id)
             l.org_id, l.stage_id, l.contact_id, l.send_token, d.url, c.type AS campaign_type
      FROM links l
      JOIN link_destinations d ON d.id = l.destination_id
      JOIN campaigns c ON c.id = l.campaign_id
      ORDER BY l.stage_id, l.id DESC
    `;
    // lookupGeoParams's OWN drizzle SQL, compiled and run on this read-only tx.
    const dialect = new PgDialect();
    const dtx = {
      execute: (q: SQL) => {
        const c = dialect.sqlToQuery(q);
        return tx.unsafe(c.sql, c.params as never[]);
      },
    } as unknown as DbOrTx;
    // Non-vacuous: the lookup returns NO_GEO for a stage it cannot find, so
    // prove every checked stage is visible to its org-scoped join.
    const visible = await tx`
      SELECT count(DISTINCT l.stage_id)::int AS n
      FROM links l JOIN campaign_stages s ON s.id = l.stage_id AND s.org_id = l.org_id
    `;
    let same = 0;
    const diffs: string[] = [];
    const byType: Record<string, number> = {};
    for (const l of links) {
      const today = appendUrlParam(l.url, RECIPIENT_SUB_ID_PARAM, l.send_token);
      const geo = await lookupGeoParams(dtx, l.org_id, Number(l.stage_id), l.contact_id);
      const next = appendGeoParams(today, geo);
      byType[l.campaign_type] = (byType[l.campaign_type] ?? 0) + 1;
      if (next === today) same++;
      else if (diffs.length < 10) diffs.push(`stage ${l.stage_id}: ${today} ≠ ${next}`);
    }
    return { flagged: flagged[0].n as number, visible: visible[0].n as number, total: links.length, same, diffs, byType };
  });
  console.log(`stages with a flag on: ${res.flagged}`);
  console.log(`stages checked (newest link each): ${res.total} — by campaign type ${JSON.stringify(res.byType)}`);
  console.log(`visible to the lookup's org-scoped join: ${res.visible}/${res.total}`);
  console.log(`byte-identical: ${res.same}/${res.total}`);
  for (const d of res.diffs) console.log(`  ✗ ${d}`);
  const ok = res.flagged === 0 && res.visible === res.total && res.same === res.total && res.total > 0;
  console.log(ok ? "PASS — every existing stage redirects byte-identically" : "FAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
