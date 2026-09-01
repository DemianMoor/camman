import "./_env-preload";

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import { OPERATOR_ROUTE_MAP, type HttpMethod } from "@/lib/authz/route-map";

// End-to-end operator access verification (ClickUp 869et3vm1, Phase 2).
//
// Signs in as a REAL operator against a REAL deployment and hits every route in
// the map. This is the check that the whole phase rests on: the route map, the
// permission set and the redactor are all claims, and this is the only thing
// that tests them against a running system rather than against themselves.
//
// ── SAFETY: PREVIEW ONLY ──────────────────────────────────────────────────
// It CREATES a user and an org membership, so it refuses to run unless both the
// database and the target URL are the disposable preview environment. Running
// it against production would mint an operator account in the live system.
//
// ── WHAT IT DOES AND DOES NOT EXERCISE ────────────────────────────────────
// The operator session is minted with a PASSWORD via the Supabase Admin API,
// not through Google OAuth — an interactive Google consent screen cannot be
// driven from a script. That is a real limitation and it is reported in the
// output rather than glossed: this proves the AUTHORIZATION layer (route map,
// permissions, redaction), not the Google sign-in path. The domain gate is
// covered separately by scripts/test-workspace-gate.ts, which unit-tests
// verifyWorkspaceIdentity against synthetic identity payloads.
//
// Note the password path is deliberately blocked for non-owners in
// signInAction — that is a UI-layer rule. The API layer only ever sees a valid
// session, which is exactly what an operator would carry after a Google login,
// so the authorization behaviour under test is identical.
//
// ── METHOD CHOICE ─────────────────────────────────────────────────────────
// DENIED routes are probed with a method the route actually exports, because a
// route with no GET handler returns 405 before any authorization runs — a 405
// would be a meaningless pass. The 403 lands in requireApiMembership(), which
// is the first statement in every handler, so nothing is mutated.
//
// ALLOWED routes are probed with GET ONLY. Probing allowed POST/PATCH/DELETE
// would create and destroy real rows; the map/wiring half of those is covered
// by scripts/test-route-map-coverage.ts. The output reports how many allowed
// routes could not be leak-checked for this reason, rather than implying full
// coverage.

const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";
const OPERATOR_EMAIL = process.env.OPERATOR_TEST_EMAIL ?? "operator-test@exuma.io";
const BASE = process.env.BASE_URL ?? "";

const API_ROOT = resolve(process.cwd(), "app/api");

let failures = 0;
const fail = (m: string) => {
  console.log(`  XX ${m}`);
  failures++;
};
const pass = (m: string) => console.log(`  OK ${m}`);

function exportedMethods(route: string): HttpMethod[] {
  const src = readFileSync(join(API_ROOT, route, "route.ts"), "utf8");
  const out: HttpMethod[] = [];
  for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"] as HttpMethod[]) {
    if (new RegExp(`export async function ${m}\\s*\\(`).test(src)) out.push(m);
  }
  return out;
}

/** Fill dynamic segments with real ids where we have them, placeholders otherwise. */
function concreteUrl(route: string, ids: Record<string, string>): string {
  return (
    "/api/" +
    route
      .split("/")
      .map((seg) => {
        if (!seg.startsWith("[")) return seg;
        const name = seg.replace(/[[\]]/g, "");
        return ids[name] ?? ids.fallback ?? "1";
      })
      .join("/")
  );
}

