import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { isRole, type Role } from "@/lib/permissions";
import {
  decideOperatorAccess,
  decideTokenAccess,
  type RouteAccess,
} from "@/lib/authz/operator-gate";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";
import {
  parseBearerToken,
  resolveApiToken,
  touchTokenLastUsed,
  type ResolvedApiToken,
  type TokenRejection,
} from "./tokens";
import {
  consumeTokenRequest,
  recordTokenDenial,
  DENIAL_BURST_THRESHOLD,
  TOKEN_REQUESTS_PER_HOUR,
} from "./token-usage";
import { alertDenialBurst, alertRateLimitTrip } from "./token-alerts";
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

/**
 * The identity a handler actually needs.
 *
 * A session supplies a full Supabase `User`; a token supplies only the owning
 * member's id and email, because no Supabase session exists for a bearer
 * request. `Pick` rather than a hand-written interface so a full `User` remains
 * assignable and the 74 existing `auth.user.id` call sites keep compiling —
 * while a handler reaching for any OTHER User field becomes a compile error,
 * which is exactly the signal wanted: that field would be undefined under a
 * token.
 */
export type ApiActor = Pick<User, "id" | "email">;

/** Present only when the request authenticated with a personal API token. */
export interface ApiTokenContext {
  id: string;
  name: string;
  readOnly: boolean;
}

export type ApiMembership = {
  user: ApiActor;
  orgId: string;
  role: Role;
  token?: ApiTokenContext;
};

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

// ── Personal API tokens (ClickUp 869evpmbz) ────────────────────────────────
//
// ⚠️ THE WHOLE FEATURE PLUGS IN HERE, AND NOWHERE ELSE. requireApiMembership()
// is called by 245 route files and every route that calls requireApiUser() also
// calls this, so there is exactly one door. Because it takes no `req` — it
// already reaches the session through cookies() — the bearer token can be read
// the same way, through headers(), and NOT ONE HANDLER SIGNATURE CHANGES.
//
// ⚠️ AND THE TAIL IS SHARED ON PURPOSE. A token resolves to { orgId, role } and
// then falls through the IDENTICAL is_active / isRole / operator-gate sequence a
// session runs. is_active, the default-deny route map, can() and redactForRole()
// therefore apply to tokens BY CONSTRUCTION rather than by anyone remembering to
// re-apply them. A token is its owner's authority, narrowed by the allowlist —
// never a second authorization system that could drift from the first.

/**
 * The bearer token on this request, if any.
 *
 * ⚠️ MEMOISED PER REQUEST, which is load-bearing rather than a micro-optimisation:
 * the rate limiter below consumes one unit per call, so a handler that resolved
 * auth twice would charge the caller twice for one request.
 */
const getRequestBearerToken = cache(async (): Promise<string | null> => {
  const h = await headers();
  return parseBearerToken(h.get("authorization"));
});

/** Request context for the audit trail. Memoised for the same reason. */
const getRequestContext = cache(
  async (): Promise<{ ip: string | null; userAgent: string | null }> => {
    const h = await headers();
    return { ip: requestIp(h), userAgent: requestUserAgent(h) };
  },
);

type TokenAuth =
  | { ok: true; token: ResolvedApiToken }
  | { ok: false; status: 401 | 429; reason: TokenRejection | "rate_limited"; detail: string };

/**
 * Resolve + rate-limit the bearer token. ONE call per request (memoised).
 *
 * Ordering, and why:
 *   1. resolve — a token that does not authenticate never reaches a counter it
 *      might not own;
 *   2. rate limit — charged BEFORE the route allowlist so that hammering a
 *      forbidden route still burns quota. Otherwise a prober would get
 *      unlimited attempts at the one thing we most want bounded;
 *   3. (the caller then applies the allowlist and the role gates).
 */
const authenticateRequestToken = cache(
  async (plaintext: string): Promise<TokenAuth> => {
    const resolution = await resolveApiToken(plaintext);
    const { ip, userAgent } = await getRequestContext();

    if (!resolution.ok) {
      // Attribute the denial wherever we can. `unknown_token` cannot be
      // attributed — nothing to count it against and nobody to tell — so it is
      // dropped rather than written as an org-less audit row: a public endpoint
      // is scanned constantly and those rows would be noise, not signal.
      if (resolution.orgId && resolution.tokenId) {
        await writeAuditLog({
          orgId: resolution.orgId,
          action: "api.denied",
          entityType: "api_token",
          entityId: resolution.tokenId,
          summary: `API token rejected: ${resolution.reason}`,
          metadata: { status: 401, reason: resolution.reason },
          ip,
          userAgent,
        });
        await recordTokenDenial(resolution.orgId, resolution.tokenId);
      }
      return {
        ok: false,
        status: 401,
        reason: resolution.reason,
        // One message for every rejection shape. Telling a caller WHICH of
        // "revoked / expired / deactivated / API switched off" applies would
        // let anyone holding a dead token probe the account's state; the Owner
        // gets the precise reason in the audit trail, which is where it belongs.
        detail: "Invalid or inactive API token",
      };
    }

    const { token } = resolution;
    const limit = await consumeTokenRequest(token.orgId, token.tokenId);
    if (!limit.allowed) {
      await writeAuditLog({
        orgId: token.orgId,
        actorUserId: token.userId,
        action: "api.rate_limited",
        entityType: "api_token",
        entityId: token.tokenId,
        summary: `API token "${token.tokenName}" exceeded ${limit.limit} requests/hour`,
        metadata: { status: 429, limit: limit.limit },
        ip,
        userAgent,
      });
      await alertRateLimitTrip({
        orgId: token.orgId,
        tokenId: token.tokenId,
        tokenName: token.tokenName,
        memberLabel: token.role,
        limit: limit.limit,
      });
      return {
        ok: false,
        status: 429,
        reason: "rate_limited",
        detail: `Rate limit exceeded (${limit.limit} requests/hour). Retry in ${limit.retryAfterSeconds}s.`,
      };
    }

    void touchTokenLastUsed(token.tokenId);
    return { ok: true, token };
  },
);

