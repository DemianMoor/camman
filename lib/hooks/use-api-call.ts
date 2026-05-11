"use client";

import { useCallback, useState } from "react";

// Result of an API call. The discriminated `ok` flag lets callers pattern-match
// without try/catch and without depending on response status codes directly.
export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      code?: string;
      details?: unknown;
      status: number;
    };

export interface UseApiCallReturn<T> {
  isLoading: boolean;
  execute: (input: RequestInfo, init?: RequestInit) => Promise<ApiResult<T>>;
}

// Minimal fetch wrapper. Decouples expected errors (4xx, handled by the UI)
// from unexpected errors (5xx, network failures — worth logging). Does not
// show toasts, redirect, or trigger reloads — callers compose those behaviors.
//
// IMPORTANT: `execute` has a stable identity across renders (it's wrapped in
// useCallback with no deps). Effects may safely include `execute` in their
// dependency arrays.
//
// The returned object itself ({ isLoading, execute }) is a fresh reference on
// every render — do NOT include the whole hook return in an effect's deps. If
// you write `useEffect(() => …, [api])`, every render will re-create `api` and
// the effect will refire endlessly. Always depend on `.execute` directly:
//
//   const api = useApiCall<T>();
//   useEffect(() => { void api.execute(…); }, [api.execute, /* other deps */]);
export function useApiCall<T = unknown>(): UseApiCallReturn<T> {
  const [isLoading, setIsLoading] = useState(false);

  const execute = useCallback(
    async (input: RequestInfo, init?: RequestInit): Promise<ApiResult<T>> => {
      setIsLoading(true);
      try {
        let response: Response;
        try {
          response = await fetch(input, init);
        } catch (e) {
          // Network failure / fetch threw. Worth logging — not an expected error.
          // eslint-disable-next-line no-console
          console.error("API call: network error", e);
          return {
            ok: false,
            error: "Network error. Please check your connection.",
            code: "internal",
            status: 0,
          };
        }

        // Parse body lazily so a 204 / non-JSON success still works.
        let body: unknown = null;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          try {
            body = await response.json();
          } catch {
            body = null;
          }
        }

        if (response.ok) {
          return { ok: true, data: body as T };
        }

        // Non-2xx: extract structured error fields if present.
        const errBody = (body ?? {}) as {
          error?: unknown;
          code?: unknown;
          details?: unknown;
        };
        const errorMsg =
          typeof errBody.error === "string"
            ? errBody.error
            : "Unexpected response from server";
        const code =
          typeof errBody.code === "string" ? errBody.code : undefined;

        if (response.status >= 500) {
          // Server errors are unexpected — log them so they're visible to devs.
          // eslint-disable-next-line no-console
          console.error(
            `API call: ${response.status} ${response.statusText}`,
            errBody,
          );
        }

        return {
          ok: false,
          error: errorMsg,
          code: code ?? (response.status >= 500 ? "internal" : undefined),
          details: errBody.details,
          status: response.status,
        };
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { isLoading, execute };
}
