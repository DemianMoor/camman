import "./_env-preload";

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import { OPERATOR_ROUTE_MAP, type HttpMethod } from "@/lib/authz/route-map";
import { allowedTokenRoutes } from "@/lib/authz/operator-gate";
import { TOKEN_REQUESTS_PER_HOUR } from "@/lib/api/token-usage";

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

  // What counts as denied depends on HOW the route authenticates.
  //
  // Routes behind requireApiMembership() must return exactly 403 — our gate
  // refusing a known operator. Cron routes, provider webhooks and the partner
  // intake authenticate with a bearer secret or a path token and never look at
  // the session at all, so an operator gets 401. Both are denials; only a 2xx
  // is a failure.
  //
  // The two populations are counted SEPARATELY rather than merged, because a
  // gate-protected route that started answering 401 would mean the session
  // broke — and a run where the session is dead would otherwise look like a
  // perfect pass.
  let gate403 = 0;
  let tokenAuth = 0;
  const reachableDenied: string[] = [];
  const wrongDenial: string[] = [];
  for (const route of denied) {
    const methods = exportedMethods(route);
    if (methods.length === 0) continue; // nothing to call
    const method = methods.includes("GET") ? "GET" : methods[0];
    const src = readFileSync(join(API_ROOT, route, "route.ts"), "utf8");
    // The stage drain calls requireApiMembership() but deliberately does NOT
    // return its error: it feeds the resolved role into decideDrainAuth, which
    // owns the refusal because a CRON_SECRET caller has no session at all. An
    // operator therefore gets 401 from that second gate, not 403 from ours.
    // Still a denial — just one this check must not attribute to our gate.
    const usesOurGate =
      src.includes("requireApiMembership") && !src.includes("decideDrainAuth");
    const { status } = await get(concreteUrl(route, ids), method);

    if (status >= 200 && status < 300) {
      reachableDenied.push(`${method} ${route} -> ${status}`);
    } else if (usesOurGate && status === 403) {
      gate403++;
    } else if (usesOurGate) {
      wrongDenial.push(`${method} ${route} -> ${status} (expected 403 from our gate)`);
    } else {
      tokenAuth++;
    }
  }
  if (reachableDenied.length === 0) {
    pass(
      `no denied route was reachable — ${gate403} refused 403 by requireApiMembership, ` +
        `${tokenAuth} by their own token/secret auth`,
    );
  } else {
    fail(`${reachableDenied.length} denied route(s) were REACHABLE:`);
    for (const d of reachableDenied.slice(0, 25)) console.log(`       ${d}`);
  }
  if (wrongDenial.length > 0) {
    fail(`${wrongDenial.length} gate-protected route(s) denied with the wrong status:`);
    for (const d of wrongDenial.slice(0, 25)) console.log(`       ${d}`);
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
  console.log(`\n--- 3. No CONTACT phone numbers or contact ids ---`);
  //
  // ⚠️ `phone_number` ALONE IS NOT A LEAK. The access matrix explicitly permits
  // the operator to see SENDING numbers ("By Number: phone numbers may show"),
  // and provider_phones.phone_number is exactly that. An assertion on the FIELD
  // NAME flagged campaigns/list and provider-phones/list on the first run, and
  // the only way to make that green would have been to delete the check.
  //
  // So this asserts on VALUES instead: every phone-shaped string in an operator
  // response must be a known SENDING number. Anything else is a recipient, and
  // that is a real leak. Strictly stronger than the field-name version it
  // replaces, not weaker.
  const senderRows = await sql<{ phone_number: string }[]>`
    SELECT phone_number FROM provider_phones`;
  const senders = new Set(
    senderRows.map((r) => String(r.phone_number).replace(/[^0-9]/g, "")),
  );
  console.log(
    `  scope: ${allowedGet.length} routes, ${senders.size} known sending numbers treated as allowed`,
  );
  if (senders.size === 0) {
    fail("sending-number scope is EMPTY - every phone would look like a leak");
  }
  const contactLeaks: string[] = [];
  for (const route of allowedGet) {
    const { status, body } = await get(concreteUrl(route, ids), "GET");
    if (status < 200 || status >= 300) continue;
    if (body.includes("contact_id")) {
      contactLeaks.push(`${route} contains contact_id`);
    }
    for (const m of body.match(/\+?1?\d{10,15}/g) ?? []) {
      const digits = m.replace(/[^0-9]/g, "");
      if (digits.length >= 10 && !senders.has(digits)) {
        contactLeaks.push(
          `${route} contains a non-sending phone ending ${digits.slice(-4)}`,
        );
        break;
      }
    }
  }
  if (contactLeaks.length === 0)
    pass("every phone-shaped value was a known sending number; no contact_id anywhere");
  else {
    fail(`${contactLeaks.length} response(s) carried contact-level fields:`);
    for (const l of contactLeaks.slice(0, 25)) console.log(`       ${l}`);
  }


  // ── 4. Rendered PAGES must not leak either ──────────────────────────────
  //
  // ⚠️ THIS SECTION EXISTS BECAUSE THE API BOUNDARY WAS NOT ENOUGH.
  //
  // SendStateStripLoader is a server component rendered by the protected layout
  // on EVERY page. It read sms_providers.name and never touched an API route,
  // so every JSON assertion above passed while the name was being written
  // straight into the HTML. Checking JSON alone would have certified a leak as
  // clean.
  //
  // So this fetches the rendered HTML of every page an operator may open and
  // applies the same two assertions. Note the honest limit: most pages here are
  // client components, so their body arrives nearly empty and the check is only
  // meaningful for what the SERVER renders — which is exactly the class of leak
  // it was written for. The count of pages returning substantial HTML is
  // printed so the strength of the run is visible rather than assumed.
  console.log(`\n--- 4. Rendered PAGES: no provider identity, no recipient phones ---`);

  const ALLOWED_PAGES = [
    "/dashboard",
    "/campaigns",
    "/campaigns/new",
    `/campaigns/${ids.campaignId ?? "1"}`,
    `/campaigns/${ids.campaignId ?? "1"}/edit`,
    "/segments",
    "/segments/charts",
    `/segments/${ids.id ?? "1"}`,
    "/creatives",
    "/brands",
    "/offers",
    "/affiliate-networks",
    "/utm-tags",
    "/routing-types",
    "/traffic-types",
    "/reports",
    "/reports/delivery",
    "/sends/today",
  ];

  const DENIED_PAGES = [
    "/contacts",
    "/contact-groups",
    "/clickers",
    "/opt-outs",
    "/opt-ins",
    "/drip/why-not-routed",
    "/providers",
    "/reports/partners",
    "/sends/autopilot",
    "/settings/sending",
    "/settings/providers",
    "/settings/lookup",
    "/settings/short-domains",
    "/settings/notifications",
    "/settings/partners",
    "/settings/users",
  ];

  const page = async (path: string) => {
    const r = await fetch(`${BASE}${path}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    return { status: r.status, html: await r.text() };
  };

  console.log(
    `  scope: ${ALLOWED_PAGES.length} allowed pages + ${DENIED_PAGES.length} denied pages`,
  );
  if (ALLOWED_PAGES.length === 0 || DENIED_PAGES.length === 0) {
    fail("page scope is EMPTY");
  }

  let substantial = 0;
  const pageLeaks: string[] = [];
  const pageBlocked: string[] = [];
  for (const path of ALLOWED_PAGES) {
    const { status, html } = await page(path);
    if (status >= 300 && status < 400) {
      pageBlocked.push(`${path} -> ${status} (redirected away)`);
      continue;
    }
    if (status !== 200) {
      pageBlocked.push(`${path} -> ${status}`);
      continue;
    }
    if (html.length > 20000) substantial++;
    const lower = html.toLowerCase();
    for (const f of forbidden) {
      if (
        new RegExp(`(^|[^a-z0-9])${f.toLowerCase()}([^a-z0-9]|$)`).test(lower)
      ) {
        pageLeaks.push(`${path} rendered provider "${f}"`);
        break;
      }
    }
    for (const m of html.match(/\+?1?\d{10,15}/g) ?? []) {
      const digits = m.replace(/[^0-9]/g, "");
      if (digits.length >= 10 && !senders.has(digits)) {
        pageLeaks.push(`${path} rendered a non-sending phone ending ${digits.slice(-4)}`);
        break;
      }
    }
  }
  if (pageBlocked.length === 0) {
    pass(`all ${ALLOWED_PAGES.length} allowed pages rendered for the operator`);
  } else {
    fail(`${pageBlocked.length} allowed page(s) were not reachable:`);
    for (const b of pageBlocked) console.log(`       ${b}`);
  }
  console.log(
    `     ${substantial}/${ALLOWED_PAGES.length} returned substantial HTML (>20KB) — the rest are\n` +
      `     client-rendered, so the check is meaningful only for server output there`,
  );
  if (pageLeaks.length === 0) {
    pass("no provider name and no recipient phone in any rendered page");
  } else {
    fail(`${pageLeaks.length} page(s) leaked in server-rendered HTML:`);
    for (const l of pageLeaks) console.log(`       ${l}`);
  }

  const pageOpen: string[] = [];
  for (const path of DENIED_PAGES) {
    const { status } = await page(path);
    // notFound() renders 404; a redirect away is also a refusal.
    if (status === 404 || (status >= 300 && status < 400)) continue;
    pageOpen.push(`${path} -> ${status}`);
  }
  if (pageOpen.length === 0) {
    pass(`all ${DENIED_PAGES.length} denied pages refused (404 or redirect)`);
  } else {
    fail(`${pageOpen.length} denied page(s) still render for the operator:`);
    for (const o of pageOpen) console.log(`       ${o}`);
  }


  // ── 5. Password sign-in is ROLE-GATED, not merely unset ─────────────────
  //
  // The question this answers: is an operator kept off the password path
  // because signInAction refuses their role, or only because the invite flow
  // never sets a password for them?
  //
  // It is BOTH, and the role gate is the load-bearing half. This run proves the
  // weaker claim is not what we are relying on: the operator we just signed in
  // as HAS a password and Supabase accepted it three sections ago. If the only
  // protection were "no password is ever set", that session would have been a
  // full app login.
  //
  // ⚠️ ASSERTED AGAINST SOURCE, not by driving the login form. Submitting the
  // form would mean putting a real password in the command output, which is
  // not worth a slightly better proof. The gate is a plain role comparison
  // whose absence this check would catch immediately.
  console.log(`\n--- 5. Password sign-in role gate ---`);
  const loginSrc = readFileSync(
    resolve(process.cwd(), "app/(auth)/login/actions.ts"),
    "utf8",
  );
  console.log(`  scope: app/(auth)/login/actions.ts (${loginSrc.length} bytes)`);
  const refusesNonOwner = /member\.role\s*!==\s*"owner"/.test(loginSrc);
  const tearsDownSession =
    /member\.role\s*!==\s*"owner"[\s\S]{0,200}?signOut\(\)/.test(loginSrc);
  if (loginSrc.length === 0) {
    fail("login action source is EMPTY");
  }
  if (refusesNonOwner) pass("signInAction refuses any role that is not owner");
  else fail("signInAction has NO role gate — an operator with a password could sign in");
  if (tearsDownSession) {
    pass("the refused session is signed out, so the refusal is not cosmetic");
  } else {
    fail("the role gate does not sign the session out — a refused user keeps a valid cookie");
  }
  console.log(
    `     (this operator authenticated against Supabase with a password during\n` +
      `      this very run — so the app-level gate is what stops them, not the\n` +
      `      absence of a credential)`,
  );

  // ── 6. API TOKENS (ClickUp 869evpmbz) ───────────────────────────────────
  //
  // ⚠️ THE POINT OF THIS SECTION IS THAT IT RE-RUNS THE SWEEP, not that it adds
  // a few auth cases. Sections 2 and 3 proved the redactor and the contact-field
  // rules hold for a SESSION. A token takes a different path into
  // requireApiMembership(), so "the operator cannot see provider names" is a
  // fresh claim for tokens and is asserted the same way, against the same
  // forbidden-string scope, rather than assumed to carry over.
  //
  // Tokens are minted by direct INSERT rather than through the Owner API: the
  // point here is the AUTH path, and provisioning through HTTP would need an
  // Owner session this script does not have. The hash is computed exactly as
  // lib/api/tokens.ts computes it — if that ever changes, every case below
  // fails loudly rather than silently testing nothing.
  console.log(`\n--- 6. API TOKENS: auth gates, allowlist, and the same leak sweep ---`);

  const mintToken = async (opts: {
    label: string;
    memberId: string;
    revoked?: boolean;
    expired?: boolean;
  }) => {
    const plaintext = `cmt_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(plaintext, "utf-8").digest("hex");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO api_tokens
        (org_id, org_member_id, token_hash, token_prefix, name, revoked_at, expires_at)
      VALUES (
        ${org.id}::uuid, ${opts.memberId}::uuid, ${hash},
        ${plaintext.slice(0, 10)}, ${`verify:${opts.label}`},
        ${opts.revoked ? new Date().toISOString() : null}::timestamptz,
        ${opts.expired ? new Date(Date.now() - 60_000).toISOString() : null}::timestamptz
      )
      RETURNING id`;
    return { plaintext, id: row.id };
  };

  const [memberRow] = await sql<{ id: string }[]>`
    SELECT id FROM org_members WHERE user_id = ${userId}::uuid AND org_id = ${org.id}::uuid`;
  const memberId = memberRow.id;

  const tokenGet = async (
    path: string,
    method: HttpMethod,
    plaintext: string,
  ) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
      redirect: "manual",
    });
    return { status: r.status, body: await r.text() };
  };

  const auditCount = async (action: string, tokenId: string) => {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = ${org.id}::uuid AND action = ${action} AND entity_id = ${tokenId}`;
    return r?.n ?? 0;
  };

  // A route every case below probes. GET, token-allowed, and it returns a real
  // body, so a 2xx here is a meaningful pass rather than an empty one.
  const PROBE = "/api/contacts/base-stats";
  // Token-DENIED but operator-ALLOWED. This is the pair that proves the token
  // allowlist is a real second gate: the same member reaching the same route
  // with a session gets through, and with a token does not.
  //
  // ⚠️ IT MUST EXPORT GET. The first pick here was /api/campaigns, which turned
  // out to be POST-only (the collection routes in this codebase are POST; the
  // GET lives at /list) — so Next returned 405 before any authorization ran, and
  // the "denied" result was meaningless. Check 6g below is what caught it: it
  // fetches the same route with a SESSION and fails if that is not a 2xx, so a
  // probe that is broken for everyone can never be mistaken for a working gate.
  const TOKEN_DENIED_PROBE = "/api/members";

  // 6a — api_enabled false ⇒ 401, even with a perfectly valid token.
  await sql`UPDATE org_members SET api_enabled = false WHERE id = ${memberId}::uuid`;
  const disabledTok = await mintToken({ label: "api-disabled", memberId });
  {
    const { status } = await tokenGet(PROBE, "GET", disabledTok.plaintext);
    if (status === 401) pass("token of an api_enabled=false member -> 401");
    else fail(`token of an api_enabled=false member -> ${status} (expected 401)`);
  }

  // Everything below needs the switch on.
  await sql`UPDATE org_members SET api_enabled = true WHERE id = ${memberId}::uuid`;

  // 6b — the switch is genuinely what gated it: same token, now allowed.
  {
    const { status } = await tokenGet(PROBE, "GET", disabledTok.plaintext);
    if (status >= 200 && status < 300) {
      pass("the SAME token works once api_enabled is on (the switch is the gate)");
    } else {
      fail(`token still refused after enabling API access -> ${status}`);
    }
  }

  // 6c — revoked ⇒ 401, and the denial is ATTRIBUTED to the owning member.
  //
  // ⚠️ THE ATTRIBUTION HALF IS NOT DECORATION. The per-user usage drill-in
  // filters audit_log on actor_user_id, so a 401 denial written with a NULL
  // actor is invisible on the one screen built to show denials — while the
  // token-keyed counter still counts it, so the panel's totals and its own
  // hourly series disagree. That shipped and was caught by the production smoke
  // test, not by this script; this assertion is why it cannot come back.
  {
    const t = await mintToken({ label: "revoked", memberId, revoked: true });
    const { status } = await tokenGet(PROBE, "GET", t.plaintext);
    if (status === 401) pass("revoked token -> 401");
    else fail(`revoked token -> ${status} (expected 401)`);

    const [attributed] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = ${org.id}::uuid AND action = 'api.denied'
        AND entity_id = ${t.id} AND actor_user_id IS NOT NULL`;
    if ((attributed?.n ?? 0) >= 1) {
      pass("the 401 denial is attributed to the owning member (visible in their drill-in)");
    } else {
      fail("the 401 denial has a NULL actor_user_id — invisible in the per-user usage panel");
    }
  }

  // 6d — expired ⇒ 401.
  {
    const t = await mintToken({ label: "expired", memberId, expired: true });
    const { status } = await tokenGet(PROBE, "GET", t.plaintext);
    if (status === 401) pass("expired token -> 401");
    else fail(`expired token -> ${status} (expected 401)`);
  }

  // 6e — a garbage bearer ⇒ 401, and NOTHING is written for it (an unresolved
  // token is a scanner; it must not be able to create audit rows).
  {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${org.id}::uuid`;
    const { status } = await tokenGet(PROBE, "GET", "cmt_not-a-real-token");
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${org.id}::uuid`;
    if (status === 401) pass("unknown token -> 401");
    else fail(`unknown token -> ${status} (expected 401)`);
    if (after[0].n === before[0].n) {
      pass("an unknown token wrote no audit rows (a scanner cannot fill the log)");
    } else {
      fail(`an unknown token wrote ${after[0].n - before[0].n} audit row(s)`);
    }
  }

  // 6f — non-flagged route ⇒ 403 AND an api.denied row.
  const liveTok = await mintToken({ label: "live", memberId });
  {
    const { status } = await tokenGet(TOKEN_DENIED_PROBE, "GET", liveTok.plaintext);
    const denials = await auditCount("api.denied", liveTok.id);
    if (status === 403) pass(`token on a non-allowlisted route (${TOKEN_DENIED_PROBE}) -> 403`);
    else fail(`token on a non-allowlisted route -> ${status} (expected 403)`);
    if (denials >= 1) pass(`the denial wrote an api.denied audit row (${denials})`);
    else fail("the denial wrote NO api.denied row — it would be invisible to the Owner");
  }

  // 6g — the SAME route with a SESSION succeeds. Without this the 403 above
  // could just mean "that route is broken", and the allowlist would look
  // effective while testing nothing.
  {
    const { status } = await get(TOKEN_DENIED_PROBE, "GET");
    if (status >= 200 && status < 300) {
      pass(`the same route is reachable with a SESSION -> ${status} (the allowlist is the difference)`);
    } else {
      fail(
        `${TOKEN_DENIED_PROBE} is ${status} for a session too — the 403 above proves nothing`,
      );
    }
  }

  // 6h — a method NOT in the route's token list ⇒ 403, on a route whose token
  // list is GET only. This is what replaces "read_only ⇒ GET".
  {
    const { status } = await tokenGet(PROBE, "POST", liveTok.plaintext);
    // 403 from our gate, or 405 if Next refuses the unexported method first.
    // Both are refusals; only a 2xx is a failure.
    if (status === 403 || status === 405) {
      pass(`POST to a GET-only token route -> ${status}`);
    } else {
      fail(`POST to a GET-only token route -> ${status} (expected 403/405)`);
    }
  }

  // 6i — rate limit. Pre-loading the counter to the limit rather than firing 300
  // real requests: the assertion is that the GATE refuses at the boundary, and
  // 300 round-trips against preview would add minutes to every run to test the
  // same branch. The counter row IS the limiter's only state, so setting it is
  // equivalent to having spent it.
  {
    const hourStart = new Date();
    hourStart.setUTCMinutes(0, 0, 0);
    await sql`
      INSERT INTO api_token_usage (org_id, api_token_id, window_kind, window_start, count)
      VALUES (${org.id}::uuid, ${liveTok.id}::uuid, 'request', ${hourStart.toISOString()}::timestamptz, ${TOKEN_REQUESTS_PER_HOUR})
      ON CONFLICT (api_token_id, window_kind, window_start)
      DO UPDATE SET count = ${TOKEN_REQUESTS_PER_HOUR}`;
    const { status } = await tokenGet(PROBE, "GET", liveTok.plaintext);
    const limited = await auditCount("api.rate_limited", liveTok.id);
    if (status === 429) pass(`token over the hourly limit -> 429`);
    else fail(`token over the hourly limit -> ${status} (expected 429)`);
    if (limited >= 1) pass(`the trip wrote an api.rate_limited audit row (${limited})`);
    else fail("the rate-limit trip wrote NO api.rate_limited row");

    // The Telegram side latches through alert_state, so the row is the
    // observable proof that a send was owed. Asserting delivery itself would
    // mean asserting Telegram is up, which is not what this verifies.
    const [alert] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM alert_state
      WHERE alert_key LIKE ${`api-token-ratelimit:${liveTok.id}:%`}`;
    if ((alert?.n ?? 0) >= 1) {
      pass("the trip armed an alert_state row (a Telegram send was owed)");
    } else {
      fail("no alert_state row — the rate-limit trip would never page anyone");
    }

    // And the refusal must NOT have burned more quota (the guard is on the
    // DO UPDATE). If it had, a retry loop would extend its own lockout.
    const [usage] = await sql<{ count: number }[]>`
      SELECT count FROM api_token_usage
      WHERE api_token_id = ${liveTok.id}::uuid AND window_kind = 'request'
        AND window_start = ${hourStart.toISOString()}::timestamptz`;
    if (Number(usage?.count) === TOKEN_REQUESTS_PER_HOUR) {
      pass("a refused request did NOT increment the counter (rejections don't burn quota)");
    } else {
      fail(
        `a refused request moved the counter to ${usage?.count} (expected ${TOKEN_REQUESTS_PER_HOUR})`,
      );
    }
    // Clear it so the sweep below is not rate-limited.
    await sql`DELETE FROM api_token_usage WHERE api_token_id = ${liveTok.id}::uuid`;
  }

  // 6j — THE SWEEP. Every token-allowed GET, fetched WITH TOKEN AUTH, run
  // through the same forbidden-string and contact-field assertions as sections
  // 2 and 3. This is the check the card asks for, and the reason this section
  // lives in this file rather than in one of its own.
  const tokenGetRoutes = allowedTokenRoutes()
    .filter((t) => t.methods.includes("GET"))
    .map((t) => t.route)
    .filter((r) => exportedMethods(r).includes("GET"));

  console.log(`  scope: ${tokenGetRoutes.length} token-allowed GET routes swept with bearer auth`);
  if (tokenGetRoutes.length === 0) fail("token GET sweep scope is EMPTY");

  // The limiter is real and this sweep spends it. Raise the ceiling for the run
  // by clearing the counter rather than by special-casing the code path.
  await sql`DELETE FROM api_token_usage WHERE api_token_id = ${liveTok.id}::uuid`;

  let tokenReachable = 0;
  let token2xx = 0;
  const tokenBlocked: string[] = [];
  const tokenLeaks: string[] = [];
  for (const route of tokenGetRoutes) {
    const { status, body } = await tokenGet(
      concreteUrl(route, ids),
      "GET",
      liveTok.plaintext,
    );
    if (status === 401 || status === 403 || status === 429) {
      tokenBlocked.push(`${route} -> ${status}`);
      continue;
    }
    tokenReachable++;
    if (status < 200 || status >= 300) continue;
    token2xx++;

    const lower = body.toLowerCase();
    for (const f of forbidden) {
      if (new RegExp(`(^|[^a-z0-9])${f.toLowerCase()}([^a-z0-9]|$)`).test(lower)) {
        tokenLeaks.push(`${route} leaked provider "${f}"`);
        break;
      }
    }
    if (body.includes("contact_id")) {
      tokenLeaks.push(`${route} contains contact_id`);
    }
    for (const m of body.match(/\+?1?\d{10,15}/g) ?? []) {
      const digits = m.replace(/[^0-9]/g, "");
      if (digits.length >= 10 && !senders.has(digits)) {
        tokenLeaks.push(`${route} contains a non-sending phone ending ${digits.slice(-4)}`);
        break;
      }
    }
  }
  if (tokenBlocked.length === 0) {
    pass(`all ${tokenReachable} token-allowed GET routes were reachable by token`);
  } else {
    fail(`${tokenBlocked.length} token-allowed route(s) refused a valid token:`);
    for (const b of tokenBlocked.slice(0, 25)) console.log(`       ${b}`);
  }
  console.log(`     of which ${token2xx} returned 2xx (a real body, so a meaningful leak check)`);
  if (tokenLeaks.length === 0) {
    pass("no provider identity and no contact field in ANY token response");
  } else {
    fail(`${tokenLeaks.length} token response(s) leaked:`);
    for (const l of tokenLeaks.slice(0, 25)) console.log(`       ${l}`);
  }

  // 6k — fresh-counts carries group names and integers, and nothing else.
  {
    const { status, body } = await tokenGet(
      "/api/audience/fresh-counts",
      "GET",
      liveTok.plaintext,
    );
    if (status === 503) {
      console.log("     fresh-counts: 503 (rollup not computed yet in preview) — shape not checked");
    } else if (status >= 200 && status < 300) {
      let bad: string[] = [];
      try {
        const parsed = JSON.parse(body) as {
          by_group?: Record<string, unknown>[];
        };
        for (const g of parsed.by_group ?? []) {
          for (const [k, v] of Object.entries(g)) {
            // group_name is the ONLY string allowed anywhere in a group entry.
            if (k === "group_name") {
              if (typeof v !== "string") bad.push(`group_name is ${typeof v}`);
              continue;
            }
            if (k === "not_used") {
              for (const [w, n] of Object.entries(v as Record<string, unknown>)) {
                if (typeof n !== "number") bad.push(`not_used.${w} is ${typeof n}`);
              }
              continue;
            }
            if (typeof v !== "number") bad.push(`${k} is ${typeof v}, expected number`);
          }
        }
      } catch {
        bad = ["response was not JSON"];
      }
      if (bad.length === 0) {
        pass("fresh-counts groups carry only a group_name string and integers");
      } else {
        fail(`fresh-counts leaked non-count fields: ${bad.slice(0, 5).join(", ")}`);
      }
    } else {
      fail(`fresh-counts -> ${status}`);
    }
  }

  // Clean up the tokens this run minted. Revoked rather than deleted would leave
  // preview accumulating rows every run; these are synthetic and named, so a
  // targeted delete is safe and keeps the table honest.
  await sql`DELETE FROM api_tokens WHERE org_id = ${org.id}::uuid AND name LIKE 'verify:%'`;

  await sql.end();
  console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
  console.log(
    "\n  NOT covered by this run: the Google OAuth sign-in path (no interactive\n" +
      "  consent from a script), allowed write methods (would mutate data), and\n" +
      "  actual Telegram delivery (asserted as an armed alert_state row instead).",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verification threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
