import "server-only";

import {
  OPERATOR_ROUTE_MAP,
  type HttpMethod,
  type OperatorAccess,
} from "./route-map";

// The operator authorization gate (ClickUp 869et3vm1, Phase 2).
//
// ⚠️ DENY IS THE DEFAULT, AND IT IS STRUCTURAL — NOT A LOOKUP.
//
// requireApiMembership() refuses an operator outright unless the handler hands
// it an explicit { route, method }. A route added tomorrow that does not do
// that denies the operator WITHOUT ANYONE TOUCHING THIS FILE OR THE MAP. That
// is what makes "default-deny" true rather than aspirational: a scheme where
// safety depends on remembering to add a deny entry is a scheme that fails the
// first time someone forgets.
//
// The map is the SECOND statement of intent — it makes the allowed set
// reviewable in one place and gives the verification script something to drive.
// Both have to agree before an operator gets through.
//
// WHY A ROUTE KEY AND NOT THE REQUEST. Passing `req` would have meant changing
// the handler signature of 54 route files that currently declare `GET()` with
// no parameters — pure churn on files this change has no other business
// touching. A string key is a one-line edit inside the handler body, and
// because the key is typed as `keyof typeof OPERATOR_ROUTE_MAP`, a typo is a
// compile error rather than a silent 403 (or worse, a silent allow).
//
// WHY THE METHOD IS REQUIRED. Registry routes are view-only, and in this
// codebase one route file exports GET, POST and PATCH from the same module.
// A route-level allow would have handed the operator write access to Brands and
// Offers. The method is what makes "view-only" expressible.

export type OperatorRouteKey = keyof typeof OPERATOR_ROUTE_MAP;

export interface RouteAccess {
  route: OperatorRouteKey;
  method: HttpMethod;
}

export type OperatorDecision =
  | { allowed: true }
  | { allowed: false; reason: OperatorDenyReason; detail: string };

export type OperatorDenyReason =
  | "route_not_wired"
  | "route_denied"
  | "method_denied";

/**
 * Decide whether an operator may run this handler.
 *
 * `access === undefined` means the route never opted in, which is the default
 * for every route in the codebase and therefore denies.
 */
export function decideOperatorAccess(
  access: RouteAccess | undefined,
): OperatorDecision {
  if (!access) {
    return {
      allowed: false,
      reason: "route_not_wired",
      detail:
        "This route is not available to the operator role. If it should be, add it to OPERATOR_ROUTE_MAP and pass { route, method } to requireApiMembership.",
    };
  }

  const entry: OperatorAccess | undefined = OPERATOR_ROUTE_MAP[access.route];

  // `undefined` (key absent) and `null` (explicitly denied) are the same
  // answer to the caller. They are distinguished only so the drift check can
  // tell "nobody classified this" from "classified as denied".
  if (entry == null) {
    return {
      allowed: false,
      reason: "route_denied",
      detail: "This route is not available to the operator role.",
    };
  }

  if (!entry.methods.includes(access.method)) {
    return {
      allowed: false,
      reason: "method_denied",
      detail: `The operator role may not ${access.method} this route.`,
    };
  }

  return { allowed: true };
}

/** Every route key the operator may reach, for the verification script. */
export function allowedOperatorRoutes(): { route: string; methods: HttpMethod[] }[] {
  return Object.entries(OPERATOR_ROUTE_MAP)
    .filter((e): e is [string, { methods: HttpMethod[] }] => e[1] != null)
    .map(([route, v]) => ({ route, methods: v.methods }));
}

/** Every route key explicitly denied, for the verification script. */
export function deniedOperatorRoutes(): string[] {
  return Object.entries(OPERATOR_ROUTE_MAP)
    .filter(([, v]) => v == null)
    .map(([route]) => route);
}
