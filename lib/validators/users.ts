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
