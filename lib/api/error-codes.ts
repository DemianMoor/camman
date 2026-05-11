// Stable error codes used across the API surface. Routes set these on error
// responses via the `code` field; clients branch on them for friendly copy
// (see lib/api/toast-error.ts) without depending on the human-readable `error`
// message, which may evolve.
//
// Prefer entity-agnostic codes (e.g. `duplicate` + `details: { field }`) over
// per-entity ones (e.g. `duplicate_brand_id`) so toast/UX behavior generalizes
// across entities.

export const API_ERROR_CODES = {
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  VALIDATION: "validation",
  DUPLICATE: "duplicate",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  INTERNAL: "internal",
} as const;

export type ApiErrorCode =
  (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
