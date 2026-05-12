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
  | "segment_groups.view"
  | "segment_groups.create"
  | "segment_groups.update"
  | "segment_groups.archive"
  | "segment_groups.restore"
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
  | "creatives.approve"
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
  | "stages.view"
  | "stages.create"
  | "stages.update"
  | "stages.send"
  | "stages.archive"
  | "stages.restore"
  | "registry.view"
  | "registry.create"
  | "registry.update"
  | "registry.archive"
  | "result_imports.view"
  | "result_imports.create"
  | "result_imports.revert"
  | "import_mappings.view"
  | "import_mappings.create"
  | "import_mappings.update"
  | "import_mappings.delete"
  | "users.manage"
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
  "segment_groups.view",
  "contacts.view",
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
]);

const operatorPerms: ReadonlySet<Permission> = new Set([
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
]);

const managerPerms: ReadonlySet<Permission> = new Set([
  ...operatorPerms,
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
  "segment_groups.create",
  "segment_groups.update",
  "segment_groups.archive",
  "segment_groups.restore",
  "contacts.delete",
  "opt_outs.delete",
  "opt_ins.delete",
  "clickers.delete",
  "segments.create",
  "segments.update",
  "segments.archive",
  "segments.restore",
  "segments.delete",
  "creatives.approve",
  "creatives.restore",
  "campaigns.restore",
  "campaigns.reassign",
  "stages.restore",
  "registry.create",
  "registry.update",
  "registry.archive",
  "result_imports.revert",
  "import_mappings.delete",
]);

const adminPerms: ReadonlySet<Permission> = new Set([
  ...managerPerms,
  "users.manage",
]);

const ownerPerms: ReadonlySet<Permission> = new Set([
  ...adminPerms,
  "org.delete",
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
