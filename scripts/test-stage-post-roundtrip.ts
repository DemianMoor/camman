import "./_env-preload";
import { createServerClient } from "@supabase/ssr";

// Stage POST round-trip — does the route STORE what it accepts?
//
// ⭐ THIS TEST EXISTS BECAUSE A DB-LEVEL ONE COULD NOT HAVE CAUGHT THE BUG.
// The drip window columns were dropped by the ROUTE, not the database: Drizzle's
// .values() writes exactly the keys it is handed, so a field the validator
// accepted and the guard checked vanished on the way to an INSERT that answered
// 201. Postgres was never asked to store it and had nothing to reject. Any test
// that inserts directly would have passed against the broken route.
//
// So this drives the deployed HTTP surface: POST a stage, GET it back through
// the list endpoint, compare. Then archive the probe stage.
//
// Usage:  SMOKE_CAMPAIGN_ID=<drip campaign> npx tsx scripts/test-stage-post-roundtrip.ts

const BASE = process.env.SMOKE_BASE_URL ?? "https://camman.vercel.app";
const CAMPAIGN = Number(process.env.SMOKE_CAMPAIGN_ID ?? 994);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Loose shape for a JSON API response — indexed so nested reads type-check
 *  without `any`. */
interface ApiBody {
  [key: string]: unknown;
  data?: ApiBody;
  id?: number;
  token?: string;
  secret?: string;
}

let cookie = "";
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let j: unknown = null;
  try {
    j = await r.json();
  } catch {
    /* non-JSON */
  }
  return { status: r.status, body: j as ApiBody | null };
}

async function main() {
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => Array.from(jar).map(([name, value]) => ({ name, value })),
        setAll: (cs) => {
          for (const c of cs) jar.set(c.name, c.value);
        },
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) {
    console.error("sign-in failed:", error.message);
    process.exit(1);
  }
  cookie = Array.from(jar)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
  console.log(`base: ${BASE}  campaign: ${CAMPAIGN}`);

  // A window far from any real one so it cannot collide with a live stage.
  const START = 1300;
  const END = 1380;

  console.log("\nPOST a drip stage:");
  const post = await api("POST", `/api/campaigns/${CAMPAIGN}/stages`, {
    window_start_min: START,
    window_end_min: END,
    drip_active: true,
    stop_text: "Stop to END",
  });
  check("POST accepted", post.status, 201);
  const stageId = post.body?.data?.id ?? post.body?.id;
  if (!stageId) {
    console.log("   " + JSON.stringify(post.body));
    process.exit(1);
  }
  console.log(`   stage ${stageId}`);

  // ⭐ The POST RESPONSE is not evidence of storage — it is built from the same
  // in-memory object the insert was built from, so it can echo a value that was
  // never written. Only a fresh GET proves the row.
  console.log("\nGET it back (a fresh read, not the POST echo):");
  const list = await api("GET", `/api/campaigns/${CAMPAIGN}/stages`);
  check("GET ok", list.status, 200);
  const rows = (list.body?.data ?? list.body ?? []) as unknown as ApiBody[];
  const got = rows.find((r) => r.id === stageId);
  check("the stage is in the list", got !== undefined, true);
  check("⭐ window_start_min round-tripped", got?.window_start_min, START);
  check("⭐ window_end_min round-tripped", got?.window_end_min, END);
  check("⭐ drip_active round-tripped", got?.drip_active, true);

  console.log("\ncleanup:");
  const arch = await api("POST", `/api/campaigns/${CAMPAIGN}/stages/${stageId}/archive`, {});
  check("probe stage archived", arch.status === 200 || arch.status === 201, true);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
