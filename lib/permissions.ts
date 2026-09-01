// Role-based permissions.
//
// To add a permission:
//   1. Add the literal to the Permission union below.
//   2. Add it to the relevant role's Set in `rolePermissions` (and higher roles
//      will inherit it via the spread chain).
// To add a role: extend the Role union, add the new Set with its inherited base,
// and add the entry to rolePermissions. Don't add roles without updating the
// org_members CHECK constraint in the database.

export type Role = "owner" | "admin" | "manager" | "operator" | "viewer";

export type Permission =
  | "brands.view"
  | "brands.create"
  | "brands.update"
  | "brands.archive"
  | "brands.restore"
  | "offers.view"
  | "offers.create"
  | "offers.update"
  | "offers.archive"
  | "offers.restore"
  | "networks.view"
  | "networks.create"
  | "networks.update"
  | "networks.archive"
  | "networks.restore"
  | "providers.view"
  | "providers.create"
  | "providers.update"
  | "providers.archive"
  | "providers.restore"
  | "provider_phones.view"
  | "provider_phones.create"
  | "provider_phones.update"
  | "provider_phones.archive"
  | "provider_phones.restore"
  | "provider_credentials.view"
  | "provider_credentials.manage"
  // Partner intake keys are the same class of thing as a provider
  // credential — they grant an outside party write access — so they carry
  // the same split: manager+ may look, admin+ may mint and rotate.
  | "partner_keys.view"
  | "partner_keys.manage"
  | "routing_types.view"
  | "routing_types.create"
  | "routing_types.update"
  | "routing_types.archive"
  | "routing_types.restore"
  | "traffic_types.view"
  | "traffic_types.create"
  | "traffic_types.update"
  | "traffic_types.archive"
  | "traffic_types.restore"
  | "utm_tags.view"
  | "utm_tags.create"
  | "utm_tags.update"
  | "utm_tags.archive"
  | "utm_tags.restore"
  | "contact_groups.view"
  | "contact_groups.create"
  | "contact_groups.update"
  | "contact_groups.archive"
  | "contact_groups.restore"
  | "contacts.view"
  | "contacts.upload"
  | "contacts.update"
  | "contacts.archive"
  | "contacts.delete"
  | "opt_outs.view"
  | "opt_outs.upload"
  | "opt_outs.update"
  | "opt_outs.delete"
  | "opt_ins.view"
  | "opt_ins.upload"
  | "opt_ins.update"
  | "opt_ins.delete"
  | "clickers.view"
  | "clickers.upload"
  | "clickers.update"
  | "clickers.delete"
  | "segments.view"
  | "segments.create"
  | "segments.update"
  | "segments.archive"
  | "segments.restore"
  | "segments.delete"
  | "segment_contacts.view"
  | "segment_contacts.upload"
  | "segment_contacts.remove"
  | "creatives.view"
  | "creatives.create"
  | "creatives.update"
  | "creatives.archive"
  | "creatives.restore"
  | "campaigns.view"
  | "campaigns.create"
  | "campaigns.update"
  | "campaigns.activate"
  | "campaigns.pause"
  | "campaigns.complete"
  | "campaigns.archive"
  | "campaigns.restore"
  | "campaigns.reassign"
  // Triggers the real-send drain (actual SMS, irreversible, costs money).
  // Manager+ only — a higher bar than the reversible approve/kickoff actions.
  | "campaigns.drain"
  | "stages.view"
  | "stages.create"
  | "stages.update"
  | "stages.send"
  | "stages.archive"
  | "stages.restore"
  | "stages.delete"
  | "registry.view"
  | "registry.create"
  | "registry.update"
  | "registry.archive"
  | "result_imports.view"
  | "result_imports.create"
  | "result_imports.revert"
  | "spam.view"
  | "spam.score"
  | "lookup.run"
  | "lookup.admin"
  | "segment_rules.view"
  | "segment_rules.create"
  | "segment_rules.update"
  | "segment_rules.delete"
  | "contact_contact_groups.view"
  | "contact_contact_groups.manage"
  | "import_mappings.view"
  | "import_mappings.create"
  | "import_mappings.update"
  | "import_mappings.delete"
  | "users.manage"
  // ── 869et3vm1 Phase 2 ──────────────────────────────────────────────────
  // Split out of the blanket *.view permissions so "may look at it" and "may
  // take a copy of it out of the system" stop being the same grant.
  // Audience SIZE without audience IDENTITY. Split from contacts.view because
  // "how many contacts are there" and "who are they" were previously the same
  // grant, which made the aggregate counters unreachable for a role that must
  // never see a row.
  | "contacts.stats"
  | "contacts.export"
  | "campaigns.export"
  | "campaigns.import"
  // Compliance & routing controls: quiet hours, breakers, dedup toggles,
  // stop_text, allow_multi_segment, carrier limits, provider/credential
  // changes. OWNER-ONLY per the access matrix.
  | "compliance.manage"
  // The deletion approval queue (Phase 3 builds the UI; the permissions and
  // the table exist now so the split is settled before anything depends on it).
  | "deletion.request"
  | "deletion.approve"
  | "audit.view"
  | "org.delete";

