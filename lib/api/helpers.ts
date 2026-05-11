import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { isRole, type Role } from "@/lib/permissions";
import { API_ERROR_CODES } from "./error-codes";

// API error contract.
//
// Every non-2xx response from an API route returns JSON of the shape:
//
//   {
//     error: string,         // user-safe human-readable message
//     code?: string,         // stable machine-readable code (see API_ERROR_CODES)
//     details?: unknown      // optional extra info (e.g. { field: 'brand_id' })
//   }
//
// Clients should branch on `code` for special handling and fall back to `error`
// for display. Prefer entity-agnostic codes with `details` carrying specifics.

// Return-style auth helpers.
//
// Pattern: each helper returns either the success payload or `{ error: NextResponse }`.
// Callers check with `if ('error' in result) return result.error;` then destructure.
// Chosen over throw/catch because route handlers stay linear (no try wrapper at
// the top of every export) and exit paths are explicit.

export type ApiAuthFailure = { error: NextResponse };
export type ApiUser = { user: User };
export type ApiMembership = { user: User; orgId: string; role: Role };

export function apiError(
  status: number,
  error: string,
  code?: string,
  details?: unknown,
) {
  const body: { error: string; code?: string; details?: unknown } = { error };
  if (code !== undefined) body.code = code;
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

export async function requireApiUser(): Promise<ApiUser | ApiAuthFailure> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: apiError(401, "Not signed in", API_ERROR_CODES.UNAUTHORIZED),
    };
  }
  return { user };
}

export async function requireApiMembership(): Promise<
  ApiMembership | ApiAuthFailure
> {
  const userResult = await requireApiUser();
  if ("error" in userResult) return userResult;

  const rows = await db
    .select({ org_id: org_members.org_id, role: org_members.role })
    .from(org_members)
    .where(eq(org_members.user_id, userResult.user.id))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      error: apiError(
        403,
        "No organization membership",
        API_ERROR_CODES.FORBIDDEN,
        { reason: "no_org_membership" },
      ),
    };
  }
  if (!isRole(row.role)) {
    return {
      error: apiError(
        500,
        "Account is in an invalid state",
        API_ERROR_CODES.INTERNAL,
        { reason: "invalid_role_in_db" },
      ),
    };
  }
  return { user: userResult.user, orgId: row.org_id, role: row.role };
}

export type ListParams = {
  page: number;
  pageSize: number;
  search: string | null;
  showArchived: boolean;
  sortBy: string | null;
  sortDir: "asc" | "desc";
};

export function parseListParams(req: NextRequest): ListParams {
  const sp = req.nextUrl.searchParams;

  const pageRaw = Number(sp.get("page"));
  const page =
    Number.isFinite(pageRaw) && pageRaw >= 0 ? Math.floor(pageRaw) : 0;

  const pageSizeRaw = Number(sp.get("pageSize"));
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(100, Math.floor(pageSizeRaw))
      : 20;

  const searchRaw = sp.get("search")?.trim();
  const search = searchRaw ? searchRaw : null;

  const showArchived = sp.get("showArchived") === "true";

  const sortBy = sp.get("sortBy");
  const sortDir = sp.get("sortDir") === "asc" ? "asc" : "desc";

  return { page, pageSize, search, showArchived, sortBy, sortDir };
}

// Detect unique-constraint violations from postgres-js (Drizzle wraps the original
// error in DrizzleQueryError; the SQLSTATE lives on either the top-level error or
// its cause).
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const top = err as { code?: unknown; cause?: { code?: unknown } };
  return top.code === "23505" || top.cause?.code === "23505";
}
