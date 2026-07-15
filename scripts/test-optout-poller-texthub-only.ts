// Regression test: the TextHub opt-out poller's credential selection
// (selectPollableCredentials in lib/sends/poll-opt-outs.ts) must only return
// TextHub (sms_provider_id = 'txh') credentials. Section 1 seeded an Ahoi
// provider row with supports_api_send = true + a credential; before the fix,
// the poller's WHERE clause matched any supports_api_send provider, so
// Ahoi's api_key got fired at TextHub's inbox URL -> 404 -> a false
// "Opt-out poller FAILED" Telegram alert. Ahoi has its own opt-out intake
// (lib/sends/ahoi-optout.ts et al) — this poller is TextHub-only.
//
// Seeds throwaway BRAND-scoped credentials (not provider-default) for the
// REAL 'txh' and 'ahi' provider rows inside a rolled-back transaction, so it
// can't collide with provider_credentials_provider_default_uniq (both real
// providers already carry a brand_id-NULL default credential) or
// provider_credentials_provider_brand_uniq (provider_id, brand_id) — see
// migration 0051.
//
// Run: npx tsx scripts/test-optout-poller-texthub-only.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { selectPollableCredentials } from "@/lib/sends/poll-opt-outs";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const org = await one<{ id: string }>(
        sql`SELECT id FROM organizations LIMIT 1`,
      );
      const orgId = org.id;

      const txhProvider = await one<{ id: number }>(
        sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'txh' AND org_id = ${orgId}`,
      );
      const ahoiProvider = await one<{ id: number }>(
        sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahi' AND org_id = ${orgId}`,
      );
      check("real 'txh' provider row exists", !!txhProvider, JSON.stringify(txhProvider));
      check("real 'ahi' provider row exists", !!ahoiProvider, JSON.stringify(ahoiProvider));
      if (!txhProvider || !ahoiProvider) throw ROLLBACK;

      // Throwaway brand so the credential inserts land under
      // provider_credentials_provider_brand_uniq (provider_id, brand_id)
      // without touching either provider's existing brand_id-NULL default
      // credential row (guarded separately by
      // provider_credentials_provider_default_uniq).
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (brand_id, org_id, name)
        VALUES (${"test-poller-brand-" + sfx}, ${orgId}, ${"Test Poller Brand " + sfx})
        RETURNING id
      `);

      const txhCred = await one<{ id: number }>(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${txhProvider.id}, ${brand.id}, ${"test-txh-key-" + sfx})
        RETURNING id
      `);
      const ahoiCred = await one<{ id: number }>(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${ahoiProvider.id}, ${brand.id}, ${"test-ahoi-key-" + sfx})
        RETURNING id
      `);

      const rows = await selectPollableCredentials(tx, orgId);
      const ids = rows.map((r) => r.credential_id);

      check(
        "TextHub test credential IS selected",
        ids.includes(txhCred.id),
        JSON.stringify(ids),
      );
      check(
        "Ahoi test credential is NOT selected",
        !ids.includes(ahoiCred.id),
        JSON.stringify(ids),
      );
      check(
        "no selected row belongs to the ahoi provider (global check, not just our fixture)",
        rows.every((r) => r.provider_id !== ahoiProvider.id),
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
