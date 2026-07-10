// Phase 3 worker tests: pure (Warsaw midnight, summary) + live-DB (lease single-
// runner + crash recovery, attempt-summed daily cap, enqueue dedup, worker lease
// guard). All DB writes are test rows, cleaned up in finally. No Telnyx HTTP.
// Run: npx tsx scripts/test-lookup-worker.ts
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Neutralize the `server-only` import guard for this node/tsx test (tsx runs CJS
// here) without a global export condition — a condition would also alter how other
// packages (e.g. libphonenumber-js) resolve their entry points. resolve() finds the
// path without executing the throwing module; we seed the require cache with {}.
const req = createRequire(import.meta.url);
try {
  const soPath = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} };
} catch {
  /* not installed — nothing to stub */
}

async function main() {
  const { warsawMidnightUtc, countAttemptsToday } = await import("@/lib/telnyx/daily-cap");
  const { formatBatchSummary } = await import("@/lib/telnyx/summary");
  const { claimWorkerLease, renewWorkerLease, releaseWorkerLease } = await import("@/lib/telnyx/lease");
  const { enqueueNormalized } = await import("@/lib/telnyx/enqueue");
  const { runLookupWorker } = await import("@/lib/telnyx/worker");
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✓ ${m}`);
    else { failures++; console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  };
  const ok = (c: boolean, m: string) => eq(!!c, true, m);

  const testPhones = ["+12128675309", "+13128675309", "+14088675309"];
  const cachePhone = "+16468675309";
  const capPhone = "+19998880000";
  const batchIds: string[] = [];
  const allPhones = [...testPhones, cachePhone, capPhone];

  try {
    // ---- pure: Warsaw midnight (summer = UTC+2) ----
    console.log("\npure — Warsaw midnight / summary:");
    eq(
      warsawMidnightUtc(new Date("2026-07-10T09:30:00Z")).toISOString(),
      "2026-07-09T22:00:00.000Z",
      "warsawMidnightUtc for 2026-07-10 09:30Z → 2026-07-09 22:00Z (Warsaw UTC+2)",
    );
    const msg = formatBatchSummary({
      trigger: "upload", orgName: "Acme", total: 100, cacheHits: 10, processed: 90,
      failed: 2, lineTypeCounts: { mobile: 45, landline: 27, voip: 18 }, actualCostUsd: 1.92, billedUsd: 0.75, balanceUsd: 142.55,
    });
    ok(msg.includes("90 new, 10 cached"), "summary shows new/cached");
    ok(msg.includes("50% mobile") && msg.includes("30% landline (N/A)"), "summary shows line-type %");
    ok(msg.includes("Telnyx balance: $142.55") && msg.includes("Failed: 2"), "summary shows balance + failed");
    ok(msg.includes("Est (rate): $1.92") && msg.includes("Billed (ledger): $0.75"), "summary reconciles rate estimate vs ledger billed");

    // ---- DB: lease single-runner + CAS + crash recovery ----
    console.log("\nDB — lease single-runner:");
    await db.execute(sql`UPDATE lookup_settings SET worker_lease_until = NULL WHERE id = true`);
    const t1 = await claimWorkerLease();
    ok(!!t1, "first claim acquires the lease");
    const t2 = await claimWorkerLease();
    eq(t2, null, "second overlapping claim is a no-op (null) — single runner");
    const w = await runLookupWorker();
    eq([w.ran, w.reason], [false, "no_lease"], "runLookupWorker exits no-op while lease held (2nd invocation)");
    const t1b = await renewWorkerLease(t1!);
    ok(!!t1b, "renew with the current token succeeds (heartbeat)");
    const stale = await renewWorkerLease(t1!);
    eq(stale, null, "renew with a stale token fails (CAS — no double-owner)");
    // simulate a crashed drain: lease left behind, then expires
    await db.execute(sql`UPDATE lookup_settings SET worker_lease_until = now() - interval '1 minute' WHERE id = true`);
    const t3 = await claimWorkerLease();
    ok(!!t3, "after lease expiry (simulated crash), the next invocation proceeds — no manual intervention");
    await releaseWorkerLease(t3!);
    const rel = await db.execute<{ wl: string | null }>(sql`SELECT worker_lease_until AS wl FROM lookup_settings WHERE id = true`);
    eq(rel[0]?.wl ?? null, null, "release clears the lease on clean exit");

    // ---- DB: daily cap counts ATTEMPTS (sum), not rows ----
    console.log("\nDB — daily cap counts attempts:");
    const org = await db.execute<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
    const orgId = org[0].id;
    const capBefore = await countAttemptsToday();
    const capBatch = await db.execute<{ id: string }>(sql`
      INSERT INTO lookup_batches (org_id, trigger, total_numbers, status)
      VALUES (${orgId}::uuid, 'upload', 1, 'pending') RETURNING id`);
    batchIds.push(capBatch[0].id);
    // A number that 429'd twice then succeeded: one row, attempts=3, status done.
    await db.execute(sql`
      INSERT INTO lookup_queue (batch_id, phone, status, attempts, updated_at)
      VALUES (${capBatch[0].id}::uuid, ${capPhone}, 'done', 3, now())`);
    const capAfter = await countAttemptsToday();
    eq(capAfter - capBefore, 3, "429×2 then success (attempts=3, one row) consumes 3 toward the cap, not 1");

    // ---- DB: enqueue dedup ----
    console.log("\nDB — enqueue dedup:");
    const r1 = await enqueueNormalized(orgId, testPhones, "upload");
    batchIds.push(r1.batchId);
    eq(r1.total, testPhones.length, "enqueue total = valid input count");
    eq(r1.enqueued, testPhones.length, "first enqueue: all enqueued");
    eq(r1.cacheHits, 0, "first enqueue: 0 cache hits");
    const r2 = await enqueueNormalized(orgId, testPhones, "upload");
    batchIds.push(r2.batchId);
    eq(r2.enqueued, 0, "re-enqueue same numbers: 0 (already pending)");
    // cache hit: a phone already complete in phone_lookups
    await db.execute(sql`
      INSERT INTO phone_lookups (phone, line_type, carrier_norm, source, lookup_status)
      VALUES (${cachePhone}, 'mobile', 'Verizon', 'telnyx', 'complete')`);
    const r3 = await enqueueNormalized(orgId, [cachePhone], "upload");
    batchIds.push(r3.batchId);
    eq([r3.cacheHits, r3.enqueued], [1, 0], "already-looked-up number: 1 cache hit, 0 enqueued (free)");
  } finally {
    // cleanup — remove all test data from the global tables
    const { pgArray } = await import("@/lib/telnyx/pg-array");
    if (batchIds.length) await db.execute(sql`DELETE FROM lookup_batches WHERE id = ANY(${pgArray(batchIds, "uuid")})`);
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone = ANY(${pgArray(allPhones, "text")})`);
    await db.execute(sql`DELETE FROM lookup_queue WHERE phone = ANY(${pgArray(allPhones, "text")})`);
    await db.execute(sql`UPDATE lookup_settings SET worker_lease_until = NULL WHERE id = true`);
    await sqlEnd();
  }

  console.log(failures === 0 ? "\nAll Phase 3 worker tests passed ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);

  async function sqlEnd() {
    const { sql: raw } = await import("@/db/client");
    await raw.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