async function main() {
  if (!BASE) {
    console.error("BASE_URL is required (the preview deployment URL).");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes(PREVIEW_REF)) {
    console.error(
      `REFUSING TO RUN: DATABASE_URL does not point at the preview project (${PREVIEW_REF}).\n` +
        "This script creates a user and a membership; it must never touch production.",
    );
    process.exit(1);
  }
  if (/camman\.vercel\.app$/.test(new URL(BASE).host)) {
    console.error("REFUSING TO RUN: BASE_URL is the production alias.");
    process.exit(1);
  }

  console.log("=== operator access verification ===\n");
  console.log(`  target : ${BASE}`);
  console.log(`  database: preview (${PREVIEW_REF})`);
  console.log(`  operator: ${OPERATOR_EMAIL}\n`);

  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // ── Provision the operator (idempotent) ─────────────────────────────────
  const password = `Op-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const existing = await admin.auth.admin.listUsers({ perPage: 200 });
  let userId = existing.data?.users.find((u) => u.email === OPERATOR_EMAIL)?.id;
  if (userId) {
    await admin.auth.admin.updateUserById(userId, { password });
  } else {
    const created = await admin.auth.admin.createUser({
      email: OPERATOR_EMAIL,
      password,
      email_confirm: true,
    });
    if (created.error) {
      console.error("could not create the operator user:", created.error.message);
      process.exit(1);
    }
    userId = created.data.user!.id;
  }

  const [org] = await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`;
  await sql`
    INSERT INTO org_members (user_id, org_id, role, is_active)
    VALUES (${userId}::uuid, ${org.id}::uuid, 'operator', true)
    ON CONFLICT (user_id, org_id)
    DO UPDATE SET role = 'operator', is_active = true`;
  console.log(`  provisioned operator membership in org ${org.id.slice(0, 8)}…\n`);

  // ── Sign in and build a cookie jar ──────────────────────────────────────
  const jar: { name: string; value: string }[] = [];
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => jar,
        setAll: (list) => {
          for (const c of list) {
            const i = jar.findIndex((x) => x.name === c.name);
            if (i >= 0) jar[i] = { name: c.name, value: c.value };
            else jar.push({ name: c.name, value: c.value });
          }
        },
      },
    },
  );
  const signIn = await sb.auth.signInWithPassword({
    email: OPERATOR_EMAIL,
    password,
  });
  if (signIn.error) {
    console.error("operator sign-in failed:", signIn.error.message);
    process.exit(1);
  }
  const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");

  // ── Real ids so allowed routes can return real bodies ───────────────────
  const pick = async (q: postgres.PendingQuery<Record<string, unknown>[]>) => {
    const r = (await q) as unknown as { id: unknown }[];
    return r[0]?.id != null ? String(r[0].id) : undefined;
  };
  const ids: Record<string, string> = {};
  const campaignId = await pick(sql`SELECT id FROM campaigns ORDER BY id LIMIT 1`);
  if (campaignId) ids.campaignId = campaignId;
  const stageId = await pick(
    sql`SELECT id FROM campaign_stages WHERE campaign_id = ${campaignId ?? null} ORDER BY id LIMIT 1`,
  );
  if (stageId) ids.stageId = stageId;
  // `[id]` is shared by creatives, segments, brands, networks and more. A
  // creative id is used as the generic filler: a wrong-entity id yields 404,
  // which still proves "not 403" and still gets leak-checked when it is 2xx.
  const creativeId = await pick(sql`SELECT id FROM creatives ORDER BY id LIMIT 1`);
  const offerId = await pick(sql`SELECT id FROM offers ORDER BY id LIMIT 1`);
  if (creativeId) ids.id = creativeId;
  if (offerId) ids.offerId = offerId;
  ids.fallback = "1";

  // ── The strings that must never appear in an operator response ──────────
  const providerRows = await sql<{ name: string; code: string }[]>`
    SELECT name, sms_provider_id AS code FROM sms_providers`;
  const forbidden = providerRows
    .flatMap((p) => [p.name, p.code])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 1);
  console.log(`  scope: ${forbidden.length} forbidden provider strings: ${forbidden.join(", ")}`);
  if (forbidden.length === 0) {
    fail("forbidden-string scope is EMPTY — nothing would ever be detected");
  }

  const get = async (path: string, method: HttpMethod) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
      redirect: "manual",
    });
    return { status: r.status, body: await r.text() };
  };

  // ── 1. Denied routes must 403 ───────────────────────────────────────────
  const denied = Object.keys(OPERATOR_ROUTE_MAP).filter(
    (r) => OPERATOR_ROUTE_MAP[r] == null,
  );
  console.log(`\n--- 1. DENIED routes must 403 ---`);
  console.log(`  scope: ${denied.length} denied routes`);
  if (denied.length === 0) fail("denied scope is EMPTY");

  let deniedOk = 0;
  const deniedBad: string[] = [];
  for (const route of denied) {
    const methods = exportedMethods(route);
    if (methods.length === 0) continue; // nothing to call
    const method = methods.includes("GET") ? "GET" : methods[0];
    const { status } = await get(concreteUrl(route, ids), method);
    // 403 is the target. 401 would mean the session broke; anything 2xx is a leak.
    if (status === 403) deniedOk++;
    else deniedBad.push(`${method} ${route} -> ${status}`);
  }
  if (deniedBad.length === 0) pass(`all ${deniedOk} callable denied routes returned 403`);
  else {
    fail(`${deniedBad.length} denied route(s) did NOT 403:`);
    for (const d of deniedBad.slice(0, 25)) console.log(`       ${d}`);
  }

  // ── 2. Allowed routes: reachable, and no leaked identity ────────────────
  const allowed = Object.keys(OPERATOR_ROUTE_MAP).filter(
    (r) => OPERATOR_ROUTE_MAP[r] != null,
  );
  const allowedGet = allowed.filter((r) => {
    const e = OPERATOR_ROUTE_MAP[r];
    return e != null && e.methods.includes("GET") && exportedMethods(r).includes("GET");
  });
  console.log(`\n--- 2. ALLOWED routes: reachable + no provider identity ---`);
  console.log(
    `  scope: ${allowedGet.length} of ${allowed.length} allowed routes are GET-probeable`,
  );
  console.log(
    `         (${allowed.length - allowedGet.length} are write-only; probing them would mutate preview data —\n` +
      `          their wiring is covered by scripts/test-route-map-coverage.ts)`,
  );
  if (allowedGet.length === 0) fail("allowed GET scope is EMPTY");

  let reachable = 0;
  let with2xx = 0;
  const wrongly403: string[] = [];
  const leaked: string[] = [];
  for (const route of allowedGet) {
    const { status, body } = await get(concreteUrl(route, ids), "GET");
    if (status === 403) {
      wrongly403.push(route);
      continue;
    }
    reachable++;
    if (status >= 200 && status < 300) with2xx++;
    const lower = body.toLowerCase();
    for (const f of forbidden) {
      // Whole-word match, so a provider code like "ahi" cannot trip on a
      // substring inside an unrelated word.
      if (new RegExp(`(^|[^a-z0-9])${f.toLowerCase()}([^a-z0-9]|$)`).test(lower)) {
        leaked.push(`${route} leaked "${f}"`);
        break;
      }
    }
  }
  if (wrongly403.length === 0) pass(`all ${reachable} probeable allowed routes were reachable (not 403)`);
  else {
    fail(`${wrongly403.length} allowed route(s) returned 403: ${wrongly403.join(", ")}`);
  }
  console.log(`     of which ${with2xx} returned 2xx (a real body, so a meaningful leak check)`);

  if (leaked.length === 0) pass(`no provider name or code appeared in any operator response`);
  else {
    fail(`${leaked.length} response(s) leaked provider identity:`);
    for (const l of leaked.slice(0, 25)) console.log(`       ${l}`);
  }

  // ── 3. Contact-level fields must never appear ───────────────────────────
  console.log(`\n--- 3. No contact-level fields in any allowed response ---`);
  const CONTACT_KEYS = ["phone_number", '"phone"', "contact_id"];
  console.log(`  scope: ${CONTACT_KEYS.length} field markers across ${allowedGet.length} routes`);
  const contactLeaks: string[] = [];
  for (const route of allowedGet) {
    const { status, body } = await get(concreteUrl(route, ids), "GET");
    if (status < 200 || status >= 300) continue;
    for (const k of CONTACT_KEYS) {
      if (body.includes(k)) contactLeaks.push(`${route} contains ${k}`);
    }
  }
  if (contactLeaks.length === 0) pass("no contact-level field markers found");
  else {
    fail(`${contactLeaks.length} response(s) carried contact-level fields:`);
    for (const l of contactLeaks.slice(0, 25)) console.log(`       ${l}`);
  }

  await sql.end();
  console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
  console.log(
    "\n  NOT covered by this run: the Google OAuth sign-in path (no interactive\n" +
      "  consent from a script) and allowed write methods (would mutate data).",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verification threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
