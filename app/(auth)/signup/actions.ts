"use server";

import type { SignupInput } from "@/lib/validators/auth";

export type SignUpResult = { ok: true } | { error: string };

// SELF-SIGNUP IS CLOSED (ClickUp 869et3vm1, Phase 1).
//
// This used to call supabase.auth.signUp with no domain restriction, and a DB
// trigger then auto-created an `organizations` row plus an `owner` membership.
// Anyone on the internet could mint themselves an org. That never granted
// access to an EXISTING org, so it was not a data leak — but it is not
// something a closed internal tool should offer, and leaving it live would
// undercut the Google Workspace gate sitting next to it.
//
// Access is now granted only by an Owner invite (`invites` row) redeemed
// through Google sign-in — see lib/auth/workspace-gate.ts and
// app/auth/callback/route.ts.
//
// ⚠️ THE SERVER ACTION IS THE CONTROL, not the page. Removing the /signup UI
// alone would leave this action reachable: a Server Action is an RPC endpoint
// with a stable id, callable directly by anyone who has seen the bundle. It is
// refused here so there is nothing left to call.
//
// The parameter is kept so the exported signature still matches its caller and
// no client code has to change shape; it is deliberately unused.
export async function signUpAction(_input: SignupInput): Promise<SignUpResult> {
  void _input;
  return {
    error:
      "Sign-up is closed. Ask the workspace owner to invite you, then sign in with Google.",
  };
}
