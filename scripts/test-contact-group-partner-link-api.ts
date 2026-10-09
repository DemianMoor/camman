// PATCH /api/contact-groups/[id] partner link + the list's Partner column,
// against a PREVIEW deployment (partner attribution Phase 2, migration 0201).
// Throwaway OWNER user (the signup trigger gives it a fresh org), fixtures by
// SQL, HTTP through a real session cookie, teardown by id in `finally`. The
// operator half demotes the same membership in place (one membership ⇒ the
// API resolves the fixture org deterministically).
//
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//     npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-contact-group-partner-link-api.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "";
const EMAIL = `cg-link-test-${Date.now()}@exuma.io`;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
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
  const partnerIds: number[] = [];
  const groupIds: number[] = [];
  let otherOrgId: string | undefined;
  let otherPartnerId: number | undefined;

  try {
    const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const created = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user!.id;
    const mem = await sql<{ org_id: string; role: string }[]>`SELECT org_id, role FROM org_members WHERE user_id = ${userId}::uuid`;
    check("the signup trigger gave the user exactly one OWNER membership", mem.length === 1 && mem[0].role === "owner", JSON.stringify(mem));
    orgId = mem[0].org_id;

    // ── fixtures ────────────────────────────────────────────────────────────
    const partner = async (slug: string, status = "active") =>
      (await sql<{ id: number }[]>`INSERT INTO partners (org_id, slug, name, status) VALUES (${orgId!}::uuid, ${slug}, ${slug}, ${status}) RETURNING id`)[0].id;
    const pA = await partner("zz-link"); const pB = await partner("zz-link-2"); const pArch = await partner("zz-link-archived", "archived");
    partnerIds.push(pA, pB, pArch);
    const group = async (key: string, name: string, extra: { partner_id?: number; system_role?: string } = {}) =>
      (await sql<{ id: number }[]>`INSERT INTO contact_groups (contact_group_id, org_id, name, status, partner_id, system_role)
         VALUES (${key}, ${orgId!}::uuid, ${name}, 'active', ${extra.partner_id ?? null}, ${extra.system_role ?? null}) RETURNING id`)[0].id;
    const gPlain = await group(`zz-plain-${Date.now()}`, "Plain group");
    const gDrip = await group(`drip:${orgId}:zz-link-aca`, "zz-link-aca", { partner_id: pA });
    const gSys = await group(`zz-sys-${Date.now()}`, "Sys-like group", { system_role: "drip_sandbox" });
    groupIds.push(gPlain, gDrip, gSys);
    // another org's partner (must 404)
    const other = await sql<{ id: string }[]>`SELECT id FROM organizations WHERE id <> ${orgId}::uuid ORDER BY created_at LIMIT 1`;
    otherOrgId = other[0]?.id;
    if (otherOrgId) {
      otherPartnerId = (await sql<{ id: number }[]>`INSERT INTO partners (org_id, slug, name) VALUES (${otherOrgId}::uuid, ${"zz-other-" + Date.now()}, 'other') RETURNING id`)[0].id;
    }

    // ── session ──────────────────────────────────────────────────────────────
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
    const api = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie, ...(init.headers ?? {}) }, redirect: "manual" });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { status: res.status, json, text };
    };
    const patch = (id: number, body: Record<string, unknown>) => api(`/api/contact-groups/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    const recalcs = async (gid: number) => (await sql<{ reason: string; status: string }[]>`SELECT reason, status FROM partner_attribution_recalcs WHERE contact_group_id = ${gid} ORDER BY id`);
    const code = (r: { json: Record<string, unknown> }) => (r.json.details as { code?: string } | undefined)?.code;

    // ── owner ────────────────────────────────────────────────────────────────
    const r1 = await patch(gPlain, { partner_id: pA });
    check("1 owner links a plain group → 200 with partner_id", r1.status === 200 && r1.json.partner_id === pA, `${r1.status} ${r1.text.slice(0, 160)}`);
    let rc = await recalcs(gPlain);
    check("1b …and ONE queued recalc row with reason 'link'", rc.length === 1 && rc[0].reason === "link" && rc[0].status === "queued", JSON.stringify(rc));
    const r2 = await patch(gPlain, { partner_id: pB });
    rc = await recalcs(gPlain);
    check("2 relink → 200 + 'relink' row", r2.status === 200 && rc.length === 2 && rc[1].reason === "relink", JSON.stringify(rc));
    const r2s = await patch(gPlain, { partner_id: pB });
    rc = await recalcs(gPlain);
    check("2b the same value again → 200 and NO new row", r2s.status === 200 && rc.length === 2);
    const r3 = await patch(gPlain, { partner_id: null });
    rc = await recalcs(gPlain);
    check("3 unlink → 200 + 'unlink' row", r3.status === 200 && r3.json.partner_id === null && rc.length === 3 && rc[2].reason === "unlink", JSON.stringify(rc));
    const r4 = await patch(gDrip, { partner_id: pA });
    check("4 (F3) a drip partner×tag group → 409 drip_group, even with its current value", r4.status === 409 && code(r4) === "drip_group", `${r4.status} ${r4.text.slice(0, 160)}`);
    const r4b = await patch(gDrip, { description: "renamed by the owner" });
    check("4b …but a plain description edit on it → 200", r4b.status === 200, `${r4b.status}`);
    const r5 = await patch(gSys, { partner_id: pA });
    check("5 (C4) a system group → 409 system_group", r5.status === 409 && code(r5) === "system_group", `${r5.status} ${r5.text.slice(0, 160)}`);
    const r6 = await patch(gPlain, { partner_id: pArch });
    check("6 an archived partner → 409 partner_archived", r6.status === 409 && code(r6) === "partner_archived", `${r6.status} ${r6.text.slice(0, 160)}`);
    if (otherPartnerId) {
      const r7 = await patch(gPlain, { partner_id: otherPartnerId });
      check("7 another org's partner → 404", r7.status === 404, `${r7.status} ${r7.text.slice(0, 120)}`);
    } else {
      console.log("  (7 skipped: the preview has a single org)");
    }
    const r8 = await patch(gPlain, { partner_id: pA });
    check("8 link again for the list check → 200", r8.status === 200);
    const list = await api("/api/contact-groups/list?pageSize=100&showArchived=true");
    const rows = (list.json.data as Record<string, unknown>[]) ?? [];
    const plainRow = rows.find((r) => r.id === gPlain); const dripRow = rows.find((r) => r.id === gDrip); const sysRow = rows.find((r) => r.id === gSys);
    check("9 the list carries partner_name on the linked rows and system_role on the system group",
      plainRow?.partner_name === "zz-link" && dripRow?.partner_name === "zz-link" && sysRow?.system_role === "drip_sandbox" && sysRow?.partner_name === null,
      JSON.stringify({ plainRow, dripRow, sysRow }).slice(0, 300));
    const detail = await api(`/api/contact-groups/${gPlain}`);
    check("9b the detail carries partner_id + partner_name", detail.status === 200 && detail.json.partner_id === pA && detail.json.partner_name === "zz-link", detail.text.slice(0, 200));

    // ── operator (no partner_keys.manage) ────────────────────────────────────
    await sql`UPDATE org_members SET role = 'operator' WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid`;
    const o1 = await patch(gPlain, { partner_id: pB });
    check("10 (Q9) an operator changing the link → 403", o1.status === 403, `${o1.status} ${o1.text.slice(0, 160)}`);
    const o2 = await patch(gPlain, { description: "operator rename" });
    check("10b …while a description edit without partner_id → 200 (or 403 if operators lack contact_groups.update — then skip)", o2.status === 200 || o2.status === 403, `${o2.status}`);
    const o3 = await patch(gPlain, { partner_id: pA });
    check("10c an operator sending the UNCHANGED link still → 403 (the gate is on the field, not the diff)", o3.status === 403, `${o3.status}`);
  } finally {
    if (groupIds.length) {
      await sql`DELETE FROM partner_attribution_recalcs WHERE contact_group_id IN ${sql(groupIds)}`;
      await sql`DELETE FROM contact_groups WHERE id IN ${sql(groupIds)}`;
    }
    if (partnerIds.length) await sql`DELETE FROM partners WHERE id IN ${sql(partnerIds)}`;
    if (otherPartnerId) await sql`DELETE FROM partners WHERE id = ${otherPartnerId}`;
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
main().catch((e) => { console.error(e); process.exit(1); });
