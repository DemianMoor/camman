// REGRESSION: a brand with 2+ short_domains rows must appear EXACTLY ONCE in
// every brand list endpoint.
//
// The defect: /api/brands/list joined short_domains with a plain LEFT JOIN whose
// one-row-per-brand property rested on `short_domains_brand_id_uniq`. Migration
// 0136 dropped that index so a brand could hold several domains, and from then
// on the join FANNED OUT — Guide Kin (2 domain rows) came back twice, appeared
// twice in every brand dropdown in the app, made `data.length` disagree with
// `totalCount`, and made LIMIT/OFFSET page over duplicated rows.
//
// This hits the REAL HTTP endpoint with a real session rather than re-running a
// copy of its query: a copy would only prove the copy is right. Read-only — it
// issues GETs and never writes.
//
// Point it at a running server:
//   APP_BASE_URL=http://localhost:3001 npx tsx scripts/verify-brand-list-no-fanout.ts
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

type BrandRow = { id: number; name: string; short_domain: string | null };
type ListResponse = { data: BrandRow[]; totalCount: number; page: number; pageSize: number };

async function main() {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  // ⚠️ NOT NEXT_PUBLIC_SITE_URL — in .env.local that points at localhost:3001
  // regardless of what is actually running, so silently defaulting to it turns a
  // dead server into "HTTP 000" that reads like an outage. Require it explicitly.
  const base = process.env.APP_BASE_URL;

  if (!supaUrl || !anonKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
    process.exit(1);
  }
  if (!email || !password) {
    console.error("Set TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local");
    process.exit(1);
  }
  if (!base) {
    console.error("Set APP_BASE_URL (e.g. http://localhost:3001) — refusing to guess the target.");
    process.exit(1);
  }
  console.log(`Target: ${base}`);

  // ── Ground truth from the database ───────────────────────────────────────
  const domainCounts = (await db.execute(sql`
    SELECT b.id, b.name, b.status,
           count(d.id)::int AS domain_rows,
           count(d.id) FILTER (WHERE d.status = 'active')::int AS active_rows
    FROM brands b
    LEFT JOIN short_domains d ON d.brand_id = b.id AND d.org_id = b.org_id
    GROUP BY b.id, b.name, b.status
    ORDER BY b.id
  `)) as unknown as {
    id: number; name: string; status: string; domain_rows: number; active_rows: number;
  }[];

  console.log(`\nBrand scope: ${domainCounts.length} brand(s)`);
  for (const b of domainCounts) {
    console.log(`     #${b.id} ${b.name} (${b.status}) — ${b.domain_rows} domain row(s), ${b.active_rows} active`);
  }
  check("brand scope is non-empty", domainCounts.length > 0, `${domainCounts.length}`);

  // NON-VACUOUS GATE. With no multi-domain brand, "appears exactly once" holds
  // trivially and proves nothing about fanout. Fail loudly rather than pass.
  const multi = domainCounts.filter((b) => b.domain_rows >= 2);
  check(
    "at least one brand has 2+ domain rows (otherwise this test is vacuous)",
    multi.length > 0,
    multi.length
      ? `multi-domain: ${multi.map((b) => `#${b.id} ${b.name} (${b.domain_rows})`).join(", ")}`
      : "NO brand has 2+ domains — the fanout case is not represented",
  );

  // ── Sign in and hit the real endpoint ────────────────────────────────────
  const jar = new Map<string, string>();
  const supabase = createServerClient(supaUrl, anonKey, {
    cookies: {
      getAll: () => Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cookies) => { for (const { name, value } of cookies) jar.set(name, value); },
    },
  });
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) {
    console.error(`Sign-in failed: ${signInErr.message}`);
    process.exit(1);
  }
  const cookie = () => Array.from(jar.entries()).map(([n, v]) => `${n}=${v}`).join("; ");

  const res = await fetch(`${base}/api/brands/list?pageSize=200`, { headers: { Cookie: cookie() } });
  check("GET /api/brands/list returned 200", res.status === 200, `HTTP ${res.status}`);
  if (res.status !== 200) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const body = (await res.json()) as ListResponse;

  console.log(`\nEndpoint returned ${body.data.length} row(s), totalCount=${body.totalCount}`);
  for (const r of body.data) console.log(`     #${r.id} ${r.name} short_domain=${r.short_domain ?? "null"}`);

  check("endpoint returned rows", body.data.length > 0, `${body.data.length}`);

  // ── The assertion this file exists for ───────────────────────────────────
  const seen = new Map<number, number>();
  for (const r of body.data) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  check(
    "every brand appears EXACTLY ONCE (no fanout)",
    dupes.length === 0,
    dupes.length
      ? `duplicated: ${dupes.map(([id, n]) => `#${id} x${n}`).join(", ")}`
      : `${seen.size} distinct brand(s) across ${body.data.length} row(s)`,
  );

  // Specifically the multi-domain brands, named — the general check above could
  // pass while the interesting case is absent from this page.
  for (const b of multi) {
    check(
      `multi-domain brand #${b.id} (${b.name}, ${b.domain_rows} domains) appears exactly once`,
      seen.get(b.id) === 1,
      `appeared ${seen.get(b.id) ?? 0} time(s)`,
    );
  }

  check(
    "data.length agrees with totalCount",
    body.data.length === body.totalCount,
    `data=${body.data.length} totalCount=${body.totalCount}`,
  );

  // ── The short_domain column must be an ACTIVE domain ─────────────────────
  // The old join had no status filter, so post-B1 it could hand a `pending`
  // host to the campaign form's SMS preview.
  const activeByBrand = (await db.execute(sql`
    SELECT brand_id, domain FROM short_domains WHERE status = 'active'
  `)) as unknown as { brand_id: number; domain: string }[];
  const activeSet = new Map<number, Set<string>>();
  for (const d of activeByBrand) {
    if (!activeSet.has(d.brand_id)) activeSet.set(d.brand_id, new Set());
    activeSet.get(d.brand_id)!.add(d.domain);
  }
  const badStatus = body.data.filter(
    (r) => r.short_domain != null && !(activeSet.get(r.id)?.has(r.short_domain) ?? false),
  );
  check(
    "every returned short_domain is an ACTIVE domain of that brand",
    badStatus.length === 0,
    badStatus.length
      ? `non-active returned: ${badStatus.map((r) => `#${r.id}:${r.short_domain}`).join(", ")}`
      : "all active",
  );

  // ── And it must be the EFFECTIVE one (default first, then oldest) ─────────
  const expected = (await db.execute(sql`
    SELECT b.id, (
      SELECT d.domain FROM short_domains d
      WHERE d.brand_id = b.id AND d.org_id = b.org_id AND d.status = 'active'
      ORDER BY d.is_default DESC, d.created_at ASC, d.id ASC LIMIT 1
    ) AS effective
    FROM brands b
  `)) as unknown as { id: number; effective: string | null }[];
  const expectedMap = new Map(expected.map((e) => [e.id, e.effective]));
  const wrongPick = body.data.filter((r) => (r.short_domain ?? null) !== (expectedMap.get(r.id) ?? null));
  check(
    "the returned domain is the brand's EFFECTIVE one (explicit default, else oldest active)",
    wrongPick.length === 0,
    wrongPick.length
      ? wrongPick.map((r) => `#${r.id} got=${r.short_domain} want=${expectedMap.get(r.id)}`).join(", ")
      : "matches the send path's brand-level precedence for every brand",
  );

  // ── Source guard: the plain join must not come back ──────────────────────
  //
  // ⚠️ SCAN THE CODE, NOT THE PROSE. The first version matched the raw file and
  // failed on the route's own comment, which quotes the removed
  // `.leftJoin(short_domains, …)` line to explain why it went away. A scanner
  // that cannot tell a description from the thing described reports a defect
  // that isn't there — and the same mistake in the other direction (a comment
  // saying "we never select api_key") hides one that is. Strip comments first,
  // and print how much was stripped so a stripper that ate everything is
  // visible instead of passing vacuously.
  const rawSrc = await fs.readFile(path.join(process.cwd(), "app/api/brands/list/route.ts"), "utf8");
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  console.log(
    `\nSource scan: ${rawSrc.length} chars -> ${src.length} chars of code ` +
      `(${rawSrc.length - src.length} stripped as comments)`,
  );
  check("comment-stripping left code to scan", src.trim().length > 300, `${src.trim().length} chars`);
  check(
    "brands/list does not use a plain leftJoin onto short_domains",
    !/\.leftJoin\(\s*short_domains/.test(src),
    "a non-lateral join here fans out the moment a brand has 2 domains",
  );
  check(
    "brands/list uses a LATERAL sub-select",
    /leftJoinLateral/.test(src),
    "LIMIT 1 inside LATERAL is what makes the cardinality structural",
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
