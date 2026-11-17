import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB
import { requirePreviewDb } from "./_require-preview-db";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// POST /api/campaigns duplicate-submit guard (2026-11-17), over HTTP against a
// PR preview (BASE_URL) on the preview DB. A throwaway user is created (the
// signup trigger gives it its own org as owner) and removed in `finally`.
//
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon> BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//     npx tsx --env-file=D:/AFF/camman/.env.demo scripts/test-campaign-create-idempotency.ts
//
// I1 same key twice → 201 then 200, same id, one row
// I2 the first request still running (its advisory lock held by THIS script)
//    → 409 create_in_progress at once, not a wait; after release → 201
// I3 no key → two drafts (behaviour unchanged for API callers)
// I4 malformed key → 400

const BASE = process.env.BASE_URL ?? "";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  if (!BASE || /camman\.vercel\.app$/.test(new URL(BASE).host)) {
    console.error("BASE_URL must be a PR preview (never the production alias).");
    process.exit(1);
  }
  console.log(`target ${BASE} · DB ${requirePreviewDb().label}`);
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `idem-test-${Date.now()}@example.com`;
  const password = `Idem-${randomUUID()}`;
  let userId: string | undefined;
  let orgId: string | undefined;
  const created: number[] = [];
  try {
    const u = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (u.error) throw new Error(`createUser: ${u.error.message}`);
    userId = u.data.user!.id;
    const [m] = await sql<{ org_id: string }[]>`SELECT org_id FROM org_members WHERE user_id = ${userId}::uuid`;
    orgId = m.org_id;

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
    if (signIn.error) throw new Error(`sign-in: ${signIn.error.message}`);
    const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");

    const post = async (body: Record<string, unknown>) => {
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ save_as_draft: true, ...body }),
      });
      const json = (await r.json().catch(() => ({}))) as { id?: number; details?: { reason?: string } };
      if (json.id && !created.includes(json.id)) created.push(json.id);
      return { status: r.status, json, ms: Date.now() - t0 };
    };
    const rowsNamed = async (name: string) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns WHERE org_id = ${orgId!}::uuid AND name = ${name}`)[0].n;

    // I1
    const k1 = randomUUID();
    const n1 = `idem I1 ${k1.slice(0, 8)}`;
    const a = await post({ name: n1, idempotency_key: k1 });
    const b = await post({ name: n1, idempotency_key: k1 });
    bar("I1a first POST → 201", a.status === 201, `${a.status}`);
    bar("I1b repeat → 200 with the SAME campaign", b.status === 200 && b.json.id === a.json.id, `${b.status} id ${b.json.id} vs ${a.json.id}`);
    bar("I1c exactly one row", (await rowsNamed(n1)) === 1);

    // I2 — hold the lock the first request would hold, from a separate connection.
    const k2 = randomUUID();
    const n2 = `idem I2 ${k2.slice(0, 8)}`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`campaign-create:${orgId}:${k2}`}, 0))`;
      locked();
      await held;
    });
    await isLocked;
    const c = await post({ name: n2, idempotency_key: k2 });
    bar("I2a while the first is in flight → 409 create_in_progress", c.status === 409 && c.json.details?.reason === "create_in_progress", `${c.status} ${JSON.stringify(c.json.details)}`);
    bar("I2b answered at once, not after a wait", c.ms < 10_000, `${c.ms} ms`);
    bar("I2c nothing created", (await rowsNamed(n2)) === 0);
    release();
    await holder;
    const d = await post({ name: n2, idempotency_key: k2 });
    bar("I2d after the first finished (rolled back) → 201", d.status === 201, `${d.status}`);
    bar("I2e one row", (await rowsNamed(n2)) === 1);

    // I3
    const n3 = `idem I3 ${randomUUID().slice(0, 8)}`;
    const e = await post({ name: n3 });
    const f = await post({ name: n3 });
    bar("I3 no key → two drafts (unchanged)", e.status === 201 && f.status === 201 && e.json.id !== f.json.id && (await rowsNamed(n3)) === 2);

    // I4
    const g = await post({ name: "idem I4", idempotency_key: "not-a-uuid" });
    bar("I4 malformed key → 400", g.status === 400, `${g.status}`);
  } finally {
    if (created.length) await sql`DELETE FROM campaigns WHERE id = ANY(${created}::int[]) AND org_id = ${orgId!}::uuid`;
    if (orgId) {
      await sql`DELETE FROM org_members WHERE org_id = ${orgId}::uuid`;
      await sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`;
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
    const left = orgId ? (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns WHERE org_id = ${orgId}::uuid`)[0].n : 0;
    bar("Z fixtures removed", left === 0, `${left} campaigns left`);
    await sql.end();
  }
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
