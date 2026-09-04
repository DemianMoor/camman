import { z } from "zod";

import { WORKSPACE_DOMAIN } from "@/lib/auth/workspace-gate";
import { ASSIGNABLE_ROLES } from "@/lib/validators/user-roles";

// ⚠️ SERVER-ONLY BY TRANSITIVE IMPORT. `WORKSPACE_DOMAIN` comes from
// lib/auth/workspace-gate.ts, which is `server-only` and pulls in db/client.
// A client component that imports from this file drags the postgres driver
// into the browser bundle and fails `next build`. Client components that just
// need the role list must import lib/validators/user-roles.ts instead.
//
// The domain refinement is deliberately on the SERVER side: GOOGLE_ALLOWED_HD
// is not a NEXT_PUBLIC_ var, so a client-side copy of this rule would silently
// fall back to the default and disagree with the server whenever the env var is
// set. One authority, not two.

export { ASSIGNABLE_ROLES };

export const inviteUserSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .refine(
      (e) => e.endsWith(`@${WORKSPACE_DOMAIN}`),
      `Only ${WORKSPACE_DOMAIN} addresses can be invited`,
    ),
  role: z.enum(ASSIGNABLE_ROLES),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

export const setActiveSchema = z.object({
  is_active: z.boolean(),
});

// ── API tokens (ClickUp 869evpmbz) ─────────────────────────────────────────

export const setApiEnabledSchema = z.object({
  api_enabled: z.boolean(),
});

export const createApiTokenSchema = z.object({
  // A label the Owner will read back in the token list and in usage rows. Bounded
  // because it is echoed into audit_log summaries, which render in an
  // Owner-facing table.
  name: z.string().trim().min(1, "Give the token a name").max(80),
  // Optional expiry. Absent = no expiry, which is deliberate: the primary
  // controls are revoke and the api_enabled switch, both of which take effect on
  // the next request. A mandatory expiry would mostly produce an agent that
  // silently stops working at an hour nobody remembers choosing.
  expires_at: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
