// Verify offer ↔ brand assignment (migration 0194, card 869f94t0t).
//
// Three modes, each prints its scope and FAILS on an empty one:
//
//   --db    READ-ONLY. Safe on prod and preview.
//           (1) backfill: per org, rows written by the migration's transaction
//               == offers × brands that existed at that moment;
//           (2) scope: every active / paused / completed-with-pending-stages
//               campaign has its (brand, offer) pair assigned — zero
//               out-of-brand on day one.
//   --http  WRITES. PREVIEW ONLY (refuses the prod Supabase project / host).
//           A throwaway user + its signup-trigger org, then through the real
//           API: picker subset per brand, new brand starts empty, a
//           grandfathered campaign saves unchanged, a CHANGED unassigned pair
//           is rejected, duplicate copies an out-of-brand pair. Deletes the
//           user + org it created, by id.
//   --diff  Zero changes on send-path files vs origin/main.
//
// db:    npx tsx scripts/verify-offer-brands.ts --db                (prod: .env.local)
//        npx tsx --env-file=C:/AFF/camman/.env.demo scripts/verify-offer-brands.ts --db
// http:  BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//        npx tsx --env-file=C:/AFF/camman/.env.demo scripts/verify-offer-brands.ts --http
// diff:  npx tsx scripts/verify-offer-brands.ts --diff
import "./_env-preload";

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const PROD_SUPABASE_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_SUPABASE_REF = "fdzxzxayhknywvmrhjcj";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── --db ─────────────────────────────────────────────────────────────────────
async function dbMode() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const host = new URL(process.env.DATABASE_URL!).hostname;
    console.log(`DB host: ${host}`);

    // The backfill rows share one created_at: the migration transaction's now().
    const backfill = await sql<
      { org_id: string; t: Date; actual: number; offers: number; brands: number }[]
    >`
      WITH t AS (
        SELECT org_id, min(created_at) AS t FROM offer_brands GROUP BY org_id
      )
      SELECT t.org_id, t.t,
        (SELECT count(*)::int FROM offer_brands ob
          WHERE ob.org_id = t.org_id AND ob.created_at = t.t) AS actual,
        (SELECT count(*)::int FROM offers o
          WHERE o.org_id = t.org_id AND o.created_at <= t.t) AS offers,
        (SELECT count(*)::int FROM brands b
          WHERE b.org_id = t.org_id AND b.created_at <= t.t) AS brands
      FROM t ORDER BY t.org_id`;
    const orgsWithBoth = await sql<{ n: number }[]>`
      SELECT count(DISTINCT o.org_id)::int AS n
      FROM offers o JOIN brands b ON b.org_id = o.org_id`;
    check(
      "backfill scope non-empty",
      backfill.length > 0,
      `${backfill.length} org(s) with offer_brands rows; ${orgsWithBoth[0].n} org(s) have offers and brands`,
    );
    check(
      "every org with offers and brands was backfilled",
      backfill.length === orgsWithBoth[0].n,
    );
    for (const r of backfill) {
      check(
        `backfill org ${r.org_id} at ${r.t.toISOString()}`,
        r.actual === r.offers * r.brands,
        `${r.actual} rows = ${r.offers} offers × ${r.brands} brands (${r.offers * r.brands})`,
      );
    }

    const scope = await sql<
      { id: number; status: string; brand_id: number | null; offer_id: number | null; assigned: boolean }[]
    >`
      SELECT c.id, c.status, c.brand_id, c.offer_id,
        EXISTS (
          SELECT 1 FROM offer_brands ob
          WHERE ob.org_id = c.org_id AND ob.offer_id = c.offer_id
            AND ob.brand_id = c.brand_id
        ) AS assigned
      FROM campaigns c
      WHERE c.status IN ('active', 'paused')
         OR (c.status = 'completed' AND EXISTS (
              SELECT 1 FROM campaign_stages s
              WHERE s.campaign_id = c.id AND s.status IN ('scheduled', 'pending')))
      ORDER BY c.id`;
    const byStatus = new Map<string, number>();
    for (const r of scope) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    check(
      "campaign scope non-empty",
      scope.length > 0,
      `${scope.length} campaigns: ${[...byStatus].map(([s, n]) => `${s} ${n}`).join(", ")}`,
    );
    const withPair = scope.filter((r) => r.brand_id != null && r.offer_id != null);
    const outOfBrand = withPair.filter((r) => !r.assigned);
    check(
      "zero in-scope campaigns outside their brand",
      outOfBrand.length === 0,
      `${withPair.length} with a brand+offer pair; out of brand: ${
        outOfBrand.map((r) => r.id).join(", ") || "none"
      }`,
    );
  } finally {
    await sql.end();
  }
}

