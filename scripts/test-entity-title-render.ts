import "./_env-preload";

import { createServerClient } from "@supabase/ssr";

import { sql } from "../db/client";

// Verifies the RENDERED <title> of the entity detail routes against a running
// app, as the signed-in test user. Source review is not enough — a title can be
// correct at the source and still render wrong (see the template-nulling bug in
// PR #33). Also counts queries via pg_stat_statements to prove each route adds
// exactly one, and that unaffected routes add none.
//
// Needs the app running. Run:
//   npx next start -p 3001            (or npm run dev)
//   npx tsx scripts/test-entity-title-render.ts

const BASE = process.env.BASE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";

type Target = {
  kind: string;
  table: string;
  path: (id: number) => string;
  fallback: string;
  // How the entity name becomes the expected title.
  expect: (name: string) => string;
};

const TARGETS: Target[] = [
  {
    kind: "campaign",
    table: "campaigns",
    path: (id) => `/campaigns/${id}`,
    fallback: "Campaign",
    expect: (n) => n,
  },
  {
    kind: "campaign/edit",
    table: "campaigns",
    path: (id) => `/campaigns/${id}/edit`,
    fallback: "Edit Campaign",
    expect: (n) => `Edit ${n}`,
  },
  {
    kind: "segment",
    table: "segments",
    path: (id) => `/segments/${id}`,
    fallback: "Segment",
    expect: (n) => n,
  },
  {
    kind: "contact_group",
    table: "contact_groups",
    path: (id) => `/contact-groups/${id}`,
    fallback: "Contact Group",
    expect: (n) => n,
  },
  {
    kind: "sms_provider",
    table: "sms_providers",
    path: (id) => `/providers/${id}`,
    fallback: "SMS Provider",
    expect: (n) => n,
  },
  {
    kind: "offer",
    table: "offers",
    path: (id) => `/offers/${id}/report`,
    fallback: "Offer Report",
    expect: (n) => n,
  },
];

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const decode = (s: string) =>
  s
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!url || !anonKey || !email || !password) {
    console.error(
      "Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, TEST_USER_EMAIL, TEST_USER_PASSWORD in .env.local",
    );
    process.exit(1);
  }

  // Cookie jar acts as a one-tab browser for @supabase/ssr.
  const jar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) {
    console.error(`Sign-in failed: ${error.message}`);
    process.exit(1);
  }
  const cookie = Array.from(jar.entries())
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
  console.log(`signed in as ${email}\nbase: ${BASE}\n`);

  async function titleOf(path: string, authed = true) {
    const res = await fetch(`${BASE}${path}`, {
      headers: authed ? { Cookie: cookie } : {},
      redirect: "manual",
    });
    const html = await res.text();
    const m = html.match(/<title>([^<]*)<\/title>/);
    return { status: res.status, title: m ? decode(m[1]) : null };
  }

  // --- 1. Happy path: the real entity name renders in the tab -------------
  const ids: Record<string, { id: number; name: string }> = {};
  for (const t of TARGETS) {
    if (!ids[t.table]) {
      const rows = await sql`
        SELECT id, name FROM ${sql(t.table)}
        WHERE name IS NOT NULL AND btrim(name) <> ''
        ORDER BY id LIMIT 1
      `;
      if (!rows.length) {
        console.log(`  SKIP  ${t.table}: no named rows`);
        continue;
      }
      ids[t.table] = rows[0] as { id: number; name: string };
    }
    const row = ids[t.table];
    if (!row) continue;
    const want = `${t.expect(row.name)} - Camman`;
    const { status, title } = await titleOf(t.path(row.id));
    check(
      `${t.kind}: ${t.path(row.id)} -> "${want}"`,
      title === want,
      `status=${status} got=${JSON.stringify(title)}`,
    );
  }

  // --- 2. Fallbacks: nonexistent, non-numeric, unauthenticated ------------
  console.log("");
  for (const t of TARGETS) {
    const want = `${t.fallback} - Camman`;
    const gone = await titleOf(t.path(2_000_000_000));
    check(
      `${t.kind}: nonexistent id -> "${want}" (no 500)`,
      gone.title === want && gone.status < 500,
      `status=${gone.status} got=${JSON.stringify(gone.title)}`,
    );
  }
  console.log("");
  for (const t of TARGETS) {
    const want = `${t.fallback} - Camman`;
    const bad = await titleOf(t.path("abc" as unknown as number));
    check(
      `${t.kind}: non-numeric id -> "${want}" (no 500)`,
      bad.title === want && bad.status < 500,
      `status=${bad.status} got=${JSON.stringify(bad.title)}`,
    );
    const anon = await titleOf(t.path(ids[t.table]?.id ?? 1), false);
    check(
      `${t.kind}: unauthenticated -> "${want}" (no name leak)`,
      anon.title === want,
      `status=${anon.status} got=${JSON.stringify(anon.title)}`,
    );
  }

  // --- 3. Query accounting via pg_stat_statements -------------------------
  console.log("");
  const [ext] = await sql`
    SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_stat_statements'
  `;
  if (!ext || ext.n === 0) {
    console.log("  SKIP  pg_stat_statements not installed — query count unverified");
  } else {
    const calls = async (table: string) => {
      const rows = await sql`
        SELECT COALESCE(sum(calls), 0)::int AS n
        FROM pg_stat_statements
        WHERE query ILIKE ${"%from \"" + table + "\"%org_id%limit%"}
          AND query ILIKE '%select "name"%'
      `;
      return rows[0]?.n ?? 0;
    };
    const probe = async (label: string, path: string, table: string, want: number) => {
      const before = await calls(table);
      await titleOf(path);
      const after = await calls(table);
      const delta = after - before;
      check(
        `${label}: +${want} query on ${table} (got +${delta})`,
        delta === want,
        `before=${before} after=${after}`,
      );
    };
    // Show exactly which normalized statements are being counted, so the
    // pattern can't be silently matching some pre-existing query.
    const matched = await sql`
      SELECT calls, query FROM pg_stat_statements
      WHERE query ILIKE '%select "name"%' AND query ILIKE '%org_id%' AND query ILIKE '%limit%'
        AND (query ILIKE '%from "campaigns"%' OR query ILIKE '%from "segments"%'
          OR query ILIKE '%from "contact_groups"%' OR query ILIKE '%from "sms_providers"%'
          OR query ILIKE '%from "offers"%')
      ORDER BY query
    `;
    console.log("  counted statements:");
    for (const r of matched) console.log(`    calls=${r.calls}  ${r.query}`);
    console.log("");

    // Every affected route: exactly one query on its own table.
    for (const t of TARGETS) {
      const row = ids[t.table];
      if (!row) continue;
      // campaign/edit shares the React.cache'd lookup with the parent layout's
      // generateMetadata, which also runs on that route — must still be ONE.
      await probe(t.kind, t.path(row.id), t.table, 1);
    }
    // Unaffected routes must not touch any of the five name queries.
    for (const path of ["/dashboard", "/campaigns", "/segments", "/contacts", "/reports"]) {
      for (const table of ["campaigns", "segments", "contact_groups", "sms_providers", "offers"]) {
        await probe(`${path} (unaffected)`, path, table, 0);
      }
    }
  }

  console.log(`\npass=${pass}  fail=${fail}`);
  await sql.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end().catch(() => {});
  process.exit(1);
});
