import { toast } from "sonner";

import { API_ERROR_CODES } from "./error-codes";

// UI-side helper: map an API error result to a user-facing toast.
// Known codes get friendlier copy; unknown codes fall back to the server's
// `error` field, then to `fallback`, then to a generic message.

type ApiErrorLike = {
  error: string;
  code?: string;
  details?: unknown;
};

function fieldFromDetails(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as { field?: unknown };
  return typeof d.field === "string" ? d.field : null;
}

export function toastApiError(result: ApiErrorLike, fallback?: string): void {
  const message = (() => {
    switch (result.code) {
      case API_ERROR_CODES.UNAUTHORIZED:
        return "Session expired. Please sign in again.";
      case API_ERROR_CODES.FORBIDDEN:
        return "You don't have permission to do that.";
      case API_ERROR_CODES.NOT_FOUND:
        return "Not found.";
      case API_ERROR_CODES.VALIDATION:
        return result.error || fallback || "Invalid input.";
      case API_ERROR_CODES.DUPLICATE: {
        const field = fieldFromDetails(result.details);
        return field
          ? `A record with this ${field} already exists.`
          : result.error || "That record already exists.";
      }
      case API_ERROR_CODES.CONFLICT:
        return result.error || "Action not allowed right now.";
      case API_ERROR_CODES.RATE_LIMITED:
        return "Too many requests. Please slow down.";
      case API_ERROR_CODES.INTERNAL:
        return "Something went wrong. Please try again.";
      default:
        return result.error || fallback || "Something went wrong.";
    }
  })();

  toast.error(message);
}
