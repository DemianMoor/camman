// RUN WITH:  npx tsx --conditions=react-server scripts/test-workspace-gate.ts
// workspace-gate.ts imports "server-only", which throws under a plain tsx run.
import "./_env-preload";

import type { User } from "@supabase/supabase-js";

import {
  verifyWorkspaceIdentity,
  WORKSPACE_DOMAIN,
} from "@/lib/auth/workspace-gate";

// Unit tests for the Google Workspace domain gate.
//
// This exists because scripts/verify-operator-access.ts CANNOT cover the Google
// sign-in path — an interactive consent screen is not scriptable — so the gate
// is tested here against synthetic identity payloads instead of being left
// unverified and described as "covered end to end".
//
// The case that matters most is IDENTITY LINKING (case 5). When a Google
// identity is linked to an existing password account, `auth.users.email` keeps
// the ORIGINAL address. Reading `user.email` would refuse the owner's own
// Google sign-in after linking — the exact scenario linking exists to enable.

type Case = {
  name: string;
  user: Partial<User>;
  expect: "ok" | string;
  why: string;
};

function u(over: Partial<User>): Partial<User> {
  return { id: "u1", app_metadata: { provider: "google" }, ...over };
}

const CASES: Case[] = [
  {
    name: "plain Google account in the domain",
    user: u({
      email: `person@${WORKSPACE_DOMAIN}`,
      user_metadata: { email_verified: true, hd: WORKSPACE_DOMAIN },
      identities: [
        {
          provider: "google",
          identity_data: { email: `person@${WORKSPACE_DOMAIN}`, email_verified: true },
        },
      ] as unknown as User["identities"],
    }),
    expect: "ok",
    why: "the ordinary case",
  },
  {
    name: "consumer gmail account",
    user: u({
      email: "someone@gmail.com",
      user_metadata: { email_verified: true },
      identities: [
        { provider: "google", identity_data: { email: "someone@gmail.com" } },
      ] as unknown as User["identities"],
    }),
    expect: "wrong_domain",
    why: "Supabase accepts ANY Google account once the provider is on; this is the gate that does not",
  },
  {
    name: "hd claim from a different Workspace",
    user: u({
      email: `person@${WORKSPACE_DOMAIN}`,
      user_metadata: { email_verified: true },
      identities: [
        {
          provider: "google",
          identity_data: {
            email: `person@${WORKSPACE_DOMAIN}`,
            hd: "someone-else.com",
          },
        },
      ] as unknown as User["identities"],
    }),
    expect: "hd_mismatch",
    why: "present-and-wrong must fail closed",
  },
  {
    name: "no hd claim at all",
    user: u({
      email: `person@${WORKSPACE_DOMAIN}`,
      user_metadata: { email_verified: true },
      identities: [
        {
          provider: "google",
          identity_data: { email: `person@${WORKSPACE_DOMAIN}` },
        },
      ] as unknown as User["identities"],
    }),
    expect: "ok",
    why: "Google omits hd in some flows; absence must NOT lock out a legitimate user",
  },
  {
    name: "LINKED identity: primary email is the old password address",
    user: u({
      // This is the owner's account after linking: primary email unchanged.
      email: "demmoor@proton.me",
      app_metadata: { provider: "email", providers: ["email", "google"] },
      user_metadata: { email_verified: true },
      identities: [
        { provider: "email", identity_data: { email: "demmoor@proton.me" } },
        {
          provider: "google",
          identity_data: {
            email: `demian@${WORKSPACE_DOMAIN}`,
            email_verified: true,
            hd: WORKSPACE_DOMAIN,
          },
        },
      ] as unknown as User["identities"],
    }),
    expect: "ok",
    why: "THE LINKING CASE — reading user.email here would refuse the owner",
  },
  {
    name: "password-only account",
    user: {
      id: "u2",
      email: "demmoor@proton.me",
      app_metadata: { provider: "email" },
      identities: [
        { provider: "email", identity_data: { email: "demmoor@proton.me" } },
      ] as unknown as User["identities"],
    },
    expect: "not_google",
    why: "the break-glass path is handled elsewhere, not by this gate",
  },
  {
    name: "Google says the address is unverified",
    user: u({
      email: `person@${WORKSPACE_DOMAIN}`,
      identities: [
        {
          provider: "google",
          identity_data: {
            email: `person@${WORKSPACE_DOMAIN}`,
            email_verified: false,
          },
        },
      ] as unknown as User["identities"],
    }),
    expect: "email_unverified",
    why: "an address Google will not vouch for must not pass",
  },
];

let failures = 0;
console.log("=== workspace gate ===\n");
console.log(`  scope: ${CASES.length} cases, domain = ${WORKSPACE_DOMAIN}`);
if (CASES.length === 0) {
  console.log("  XX  EMPTY case list");
  process.exit(1);
}

for (const c of CASES) {
  const r = verifyWorkspaceIdentity(c.user as User);
  const got = r.ok ? "ok" : r.reason;
  const ok = got === c.expect;
  console.log(`  ${ok ? "OK " : "XX "} ${c.name} -> ${got}${ok ? "" : ` (expected ${c.expect})`}`);
  console.log(`       ${c.why}`);
  if (!ok) failures++;
}

console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} — ${CASES.length - failures}/${CASES.length} ===`);
process.exit(failures === 0 ? 0 : 1);
