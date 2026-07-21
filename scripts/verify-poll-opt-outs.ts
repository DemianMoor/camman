import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

import { isOptOutKeyword } from "../lib/sends/opt-out-keywords";
import {
  buildInboxUrl,
  fetchInbox,
  shouldFetchNextInboxPage,
} from "../lib/sends/texthub-inbox";

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
  check("page 1 omits the page param", !url.includes("page="));
  check("page 3 adds page=3", buildInboxUrl("ABC123", 3).includes("page=3"));

  console.log("\n--- pagination control (shouldFetchNextInboxPage) ---");
  const cont = (a: Partial<Parameters<typeof shouldFetchNextInboxPage>[0]>) =>
    shouldFetchNextInboxPage({
      page: 1,
      newlyClaimedThisPage: 5,
      totalPages: 8,
      maxPages: 10,
      elapsedMs: 0,
      budgetMs: 35_000,
      ...a,
    });
  check("continues when new msgs + pages remain", cont({}) === true);
  check("STOPS when a page is fully already-claimed (caught up)", cont({ newlyClaimedThisPage: 0 }) === false);
  check("STOPS at the last page", cont({ page: 8, totalPages: 8 }) === false);
  check("STOPS at the per-tick page cap", cont({ page: 10, maxPages: 10 }) === false);
  check("STOPS when the time budget is spent", cont({ elapsedMs: 40_000 }) === false);

  console.log("\n--- inbox response classification (stubbed fetch) ---");
  // Stub global fetch so we exercise the REAL fetchInbox classification without
  // the network. fetchInbox only touches res.ok / res.status / res.json().
  const realFetch = globalThis.fetch;
  const stub = (ok: boolean, status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      ({ ok, status, json: async () => body }) as unknown as Response) as typeof fetch;
  };
  try {
    stub(true, 200, { response: "No new messages" });
    let r = await fetchInbox({ apiKey: "X" });
    check("empty inbox → ok:true", r.ok === true);
    check("empty inbox → 0 messages", r.messages.length === 0);
    check("empty inbox → no error (no false alert)", r.error === null);

    stub(true, 200, {
      status: 200,
      page: 2,
      total_pages: 8,
      data: [{ id: "1", message: "STOP", phone: "+15551234567", received_at: null }],
    });
    r = await fetchInbox({ apiKey: "X", page: 2 });
    check("messages present → ok:true", r.ok === true);
    check("messages present → 1 message parsed", r.messages.length === 1);
    check("pagination meta parsed (page=2, totalPages=8)", r.page === 2 && r.totalPages === 8);

    stub(true, 200, { status: 0, error: "bad key" });
    r = await fetchInbox({ apiKey: "X" });
    check("status:0 envelope → ok:false (still alerts)", r.ok === false);
    check("status:0 envelope → error set", r.error !== null);

    stub(false, 500, {});
    r = await fetchInbox({ apiKey: "X" });
    check("HTTP 500 → ok:false (still alerts)", r.ok === false);
  } finally {
    globalThis.fetch = realFetch;
  }

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
