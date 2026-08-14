// P0 probe (869egmakh): does Ahoi's CDR endpoint distinguish a BAD api key from
// a good one? READ-ONLY — GET only, no SMS is sent, no spend, nothing written.
//
// Why this exists: Ahoi/api19 ALWAYS returns HTTP 200 on /sms/send and classifies
// off the body. If /cdrs/download/csv behaves the same way, a wrong key may come
// back as HTTP 200 with an empty-or-error CSV — in which case a naive
// validateCredentials() would GREEN-LIGHT A BAD KEY. This probe decides whether
// Ahoi gets a real validateCredentials() or an honest "cannot verify without
// sending" descriptor flag.
//
// The real key is resolved from the DB and NEVER printed (only its last 4).
import "./_env-preload";

import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { decryptCredentialKey } from "@/lib/sends/provider-credential";
import { ahoiBaseUrl } from "@/lib/sends/providers/ahoi";

const TIMEOUT_MS = 20000;

// Same-day ET window — the cheapest possible CDR request (mirrors what a real
// validateCredentials() would send).
function todayEt(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(new Date());
}

interface ProbeResult {
  label: string;
  httpStatus: number;
  ok: boolean;
  contentType: string | null;
  bodyBytes: number;
  bodyHead: string;
  csvDataRows: number | null;
  error: string | null;
}

async function probe(label: string, key: string): Promise<ProbeResult> {
  const day = todayEt();
  const url =
    `${ahoiBaseUrl()}/cdrs/download/csv?record_type=sms` +
    `&startdate=${encodeURIComponent(day)}&enddate=${encodeURIComponent(day)}` +
    `&key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const body = await res.text();
    // Count CSV data rows (excluding header) so "authenticated but empty" is
    // distinguishable from "auth failure rendered as CSV".
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const csvDataRows = lines.length > 0 ? Math.max(0, lines.length - 1) : 0;
    return {
      label,
      httpStatus: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type"),
      bodyBytes: body.length,
      bodyHead: body.slice(0, 300),
      csvDataRows,
      error: null,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      label,
      httpStatus: 0,
      ok: false,
      contentType: null,
      bodyBytes: 0,
      bodyHead: "",
      csvDataRows: null,
      error: aborted ? "timeout" : err instanceof Error ? err.message : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function show(r: ProbeResult) {
  console.log(`\n──── ${r.label} ────`);
  console.log(`  HTTP status : ${r.httpStatus}${r.ok ? " (ok)" : ""}`);
  console.log(`  Content-Type: ${r.contentType ?? "(none)"}`);
  console.log(`  Body bytes  : ${r.bodyBytes}`);
  console.log(`  CSV rows    : ${r.csvDataRows ?? "n/a"}`);
  if (r.error) console.log(`  Error       : ${r.error}`);
  console.log(`  Body head   : ${JSON.stringify(r.bodyHead)}`);
}

async function main() {
  console.log(`Ahoi CDR bad-key probe — base ${ahoiBaseUrl()}, window ${todayEt()} (ET)`);
  console.log("READ-ONLY: GET only, no SMS, no spend.\n");

  // Resolve the real Ahoi key (provider row 'ahi'). Never printed.
  const rows = (await db.execute(sql`
    SELECT pc.api_key_encrypted, pc.api_key
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id
    WHERE p.sms_provider_id = 'ahi'
    ORDER BY pc.id
    LIMIT 1
  `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];

  if (!rows[0]) {
    console.error("No Ahoi credential found — cannot establish the good-key baseline.");
    process.exit(1);
  }
  const realKey = decryptCredentialKey(rows[0]);
  if (!realKey) {
    console.error("Ahoi credential present but key did not decrypt.");
    process.exit(1);
  }
  console.log(`Real key resolved (last4 ••••${realKey.slice(-4)}). Never logged in full.`);

  // A wrong key of the SAME SHAPE as the real one — so any difference is about
  // validity, not about length/format tripping a different code path.
  const sameShapeBad = realKey.slice(0, -4) + "0000";

  const results: ProbeResult[] = [];
  results.push(await probe("A. REAL key (baseline)", realKey));
  results.push(await probe("B. WRONG key, same shape", sameShapeBad));
  results.push(await probe("C. Obviously bogus key", "definitely-not-a-valid-key-12345"));
  results.push(await probe("D. EMPTY key", ""));

  for (const r of results) show(r);

  // ── Verdict ────────────────────────────────────────────────────────────────
  const [good, ...bad] = results;
  console.log("\n════ VERDICT ════");
  const distinguishable = bad.every(
    (b) =>
      b.httpStatus !== good.httpStatus ||
      b.bodyHead !== good.bodyHead ||
      (b.csvDataRows === 0 && (good.csvDataRows ?? 0) > 0 && b.bodyBytes !== good.bodyBytes),
  );
  if (distinguishable) {
    console.log("Bad keys ARE distinguishable from the good key.");
    console.log("=> Ahoi can have a real validateCredentials(). Classify on the");
    console.log("   discriminator shown above (status and/or body), NOT on row count");
    console.log("   alone — a valid key with no sends today also returns 0 rows.");
  } else {
    console.log("⚠️  Bad keys are NOT reliably distinguishable from the good key.");
    console.log("=> Ahoi must NOT get a naive validateCredentials() — it would");
    console.log("   green-light a bad key. Use the descriptor's honest");
    console.log("   'cannot verify without sending' flag instead.");
  }

  // Explicit caution when the good key returned no rows: the baseline is weak.
  if ((good.csvDataRows ?? 0) === 0) {
    console.log("\n⚠️  NOTE: the REAL key returned 0 CSV data rows, so 'empty' cannot");
    console.log("   be used as a failure signal. Re-run on a day with Ahoi traffic to");
    console.log("   confirm the good-key shape, or rely on status/body only.");
  }

  await db.$client.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try {
    await db.$client.end({ timeout: 5 });
  } catch {}
  process.exit(1);
});
