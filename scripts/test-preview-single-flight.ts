import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The preview's statement ceiling (30 s since 2026-10-03; 110 s in the 2026-10-01 hotfix), and the per-user
// single-flight lock that keeps a superseded or retried preview from stacking
// another long query.
//
// The lock is REAL: a second connection takes the same transaction-scoped
// advisory lock the route takes, holds it, and the preview is called while it
// is held — exactly the state a still-running earlier preview leaves behind.
// Writes nothing.
//
//   library only:  node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-preview-single-flight.ts
//   + the route:   start `npm run dev:preview` first; the HTTP part runs when it answers.

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { db } = await import("@/db/client");
  const { previewAudience, PreviewBusyError, PREVIEW_STATEMENT_TIMEOUT } =
    await import("@/lib/audience-snapshot");

  // A holder connection that keeps the lock for as long as we say.
  const holderSql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const hold = (key: string) => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const done = holderSql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"audience-preview:" + key})::int8)`;
      ready();
      await released;
    });
    return { isReady, release: async () => { release(); await done; } };
  };

  // A real preview input from the preview DB (any group in any org).
  const [g] = (await db.execute(sql`
    select org_id, id from contact_groups order by id limit 1
  `)) as unknown as { org_id: string; id: number }[];
  bar("a contact group exists to preview", !!g);
  const input = {
    orgId: g.org_id,
    lifecycleRules: true,
    segmentIds: [],
    contactGroupIds: [g.id],
    filters: { lifecycle_statuses: ["hot", "warm"] },
    excludeInUse: true,
  };

  // 1. The ceiling the preview actually sets (captured, not executed).
  const dialect = new PgDialect();
  const texts: string[] = [];
  await previewAudience(input, {
    transaction: (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
          texts.push(dialect.sqlToQuery(q).sql);
          return [];
        },
      })) as never,
  });
  bar(
    "the preview sets a 30 s statement ceiling",
    PREVIEW_STATEMENT_TIMEOUT === "30s" &&
      texts.some((t) => t.includes("set local statement_timeout = '30s'")),
    texts.find((t) => t.includes("statement_timeout")) ?? "none",
  );

  // 2. Lock held for key A → busy for A, fine for B; released → fine for A.
  const h = hold("org-x:user-a");
  await h.isReady;
  const busy = await previewAudience(input, undefined, { singleFlightKey: "org-x:user-a" })
    .then(() => null)
    .catch((e: unknown) => e);
  bar("while a preview by the same user holds the lock, the next is refused", busy instanceof PreviewBusyError, String(busy));
  const other = await previewAudience(input, undefined, { singleFlightKey: "org-x:user-b" })
    .then((r) => r)
    .catch((e: unknown) => e);
  bar("a DIFFERENT user is not affected", typeof (other as { total_matching?: unknown }).total_matching === "number", String(other instanceof Error ? other : "ok"));
  await h.release();
  const after = await previewAudience(input, undefined, { singleFlightKey: "org-x:user-a" })
    .then((r) => r)
    .catch((e: unknown) => e);
  bar("once released, the same user runs again", typeof (after as { total_matching?: unknown }).total_matching === "number", String(after instanceof Error ? after : "ok"));

  // 3. The route, if a dev:preview server answers.
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const up = await fetch(`${appUrl}/login`).then((r) => r.ok || r.status === 307).catch(() => false);
  if (!up) {
    console.log(`\n  (route part skipped: no server at ${appUrl})`);
  } else {
    const jar = new Map<string, string>();
    const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    const { data, error } = await sb.auth.signInWithPassword({
      email: process.env.TEST_USER_EMAIL!,
      password: process.env.TEST_USER_PASSWORD!,
    });
    bar("signed in to the preview server", !error && !!data.user, error?.message);
    const [m] = (await db.execute(sql`
      select org_id from org_members where user_id = ${data.user!.id}::uuid limit 1
    `)) as unknown as { org_id: string }[];
    const [grp] = (await db.execute(sql`
      select id from contact_groups where org_id = ${m.org_id}::uuid order by id limit 1
    `)) as unknown as { id: number }[];
    const post = () =>
      fetch(`${appUrl}/api/campaigns/audience-preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
        },
        body: JSON.stringify({
          audience_contact_group_ids: [grp.id],
          audience_filters: { lifecycle_statuses: ["hot", "warm"] },
        }),
      });
    // The route keys the lock per user AND part (T5); a part-less request is "full".
    const hr = hold(`${m.org_id}:${data.user!.id}:full`);
    await hr.isReady;
    const r1 = await post();
    const b1 = (await r1.json().catch(() => ({}))) as { error?: string; details?: { reason?: string } };
    bar("route: while the user's previous preview runs → 409 preview_busy", r1.status === 409 && b1.details?.reason === "preview_busy", `${r1.status} ${JSON.stringify(b1).slice(0, 140)}`);
    await hr.release();
    const r2 = await post();
    bar("route: once it finishes → 200", r2.status === 200, `${r2.status}`);
  }

  await holderSql.end();
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
