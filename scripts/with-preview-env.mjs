#!/usr/bin/env node
// Run a command against the PREVIEW environment (Supabase project camman-v2).
//
// ⚠️ WHY THIS EXISTS. The three HTTP API suites (test-campaigns-api,
// test-offers-api, test-provider-phones-api) drive a real server over fetch, so
// they need one. A plain `next dev` reads `.env.local`, which points
// NEXT_PUBLIC_SUPABASE_URL at PRODUCTION Supabase — so even with DATABASE_URL
// pointed at the preview database, the signed-in user authenticates against
// production and has no membership in the preview org. Every suite died at seed
// with `No organization membership`, and it read like a code failure.
//
// This loads `.env.demo` (gitignored; preview URL + publishable anon key, never
// a service key beyond what already lived there) and execs the command with it,
// so the auth project and the database project are the same one.
//
// Shell-set variables still win, so a one-off override works:
//   PORT=3002 node scripts/with-preview-env.mjs npx next dev
//
// Usage:
//   node scripts/with-preview-env.mjs npx next dev -p 3001
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-offers-api.ts
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ENV_FILE = resolve(process.cwd(), ".env.demo");
if (!existsSync(ENV_FILE)) {
  console.error(
    `Missing ${ENV_FILE}.\nIt holds the preview project's URL, publishable anon key and DATABASE_URL.\nIt is gitignored on purpose — ask the owner for a copy.`,
  );
  process.exit(1);
}

const env = { ...process.env };
for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
  if (!m) continue;
  const [, k, rawV] = m;
  const v = rawV.trim().replace(/^["']|["']$/g, "");
  // A variable set in the shell wins, so an override on the command line works.
  if (process.env[k] === undefined) env[k] = v;
}

// The suites read NEXT_PUBLIC_SITE_URL as the base URL to fetch. In .env.demo
// it names the deployed preview host, which is right for the deployed app and
// wrong for a local run — point it at the local server unless told otherwise.
if (process.env.NEXT_PUBLIC_SITE_URL === undefined) {
  env.NEXT_PUBLIC_SITE_URL = `http://localhost:${process.env.PORT ?? "3001"}`;
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node scripts/with-preview-env.mjs <command> [args…]");
  process.exit(1);
}

// The invariant, asserted WITHOUT naming a project. The bug this runner exists
// to prevent is the AUTH project and the DATABASE project being different ones
// -- a server reading production Supabase while pointed at the preview
// database, where the signed-in user has no membership. So compare the two refs
// to EACH OTHER rather than to a hardcoded id: no project literal to copy
// around (the preview-DB guard exists because those literals spread), and it
// keeps working if either project is ever replaced.
const authRef = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([^.]+)\./)?.[1];
const dbRef = (env.DATABASE_URL ?? "").match(/postgres\.([a-z0-9]+)[:@]/)?.[1];
if (!authRef || !dbRef) {
  console.error(
    `REFUSING: .env.demo must set both NEXT_PUBLIC_SUPABASE_URL and DATABASE_URL.\n  auth project: ${authRef ?? "(unreadable)"}\n  db project:   ${dbRef ?? "(unreadable)"}`,
  );
  process.exit(1);
}
if (authRef !== dbRef) {
  console.error(
    `REFUSING: auth and database point at DIFFERENT Supabase projects.\n  auth: ${authRef}\n  db:   ${dbRef}\nThat mismatch is exactly what made the API suites fail with "No organization membership".`,
  );
  process.exit(1);
}
console.log(`[with-preview-env] project ${authRef} (auth + db agree) - ${env.NEXT_PUBLIC_SITE_URL}`);

spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" })
  .on("exit", (code) => process.exit(code ?? 1));
