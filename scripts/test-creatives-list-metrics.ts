import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";

// Verifies the `include_metrics` opt-out on /api/creatives/list (the stage
// form's creative dropdown renders id/text/status/spam only, but was paying for
// an org-wide 30-day aggregate over the whole `links` table on every open), plus
// the raised pageSize cap that stopped the picker silently truncating.
//
// Run against a dev server:  npx tsx scripts/test-creatives-list-metrics.ts
// Requires TEST_USER_EMAIL / TEST_USER_PASSWORD in .env.local.
type Creative = {
  id: number;
  text: string;
  metrics?: {
    delivered: number;
    clean_clicks: number;
    ctr: number | null;
    epc: number | null;
  };
};
type ListResponse = {
  data: Creative[];
  totalCount: number;
  page: number;
  pageSize: number;
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;
  if (!testEmail || !testPassword) {
    console.error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD in .env.local.");
    process.exit(1);
  }

  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        Array.from(cookieJar.entries()).map(([name, value]) => ({
          name,
          value,
        })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) cookieJar.set(name, value);
      },
    },
  });

  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });
  if (signInErr) {
    console.error(`Sign-in failed: ${signInErr.message}`);
    process.exit(1);
  }

  function cookieHeader() {
    return Array.from(cookieJar.entries())
      .map(([n, v]) => `${n}=${v}`)
      .join("; ");
  }
  async function getList(qs: string) {
    const started = Date.now();
    const res = await fetch(`${appUrl}/api/creatives/list?${qs}`, {
      headers: { Cookie: cookieHeader() },
    });
    const elapsed = Date.now() - started;
    if (!res.ok) {
      throw new Error(`GET ?${qs} → ${res.status} ${await res.text()}`);
    }
    return {
      body: (await res.json()) as ListResponse,
      elapsed,
      serverTiming: res.headers.get("server-timing"),
    };
  }

  let passed = 0;
  let failed = 0;
  function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  const BASE = "status=active&pageSize=500";

  console.log("\n[1] Default (no param) still returns metrics");
  const withM = await getList(BASE);
  check(
    "returns rows",
    withM.body.data.length > 0,
    `got ${withM.body.data.length}`,
  );
  check(
    "every row has a metrics object",
    withM.body.data.every((c) => c.metrics !== undefined),
    `${withM.body.data.filter((c) => c.metrics === undefined).length} missing`,
  );
  check(
    "metrics carry the expected keys",
    withM.body.data.every(
      (c) =>
        c.metrics !== undefined &&
        "delivered" in c.metrics &&
        "clean_clicks" in c.metrics &&
        "ctr" in c.metrics &&
        "epc" in c.metrics,
    ),
  );

  console.log("\n[2] include_metrics=false omits metrics entirely");
  const noM = await getList(`${BASE}&include_metrics=false`);
  check(
    "no row carries a metrics key",
    noM.body.data.every((c) => c.metrics === undefined),
    `${noM.body.data.filter((c) => c.metrics !== undefined).length} still have it`,
  );
  check(
    "metrics is ABSENT, not zero-filled",
    noM.body.data.every((c) => !Object.hasOwn(c, "metrics")),
  );

  console.log("\n[3] Opting out changes cost, not the result set");
  const idsWith = withM.body.data.map((c) => c.id);
  const idsWithout = noM.body.data.map((c) => c.id);
  check(
    "same number of rows",
    idsWith.length === idsWithout.length,
    `${idsWith.length} vs ${idsWithout.length}`,
  );
  check(
    "identical ids in identical order",
    JSON.stringify(idsWith) === JSON.stringify(idsWithout),
  );
  check(
    "totalCount unchanged",
    withM.body.totalCount === noM.body.totalCount,
    `${withM.body.totalCount} vs ${noM.body.totalCount}`,
  );
  check(
    "text bodies identical",
    JSON.stringify(withM.body.data.map((c) => c.text)) ===
      JSON.stringify(noM.body.data.map((c) => c.text)),
  );

  console.log("\n[4] Ratio sort with metrics off degrades, does not 500");
  const sorted = await getList(`${BASE}&sortBy=epc&sortDir=desc&include_metrics=false`);
  check("sortBy=epc + include_metrics=false → 200", sorted.body.data.length >= 0);
  check(
    "still omits metrics",
    sorted.body.data.every((c) => c.metrics === undefined),
  );

  console.log("\n[5] pageSize cap raised to 500 (was silently clamped to 100)");
  check(
    "pageSize=500 is honoured",
    withM.body.pageSize === 500,
    `got ${withM.body.pageSize}`,
  );
  const over = await getList("status=active&pageSize=9999");
  check(
    "pageSize=9999 clamps to 500, not beyond",
    over.body.pageSize === 500,
    `got ${over.body.pageSize}`,
  );
  check(
    "picker's full set is no longer truncated",
    withM.body.data.length === withM.body.totalCount ||
      withM.body.totalCount > 500,
    `returned ${withM.body.data.length} of ${withM.body.totalCount}`,
  );

  console.log("\n[6] Server-Timing attribution header");
  check(
    "header present",
    withM.serverTiming !== null,
    String(withM.serverTiming),
  );
  check(
    "records which mode ran",
    (withM.serverTiming ?? "").includes('metrics;desc="1"') &&
      (noM.serverTiming ?? "").includes('metrics;desc="0"'),
    `with=${withM.serverTiming} / without=${noM.serverTiming}`,
  );

  console.log("\n[7] Timing (informational — single sample, not an assertion)");
  console.log(`  with metrics    : ${withM.elapsed} ms   ${withM.serverTiming ?? ""}`);
  console.log(`  without metrics : ${noM.elapsed} ms   ${noM.serverTiming ?? ""}`);
  if (noM.elapsed > 0) {
    console.log(
      `  speedup         : ${(withM.elapsed / Math.max(noM.elapsed, 1)).toFixed(1)}x`,
    );
  }

  console.log(
    `\n${failed === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} — ${passed} passed, ${failed} failed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
