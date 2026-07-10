// Manual calibration / on-demand drain for the Telnyx lookup feature — for use
// while the */2 cron isn't deployed yet (feature branch). It enqueues a RANDOM
// sample via the real backfill path (runBackfill — NOT a bespoke enqueue) and then
// drives the real worker (runLookupWorker) until the batch drains, printing the
// batch row each pass. The worker fires its own Telegram summary on batch completion.
//
// PREREQUISITES:
//   .env.local must have DATABASE_URL + TELNYX_API_KEY (account: Permitted NPAC User,
//   positive balance). Optional TELEGRAM_BOT_TOKEN/CHAT_ID for the completion summary.
//   THIS SPENDS REAL MONEY (~$0.0015–$0.007 per number).
//
// USAGE:
//   npx tsx scripts/run-lookup-calibration.ts [sampleLimit=500] [orgId?]
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch { /* noop */ }
// libphonenumber-js mis-resolves under tsx; our numbers are +1 E.164 (stub for US).
try {
  const lp = req.resolve("libphonenumber-js");
  const stub = (i: string) => { const m = /(\d{10})$/.exec(String(i).replace(/[^\d]/g, "")); if (!m) return null; return { number: `+1${m[1]}`, country: "US", countryCallingCode: "1", nationalNumber: m[1], isValid: () => true }; };
  // @ts-expect-error minimal Module cache entry
  req.cache[lp] = { id: lp, filename: lp, loaded: true, exports: { parsePhoneNumberFromString: stub } };
} catch { /* noop */ }

const MAX_PASSES = 30;
const PASS_DELAY_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.TELNYX_API_KEY) {
    throw new Error("TELNYX_API_KEY is not set — the worker would no-op. Set it in .env.local first.");
  }
  const sampleLimit = Number(process.argv[2] ?? 500);
  const { runBackfill } = await import("@/lib/telnyx/backfill");
  const { runLookupWorker } = await import("@/lib/telnyx/worker");
  const { db } = await import("@/db/client");
  const { sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  const orgId = process.argv[3] ?? (await db.execute<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`))[0].id;

  console.log(`Enqueuing a random sample of ${sampleLimit} via runBackfill (org ${orgId})…`);
  const res = await runBackfill(orgId, sampleLimit);
  console.log(`  batch ${res.batchId}: ${res.enqueued} enqueued, ${res.cacheHits} cached, est $${res.estCostUsd.toFixed(4)}`);
  if (res.enqueued === 0) { console.log("Nothing to look up (all already cached)."); await raw.end({ timeout: 5 }); return; }

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const w = await runLookupWorker();
    const [b] = await db.execute<{ status: string; processed: number; failed: number; actual_cost_usd: string | null }>(sql`
      SELECT status, processed, failed, actual_cost_usd FROM lookup_batches WHERE id = ${res.batchId}::uuid`);
    const [pend] = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM lookup_queue WHERE batch_id = ${res.batchId}::uuid AND status = 'pending'`);
    console.log(`  pass ${pass}: worker=${w.reason} (attempted ${w.attempted}, done ${w.processed}, failed ${w.failed}) | batch=${b?.status} pending=${pend.n}`);
    if (b?.status === "complete") {
      console.log(`\n✅ Batch complete: processed ${b.processed}, failed ${b.failed}, actual cost $${b.actual_cost_usd ?? "?"}. Telegram summary sent (if configured).`);
      break;
    }
    if (Number(pend.n) === 0) { console.log("\nNo pending rows left (batch will finalize on the next worker pass)."); }
    if (w.reason === "no_lease") console.log("  (another worker/cron holds the lease — waiting)");
    await sleep(PASS_DELAY_MS);
  }

  // Show the unmapped-carrier queue (interim — no admin UI yet).
  const unmapped = await db.execute<{ carrier_raw: string; n: string }>(sql`
    SELECT carrier_raw, count(*)::text AS n FROM phone_lookups
    WHERE carrier_norm = 'Unmapped' GROUP BY carrier_raw ORDER BY count(*) DESC LIMIT 20`);
  console.log(`\nUnmapped carrier strings (top 20) — assign these to buckets later:`);
  if (unmapped.length === 0) console.log("  (none)");
  for (const u of unmapped) console.log(`  ${String(u.n).padStart(5)}  ${u.carrier_raw}`);

  await raw.end({ timeout: 5 });
}
main().catch((e) => { console.error(e); process.exit(1); });
