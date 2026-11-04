// Verifies the Keitaro offer id on the Offer API (POST /api/offers,
// PATCH /api/offers/[id]) on a PR PREVIEW deploy, with throwaway users and
// full cleanup. Nothing here touches production.
//
// Org A (throwaway user, OWNER, then demoted to OPERATOR) and org B (a second
// throwaway user's org, the "other tenant"):
//   1. validator: positive integer only, null/absent allowed (pure, no network)
//   2. POST with keitaro_offer_id → 201, stored
//   3. duplicate in the same org (POST and PATCH) → 409 code `duplicate`
//   4. an ARCHIVED offer still holds its id (duplicate → 409)
//   5. another org may use the same id (201, no 409)
//   6. PATCH to the offer's own current id → 200 (self excluded)
//   7. PATCH null clears → stored NULL; the id is then free again
//   8. a PATCH without the key leaves the stored id alone
//   9. OPERATOR PATCH that includes keitaro_offer_id → 403, row untouched
//
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon key> \
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//   npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-offers-keitaro-id-api.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { offerCreateSchema, offerUpdateSchema } from "../lib/validators/offers";

const TAG = `__offer-keitaro-test-${Date.now()}__`;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function validatorChecks() {
  console.log("\n[validator]");
  const base = {
    name: "n",
    offer_id: "o1",
    network_id: 1,
    payout_model: "cpa" as const,
    payout_cpa: 1,
    brand_ids: [1],
  };
  const ok = (v: unknown) => offerCreateSchema.safeParse({ ...base, keitaro_offer_id: v }).success;
  check("1. 62, null, absent accepted", ok(62) && ok(null) && offerCreateSchema.safeParse(base).success);
  check("1. 0, -1, 1.5, '62', too large rejected", !ok(0) && !ok(-1) && !ok(1.5) && !ok("62") && !ok(2147483648));
  check("1. update accepts null alone", offerUpdateSchema.safeParse({ keitaro_offer_id: null }).success);
}