const VALID_ROLES: ReadonlySet<Role> = new Set([
  "owner",
  "admin",
  "manager",
  "operator",
  "viewer",
]);

export function isRole(value: string | null | undefined): value is Role {
  return value != null && VALID_ROLES.has(value as Role);
}

const viewerPerms: ReadonlySet<Permission> = new Set([
  "brands.view",
  "offers.view",
  "networks.view",
  "providers.view",
  "provider_phones.view",
  "routing_types.view",
  "traffic_types.view",
  "utm_tags.view",
  "contact_groups.view",
  "contacts.view",
  "contacts.stats",
  "opt_outs.view",
  "opt_ins.view",
  "clickers.view",
  "segments.view",
  "segment_contacts.view",
  "creatives.view",
  "campaigns.view",
  "stages.view",
  "registry.view",
  "result_imports.view",
  "import_mappings.view",
  "spam.view",
  "segment_rules.view",
  "contact_contact_groups.view",
]);

// ⚠️ THIS IS NOT THE OPERATOR SET. It is the staff baseline that manager and
// above inherit, and it is EXACTLY what `operatorPerms` contained before
// 869et3vm1 Phase 2 redefined that role.
//
// It had to be split out. `managerPerms` used to spread `operatorPerms`, so
// narrowing operator to the access matrix would have silently stripped
// contacts.upload, opt_outs.upload, clickers.upload, lookup.run and the rest
// from manager, admin AND owner — a severe regression in a change whose whole
// purpose is to restrict ONE role. Renaming the shared base makes the
// inheritance say what it means.
//
// scripts/test-operator-permission-matrix.ts asserts manager/admin/owner/viewer
// come out byte-identical to their pre-Phase-2 sets.
const staffBaselinePerms: ReadonlySet<Permission> = new Set([
  ...viewerPerms,
  "contacts.upload",
  "contacts.update",
  "contacts.archive",
  "opt_outs.upload",
  "opt_outs.update",
  "opt_ins.upload",
  "opt_ins.update",
  "clickers.upload",
  "clickers.update",
  "segment_contacts.upload",
  "segment_contacts.remove",
  "creatives.create",
  "creatives.update",
  "creatives.archive",
  "campaigns.create",
  "campaigns.update",
  "campaigns.activate",
  "campaigns.pause",
  "campaigns.complete",
  "campaigns.archive",
  "stages.create",
  "stages.update",
  "stages.send",
  "stages.archive",
  "result_imports.create",
  "import_mappings.create",
  "import_mappings.update",
  "spam.score",
  "contact_contact_groups.manage",
  // Telnyx number lookup: enqueue/preview on upload — a spend action, operator+
  // (mirrors spam.score). Backfill/csv-update/settings are manager+ (lookup.admin).
  "lookup.run",
]);

// ── The OPERATOR role (869et3vm1 Phase 2) ─────────────────────────────────
//
// DEFINED STANDALONE, and deliberately NOT spread from viewerPerms. `viewer`
// carries contacts.view, opt_outs.view, clickers.view and segment_contacts.view
// — the entire audience block — so inheriting from it would have re-granted in
// one line what this role exists to withhold. Every entry below is here because
// the access matrix on the card puts it there.
//
// This set is asserted against the matrix, literal for literal, by
// scripts/test-operator-permission-matrix.ts. Adding a permission here without
// adding it to the matrix in that script FAILS THE BUILD — which is the point:
// the matrix is a product decision, not something to be widened by whoever is
// nearest the file.
//
// NOTE what is absent and why:
//   contacts.* / opt_outs.* / opt_ins.* / clickers.* / contact_groups.* /
//   segment_contacts.* / contact_contact_groups.* — the audience block.
//   *.export / *.import — no data leaves or enters the system.
//   creatives.archive — archive IS delete here; the matrix says no delete.
//   segments.archive / segments.delete — same, via the deletion queue.
//   campaigns.drain — fires real SMS; Phase 3 owns the volume caps.
//   compliance.manage — quiet hours, breakers, stop_text, allow_multi_segment.
//   providers.* / provider_credentials.* / lookup.* / users.manage / audit.view.
const operatorPerms: ReadonlySet<Permission> = new Set([
  // Registry — VIEW ONLY.
  "brands.view",
  "offers.view",
  "networks.view",
  "utm_tags.view",
  "routing_types.view",
  "traffic_types.view",
  "registry.view",
  // Sending numbers: needed to choose a route on a stage. The response is
  // redacted to a route alias, so this grants "pick Route B", never "learn
  // which SSP Route B is".
  "provider_phones.view",
  // Campaigns & stages — the job. Delete is granted on STAGES only; campaigns
  // have no hard delete in this codebase, so "delete a campaign" is archive.
  "campaigns.view",
  "campaigns.create",
  "campaigns.update",
  "campaigns.activate",
  "campaigns.pause",
  "campaigns.complete",
  "campaigns.archive",
  "campaigns.restore",
  "stages.view",
  "stages.create",
  "stages.update",
  "stages.send",
  "stages.archive",
  "stages.restore",
  "stages.delete",
  // Creatives — view + create + edit. No archive.
  "creatives.view",
  "creatives.create",
  "creatives.update",
  // Segments — view + create/edit, counts only. The contact-level endpoints
  // under a segment are denied by the route map, not by these.
  "segments.view",
  "segments.create",
  "segments.update",
  "segment_rules.view",
  "segment_rules.create",
  "segment_rules.update",
  "segment_rules.delete",
  // Audience SIZE only: count(*), count(distinct), carrier histogram. No rows.
  "contacts.stats",
  // Spam scoring is part of authoring a creative.
  "spam.view",
  "spam.score",
  // May ASK for a deletion; only an Owner may approve one.
  "deletion.request",
]);

