// Contact-group allow_voip / allow_unknown over HTTP (migration 0218), against
// a PREVIEW deployment. Throwaway OWNER user (the signup trigger gives it a
// fresh org), real session cookie, teardown by id in `finally`.
//
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//     npx tsx --conditions=react-server --env-file=D:/AFF/camman/.env.demo scripts/test-contact-group-line-type-api.ts
//
//   A1 a new group defaults both boxes to true (POST without the fields)
//   A2 PATCH allow_voip=false persists; GET [id] and the list both return it
//   A3 a rename that omits the fields leaves them as stored
//   A4 an operator (no contact_groups.update) gets 403 and changes nothing
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "";
const EMAIL = `cg-linetype-test-${Date.now()}@exuma.io`;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  if (!BASE) throw new Error("BASE_URL is required (the preview deployment URL)");
  if (/camman\.vercel\.app$|camman\.exuma\.io$/.test(new URL(BASE).host)) throw new Error("REFUSING TO RUN: BASE_URL is a production host");
  console.log(`target: ${BASE}\nTarget DB: ${requirePreviewDb().label}\n`);

  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let userId: string | undefined;
  let orgId: string | undefined;
  let groupId: number | undefined;

  try {
    const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const created = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user!.id;
    const mem = await sql<{ org_id: string; role: string }[]>`SELECT org_id, role FROM org_members WHERE user_id = ${userId}::uuid`;
    if (mem.length !== 1 || mem[0].role !== "owner") throw new Error(`unexpected membership ${JSON.stringify(mem)}`);
    orgId = mem[0].org_id;

    const jar: { name: string; value: string }[] = [];
    const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => jar,
        setAll: (list) => { for (const c of list) { const i = jar.findIndex((x) => x.name === c.name); if (i >= 0) jar[i] = { name: c.name, value: c.value }; else jar.push({ name: c.name, value: c.value }); } },
      },
    });
    const signIn = await sb.auth.signInWithPassword({ email: EMAIL, password });
    if (signIn.error) throw new Error(`sign-in: ${signIn.error.message}`);
    const Cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie }, redirect: "manual" });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: res.status, json, text };
    };
    const stored = async () => (await sql<{ allow_voip: boolean; allow_unknown: boolean }[]>`
      SELECT allow_voip, allow_unknown FROM contact_groups WHERE id = ${groupId!}`)[0];
    const listRow = async () => {
      const r = await call(`/api/contact-groups/list?page=0&pageSize=50&search=zz-lt`);
      const row = ((r.json.data as Record<string, unknown>[] | undefined) ?? []).find((g) => g.id === groupId);
      if (!row) console.log(`    list ${r.status}: ${r.text.slice(0, 300)}`);
      return row;
    };

    const c = await call("/api/contact-groups", { method: "POST", body: JSON.stringify({ name: "zz-lt group", contact_group_id: `zz-lt-${Date.now()}` }) });
    groupId = c.json.id as number | undefined;
    check("A1 a new group defaults both boxes to true", c.status === 201 && c.json.allow_voip === true && c.json.allow_unknown === true,
      `${c.status} voip=${c.json.allow_voip} unknown=${c.json.allow_unknown}`);

    const p = await call(`/api/contact-groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ allow_voip: false }) });
    const g = await call(`/api/contact-groups/${groupId}`);
    const l = await listRow();
    const s2 = await stored();
    check("A2 PATCH allow_voip=false persists and both reads return it",
      p.status === 200 && s2.allow_voip === false && s2.allow_unknown === true && g.json.allow_voip === false && l?.allow_voip === false && l?.allow_unknown === true,
      `patch ${p.status}; db ${JSON.stringify(s2)}; get ${g.json.allow_voip}; list ${l?.allow_voip}/${l?.allow_unknown}`);

    const r = await call(`/api/contact-groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ name: "zz-lt renamed" }) });
    const s3 = await stored();
    check("A3 a rename leaves the boxes as stored", r.status === 200 && s3.allow_voip === false && s3.allow_unknown === true, `${r.status} ${JSON.stringify(s3)}`);

    await sql`UPDATE org_members SET role = 'operator' WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid`;
    const o = await call(`/api/contact-groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ allow_voip: true }) });
    const s4 = await stored();
    check("A4 an operator gets 403 and nothing changes", o.status === 403 && s4.allow_voip === false, `${o.status} ${JSON.stringify(s4)}`);
  } finally {
    if (groupId) await sql`DELETE FROM contact_groups WHERE id = ${groupId} AND org_id = ${orgId!}::uuid`;
    if (userId) {
      await sql`DELETE FROM org_members WHERE user_id = ${userId}::uuid`;
      if (orgId) {
        const others = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${orgId}::uuid`;
        if (others[0].n === 0) await sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`;
      }
      await admin.auth.admin.deleteUser(userId);
    }
    const left = await sql<{ n: number }[]>`
      SELECT ((SELECT count(*) FROM contact_groups WHERE id = ${groupId ?? -1})
            + (SELECT count(*) FROM organizations WHERE id = ${orgId ?? null}::uuid))::int AS n`;
    console.log(`\nTeardown: ${left[0].n} row(s) left`);
    if (left[0].n !== 0) failed++;
    await sql.end();
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