async function main() {
  validatorChecks();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const base = process.env.BASE_URL ?? "";
  const preview = requirePreviewDb();
  if (!supabaseUrl.includes(preview.ref)) {
    console.error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL must be the same preview project (${preview.ref}).`);
    process.exit(1);
  }
  if (!/^https:\/\/camman-[a-z0-9]+-demian-moors-projects\.vercel\.app$/.test(base)) {
    console.error("Refusing to run: BASE_URL must be a camman-* preview deployment.");
    process.exit(1);
  }

  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);

  const createdUsers: { id: string; orgId: string | null }[] = [];
  try {
    // createUser fires the signup trigger: a new org + an OWNER membership.
    async function throwawayUser(label: string) {
      const email = `${TAG}${label}@example.invalid`.replace(/_/g, "");
      const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const u = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (u.error || !u.data.user) throw new Error(`createUser failed: ${u.error?.message}`);
      const entry = { id: u.data.user.id, orgId: null as string | null };
      createdUsers.push(entry);
      const m = (await db.execute(sql`
        SELECT org_id, role FROM org_members WHERE user_id = ${u.data.user.id}`)) as unknown as {
        org_id: string;
        role: string;
      }[];
      if (m.length !== 1 || m[0].role !== "owner") throw new Error(`expected one owner membership, got ${JSON.stringify(m)}`);
      entry.orgId = m[0].org_id;
      const net = Number(
        ((await db.execute(sql`
          INSERT INTO affiliate_networks (org_id, name, network_id, status)
          VALUES (${m[0].org_id}, ${TAG + label}, ${"n" + label}, 'active') RETURNING id`)) as unknown as { id: number }[])[0].id,
      );
      const brand = Number(
        ((await db.execute(sql`
          INSERT INTO brands (org_id, brand_id, name)
          VALUES (${m[0].org_id}, ${`${TAG}${label}`}, ${TAG + label}) RETURNING id`)) as unknown as { id: number }[])[0].id,
      );
      return { email, password, userId: u.data.user.id, orgId: m[0].org_id, net, brand };
    }

    const A = await throwawayUser("a");
    const B = await throwawayUser("b");

    function client(email: string, password: string) {
      const jar = new Map<string, string>();
      const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        cookies: {
          getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
          setAll: (cookies) => {
            for (const { name, value } of cookies) jar.set(name, value);
          },
        },
      });
      return {
        async signIn() {
          const r = await supabase.auth.signInWithPassword({ email, password });
          if (r.error) throw new Error(`sign-in failed: ${r.error.message}`);
        },
        async call(method: string, path: string, body?: unknown): Promise<Res> {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: { "Content-Type": "application/json", Cookie: Array.from(jar, ([n, v]) => `${n}=${v}`).join("; ") },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* non-JSON */
          }
          return { status: res.status, body: parsed };
        },
      };
    }
    const a = client(A.email, A.password);
    const b = client(B.email, B.password);
    await a.signIn();
    await b.signIn();

    const KID = 910_000 + Math.floor(Math.random() * 80_000);
    const mk = (who: typeof A, offerId: string, extra: Record<string, unknown> = {}) => ({
      name: `${TAG}${offerId}`,
      offer_id: `${TAG}${offerId}`.replace(/_/g, "-").slice(0, 40),
      network_id: who.net,
      payout_model: "cpa",
      payout_cpa: 5,
      brand_ids: [who.brand],
      ...extra,
    });
    const stored = async (id: number) =>
      ((await db.execute(sql`SELECT keitaro_offer_id AS k FROM offers WHERE id = ${id}`)) as unknown as { k: number | null }[])[0]?.k ?? null;

    console.log("\n[owner]");
    const o1 = await a.call("POST", "/api/offers", mk(A, "1", { keitaro_offer_id: KID }));
    check("2. POST with keitaro_offer_id → 201, stored", o1.status === 201 && o1.body?.keitaro_offer_id === KID && (await stored(o1.body?.id)) === KID, JSON.stringify(o1.body).slice(0, 200));

    const o2 = await a.call("POST", "/api/offers", mk(A, "2"));
    check("2. POST without it → 201, NULL", o2.status === 201 && (await stored(o2.body?.id)) === null);

    const dupPost = await a.call("POST", "/api/offers", mk(A, "3", { keitaro_offer_id: KID }));
    const dupRows = (await db.execute(sql`SELECT 1 FROM offers WHERE org_id = ${A.orgId} AND name = ${TAG + "3"}`)) as unknown as unknown[];
    check("3. POST duplicate in org → 409 duplicate, no row", dupPost.status === 409 && dupPost.body?.code === "duplicate" && dupRows.length === 0, JSON.stringify(dupPost.body));
    const dupPatch = await a.call("PATCH", `/api/offers/${o2.body?.id}`, { keitaro_offer_id: KID });
    check("3. PATCH duplicate in org → 409 duplicate, unchanged", dupPatch.status === 409 && dupPatch.body?.code === "duplicate" && (await stored(o2.body?.id)) === null, JSON.stringify(dupPatch.body));

    const arch = await a.call("POST", `/api/offers/${o1.body?.id}/archive`);
    const dupArchived = await a.call("PATCH", `/api/offers/${o2.body?.id}`, { keitaro_offer_id: KID });
    check("4. archived offer still holds its id → 409", arch.status === 200 && dupArchived.status === 409 && dupArchived.body?.code === "duplicate", `${arch.status}/${dupArchived.status}`);
    await a.call("POST", `/api/offers/${o1.body?.id}/restore`);

    const other = await b.call("POST", "/api/offers", mk(B, "b1", { keitaro_offer_id: KID }));
    check("5. another org may use the same id → 201", other.status === 201 && (await stored(other.body?.id)) === KID, JSON.stringify(other.body).slice(0, 200));

    const self = await a.call("PATCH", `/api/offers/${o1.body?.id}`, { keitaro_offer_id: KID, name: `${TAG}1` });
    check("6. PATCH to own current id → 200", self.status === 200 && self.body?.keitaro_offer_id === KID, JSON.stringify(self.body).slice(0, 200));

    const noKey = await a.call("PATCH", `/api/offers/${o1.body?.id}`, { name: `${TAG}1b` });
    check("8. PATCH without the key leaves it alone", noKey.status === 200 && (await stored(o1.body?.id)) === KID);

    const bad = await a.call("PATCH", `/api/offers/${o1.body?.id}`, { keitaro_offer_id: 0 });
    check("1b. PATCH 0 → 400", bad.status === 400, String(bad.status));

    // Operator, before the clear so the stored id is observable.
    console.log("\n[operator]");
    await db.execute(sql`UPDATE org_members SET role = 'operator' WHERE user_id = ${A.userId} AND org_id = ${A.orgId}`);
    const denied = await a.call("GET", "/api/deletion-requests");
    check("9. session is operator (denied route → 403)", denied.status === 403, String(denied.status));
    const opSet = await a.call("PATCH", `/api/offers/${o2.body?.id}`, { keitaro_offer_id: KID + 1 });
    const opClear = await a.call("PATCH", `/api/offers/${o1.body?.id}`, { keitaro_offer_id: null });
    check(
      "9. operator PATCH with keitaro_offer_id → 403, rows untouched",
      opSet.status === 403 && opClear.status === 403 && (await stored(o2.body?.id)) === null && (await stored(o1.body?.id)) === KID,
      `${opSet.status}/${opClear.status}`,
    );

    console.log("\n[owner again]");
    await db.execute(sql`UPDATE org_members SET role = 'owner' WHERE user_id = ${A.userId} AND org_id = ${A.orgId}`);
    const cleared = await a.call("PATCH", `/api/offers/${o1.body?.id}`, { keitaro_offer_id: null });
    check("7. PATCH null clears → NULL", cleared.status === 200 && cleared.body?.keitaro_offer_id === null && (await stored(o1.body?.id)) === null, JSON.stringify(cleared.body).slice(0, 200));
    const reuse = await a.call("PATCH", `/api/offers/${o2.body?.id}`, { keitaro_offer_id: KID });
    check("7. the cleared id is free again → 200", reuse.status === 200 && (await stored(o2.body?.id)) === KID, JSON.stringify(reuse.body).slice(0, 200));
  } finally {
    for (const u of createdUsers) {
      if (u.orgId) {
        await db.execute(sql`DELETE FROM offers WHERE org_id = ${u.orgId}`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${u.orgId}`);
      }
      await admin.auth.admin.deleteUser(u.id);
    }
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM offers WHERE name LIKE ${TAG + "%"}`)) as unknown as { n: number }[];
    console.log(`\ncleanup: ${createdUsers.length} users + orgs removed; leftover tagged offers: ${left[0].n}`);
    await pg.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
