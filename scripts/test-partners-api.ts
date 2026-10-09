// /api/partners/* and the key-under-a-partner flow, against a PREVIEW deployment
// (partner attribution Phase 1, migration 0200). Builds a throwaway OWNER user
// (the signup trigger gives it a fresh org with one owner membership, so every
// route resolves THAT org deterministically), exercises the routes through HTTP
// with a real session cookie, and tears everything down by id in `finally`.
//
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//     npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-partners-api.ts
//
// --env-file wins over _env-preload's .env.local (dotenv never overrides a set
// variable), so Supabase Auth AND Postgres both point at the preview project.
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "";
const EMAIL = `partners-api-test-${Date.now()}@exuma.io`;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  if (!BASE) throw new Error("BASE_URL is required (the preview deployment URL)");
  if (/camman\.vercel\.app$|camman\.exuma\.io$/.test(new URL(BASE).host)) {
    throw new Error("REFUSING TO RUN: BASE_URL is a production host");
  }
  console.log(`target: ${BASE}\nTarget DB: ${requirePreviewDb().label}\n`);

  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId: string | undefined;
  let orgId: string | undefined;
  let partnerId: number | undefined;
  const keyIds: number[] = [];

  try {
    // ── throwaway owner ──────────────────────────────────────────────────
    const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const created = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user!.id;
    const mem = await sql<{ org_id: string; role: string }[]>`
      SELECT org_id, role FROM org_members WHERE user_id = ${userId}::uuid`;
    check("the signup trigger gave the user exactly one OWNER membership", mem.length === 1 && mem[0].role === "owner", JSON.stringify(mem));
    orgId = mem[0].org_id;

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
    const signIn = await sb.auth.signInWithPassword({ email: EMAIL, password });
    if (signIn.error) throw new Error(`sign-in: ${signIn.error.message}`);
    const Cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    const api = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Cookie, ...(init.headers ?? {}) },
        redirect: "manual",
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body */ }
      return { status: res.status, json, text };
    };

    // probe: the API resolves the fixture org (owner → 200)
    const probe = await api("/api/partners");
    check("probe: GET /api/partners → 200 for the throwaway owner", probe.status === 200, `${probe.status} ${probe.text.slice(0, 120)}`);
    check("probe: the fresh org has no partners and no unassigned keys",
      Array.isArray(probe.json.data) && (probe.json.data as unknown[]).length === 0 && Array.isArray(probe.json.unassigned_keys),
      probe.text.slice(0, 200));

    // 1. create a partner (file-only → may hold a link)
    const c1 = await api("/api/partners", { method: "POST", body: JSON.stringify({ slug: "zz-api-test", name: "API test" }) });
    check("1 POST /api/partners → 201", c1.status === 201, `${c1.status} ${c1.text.slice(0, 200)}`);
    partnerId = c1.json.id as number;
    check("1b a file-only partner can_have_link and has no keys",
      c1.json.can_have_link === true && Array.isArray(c1.json.keys) && (c1.json.keys as unknown[]).length === 0 && c1.json.status === "active",
      c1.text.slice(0, 300));

    // 2. duplicate slug
    const c2 = await api("/api/partners", { method: "POST", body: JSON.stringify({ slug: "zz-api-test", name: "again" }) });
    check("2 duplicate slug → 409 DUPLICATE on `slug`", c2.status === 409 && (c2.json.details as { field?: string } | undefined)?.field === "slug", `${c2.status} ${c2.text.slice(0, 200)}`);

    // 3. two keys under the partner, same slug, no 409
    const k1 = await api("/api/partner-keys", { method: "POST", body: JSON.stringify({ partner_id: partnerId, name: "k1" }) });
    check("3 POST /api/partner-keys {partner_id} → 201 with slug copied from the partner",
      k1.status === 201 && k1.json.partner_slug === "zz-api-test" && typeof k1.json.token === "string" && typeof k1.json.secret === "string" && k1.json.partner_id === partnerId,
      `${k1.status} ${k1.text.slice(0, 200)}`);
    if (k1.status === 201) keyIds.push(k1.json.id as number);
    const k2 = await api("/api/partner-keys", { method: "POST", body: JSON.stringify({ partner_id: partnerId, name: "k2" }) });
    check("3b a second key of the same partner (same slug) → 201, not 409", k2.status === 201, `${k2.status} ${k2.text.slice(0, 200)}`);
    if (k2.status === 201) keyIds.push(k2.json.id as number);
    const kOld = await api("/api/partner-keys", { method: "POST", body: JSON.stringify({ partner_slug: "zz-api-test", name: "old shape" }) });
    check("3c the old create shape (partner_slug, no partner_id) → 400", kOld.status === 400, `${kOld.status}`);

    // 4. list: keys nested, both sandbox → no link
    const l4 = await api("/api/partners");
    const p4 = (l4.json.data as Record<string, unknown>[]).find((p) => p.id === partnerId);
    check("4 GET /api/partners nests the 2 keys and reports can_have_link=false (both sandbox)",
      !!p4 && (p4.keys as unknown[]).length === 2 && p4.can_have_link === false && p4.report_link_active === false, JSON.stringify(p4).slice(0, 300));
    check("4b a key row carries no token / secret_hash / report fields",
      !!p4 && (p4.keys as Record<string, unknown>[]).every((k) => !("token" in k) && !("secret_hash" in k) && !("report_token_hash" in k) && !("report_show_revenue" in k)));

    // 5. sandbox-only → no link
    const r5 = await api(`/api/partners/${partnerId}/report-link`, { method: "POST", body: "{}" });
    check("5 report-link on a sandbox-only partner → 409 sandbox_only", r5.status === 409 && (r5.json.details as { code?: string } | undefined)?.code === "sandbox_only", `${r5.status} ${r5.text.slice(0, 200)}`);

    // 6. one live key → link works; signed page renders the partner's name
    const p6 = await api(`/api/partner-keys/${keyIds[0]}`, { method: "PATCH", body: JSON.stringify({ sandbox: false }) });
    check("6 PATCH key sandbox=false → 200", p6.status === 200, `${p6.status}`);
    const r6 = await api(`/api/partners/${partnerId}/report-link`, { method: "POST", body: "{}" });
    check("6b report-link → 200 with a token and shown_once", r6.status === 200 && typeof r6.json.token === "string" && r6.json.shown_once === true, `${r6.status} ${r6.text.slice(0, 200)}`);
    const link = `${BASE}/partner-report/${r6.json.token as string}`;
    const page6 = await fetch(link, { redirect: "manual" });
    const html6 = await page6.text();
    check("6c the signed page (no cookie) → 200 and shows the partner's name", page6.status === 200 && html6.includes("API test"), `${page6.status}`);
    check("6d …and does NOT render revenue columns (toggle off)", !html6.includes("NET profit"));

    // 7. revenue toggle lives on the partner, not the key
    const t7 = await api(`/api/partners/${partnerId}`, { method: "PATCH", body: JSON.stringify({ report_show_revenue: true }) });
    check("7 PATCH /api/partners/[id] {report_show_revenue:true} → 200 and reflected", t7.status === 200 && t7.json.report_show_revenue === true, `${t7.status} ${t7.text.slice(0, 200)}`);
    const t7k = await api(`/api/partner-keys/${keyIds[0]}`, { method: "PATCH", body: JSON.stringify({ report_show_revenue: true }) });
    check("7b PATCH /api/partner-keys/[id] {report_show_revenue} → 400 (moved to the partner)", t7k.status === 400, `${t7k.status} ${t7k.text.slice(0, 160)}`);
    const t7e = await api(`/api/partners/${partnerId}`, { method: "PATCH", body: "{}" });
    check("7e PATCH /api/partners/[id] {} → 400, not 500", t7e.status === 400, `${t7e.status} ${t7e.text.slice(0, 160)}`);
    const t7u = await api(`/api/partners/${partnerId}`, { method: "PATCH", body: JSON.stringify({ slug: "nope" }) });
    check("7f PATCH /api/partners/[id] {slug} → 400 (immutable, strict schema)", t7u.status === 400, `${t7u.status} ${t7u.text.slice(0, 160)}`);
    const page7 = await fetch(link, { redirect: "manual" });
    check("7c the signed page now renders the revenue columns", (await page7.text()).includes("NET profit"));

    // 8. archive: link dead, intake 403, no new keys
    const a8 = await api(`/api/partners/${partnerId}/archive`, { method: "POST" });
    check("8 archive → 200 status=archived", a8.status === 200 && a8.json.status === "archived" && a8.json.archived_at != null, `${a8.status} ${a8.text.slice(0, 200)}`);
    check("8b the signed link → 404 while archived", (await fetch(link, { redirect: "manual" })).status === 404);
    const in8 = await fetch(`${BASE}/api/intake/leads/${k1.json.token as string}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leads: [] }),
    });
    const in8text = await in8.text();
    check("8c intake on the archived partner's LIVE key → 403 'archived'", in8.status === 403 && /archived/i.test(in8text), `${in8.status} ${in8text.slice(0, 120)}`);
    const k8 = await api("/api/partner-keys", { method: "POST", body: JSON.stringify({ partner_id: partnerId, name: "k3" }) });
    check("8d a new key on an archived partner → 409 partner_archived", k8.status === 409 && (k8.json.details as { code?: string } | undefined)?.code === "partner_archived", `${k8.status} ${k8.text.slice(0, 200)}`);
    const a8b = await api(`/api/partners/${partnerId}/archive`, { method: "POST" });
    check("8e archiving twice → 409 already_archived", a8b.status === 409, `${a8b.status}`);
    const r8 = await api(`/api/partners/${partnerId}/report-link`, { method: "POST", body: "{}" });
    check("8f issuing a link on an archived partner → 409 archived", r8.status === 409 && (r8.json.details as { code?: string } | undefined)?.code === "archived", `${r8.status}`);

    // 9. restore: link back, key status untouched
    const s9 = await api(`/api/partners/${partnerId}/restore`, { method: "POST" });
    check("9 restore → 200 status=active", s9.status === 200 && s9.json.status === "active" && s9.json.archived_at == null, `${s9.status} ${s9.text.slice(0, 200)}`);
    check("9b the signed link resolves again", (await fetch(link, { redirect: "manual" })).status === 200);
    const keysAfter = (s9.json.keys as { id: number; status: string; sandbox: boolean }[]) ?? [];
    check("9c the keys' own status was never touched by archive/restore", keysAfter.length === 2 && keysAfter.every((k) => k.status === "active"), JSON.stringify(keysAfter));

    // 10. revoke
    const d10 = await api(`/api/partners/${partnerId}/report-link`, { method: "DELETE" });
    check("10 DELETE report-link → 200 revoked", d10.status === 200 && d10.json.revoked === true, `${d10.status}`);
    check("10b the signed link → 404 after revoke", (await fetch(link, { redirect: "manual" })).status === 404);
    const gone = await api(`/api/partner-keys/${keyIds[0]}/report-link`, { method: "POST", body: "{}" });
    check("10c the old key-level report-link route is gone (404)", gone.status === 404, `${gone.status}`);
  } finally {
    // ── teardown by id, never by pattern ───────────────────────────────────
    if (keyIds.length) {
      await sql`DELETE FROM partner_key_usage WHERE partner_key_id IN ${sql(keyIds)}`;
      await sql`DELETE FROM lead_inbox WHERE partner_key_id IN ${sql(keyIds)}`;
      await sql`DELETE FROM partner_keys WHERE id IN ${sql(keyIds)}`;
    }
    if (partnerId != null) await sql`DELETE FROM partners WHERE id = ${partnerId}`;
    if (userId && orgId) {
      await sql`DELETE FROM org_members WHERE user_id = ${userId}::uuid`;
      const others = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${orgId}::uuid`;
      if (others[0].n === 0) await sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`;
      await admin.auth.admin.deleteUser(userId);
    }
    await sql.end();
    console.log(failed === 0 ? "\nAll checks passed. (fixtures removed)" : `\n${failed} check(s) FAILED. (fixtures removed)`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
