import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Lists the current org's members. The Drizzle schema only declares
// auth.users.id (the auth schema is managed by Supabase), so we reach into
// email + display_name via raw SQL on a confined query rather than mirror
// the whole auth.users shape. display_name lives in raw_user_meta_data and
// may be null for users who haven't completed their profile yet.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Anyone who can view campaigns needs to see assignee options for the
  // picker. Tighter gates (e.g. on the user-management page) live elsewhere.
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = (await db.execute(drizzleSql`
    select
      om.user_id as id,
      u.email,
      u.raw_user_meta_data->>'display_name' as display_name,
      om.role,
      om.joined_at
    from public.org_members om
    inner join auth.users u on u.id = om.user_id
    where om.org_id = ${orgId}::uuid
    order by om.joined_at asc
  `)) as unknown as {
    id: string;
    email: string | null;
    display_name: string | null;
    role: string;
    joined_at: string;
  }[];

  return NextResponse.json({ data: rows });
}