// ── --http ───────────────────────────────────────────────────────────────────
async function httpMode() {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const baseUrl = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  // Refuse anything that could touch production.
  if (
    !supaUrl.includes(PREVIEW_SUPABASE_REF) ||
    supaUrl.includes(PROD_SUPABASE_REF) ||
    dbUrl.includes(PROD_SUPABASE_REF) ||
    !baseUrl ||
    /camman\.vercel\.app|exuma\.io/.test(baseUrl)
  ) {
    console.error(
      "REFUSING: --http needs the PREVIEW Supabase project, a preview DATABASE_URL and a preview BASE_URL.",
    );
    process.exit(1);
  }
  console.log(`Preview: ${baseUrl} (supabase ${PREVIEW_SUPABASE_REF})`);

  const admin = createClient(supaUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  const email = `offer-brands-verify-${Date.now()}@example.invalid`;
  const password = randomBytes(24).toString("base64url");
  let userId: string | null = null;
  let orgId: string | null = null;

  try {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser: ${created.error?.message}`);
    }
    userId = created.data.user.id;
    const members = await sql<{ org_id: string; role: string }[]>`
      SELECT org_id, role FROM org_members WHERE user_id = ${userId}`;
    check(
      "throwaway user has exactly one (owner) membership",
      members.length === 1 && members[0].role === "owner",
      JSON.stringify(members),
    );
    orgId = members[0]?.org_id ?? null;
    if (!orgId) throw new Error("signup trigger created no org");

    const jar = new Map<string, string>();
    const client = createServerClient(supaUrl, serviceKey, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
    const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");

    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      return { status: res.status, json };
    };
    const must = async (method: string, path: string, body?: unknown) => {
      const r = await api(method, path, body);
      if (r.status >= 300) {
        throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
      }
      return r.json;
    };
    const idsFor = async (q: string) => {
      const r = await must("GET", `/api/offers/list?pageSize=500${q}`);
      return (r.data as { id: number }[]).map((o) => o.id).sort((a, b) => a - b);
    };
    const same = (a: number[], b: number[]) =>
      JSON.stringify([...a].sort((x, y) => x - y)) ===
      JSON.stringify([...b].sort((x, y) => x - y));

    const sfx = Date.now().toString(36);
    const net = await must("POST", "/api/networks", { name: "ob net", network_id: `obn-${sfx}` });
    const brandA = await must("POST", "/api/brands", { name: "ob A", brand_id: `oba-${sfx}` });
    const brandB = await must("POST", "/api/brands", { name: "ob B", brand_id: `obb-${sfx}` });
    const A = brandA.id as number;
    const B = brandB.id as number;
    const offer = (tag: string, brand_ids: number[]) =>
      must("POST", "/api/offers", {
        name: `ob ${tag}`,
        offer_id: `ob${tag}-${sfx}`,
        network_id: net.id,
        payout_model: "cpa",
        payout_cpa: 10,
        brand_ids,
      });
    const X = (await offer("x", [A, B])).id as number;
    const Y = (await offer("y", [B])).id as number;

    // Picker subset per brand, and the unfiltered list.
    check("list brand_id=A → {X}", same(await idsFor(`&brand_id=${A}`), [X]));
    check("list brand_id=B → {X, Y}", same(await idsFor(`&brand_id=${B}`), [X, Y]));
    check("list without brand → {X, Y}", same(await idsFor(""), [X, Y]));
    const rows = (await must("GET", "/api/offers/list?pageSize=500")).data as {
      id: number;
      brand_ids: number[];
    }[];
    check(
      "list rows carry brand_ids",
      same(rows.find((r) => r.id === X)!.brand_ids, [A, B]) &&
        same(rows.find((r) => r.id === Y)!.brand_ids, [B]),
    );
    const big = await api("GET", "/api/offers/list?pageSize=300");
    check("pageSize cap raised (300 honoured)", big.json.pageSize === 300, `pageSize=${big.json.pageSize}`);

    // A brand created now starts empty.
    const brandC = await must("POST", "/api/brands", { name: "ob C", brand_id: `obc-${sfx}` });
    check("new brand has no offers", (await idsFor(`&brand_id=${brandC.id}`)).length === 0);

    // Offer validation.
    const noBrand = await api("POST", "/api/offers", {
      name: "ob z", offer_id: `obz-${sfx}`, network_id: net.id,
      payout_model: "cpa", payout_cpa: 10, brand_ids: [],
    });
    check("offer create with zero brands → 400", noBrand.status === 400, String(noBrand.status));
    const foreign = await api("POST", "/api/offers", {
      name: "ob z", offer_id: `obz-${sfx}`, network_id: net.id,
      payout_model: "cpa", payout_cpa: 10, brand_ids: [2147483000],
    });
    check("offer create with a foreign brand → 400", foreign.status === 400, String(foreign.status));

    // Campaign create: an unassigned pair is rejected, an assigned one saves.
    const badCreate = await api("POST", "/api/campaigns", {
      name: "ob bad", brand_id: A, offer_id: Y, save_as_draft: true,
    });
    check(
      "campaign POST with unassigned pair → 400 offer_not_assigned_to_brand",
      badCreate.status === 400 && JSON.stringify(badCreate.json).includes("offer_not_assigned_to_brand"),
      String(badCreate.status),
    );
    const camp = await must("POST", "/api/campaigns", {
      name: "ob camp", brand_id: A, offer_id: X, save_as_draft: true,
    });
    const cid = camp.id as number;

    // Unassign X from A (brands-only PATCH) → campaign (A, X) is grandfathered.
    const brandsOnly = await api("PATCH", `/api/offers/${X}`, { brand_ids: [B] });
    check("brands-only offer PATCH → 200", brandsOnly.status === 200, String(brandsOnly.status));
    check("X no longer listed for A", same(await idsFor(`&brand_id=${A}`), []));

    // Grandfathered: the editor sends brand + offer on every save.
    const gf = await api("PATCH", `/api/campaigns/${cid}`, {
      name: "ob camp (edited)", brand_id: A, offer_id: X,
    });
    check("grandfathered campaign saves with the pair unchanged → 200", gf.status === 200, `${gf.status} ${gf.status !== 200 ? JSON.stringify(gf.json) : ""}`);
    const changedBad = await api("PATCH", `/api/campaigns/${cid}`, { brand_id: A, offer_id: Y });
    check(
      "CHANGED offer to an unassigned one → 400 offer_not_assigned_to_brand",
      changedBad.status === 400 && JSON.stringify(changedBad.json).includes("offer_not_assigned_to_brand"),
      String(changedBad.status),
    );
    const changedGood = await api("PATCH", `/api/campaigns/${cid}`, { brand_id: B, offer_id: X });
    check("CHANGED brand to an assigned one → 200", changedGood.status === 200, String(changedGood.status));
    const foreignOffer = await api("PATCH", `/api/campaigns/${cid}`, { offer_id: 2147483000 });
    check("PATCH with a foreign offer_id → 400 (new org check)", foreignOffer.status === 400, String(foreignOffer.status));

    // Duplicate copies an out-of-brand pair as-is: make (B, X) grandfathered.
    await must("PATCH", `/api/offers/${X}`, { brand_ids: [A] });
    const dup = await api("POST", `/api/campaigns/${cid}/duplicate`, {});
    check("duplicate of an out-of-brand campaign → 2xx", dup.status >= 200 && dup.status < 300, String(dup.status));
  } finally {
    // Cleanup by explicit id only: the throwaway org's campaigns (brand/offer
    // FKs are RESTRICT), then the org (cascades the rest), then the user.
    if (orgId) {
      const others = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM org_members
        WHERE org_id = ${orgId} AND user_id <> ${userId}`;
      if (others[0].n === 0) {
        await sql`DELETE FROM campaigns WHERE org_id = ${orgId}`;
        await sql`DELETE FROM organizations WHERE id = ${orgId}`;
      } else {
        console.error(`NOT deleting org ${orgId}: it has other members`);
      }
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
    await sql.end();
    console.log(`cleanup: user ${userId ?? "-"} / org ${orgId ?? "-"} removed`);
  }
}

// ── --diff ───────────────────────────────────────────────────────────────────
const SEND_PATH = [
  "lib/sends/",
  "lib/drip/",
  "lib/reporting/",
  "lib/audience-snapshot.ts",
  "lib/segment-rules-eval.ts",
  "lib/engagement/",
  "lib/links/",
  "app/api/cron/",
  "app/api/campaigns/[campaignId]/status/",
  "app/api/campaigns/[campaignId]/stages/",
  "app/api/campaigns/[campaignId]/send",
  "app/r/",
];
function diffMode() {
  const changed = execSync("git diff --name-only origin/main...HEAD", {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  check("branch diff non-empty", changed.length > 0, `${changed.length} files vs origin/main`);
  console.log(`send-path prefixes checked: ${SEND_PATH.join(", ")}`);
  const hits = changed.filter((f) => SEND_PATH.some((p) => f.startsWith(p)));
  check("zero send-path files changed", hits.length === 0, hits.join(", ") || "none");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--db") await dbMode();
  else if (mode === "--http") await httpMode();
  else if (mode === "--diff") diffMode();
  else {
    console.error("usage: verify-offer-brands.ts --db | --http | --diff");
    process.exit(1);
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