const managerPerms: ReadonlySet<Permission> = new Set([
  // Inherits the STAFF BASELINE, not the operator role — see the note above.
  ...staffBaselinePerms,
  "brands.create",
  "brands.update",
  "brands.archive",
  "brands.restore",
  "offers.create",
  "offers.update",
  "offers.archive",
  "offers.restore",
  "networks.create",
  "networks.update",
  "networks.archive",
  "networks.restore",
  "providers.create",
  "providers.update",
  "providers.archive",
  "providers.restore",
  "provider_phones.create",
  "provider_phones.update",
  "provider_phones.archive",
  "provider_phones.restore",
  "provider_credentials.view",
  "partner_keys.view",
  "routing_types.create",
  "routing_types.update",
  "routing_types.archive",
  "routing_types.restore",
  "traffic_types.create",
  "traffic_types.update",
  "traffic_types.archive",
  "traffic_types.restore",
  "utm_tags.create",
  "utm_tags.update",
  "utm_tags.archive",
  "utm_tags.restore",
  "contact_groups.create",
  "contact_groups.update",
  "contact_groups.archive",
  "contact_groups.restore",
  "contacts.delete",
  "lookup.admin",
  "opt_outs.delete",
  "opt_ins.delete",
  "clickers.delete",
  "segments.create",
  "segments.update",
  "segments.archive",
  "segments.restore",
  "segments.delete",
  "segment_rules.create",
  "segment_rules.update",
  "segment_rules.delete",
  "creatives.restore",
  "campaigns.restore",
  "campaigns.reassign",
  "campaigns.drain",
  "stages.restore",
  "stages.delete",
  "registry.create",
  "registry.update",
  "registry.archive",
  "result_imports.revert",
  "import_mappings.delete",
  // Taking data OUT of the system is a manager decision, not a side effect of
  // being able to view it.
  "contacts.export",
  "campaigns.export",
  "campaigns.import",
]);

const adminPerms: ReadonlySet<Permission> = new Set([
  ...managerPerms,
  "users.manage",
  "provider_credentials.manage",
  "partner_keys.manage",
]);

const ownerPerms: ReadonlySet<Permission> = new Set([
  ...adminPerms,
  "org.delete",
  // OWNER-ONLY per the access matrix: resuming tripped breakers, the dedup
  // include/exclude toggle, allow_multi_segment, stop_text, quiet hours,
  // carrier limits, provider/credential changes.
  //
  // ⚠️ BEHAVIOUR CHANGE for manager/admin: they could edit stop_text and
  // allow_multi_segment before Phase 2 and can no longer. Nobody holds those
  // roles in production today (one member, role owner), so nothing breaks now
  // — but that is a fact about today, not a guarantee.
  "compliance.manage",
  "deletion.approve",
  "audit.view",
]);

export const rolePermissions: Record<Role, ReadonlySet<Permission>> = {
  viewer: viewerPerms,
  operator: operatorPerms,
  manager: managerPerms,
  admin: adminPerms,
  owner: ownerPerms,
};

export function can(role: Role | null, permission: Permission): boolean {
  if (!role) return false;
  return rolePermissions[role].has(permission);
}

export class PermissionError extends Error {
  readonly code = "forbidden";
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
    this.permission = permission;
  }
}

export function assertPermission(
  role: Role | null,
  permission: Permission,
): void {
  if (!can(role, permission)) throw new PermissionError(permission);
}
