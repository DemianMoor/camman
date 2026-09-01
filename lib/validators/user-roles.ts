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
// `operator` is the restricted campaign role defined by the access matrix
// (869et3vm1 Phase 2): campaigns, stages, creatives and segments, with no
// contact-level access, no exports/imports, and no compliance controls.
export const ASSIGNABLE_ROLES = [
  "admin",
  "manager",
  "operator",
  "viewer",
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
