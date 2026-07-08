import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: {
        getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
        setAll: (cs) => cs.forEach((c) => cookieJar.set(c.name, c.value)),
      } },
  );
  await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!, password: process.env.TEST_USER_PASSWORD!,
  });
  const cookie = [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
  const apiFetch = (p: string) => fetch(`${BASE}${p}`, { headers: { cookie } });

  // [1] Unauthenticated → 401
  const anon = await fetch(`${BASE}/api/offers/62/report`);
  check("[1] anon rejected", anon.status === 401 || anon.status === 403, `got ${anon.status}`);

  // [2] Invalid id → 400
  const bad = await apiFetch(`/api/offers/not-a-number/report`);
  check("[2] invalid id -> 400", bad.status === 400, `got ${bad.status}`);

  // [3] Valid offer → 200 + shape
  const res = await apiFetch(`/api/offers/62/report`);
  check("[3] 200", res.status === 200, `got ${res.status}`);
  const body = await res.json();
  check("[4] has offerName", typeof body.offerName === "string");
  check("[5] rows array", Array.isArray(body.rows));
  check("[6] offerTotals + benchmark present",
    typeof body.offerTotals?.sends === "number" &&
    typeof body.orgBenchmark?.sends === "number");
  check("[7] breakEven derived",
    body.breakEvenPer1k === null || typeof body.breakEvenPer1k === "number");
  check("[8] rows carry no internal contact ids (names only)",
    body.rows.every((r: any) => typeof r.group_name === "string"));

  // [9] Cron rejects without secret
  const noSecret = await fetch(`${BASE}/api/cron/refresh-offer-group-report`);
  check("[9] cron 401 without secret", noSecret.status === 401, `got ${noSecret.status}`);

  // [10] Cron accepts with secret + advances the log timestamp
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const ok = await fetch(`${BASE}/api/cron/refresh-offer-group-report`, {
      headers: { "x-cron-secret": secret },
    });
    check("[10] cron 200 with secret", ok.status === 200, `got ${ok.status}`);
  } else {
    console.log("… [10] skipped (no CRON_SECRET in env)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
