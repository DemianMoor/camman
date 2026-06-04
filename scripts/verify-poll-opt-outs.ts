import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

import { isOptOutKeyword } from "../lib/sends/opt-out-keywords";
import { buildInboxUrl } from "../lib/sends/texthub-inbox";

// Verifies the opt-out poll building blocks WITHOUT calling TextHub and WITHOUT
// leaving any rows behind (the DB portion runs in a rolled-back transaction).
//   npx tsx scripts/verify-poll-opt-outs.ts

let failures = 0;
function check(name: string, cond: boolean) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (!cond) failures++;
}

async function main() {
  console.log("--- keyword matching ---");
  check('"STOP" is opt-out', isOptOutKeyword("STOP"));
  check('"Stop" is opt-out', isOptOutKeyword("Stop"));
  check('"STOP ✋️" (trailing emoji) is opt-out', isOptOutKeyword("STOP ✋️"));
  check('"unsubscribe" is opt-out', isOptOutKeyword("unsubscribe"));
  check('"Stop please" is opt-out', isOptOutKeyword("Stop please"));
  check('"hello" is NOT opt-out', !isOptOutKeyword("hello"));
  check('"" is NOT opt-out', !isOptOutKeyword(""));
  check('"STOPPING" is NOT opt-out (exact first word)', !isOptOutKeyword("STOPPING"));

  console.log("\n--- inbox URL ---");
  const url = buildInboxUrl("ABC123");
  check("url targets api.texthub.com/v2", url.startsWith("https://api.texthub.com/v2/"));
  check("url has inbox=true", url.includes("inbox=true"));
  check("url carries api_key", url.includes("api_key=ABC123"));

  console.log("\n--- DB dedupe (rolled back) ---");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    const prov = (await pg`
      SELECT id, org_id FROM sms_providers LIMIT 1
    `) as unknown as { id: number; org_id: string }[];

    if (prov.length === 0) {
      console.log("  ⚠ no sms_providers in DB — skipping dedupe round-trip");
    } else {
      const { id: providerId, org_id: orgId } = prov[0];
      const msgId = `verify-${Date.now()}`;
      try {
        await pg.begin(async (tx) => {
          const a = await tx`
            INSERT INTO texthub_inbound_events
              (org_id, provider_id, method, provider_message_id, result)
            VALUES (${orgId}, ${providerId}, 'poll', ${msgId}, 'pending')
            ON CONFLICT (provider_id, provider_message_id)
              WHERE provider_message_id IS NOT NULL DO NOTHING
            RETURNING id`;
          const b = await tx`
            INSERT INTO texthub_inbound_events
              (org_id, provider_id, method, provider_message_id, result)
            VALUES (${orgId}, ${providerId}, 'poll', ${msgId}, 'pending')
            ON CONFLICT (provider_id, provider_message_id)
              WHERE provider_message_id IS NOT NULL DO NOTHING
            RETURNING id`;
          check("first claim inserts 1 row", a.length === 1);
          check("duplicate message id is deduped (0 rows)", b.length === 0);
          throw new Error("__rollback__");
        });
      } catch (e) {
        if (!(e instanceof Error && e.message === "__rollback__")) throw e;
      }
      const after = (await pg`
        SELECT count(*)::int AS n FROM texthub_inbound_events
        WHERE provider_message_id = ${msgId}
      `) as unknown as { n: number }[];
      check("transaction rolled back (no residue)", after[0].n === 0);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }

  console.log(
    failures === 0 ? "\nAll checks passed." : `\nFAILED: ${failures} check(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Verify crashed:", err);
  process.exit(1);
});
