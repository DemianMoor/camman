import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { isRole, type Role } from "@/lib/permissions";
import {
  decideOperatorAccess,
  type RouteAccess,
} from "@/lib/authz/operator-gate";
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

// Per-request-memoized primitives. React.cache bounds the Supabase Auth
// round-trip and the org_members lookup to one call each per request, so a
// handler that resolves auth more than once (or calls both helpers) pays the
// network/DB cost only once. Scope is a single request — never cross-request.
const getApiUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

// `is_active` is selected in the SAME query that already resolves org_id and
// role, so the per-request deactivation check costs ZERO extra round-trips.
// This is the load-bearing half of the kill switch: revoking refresh tokens
// only stops NEW sessions, while an already-issued access token stays valid
// until it expires. Re-reading is_active here is what makes a deactivation
// take effect on the very next request instead of at token expiry.
//
// It cannot live in proxy.ts alone: ALL of api/ is excluded from the
// middleware matcher (see proxy.ts config), so the middleware never runs for
// any of these routes.
const getApiMembershipRow = cache(
  async (
    userId: string,
  ): Promise<{ org_id: string; role: string; is_active: boolean } | null> => {
    const rows = await db
      .select({
        org_id: org_members.org_id,
        role: org_members.role,
        is_active: org_members.is_active,
      })
      .from(org_members)
      .where(eq(org_members.user_id, userId))
      .limit(1);
    return rows[0] ?? null;
  },
);

export async function requireApiUser(): Promise<ApiUser | ApiAuthFailure> {
  const user = await getApiUser();
  if (!user) {
    return {
      error: apiError(401, "Not signed in", API_ERROR_CODES.UNAUTHORIZED),
    };
  }
  return { user };
}

// `access` is the OPERATOR gate (ClickUp 869et3vm1 Phase 2). Omitting it denies
// the operator role — which is every existing route until it explicitly opts
// in, and every route added in future until someone decides otherwise. Other
// roles are unaffected by this parameter; they are gated by can() exactly as
// before, so this change cannot alter owner/admin/manager/viewer behaviour.
//
// See lib/authz/operator-gate.ts for why this is a typed route key rather than
// the request object.
export async function requireApiMembership(
  access?: RouteAccess,
): Promise<ApiMembership | ApiAuthFailure> {
  const userResult = await requireApiUser();
  if ("error" in userResult) return userResult;

  const row = await getApiMembershipRow(userResult.user.id);
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
  // Ordered BEFORE the role check on purpose: a deactivated account gets the
  // same answer whatever its role is, including a role this build no longer
  // recognises.
  if (!row.is_active) {
    return {
      error: apiError(
        403,
        "Your access has been deactivated",
        API_ERROR_CODES.FORBIDDEN,
        { reason: "membership_inactive" },
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

  // Operator default-deny. Deliberately AFTER the role check (so an unknown
  // role still reports as invalid rather than as an authz refusal) and BEFORE
  // the success return, so no handler body can run for a denied operator.
  if (row.role === "operator") {
    const decision = decideOperatorAccess(access);
    if (!decision.allowed) {
      return {
        error: apiError(403, decision.detail, API_ERROR_CODES.FORBIDDEN, {
          reason: decision.reason,
          route: access?.route ?? null,
          method: access?.method ?? null,
        }),
      };
    }
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

export const DEFAULT_MAX_PAGE_SIZE = 100;

// `maxPageSize` raises the cap for endpoints whose callers legitimately need a
// whole (small, bounded) set in one shot — e.g. the stage creative picker,
// which filters client-side over every eligible creative. Callers that exceed
// the cap are TRUNCATED SILENTLY at the API layer, so any endpoint raising this
// should also surface `totalCount` so the client can tell it was clipped.
export function parseListParams(
  req: NextRequest,
  opts?: { maxPageSize?: number },
): ListParams {
  const sp = req.nextUrl.searchParams;
  const maxPageSize = opts?.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

  const pageRaw = Number(sp.get("page"));
  const page =
    Number.isFinite(pageRaw) && pageRaw >= 0 ? Math.floor(pageRaw) : 0;

  const pageSizeRaw = Number(sp.get("pageSize"));
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(maxPageSize, Math.floor(pageSizeRaw))
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
