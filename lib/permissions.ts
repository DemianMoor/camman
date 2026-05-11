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
  | "registry.view"
  | "registry.create"
  | "registry.update"
  | "registry.archive"
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
  "registry.view",
]);

const operatorPerms: ReadonlySet<Permission> = new Set([...viewerPerms]);

const managerPerms: ReadonlySet<Permission> = new Set([
  ...operatorPerms,
  "brands.create",
  "brands.update",
  "brands.archive",
  "brands.restore",
  "registry.create",
  "registry.update",
  "registry.archive",
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