/** Log + count one denial against an authenticated token, then 403. */
async function denyToken(
  token: ResolvedApiToken,
  access: RouteAccess | undefined,
  detail: string,
  reason: string,
): Promise<ApiAuthFailure> {
  const { ip, userAgent } = await getRequestContext();
  const route = access?.route ?? "<unwired>";
  const method = access?.method ?? "?";

  await writeAuditLog({
    orgId: token.orgId,
    actorUserId: token.userId,
    action: "api.denied",
    entityType: "api_token",
    entityId: token.tokenId,
    summary: `API token "${token.tokenName}" denied ${method} ${route}`,
    metadata: { status: 403, reason, endpoint: route, method },
    ip,
    userAgent,
  });

  const count = await recordTokenDenial(token.orgId, token.tokenId);
  // Exactly one call sees the count EQUAL the threshold, because the increment
  // is atomic — so this fires once per token per hour without any extra state.
  // It stays counting past the threshold so the message can report the real
  // figure (see recordTokenDenial).
  if (count >= DENIAL_BURST_THRESHOLD) {
    await alertDenialBurst({
      orgId: token.orgId,
      tokenId: token.tokenId,
      tokenName: token.tokenName,
      memberLabel: token.role,
      count,
      lastRoute: route,
      lastMethod: method,
    });
  }

  return {
    error: apiError(403, detail, API_ERROR_CODES.FORBIDDEN, {
      reason,
      route: access?.route ?? null,
      method: access?.method ?? null,
    }),
  };
}

// `access` is the OPERATOR gate (ClickUp 869et3vm1 Phase 2) and, since
// 869evpmbz, the API-TOKEN gate too. Omitting it denies the operator role AND
// every token — which is every existing route until it explicitly opts in, and
// every route added in future until someone decides otherwise. Session requests
// from other roles are unaffected by this parameter; they are gated by can()
// exactly as before, so this cannot alter owner/admin/manager/viewer behaviour.
//
// See lib/authz/operator-gate.ts for why this is a typed route key rather than
// the request object.
export async function requireApiMembership(
  access?: RouteAccess,
): Promise<ApiMembership | ApiAuthFailure> {
  const bearer = await getRequestBearerToken();
  if (bearer) return requireApiMembershipByToken(bearer, access);

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

/**
 * The bearer-token half of requireApiMembership().
 *
 * Runs the token gates, then the SAME role gates a session runs. Split into its
 * own function only for readability — it is not an alternate entry point and
 * must never be exported: one door in, one set of rules.
 */
async function requireApiMembershipByToken(
  bearer: string,
  access: RouteAccess | undefined,
): Promise<ApiMembership | ApiAuthFailure> {
  const auth = await authenticateRequestToken(bearer);
  if (!auth.ok) {
    if (auth.status === 429) {
      return {
        error: apiError(429, auth.detail, API_ERROR_CODES.RATE_LIMITED, {
          reason: auth.reason,
        }),
      };
    }
    return {
      error: apiError(401, auth.detail, API_ERROR_CODES.UNAUTHORIZED, {
        reason: "invalid_token",
      }),
    };
  }
  const { token } = auth;

  // Gate 1 — the token allowlist. Applies to EVERY role, Owner included: a
  // long-lived bearer secret sitting in an agent's config gets a much smaller
  // surface than the human it belongs to.
  const tokenDecision = decideTokenAccess(access);
  if (!tokenDecision.allowed) {
    return denyToken(token, access, tokenDecision.detail, tokenDecision.reason);
  }

  if (!isRole(token.role)) {
    return {
      error: apiError(500, "Account is in an invalid state", API_ERROR_CODES.INTERNAL, {
        reason: "invalid_role_in_db",
      }),
    };
  }

  // Gate 2 — the ordinary operator default-deny, unchanged. A token belonging
  // to an operator must satisfy BOTH gates; passing the allowlist grants
  // nothing on its own. This is what makes "whatever the worker can reach,
  // their Claude can reach — and no more" true by construction.
  if (token.role === "operator") {
    const decision = decideOperatorAccess(access);
    if (!decision.allowed) {
      return denyToken(token, access, decision.detail, decision.reason);
    }
  }

  const { ip, userAgent } = await getRequestContext();
  await writeAuditLog({
    orgId: token.orgId,
    actorUserId: token.userId,
    action: "api.request",
    entityType: "api_token",
    entityId: token.tokenId,
    summary: `${access?.method ?? "?"} ${access?.route ?? "<unwired>"} via token "${token.tokenName}"`,
    // `outcome`, not `status`: this row is written BEFORE the handler runs, so
    // an HTTP code here would be a guess. See the AuditAction docblock.
    metadata: {
      outcome: "allowed",
      endpoint: access?.route ?? null,
      method: access?.method ?? null,
      hourly_limit: TOKEN_REQUESTS_PER_HOUR,
    },
    ip,
    userAgent,
  });

  return {
    // No Supabase session exists for a bearer request, so there is no User to
    // hand back — only the owning member's identity. `email` is left undefined
    // (the same thing Supabase does for a user without one) because resolving it
    // would cost a Supabase Admin round-trip on every API call to populate a
    // field exactly one route reads, and that route already coalesces it.
    user: { id: token.userId, email: undefined },
    orgId: token.orgId,
    role: token.role,
    token: { id: token.tokenId, name: token.tokenName, readOnly: token.readOnly },
  };
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
