import "./_env-preload";
import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";

// Drip Phase 5 — production send-proof SETUP.
//
// Every object is created through the REAL deployed API route rather than a DB
// insert, so the proof covers the paths an operator would actually use. A DB
// insert would prove the schema accepts the row and nothing about whether the
// product can produce it.
const PROD = process.env.SMOKE_BASE_URL ?? "https://camman.vercel.app";
const BRAND_LUMZEN = 142;
const OFFER = 118; // Lean Habit Jelly — live on LumZen
const SLUG = "lhj"; // proven live: www.lumzen.co/lp/lhj
const PHONE_114 = 114;
const PROVIDER_TXR = 641;
const CREATIVE = 599;
const TAG = "medicare";

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
  const r = await fetch(`${PROD}${path}`, {
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

function hhmm(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function etNowMinutes() {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(f.find((p) => p.type === "hour")!.value);
  const m = Number(f.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
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

  // Control — a bogus path must NOT 200, else every result below is meaningless.
  const ctl = await api("GET", "/api/campaigns/999999999/drip-config");
  console.log(
    `control (nonexistent campaign): HTTP ${ctl.status}  ${ctl.status === 200 ? "SUSPECT" : "ok"}`,
  );

  const etMin = etNowMinutes();
  console.log(`ET now: ${hhmm(etMin)}  (${etMin} min past ET midnight)`);

  // 1. partner key
  console.log("\n-- 1. partner key 'internal-test' (non-sandbox, tiny limits)");
  const pk = await api("POST", "/api/partner-keys", {
    partner_slug: "internal-test",
    name: "internal-test",
    interest_tag_mode: "force",
    interest_tag: TAG,
    sandbox: false,
    rate_per_sec: 2,
    rate_per_day: 40,
  });
  console.log(`   HTTP ${pk.status}`);
  let keyId = pk.body?.data?.id ?? pk.body?.id;
  let token = pk.body?.token;
  let secret = pk.body?.secret;
  if (pk.status !== 201 && pk.status !== 200) {
    // Re-runnable: reuse the key if a previous run already made it. The SECRET
    // is unrecoverable by construction, so a reused key needs a rotate to get
    // a usable one -- reported rather than silently skipped.
    console.log("   " + JSON.stringify(pk.body));
    const existing = (await db.execute(
      sql`SELECT id, token FROM partner_keys WHERE partner_slug = 'internal-test'`,
    )) as unknown as { id: number; token: string }[];
    if (!existing[0]) process.exit(1);
    keyId = existing[0].id;
    token = existing[0].token;
    const rot = await api("POST", `/api/partner-keys/${keyId}/rotate`, {});
    secret = rot.body?.secret;
    console.log(`   reused key id=${keyId}; rotate -> HTTP ${rot.status}`);
  }
  console.log(`   id=${keyId} token=${token} sandbox=${pk.body?.data?.sandbox ?? pk.body?.sandbox}`);

  // 2. landing page
  console.log(`\n-- 2. landing page (kind=slug, /lp/${SLUG})`);
  const lp = await api("POST", `/api/offers/${OFFER}/landing-pages`, {
    title: "LumZen - Lean Habit Jelly",
    kind: "slug",
    slug: SLUG,
    is_default: true,
  });
  console.log(`   HTTP ${lp.status}  ${JSON.stringify(lp.body?.data ?? lp.body).slice(0, 220)}`);
  let lpId = lp.body?.data?.id ?? lp.body?.id;
  if (!lpId) {
    const ex = (await db.execute(
      sql`SELECT id FROM offer_landing_pages WHERE offer_id = ${OFFER} AND slug = ${SLUG}`,
    )) as unknown as { id: number }[];
    lpId = ex[0]?.id;
    console.log(`   reused landing page id=${lpId}`);
  }

  // 3. campaign
  console.log("\n-- 3. campaign 'Drip Test 1'");
  const c = await api("POST", "/api/campaigns", {
    name: "Drip Test 1",
    brand_id: BRAND_LUMZEN,
    offer_id: OFFER,
    type: "drip",
    // A drip campaign has NO contact groups by design -- its audience arrives as
    // leads. The create schema's launch branch demands one, so it is created as
    // a draft. Whether it can then REACH 'active' is exactly what step 7 tests.
    save_as_draft: true,
  });
  console.log(`   HTTP ${c.status}`);
  const campId = c.body?.data?.id ?? c.body?.id;
  if (!campId) {
    console.log("   " + JSON.stringify(c.body));
    process.exit(1);
  }
  console.log(`   id=${campId} type=${c.body?.data?.type} status=${c.body?.data?.status}`);
  // link_mode is update-only (campaigns always start manual); the drain needs tracked.
  const lm = await api("PATCH", `/api/campaigns/${campId}`, { link_mode: "tracked" });
  console.log(`   PATCH link_mode=tracked -> HTTP ${lm.status}`);

  // 4. drip config
  console.log("\n-- 4. drip config");
  const cfg = await api("PUT", `/api/campaigns/${campId}/drip-config`, {
    interest_tag: TAG,
    partner_key_id: keyId,
    priority: 1,
    daily_cap: 20,
    campaign_cap: 20,
    filters: {},
  });
  console.log(`   HTTP ${cfg.status}  ${JSON.stringify(cfg.body).slice(0, 220)}`);

  // 5. number
  console.log("\n-- 5. number (phone 114, daily limit 20)");
  const nums = await api("PUT", `/api/campaigns/${campId}/drip-numbers`, {
    numbers: [{ provider_phone_id: PHONE_114, daily_limit: 20, position: 0 }],
  });
  console.log(`   HTTP ${nums.status}  ${JSON.stringify(nums.body).slice(0, 220)}`);

  // 6. stage with a window covering now
  const startMin = Math.max(0, etMin - 60);
  const endMin = Math.min(1440, etMin + 240);
  console.log(`\n-- 6. first-send stage, window ${hhmm(startMin)}-${hhmm(endMin)} ET (covers now)`);
  const st = await api("POST", `/api/campaigns/${campId}/stages`, {
    stage_number: 1,
    creative_id: CREATIVE,
    landing_page_id: lpId,
    sms_provider_id: PROVIDER_TXR,
    provider_phone_id: PHONE_114,
    window_start_min: startMin,
    window_end_min: endMin,
    drip_active: true,
    stop_text: "Stop to END",
  });
  console.log(`   HTTP ${st.status}  ${JSON.stringify(st.body?.data ?? st.body).slice(0, 320)}`);
  const stageId = st.body?.data?.id ?? st.body?.id;

  // 7. can a drip campaign even reach active?
  console.log(
    "\n-- 7. draft -> active  (routing, scheduling AND the drain all require status='active')",
  );
  const act = await api("POST", `/api/campaigns/${campId}/status`, { status: "active" });
  console.log(`   HTTP ${act.status}  ${JSON.stringify(act.body).slice(0, 400)}`);

  console.log("\n-- DB evidence -------------------------------------------------");
  const queries: [string, ReturnType<typeof sql>][] = [
    [
      "campaign",
      sql`SELECT id, name, type, status, brand_id, offer_id, link_mode, send_paused FROM campaigns WHERE id=${campId}`,
    ],
    [
      "drip_campaign_configs",
      sql`SELECT campaign_id, interest_tag, partner_key_id, priority, daily_cap, campaign_cap, filters FROM drip_campaign_configs WHERE campaign_id=${campId}`,
    ],
    ["drip_campaign_numbers", sql`SELECT * FROM drip_campaign_numbers WHERE campaign_id=${campId}`],
    [
      "stage",
      sql`SELECT id, stage_number, creative_id, provider_phone_id, sms_provider_id, landing_page_id,
                 window_start_min, window_end_min, drip_active, send_approved, scheduled_at,
                 materialized_at, full_url
          FROM campaign_stages WHERE campaign_id=${campId}`,
    ],
    [
      "partner_key",
      sql`SELECT id, partner_slug, name, sandbox, rate_per_sec, rate_per_day, interest_tag_mode,
                 interest_tag, status FROM partner_keys WHERE id=${keyId}`,
    ],
    [
      "landing_page",
      sql`SELECT id, offer_id, title, kind, slug, is_default, status FROM offer_landing_pages WHERE offer_id=${OFFER}`,
    ],
  ];
  for (const [label, q] of queries) {
    const r = (await db.execute(q)) as unknown as Record<string, unknown>[];
    console.log(`   ${label}: ${r.length ? JSON.stringify(r[0]) : "(none)"}`);
  }
  console.log(
    `\nIDS  campaign=${campId} stage=${stageId} partner_key=${keyId} landing_page=${lpId}`,
  );
  console.log(`TOKEN  ${token}`);
  console.log(`SECRET ${secret}`);
  await pgConn.end();
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
