import "./_env-preload";

import { createServerClient } from "@supabase/ssr";
import { sql as drizzleSql } from "drizzle-orm";

import { db } from "../db/client";

// Prod smoke-check for the purchase-rule fix: hits the DEPLOYED segment rules
// preview endpoint with real Supabase SSR cookies and asserts the Buyers
// segment resolves to the fixed count, proving the deployed BUNDLE carries the
// change (the local verifier only proves the source does).
//
// The expectation is COMPUTED LIVE from the database, not frozen: the preview
// reports the SENDABLE audience, i.e. buyers MINUS contacts in `opt_outs`
// (835 - 128 = 707 at the time of writing). Asserting a hardcoded number here
// would either go stale as sales accumulate or, worse, silently encode the
// opt-out subtraction as a coincidence.
//
// NOTE: NEXT_PUBLIC_SITE_URL in .env.local points at localhost — never use it
// here. The prod alias is passed explicitly.
const PROD = process.env.SMOKE_BASE_URL ?? "https://camman.vercel.app";
const SEGMENT_ID = Number(process.env.SMOKE_SEGMENT_ID ?? 219);
// The value the OLD, broken predicate produced. The fix is only proven if we
// land far above it.
const BROKEN_BASELINE = 2;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    console.error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD in .env.local.");
    process.exit(1);
  }

  const jar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cs) => {
        for (const { name, value } of cs) jar.set(name, value);
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(`Sign-in failed: ${error.message}`);
    process.exit(1);
  }
  const cookie = Array.from(jar.entries())
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");

  // Control: a bogus path must NOT 200, otherwise a blanket redirect would make
  // any result below meaningless.
  const control = await fetch(`${PROD}/api/segments/999999999/rules/preview`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  console.log(`control (nonexistent segment): HTTP ${control.status}`);

  const res = await fetch(`${PROD}/api/segments/${SEGMENT_ID}/rules/preview`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as {
    count: number | null;
    manual_count?: number;
    rule_filtered_count?: number | null;
    truncated?: boolean;
  };
  console.log(`preview segment ${SEGMENT_ID}: HTTP ${res.status}`);
  console.log(`  ${JSON.stringify(body)}`);

  // Live expectation: sendable buyers = non-rejected conversions MINUS opt-outs.
  const rows = (await db.execute(drizzleSql`
    WITH seg AS (SELECT org_id FROM segments WHERE id = ${SEGMENT_ID}::int),
    buyers AS (
      SELECT DISTINCT ss.contact_id
      FROM stage_sends ss JOIN seg ON seg.org_id = ss.org_id
      WHERE ss.sale_status IN ('lead','sale')
    )
    SELECT count(*)::int AS n FROM buyers b
    WHERE NOT EXISTS (
      SELECT 1 FROM opt_outs o JOIN seg ON seg.org_id = o.org_id
      WHERE o.contact_id = b.contact_id)
  `)) as unknown as { n: number }[];
  const expected = rows[0]?.n ?? -1;
  const manual = body.manual_count ?? 0;
  console.log(
    `  live expectation: ${expected} sendable buyers (+ ${manual} manual members)`,
  );

  const ok =
    res.status === 200 &&
    control.status !== 200 &&
    body.count === expected &&
    expected > BROKEN_BASELINE;
  console.log(
    ok
      ? `\nPASS — deployed prod resolves segment ${SEGMENT_ID} to ${body.count}, matching the live sendable-buyer count exactly (old predicate gave ${BROKEN_BASELINE})`
      : `\nFAIL — prod ${body.count} vs live expectation ${expected} (control ${control.status})`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke check crashed:", e);
  process.exit(1);
});
