// Verifies the network-level conversion mapping API (Affiliate Networks →
// Conversion mapping) on a PR PREVIEW deploy, with throwaway users and full
// cleanup. Nothing here touches production.
//
// Org A (throwaway user, OWNER, then demoted to OPERATOR) and org B (a second
// throwaway user's org, used only as the "other tenant"):
//   1. GET /api/event-types lists org A's types only
//   2. POST /api/networks with the three default rules → 201, rules stored
//   3. list: active_rule_count 3; a network created without rules → 0
//   4. another org's event type is refused (create network AND add rule), and
//      the refused network create leaves no network behind
//   5. duplicate Keitaro type → 409; a duplicate inside one create → 400
//   6. PATCH edits status/event type; keitaro_type is ignored (not editable)
//   7. another org's rule / wrong network in the path → 404
//   8. archive → gone from GET, count drops, archiving again → 404
//   9. OPERATOR: GETs 200, every write 403
//
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon key> \
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//   npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-network-mappings-api.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const TAG = `__net-mapping-test-${Date.now()}__`;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function main() {
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
      return { email, password, userId: u.data.user.id, orgId: m[0].org_id };
    }
    async function ensurePurchaseType(orgId: string) {
      await db.execute(sql`
        INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue)
        VALUES (${orgId}, 'purchase', 'Purchase', 10, true, true)
        ON CONFLICT (org_id, key) DO NOTHING`);
      return Number(
        ((await db.execute(sql`SELECT id FROM event_types WHERE org_id = ${orgId} AND key = 'purchase'`)) as unknown as { id: number }[])[0].id,
      );
    }

    const A = await throwawayUser("a");
    const B = await throwawayUser("b");
    const purchaseA = await ensurePurchaseType(A.orgId);
    const purchaseB = await ensurePurchaseType(B.orgId);

    const cookieJar = new Map<string, string>();
    const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => Array.from(cookieJar, ([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) cookieJar.set(name, value);
        },
      },
    });
    const signIn = await supabase.auth.signInWithPassword({ email: A.email, password: A.password });
    if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);
    const cookie = () => Array.from(cookieJar, ([n, v]) => `${n}=${v}`).join("; ");
    async function call(method: string, path: string, body?: unknown): Promise<Res> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie() },
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
    }

    // Org B's rule, to prove A can't reach it.
    const netB = Number(
      ((await db.execute(sql`
        INSERT INTO affiliate_networks (org_id, name, network_id, status)
        VALUES (${B.orgId}, ${TAG + "B"}, 'tb', 'active') RETURNING id`)) as unknown as { id: number }[])[0].id,
    );
    const ruleB = Number(
      ((await db.execute(sql`
        INSERT INTO conversion_event_mappings (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status)
        VALUES (${B.orgId}, ${netB}, 'lead', ${purchaseB}, 'approved') RETURNING id`)) as unknown as { id: number }[])[0].id,
    );

    console.log("\n[owner]");
    const et = await call("GET", "/api/event-types");
    const etIds = (et.body?.data ?? []).map((e: { id: number }) => e.id);
    check("1. event-types lists own org only", et.status === 200 && etIds.includes(purchaseA) && !etIds.includes(purchaseB), JSON.stringify(et.body));

    const defaults = [
      { keitaro_type: "lead", event_type_id: purchaseA, conversion_status: "approved" },
      { keitaro_type: "sale", event_type_id: purchaseA, conversion_status: "approved" },
      { keitaro_type: "rejected", event_type_id: purchaseA, conversion_status: "rejected" },
    ];
    const created = await call("POST", "/api/networks", { name: "With rules", network_id: "wr", mappings: defaults });
    check("2. create network with defaults → 201", created.status === 201, JSON.stringify(created.body));
    const netId = created.body?.id as number;
    const rules = await call("GET", `/api/networks/${netId}/mappings`);
    const stored = (rules.body?.data ?? []) as { id: number; keitaro_type: string; event_type_id: number; conversion_status: string }[];
    check(
      "2. the three rules are stored as sent",
      rules.status === 200 &&
        stored.length === 3 &&
        defaults.every((d) => stored.some((s) => s.keitaro_type === d.keitaro_type && s.event_type_id === d.event_type_id && s.conversion_status === d.conversion_status)),
      JSON.stringify(rules.body),
    );

    const bare = await call("POST", "/api/networks", { name: "No rules", network_id: "nr" });
    check("3. create network without rules → 201", bare.status === 201);
    const list = await call("GET", "/api/networks/list?pageSize=50");
    const countOf = (id: number) => (list.body?.data ?? []).find((n: { id: number }) => n.id === id)?.active_rule_count;
    check("3. list active_rule_count 3 / 0", countOf(netId) === 3 && countOf(bare.body?.id) === 0, `${countOf(netId)} / ${countOf(bare.body?.id)}`);

    const foreignCreate = await call("POST", "/api/networks", {
      name: "Foreign",
      network_id: "fx",
      mappings: [{ keitaro_type: "lead", event_type_id: purchaseB, conversion_status: "approved" }],
    });
    const fxRows = (await db.execute(sql`SELECT 1 FROM affiliate_networks WHERE org_id = ${A.orgId} AND network_id = 'fx'`)) as unknown as unknown[];
    check("4. create with another org's event type → 400, no network left", foreignCreate.status === 400 && fxRows.length === 0, `${foreignCreate.status} rows=${fxRows.length}`);
    const foreignAdd = await call("POST", `/api/networks/${bare.body?.id}/mappings`, { keitaro_type: "lead", event_type_id: purchaseB, conversion_status: "approved" });
    check("4. add rule with another org's event type → 400", foreignAdd.status === 400, String(foreignAdd.status));

    const dup = await call("POST", `/api/networks/${netId}/mappings`, { keitaro_type: "lead", event_type_id: purchaseA, conversion_status: "approved" });
    check("5. duplicate active Keitaro type → 409", dup.status === 409 && dup.body?.code === "duplicate", JSON.stringify(dup.body));
    const dupInCreate = await call("POST", "/api/networks", {
      name: "Dup",
      network_id: "dp",
      mappings: [defaults[0], defaults[0]],
    });
    check("5. duplicate type inside one create → 400", dupInCreate.status === 400, String(dupInCreate.status));
    const added = await call("POST", `/api/networks/${bare.body?.id}/mappings`, { keitaro_type: "deposit", event_type_id: purchaseA, conversion_status: "pending" });
    check("5. add a rule to an empty network → 201", added.status === 201 && added.body?.org_id === A.orgId, JSON.stringify(added.body));

    const lead = stored.find((s) => s.keitaro_type === "lead")!;
    const patched = await call("PATCH", `/api/networks/${netId}/mappings/${lead.id}`, { conversion_status: "pending", keitaro_type: "trash" });
    check("6. PATCH status → 200, keitaro_type unchanged", patched.status === 200 && patched.body?.conversion_status === "pending" && patched.body?.keitaro_type === "lead", JSON.stringify(patched.body));
    const emptyPatch = await call("PATCH", `/api/networks/${netId}/mappings/${lead.id}`, {});
    check("6. empty PATCH → 400", emptyPatch.status === 400);
    const statusOnly = await call("PATCH", `/api/networks/${netId}/mappings/${lead.id}`, { event_type_id: null });
    check("6. PATCH event_type_id null (status-only) → 400", statusOnly.status === 400, String(statusOnly.status));

    const crossOrg = await call("PATCH", `/api/networks/${netB}/mappings/${ruleB}`, { conversion_status: "rejected" });
    const crossOrgArchive = await call("POST", `/api/networks/${netB}/mappings/${ruleB}/archive`);
    const crossOrgGet = await call("GET", `/api/networks/${netB}/mappings`);
    const ruleBNow = ((await db.execute(sql`SELECT conversion_status, status FROM conversion_event_mappings WHERE id = ${ruleB}`)) as unknown as { conversion_status: string; status: string }[])[0];
    check(
      "7. another org's network/rule → 404 on GET/PATCH/archive, row untouched",
      crossOrg.status === 404 && crossOrgArchive.status === 404 && crossOrgGet.status === 404 && ruleBNow.conversion_status === "approved" && ruleBNow.status === "active",
      `${crossOrgGet.status}/${crossOrg.status}/${crossOrgArchive.status}`,
    );
    const wrongNet = await call("PATCH", `/api/networks/${bare.body?.id}/mappings/${lead.id}`, { conversion_status: "approved" });
    check("7. rule under the wrong network id → 404", wrongNet.status === 404);

    const archived = await call("POST", `/api/networks/${netId}/mappings/${lead.id}/archive`);
    const after = await call("GET", `/api/networks/${netId}/mappings`);
    const list2 = await call("GET", "/api/networks/list?pageSize=50");
    const count2 = (list2.body?.data ?? []).find((n: { id: number }) => n.id === netId)?.active_rule_count;
    check("8. archive → 200, rule gone, count 2", archived.status === 200 && after.body?.data?.length === 2 && count2 === 2, `${archived.status} ${after.body?.data?.length} ${count2}`);
    const again = await call("POST", `/api/networks/${netId}/mappings/${lead.id}/archive`);
    check("8. archiving again → 404", again.status === 404);
    const readd = await call("POST", `/api/networks/${netId}/mappings`, { keitaro_type: "lead", event_type_id: purchaseA, conversion_status: "approved" });
    check("8. re-adding the archived type → 201", readd.status === 201);

    console.log("\n[operator]");
    await db.execute(sql`UPDATE org_members SET role = 'operator' WHERE user_id = ${A.userId} AND org_id = ${A.orgId}`);
    // Prove the session now resolves as operator: a route the map denies.
    const denied = await call("GET", "/api/deletion-requests");
    check("9. session is operator (denied route → 403)", denied.status === 403, String(denied.status));
    const opGets = [await call("GET", "/api/event-types"), await call("GET", `/api/networks/${netId}/mappings`), await call("GET", "/api/networks/list")];
    check("9. operator GETs → 200", opGets.every((r) => r.status === 200), opGets.map((r) => r.status).join(","));
    const opWrites = [
      await call("POST", `/api/networks/${netId}/mappings`, { keitaro_type: "trash", event_type_id: purchaseA, conversion_status: "rejected" }),
      await call("PATCH", `/api/networks/${netId}/mappings/${readd.body?.id}`, { conversion_status: "rejected" }),
      await call("POST", `/api/networks/${netId}/mappings/${readd.body?.id}/archive`),
      await call("POST", "/api/networks", { name: "Op", network_id: "op", mappings: defaults }),
    ];
    check("9. operator writes → 403", opWrites.every((r) => r.status === 403), opWrites.map((r) => r.status).join(","));
  } finally {
    for (const u of createdUsers) {
      if (u.orgId) {
        // event_type_id is ON DELETE RESTRICT: drop the rules before the org cascade.
        await db.execute(sql`DELETE FROM conversion_event_mappings WHERE org_id = ${u.orgId}`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${u.orgId}`);
      }
      await admin.auth.admin.deleteUser(u.id);
    }
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM affiliate_networks WHERE name LIKE ${TAG + "%"}`)) as unknown as { n: number }[];
    console.log(`\ncleanup: ${createdUsers.length} users + orgs removed; leftover tagged networks: ${left[0].n}`);
    await pg.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
