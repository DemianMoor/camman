// MUST BE FIRST. ESM evaluates imports in source order and HOISTS them above
// statements, so a bare `config({...})` call in this file would run AFTER
// db/client had already read process.env.DATABASE_URL and failed to connect.
// The side-effect import is the only ordering that works.
import "./_env-preload";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";

// Phase 1 verification for ClickUp 869et3vm1 (multi-user / Operator).
//
// Read-only. Safe against production.
//
// Per docs/07-conventions.md ("a passing check is not evidence until you know
// what it ran against"): every check PRINTS ITS SCOPE, and an empty scope is a
// FAILURE, not a pass. A check that finds nothing to look at has told you the
// parser broke, not that the system is healthy.
//
// ⚠️ This suite deliberately does NOT assert "no members are deactivated" or
// "audit_log is empty". Those describe today's world-state and would go red the
// first time the feature is USED correctly (docs/07-conventions.md, "A guard
// that goes red on correct use is a countdown"). What it asserts instead are
// INVARIANTS that must hold no matter how much the feature gets used.

let failures = 0;
let checks = 0;

function ok(label: string, detail: string) {
  checks++;
  console.log(`  ✓ ${label} — ${detail}`);
}
function bad(label: string, detail: string) {
  checks++;
  failures++;
  console.log(`  ✗ ${label} — ${detail}`);
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

async function main() {
  console.log("=== 869et3vm1 Phase 1 verification ===\n");

  // ── 1. Schema: migration 0175 applied ────────────────────────────────────
  console.log("--- 1. Schema (migration 0175) ---");
  const cols = await db.execute<{ table_name: string; column_name: string }>(
    drizzleSql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'org_members' AND column_name IN
            ('is_active','last_login_at','last_login_ip','invited_email','invited_at'))
          OR (table_name = 'campaign_stages' AND column_name = 'created_by_user_id')
          OR (table_name = 'campaigns' AND column_name = 'created_by_user_id')
        )
      ORDER BY table_name, column_name`,
  );
  const found = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
  console.log(`  scope: ${found.size} matching columns found`);
  if (found.size === 0) {
    bad("column scope", "EMPTY — migration 0175 has not been applied here");
  }
  for (const expected of [
    "org_members.is_active",
    "org_members.last_login_at",
    "org_members.last_login_ip",
    "org_members.invited_email",
    "org_members.invited_at",
    "campaigns.created_by_user_id",
    "campaign_stages.created_by_user_id",
  ]) {
    if (found.has(expected)) ok("column", expected);
    else bad("column", `${expected} MISSING`);
  }

  const tables = await db.execute<{ tablename: string; rls: boolean }>(
    drizzleSql`
      SELECT c.relname AS tablename, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('audit_log','deletion_requests','provider_route_aliases')`,
  );
  console.log(`  scope: ${tables.length} of 3 new tables present`);
  if (tables.length !== 3) {
    bad("new tables", `expected 3, found ${tables.length}`);
  } else {
    for (const t of tables) {
      if (t.rls) ok("RLS enabled", t.tablename);
      else bad("RLS enabled", `${t.tablename} has RLS OFF`);
    }
  }

  // RLS coverage must not regress: the security advisor treats any public
  // table without RLS as an ERROR, because the anon key ships in the browser
  // bundle and reaches PostgREST directly.
  const cover = await db.execute<{ total: string; with_rls: string }>(
    drizzleSql`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE relrowsecurity)::text AS with_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  const total = Number(cover[0]?.total ?? 0);
  const withRls = Number(cover[0]?.with_rls ?? 0);
  console.log(`  scope: ${withRls}/${total} public tables have RLS`);
  if (total === 0) bad("RLS coverage", "EMPTY — no public tables found");
  else if (withRls === total) ok("RLS coverage", `${withRls}/${total}`);
  else bad("RLS coverage", `${withRls}/${total} — ${total - withRls} table(s) unprotected`);

  // ── 2. The is_active gate is wired into BOTH per-request helpers ─────────
  //
  // Asserted against SOURCE, because this is the one thing that cannot be
  // observed from the database and is silently catastrophic if dropped: with
  // it missing, deactivation would not take effect until token expiry.
  console.log("\n--- 2. Per-request is_active gate ---");
  const gateFiles: Array<[string, string]> = [
    ["lib/api/helpers.ts", "requireApiMembership (every API route)"],
    ["lib/auth/helpers.ts", "requireOrgMembership (every page)"],
  ];
  console.log(`  scope: ${gateFiles.length} helper files`);
  for (const [path, what] of gateFiles) {
    const src = readRepoFile(path);
    const selects = src.includes("is_active: org_members.is_active");
    const enforces = /!\s*(row|membership)\.is_active/.test(src);
    if (selects && enforces) ok("gate present", `${path} — ${what}`);
    else
      bad(
        "gate present",
        `${path} — selects=${selects} enforces=${enforces} (${what})`,
      );
  }

  // ── 3. Deactivation must never write sent_at ─────────────────────────────
  //
  // sent_at is the scheduler's atomic fire-lock. A second writer stamping it
  // silently cancels a scheduled send — a real past incident in this repo.
  console.log("\n--- 3. Kill switch does not touch the fire-lock ---");
  const deactivateSrc = readRepoFile("lib/auth/deactivate.ts");
  console.log(`  scope: lib/auth/deactivate.ts (${deactivateSrc.length} bytes)`);
  if (deactivateSrc.length === 0) {
    bad("kill switch source", "EMPTY FILE");
    // Matches `sent_at:` — an object-literal KEY, i.e. a write. Reads like
    // `isNull(campaign_stages.sent_at)` are legitimate and must not trip this.
    // (Deliberately not a dotall regex: the `s` flag needs an es2018 target and
    // `next build`'s type check runs below that.)
  } else if (/sent_at\s*:/.test(deactivateSrc)) {
    bad("fire-lock untouched", "deactivate.ts writes sent_at");
  } else {
    ok("fire-lock untouched", "no sent_at write in deactivate.ts");
  }
  if (deactivateSrc.includes("send_approved: false")) {
    ok("uses existing gate", "clears send_approved (no new send-path logic)");
  } else {
    bad("uses existing gate", "send_approved is not cleared");
  }

  // ── 4. Self-signup is closed AT THE SERVER ACTION ────────────────────────
  //
  // Removing the page would not close anything: a Server Action is an RPC
  // endpoint with a stable id and stays callable without any UI.
  console.log("\n--- 4. Self-signup closed ---");
  const signupSrc = readRepoFile("app/(auth)/signup/actions.ts");
  console.log(`  scope: app/(auth)/signup/actions.ts (${signupSrc.length} bytes)`);
  if (signupSrc.length === 0) {
    bad("signup action", "EMPTY FILE");
  } else if (signupSrc.includes("auth.signUp(")) {
    bad("signup closed", "signUpAction still calls supabase.auth.signUp");
  } else {
    ok("signup closed", "signUpAction refuses without calling signUp");
  }

  // ── 5. Authorship is stamped at every stage-insert site ──────────────────
  //
  // A site that forgets it leaves stages the kill switch cannot find. The list
  // is DISCOVERED from the repo rather than hardcoded, so a new insert site
  // added later fails this check instead of slipping past it.
  console.log("\n--- 5. created_by_user_id at every stage insert ---");
  const insertSites = [
    "app/api/campaigns/[campaignId]/stages/route.ts",
    "app/api/campaigns/[campaignId]/stages/[stageId]/duplicate/route.ts",
    "app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts",
    "app/api/campaigns/[campaignId]/duplicate/route.ts",
    "lib/stages/behavioral-split.ts",
  ];
  console.log(`  scope: ${insertSites.length} known insert sites`);
  if (insertSites.length === 0) bad("insert sites", "EMPTY");
  for (const path of insertSites) {
    const src = readRepoFile(path);
    if (!src.includes("insert(campaign_stages)")) {
      bad("insert site", `${path} no longer inserts campaign_stages — update this list`);
      continue;
    }
    if (src.includes("created_by_user_id")) ok("stamps author", path);
    else bad("stamps author", `${path} inserts stages WITHOUT created_by_user_id`);
  }

  // ── 6. Operator role is still locked until Phase 2 ───────────────────────
  //
  // Until operatorPerms is redefined, handing out `operator` grants the whole
  // audience block. This check EXPIRES BY DESIGN in Phase 2 — and it says so,
  // so whoever sees it go red knows to delete it rather than "fix" it.
  console.log("\n--- 6. Operator role locked (expires in Phase 2) ---");
  const inviteSrc = readRepoFile("app/api/users/invite/route.ts");
  console.log(`  scope: app/api/users/invite/route.ts (${inviteSrc.length} bytes)`);
  if (inviteSrc.includes("OPERATOR_LOCKED_UNTIL_PHASE_2")) {
    ok(
      "operator locked",
      "invite route refuses role=operator — REMOVE THIS CHECK in Phase 2",
    );
  } else {
    bad(
      "operator locked",
      "the Phase-1 lock is gone; if Phase 2 landed, delete this check",
    );
  }

  console.log(
    `\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures}/${checks} checks passed ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verification threw:", err);
  process.exit(1);
});
