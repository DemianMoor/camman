// partner_keys.postback_url_template is returned RAW only to callers with
// partner_keys.manage; a view-only caller gets maskUrl(template). Function level
// (loadPartner / listPartners / normalizeKeyRows) on the PREVIEW database, with a
// throwaway org that is deleted in `finally`.
//
//   npx tsx --conditions=react-server --env-file=D:/AFF/camman/.env.demo scripts/test-partner-key-template-masking.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { listPartners, loadPartner, normalizeKeyRows } from "@/lib/partners/queries";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}
const RAW = "https://p.example/pb?rid={relay_lead_id}&c={conversion_id}&token=abc123";
const MASKED = "https://p.example/pb?rid={relay_lead_id}&c={conversion_id}&token=***";

async function main() {
  let orgId: string | undefined;
  try {
    orgId = ((await db.execute(sql`INSERT INTO organizations (name) VALUES ('zz-masking-test') RETURNING id`)) as unknown as { id: string }[])[0].id;
    const pid = ((await db.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'zz-mask', 'zz') RETURNING id`)) as unknown as { id: number }[])[0].id;
    await db.execute(sql`INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, postback_url_template)
      VALUES (${orgId}::uuid, ${pid}, 'zz-mask', 'k1', ${"zz-mask-1-" + Date.now()}, 'h', ${RAW}),
             (${orgId}::uuid, ${pid}, 'zz-mask', 'k2', ${"zz-mask-2-" + Date.now()}, 'h', NULL)`);

    const tpl = (keys: { name: string; postback_url_template: string | null }[]) => keys.find((k) => k.name === "k1")?.postback_url_template;
    const nullTpl = (keys: { name: string; postback_url_template: string | null }[]) => keys.find((k) => k.name === "k2")?.postback_url_template;

    const asManage = await loadPartner(orgId, pid, true);
    const asView = await loadPartner(orgId, pid, false);
    check("loadPartner manage: raw template", tpl(asManage!.keys) === RAW, String(tpl(asManage!.keys)));
    check("loadPartner view-only: masked (token=***)", tpl(asView!.keys) === MASKED, String(tpl(asView!.keys)));
    check("loadPartner view-only: null stays null", nullTpl(asView!.keys) === null);

    const lm = await listPartners(orgId, true);
    const lv = await listPartners(orgId, false);
    check("listPartners manage: raw template", tpl(lm.data[0].keys) === RAW);
    check("listPartners view-only: masked", tpl(lv.data[0].keys) === MASKED, String(tpl(lv.data[0].keys)));
    check("view-only JSON never contains the secret value", !JSON.stringify(lv).includes("abc123"));

    const rows = [{ name: "k", postback_url_template: RAW }];
    check("normalizeKeyRows(canManage=false) masks", normalizeKeyRows(rows, false)[0].postback_url_template === MASKED);
    check("normalizeKeyRows(canManage=true) keeps raw", normalizeKeyRows(rows, true)[0].postback_url_template === RAW);
  } finally {
    if (orgId) {
      await db.execute(sql`DELETE FROM partner_keys WHERE org_id = ${orgId}::uuid`);
      await db.execute(sql`DELETE FROM partners WHERE org_id = ${orgId}::uuid`);
      await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      const left = (await db.execute(sql`SELECT (SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid) o, (SELECT count(*) FROM partner_keys WHERE org_id = ${orgId}::uuid) k`)) as unknown as { o: string; k: string }[];
      check("teardown: no residue", Number(left[0].o) === 0 && Number(left[0].k) === 0);
    }
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
