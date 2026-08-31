// Roles an Owner may hand out, as a plain constant with NO imports.
//
// ⚠️ THIS FILE MUST STAY DEPENDENCY-FREE. It is imported by
// components/settings/users-panel.tsx, a client component. It used to live in
// lib/validators/users.ts, which imports WORKSPACE_DOMAIN from
// lib/auth/workspace-gate.ts — a `server-only` module that pulls in db/client
// — and that dragged the postgres driver into the browser bundle and failed
// `next build` outright. Adding an import here can reintroduce that.
//
// `owner` is absent on purpose: minting a second owner is not a one-click
// action for the Users screen, and the `invites_role_check` DB constraint
// already refuses it.
//
// ⚠️ `operator` is listed because the org_members CHECK allows it, but as of
// Phase 1 the `operator` role in lib/permissions.ts still carries its ORIGINAL
// permission set — which grants the whole audience block (contacts.upload,
// opt_outs.upload, clickers.view, …), the exact inverse of the Operator access
// matrix. The invite route refuses it outright until Phase 2 redefines
// operatorPerms; see OPERATOR_LOCKED_UNTIL_PHASE_2 in
// app/api/users/invite/route.ts.
export const ASSIGNABLE_ROLES = [
  "admin",
  "manager",
  "operator",
  "viewer",
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
