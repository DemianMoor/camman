import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { captureTxrDlrEvent, parseTxrStatusCallback } from "@/lib/sends/textrequest-dlr";

// textrequest_dlr_events.headers is never written since 2026-11-17 (24 GB of
// request headers nothing read; the set Vercel forwards can echo the token path).
// Captures one webhook event through the real function on the PREVIEW DB inside a
// transaction that always rolls back, and reads the stored row.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-txr-dlr-no-headers.ts
class Rollback extends Error {}

async function main() {
  console.log(`DB: ${requirePreviewDb().label}`);
  let stored: { headers: unknown; query: unknown; raw_body: string | null } | undefined;
  try {
    await db.transaction(async (tx) => {
      // Fixture provider + credential, created inside the rolled-back transaction.
      const [org] = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      const [prov] = (await tx.execute(sql`
        INSERT INTO sms_providers (org_id, name, sms_provider_id)
        VALUES (${org.id}::uuid, 'no-headers fixture', ${`tst${Date.now()}`}) RETURNING id`)) as unknown as { id: number }[];
      const [pc] = (await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id)
        VALUES (${org.id}::uuid, ${prov.id}) RETURNING id`)) as unknown as { id: number }[];
      const cred = { id: pc.id, org_id: org.id, provider_id: prov.id };
      const body = '{"message_id":"no-headers-test","status":"delivered"}';
      const { id } = await captureTxrDlrEvent(tx, {
        orgId: cred.org_id, credentialId: cred.id, providerId: cred.provider_id,
        method: "POST", query: { ss: "x" }, rawBody: body, stageSendId: null,
        parsed: parseTxrStatusCallback(body),
      });
      [stored] = (await tx.execute(sql`
        SELECT headers, query, raw_body FROM textrequest_dlr_events WHERE id = ${id}::uuid`)) as unknown as typeof stored[];
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const ok = stored != null && JSON.stringify(stored.headers) === "{}" && JSON.stringify(stored.query) === '{"ss":"x"}' && !!stored.raw_body;
  console.log(`  ${ok ? "✓" : "✗"} H1 a captured webhook event stores headers {} (query and raw_body kept) — ${JSON.stringify(stored)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
