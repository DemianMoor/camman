// Verify offer ↔ brand assignment over HTTP (migration 0194, card 869f94t0t).
// WRITES — PREVIEW ONLY.
//
// ⚠️ SPLIT OUT OF verify-offer-brands.ts (2026-09-30). That file carried BOTH
// a read-only `--db` mode, documented as safe on production, AND this
// write mode. One file could therefore not satisfy the preview-DB guard:
// importing `_require-preview-db` unconditionally is what the guard demands of
// a write-capable script, and it refuses any non-preview target — which would
// have broken the legitimate read-only run against production.
//
// Splitting by what the mode DOES resolves it without an exclusion entry: this
// file is unambiguously a writer and imports the guard at the top; the
// remaining file issues no writes and passes the guard by being what it claims.
//
// ⚠️ NO PROJECT IDS IN HERE. The old version hardcoded both the production and
// preview Supabase refs to build its own refusal — the exact literal the guard
// exists to stop spreading. The allowlist lives in `_require-preview-db`; this
// file asks it which project the DATABASE_URL resolved to and requires the
// Supabase AUTH project to be the same one. Same invariant, no literal, and it
// survives either project being replaced.
//
// Run:
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app //     npx tsx --env-file=C:/AFF/camman/.env.demo scripts/verify-offer-brands-http.ts
import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { randomBytes } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import { requirePreviewDb } from "./_require-preview-db";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function httpMode() {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const baseUrl = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  // The guard import above already proved DATABASE_URL is an allowlisted
  // preview project and told us which one. Two things it cannot know:
  // whether the Supabase AUTH project matches (a server authenticating
  // against production while writing to preview is the mismatch that makes
  // every seeded user membership-less), and whether BASE_URL is a prod host.
  const target = requirePreviewDb();
  const authRef = supaUrl.match(/https:\/\/([^.]+)\./)?.[1];
  if (authRef !== target.ref) {
    console.error(
      `REFUSING: DATABASE_URL is ${target.ref} but NEXT_PUBLIC_SUPABASE_URL is ${authRef ?? "(unreadable)"}.
Auth and database must be the same project.`,
    );
    process.exit(1);
  }
  if (!baseUrl || /camman\.vercel\.app|exuma\.io/.test(baseUrl)) {
    console.error(
      "REFUSING: BASE_URL must be set and must not be a production host.",
    );
    process.exit(1);
  }
  console.log(`Preview: ${baseUrl} (${target.label})`);

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
        throw new Error(
          `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`,
        );
      }
      return r.json;
    };
    const idsFor = async (q: string) => {
      const r = await must("GET", `/api/offers/list?pageSize=500${q}`);
      return (r.data as { id: number }[])
        .map((o) => o.id)
        .sort((a, b) => a - b);
    };
    const same = (a: number[], b: number[]) =>
      JSON.stringify([...a].sort((x, y) => x - y)) ===
      JSON.stringify([...b].sort((x, y) => x - y));

    const sfx = Date.now().toString(36);
    const net = await must("POST", "/api/networks", {
      name: "ob net",
      network_id: `obn-${sfx}`,
    });
    const brandA = await must("POST", "/api/brands", {
      name: "ob A",
      brand_id: `oba-${sfx}`,
    });
    const brandB = await must("POST", "/api/brands", {
      name: "ob B",
      brand_id: `obb-${sfx}`,
    });
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
    check(
      "list brand_id=B → {X, Y}",
      same(await idsFor(`&brand_id=${B}`), [X, Y]),
    );
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
    check(
      "pageSize cap raised (300 honoured)",
      big.json.pageSize === 300,
      `pageSize=${big.json.pageSize}`,
    );

    // A brand created now starts empty.
    const brandC = await must("POST", "/api/brands", {
      name: "ob C",
      brand_id: `obc-${sfx}`,
    });
    check(
      "new brand has no offers",
      (await idsFor(`&brand_id=${brandC.id}`)).length === 0,
    );

    // Offer validation.
    const noBrand = await api("POST", "/api/offers", {
      name: "ob z",
      offer_id: `obz-${sfx}`,
      network_id: net.id,
      payout_model: "cpa",
      payout_cpa: 10,
      brand_ids: [],
    });
    check(
      "offer create with zero brands → 400",
      noBrand.status === 400,
      String(noBrand.status),
    );
    const foreign = await api("POST", "/api/offers", {
      name: "ob z",
      offer_id: `obz-${sfx}`,
      network_id: net.id,
      payout_model: "cpa",
      payout_cpa: 10,
      brand_ids: [2147483000],
    });
    check(
      "offer create with a foreign brand → 400",
      foreign.status === 400,
      String(foreign.status),
    );

    // Campaign create: an unassigned pair is rejected, an assigned one saves.
    const badCreate = await api("POST", "/api/campaigns", {
      name: "ob bad",
      brand_id: A,
      offer_id: Y,
      save_as_draft: true,
    });
    check(
      "campaign POST with unassigned pair → 400 offer_not_assigned_to_brand",
      badCreate.status === 400 &&
        JSON.stringify(badCreate.json).includes("offer_not_assigned_to_brand"),
      String(badCreate.status),
    );
    const camp = await must("POST", "/api/campaigns", {
      name: "ob camp",
      brand_id: A,
      offer_id: X,
      save_as_draft: true,
    });
    const cid = camp.id as number;

    // Unassign X from A (brands-only PATCH) → campaign (A, X) is grandfathered.
    const brandsOnly = await api("PATCH", `/api/offers/${X}`, {
      brand_ids: [B],
    });
    check(
      "brands-only offer PATCH → 200",
      brandsOnly.status === 200,
      String(brandsOnly.status),
    );
    check("X no longer listed for A", same(await idsFor(`&brand_id=${A}`), []));

    // Grandfathered: the editor sends brand + offer on every save.
    const gf = await api("PATCH", `/api/campaigns/${cid}`, {
      name: "ob camp (edited)",
      brand_id: A,
      offer_id: X,
    });
    check(
      "grandfathered campaign saves with the pair unchanged → 200",
      gf.status === 200,
      `${gf.status} ${gf.status !== 200 ? JSON.stringify(gf.json) : ""}`,
    );
    const changedBad = await api("PATCH", `/api/campaigns/${cid}`, {
      brand_id: A,
      offer_id: Y,
    });
    check(
      "CHANGED offer to an unassigned one → 400 offer_not_assigned_to_brand",
      changedBad.status === 400 &&
        JSON.stringify(changedBad.json).includes("offer_not_assigned_to_brand"),
      String(changedBad.status),
    );
    const changedGood = await api("PATCH", `/api/campaigns/${cid}`, {
      brand_id: B,
      offer_id: X,
    });
    check(
      "CHANGED brand to an assigned one → 200",
      changedGood.status === 200,
      String(changedGood.status),
    );
    const foreignOffer = await api("PATCH", `/api/campaigns/${cid}`, {
      offer_id: 2147483000,
    });
    check(
      "PATCH with a foreign offer_id → 400 (new org check)",
      foreignOffer.status === 400,
      String(foreignOffer.status),
    );

    // Duplicate copies an out-of-brand pair as-is: make (B, X) grandfathered.
    await must("PATCH", `/api/offers/${X}`, { brand_ids: [A] });
    const dup = await api("POST", `/api/campaigns/${cid}/duplicate`, {});
    check(
      "duplicate of an out-of-brand campaign → 2xx",
      dup.status >= 200 && dup.status < 300,
      String(dup.status),
    );
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

async function main() {
  await httpMode();
  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
