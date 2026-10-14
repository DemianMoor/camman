import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

// Role checks for the brand landing host/path controls (0212), against a REAL
// preview deployment with REAL sessions:
//
//   operator — may not edit brands at all, may not run the Test fetch, MAY read
//              /api/brands/landing-pairs (the stage form needs it)
//   manager  — may edit other brand fields, may NOT change landing host/path,
//              may not run the Test fetch
//   admin    — may change them: 409 brand_landing_in_use first, then confirm;
//              may run the Test fetch
//
// Each role gets a THROWAWAY user (the signup trigger gives it its own org as
// owner; the row is then demoted in place) and a fixture brand in that org.
// Everything is deleted in `finally`.
//
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//   npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo \
//     scripts/test-brand-landing-roles.ts

const BASE = process.env.BASE_URL ?? "";
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

async function main() {
  if (!BASE || /camman\.vercel\.app$/.test(new URL(BASE).host)) {
    console.error("BASE_URL must be a PREVIEW deployment URL.");
    process.exit(2);
  }
  console.log(`target ${BASE}  db ${requirePreviewDb().label}\n`);
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const made: { userId: string; orgId: string | null; brandId: number | null }[] = [];
  try {
    for (const role of ["operator", "manager", "admin"] as const) {
      console.log(`── ${role}`);
      const email = `t212-${role}-${Date.now()}@example.com`;
      const password = `T212-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
      const rec = { userId: created.data.user.id, orgId: null as string | null, brandId: null as number | null };
      made.push(rec);

      const [m] = await sql<{ org_id: string }[]>`
        SELECT org_id FROM org_members WHERE user_id = ${rec.userId}::uuid`;
      rec.orgId = m.org_id;
      await sql`UPDATE org_members SET role = ${role} WHERE user_id = ${rec.userId}::uuid AND org_id = ${rec.orgId}::uuid`;
      const [b] = await sql<{ id: number }[]>`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${rec.orgId}::uuid, ${`t212-${role}-${Date.now()}`}, 'T212 role brand')
        RETURNING id`;
      rec.brandId = b.id;

      const jar: { name: string; value: string }[] = [];
      const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
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
      });
      const signIn = await sb.auth.signInWithPassword({ email, password });
      if (signIn.error) throw new Error(`signIn ${role}: ${signIn.error.message}`);
      const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
      const call = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${BASE}${path}`, {
          method,
          headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual",
        });
        let j: Record<string, unknown> = {};
        try {
          j = (await r.json()) as Record<string, unknown>;
        } catch {
          /* non-JSON */
        }
        return { status: r.status, body: j };
      };

      // The session resolves to the fixture org (one membership by construction).
      const own = await call("GET", `/api/brands/${rec.brandId}`);
      check(`${role}: session resolves the fixture org (GET own brand 200)`, own.status === 200, `${own.status}`);

      const pairs = await call("GET", "/api/brands/landing-pairs");
      check(`${role}: GET landing-pairs 200`, pairs.status === 200, `${pairs.status} ${JSON.stringify(pairs.body)}`);

      const test = await call("POST", "/api/brands/landing-test", { host: "blogcascade.com", path: "bcf" });
      const landingHost = `t212-${role}.example`;
      const patch = await call("PATCH", `/api/brands/${rec.brandId}`, { landing_host: landingHost, landing_path: "lp" });

      if (role === "operator") {
        check("operator: Test fetch refused (403)", test.status === 403, `${test.status}`);
        check("operator: landing change refused (403)", patch.status === 403, `${patch.status}`);
      } else if (role === "manager") {
        check("manager: Test fetch refused (403)", test.status === 403, `${test.status}`);
        check("manager: landing change refused (403)", patch.status === 403, `${patch.status} ${JSON.stringify(patch.body)}`);
        const other = await call("PATCH", `/api/brands/${rec.brandId}`, { name: "T212 renamed by manager" });
        check("manager: other brand fields still editable (200)", other.status === 200, `${other.status}`);
        const same = await call("PATCH", `/api/brands/${rec.brandId}`, { name: "T212 again", landing_host: "", landing_path: "lp" });
        check("manager: re-saving UNCHANGED landing values is not refused (200)", same.status === 200, `${same.status} ${JSON.stringify(same.body)}`);
      } else {
        // No slug pages in a fresh org ⇒ the Test route says so (400) rather than fetching.
        check("admin: Test route reachable (not 403)", test.status !== 403, `${test.status} ${JSON.stringify(test.body)}`);
        check("admin: first save ⇒ 409 brand_landing_in_use with counts",
              patch.status === 409 && patch.body.code === "brand_landing_in_use" &&
                typeof (patch.body.details as { stages?: unknown })?.stages === "number",
              `${patch.status} ${JSON.stringify(patch.body)}`);
        const ok = await call("PATCH", `/api/brands/${rec.brandId}`, { landing_host: landingHost, landing_path: "lp", confirm: true });
        check("admin: confirmed save ⇒ 200 with the new host", ok.status === 200 && ok.body.landing_host === landingHost,
              `${ok.status} ${JSON.stringify(ok.body)}`);
        const bad = await call("PATCH", `/api/brands/${rec.brandId}`, { landing_path: "Bad/Path", confirm: true });
        check("admin: invalid path ⇒ 400", bad.status === 400, `${bad.status}`);
      }
    }
  } finally {
    for (const r of made) {
      if (r.brandId) await sql`DELETE FROM brands WHERE id = ${r.brandId}`;
      if (r.orgId) {
        await sql`DELETE FROM org_members WHERE user_id = ${r.userId}::uuid`;
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${r.orgId}::uuid`;
        if (n === 0) await sql`DELETE FROM organizations WHERE id = ${r.orgId}::uuid`;
      }
      await admin.auth.admin.deleteUser(r.userId);
    }
    const left = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM brands WHERE brand_id LIKE 't212-%'`;
    const users = await admin.auth.admin.listUsers({ perPage: 1000 });
    const leftUsers = users.data?.users.filter((u) => u.email?.startsWith("t212-")).length ?? -1;
    check(`teardown: 0 fixture brands (${left[0].n}), 0 fixture users (${leftUsers})`, left[0].n === 0 && leftUsers === 0);
    await sql.end({ timeout: 5 });
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
