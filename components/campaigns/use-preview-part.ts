"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useApiCall } from "@/lib/hooks/use-api-call";

// One half of the campaign audience preview (Task 2 T5), fetched with the
// hotfix's rules (2026-10-01), now per part:
//   * at most ONE request for this part in flight;
//   * a body change while it runs marks it stale: its answer is dropped and
//     ONE new request runs with the latest body (an abort would close the HTTP
//     request but never cancel the Postgres query behind it);
//   * a timeout, server error, gateway timeout or dropped connection is retried
//     automatically once; "still running" (409 preview_busy, the server's
//     per-user-per-part lock) is waited out and retried;
//   * retry() re-runs it on demand.
// `body` is the exact JSON to POST, or null when there is nothing to preview.
// The answer is returned WITH the body that produced it, so the caller can
// tell which inputs a result describes.

export type PreviewPartAnswer = {
  body: string;
  part: "base" | "audience" | "full";
  data: unknown;
};

export function usePreviewPart(body: string | null, debounceMs = 500) {
  const api = useApiCall<{ part: PreviewPartAnswer["part"]; data: unknown }>();
  const [answer, setAnswer] = useState<PreviewPartAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bodyRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const staleRef = useRef(false);
  const unmountedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Self-referencing through a ref (timers call the latest run); the ref is
  // updated in an effect, never during render.
  const runRef = useRef<(attempt: number) => Promise<void>>(async () => {});
  const run = useCallback(async (attempt: number): Promise<void> => {
    const sent = bodyRef.current;
    if (!sent) {
      setLoading(false);
      return;
    }
    if (inFlightRef.current) {
      staleRef.current = true;
      return;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    inFlightRef.current = true;
    staleRef.current = false;
    setLoading(true);
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const result = await api.execute("/api/campaigns/audience-preview", {
      method: "POST",
      // Aborted only when the form unmounts — never because an input changed.
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: sent,
    });
    inFlightRef.current = false;
    abortRef.current = null;
    if (unmountedRef.current) return;
    if (staleRef.current || sent !== bodyRef.current) {
      void runRef.current(0);
      return;
    }
    if (result.ok) {
      setLoading(false);
      setAnswer({ body: sent, part: result.data.part, data: result.data.data });
      setError(null);
      return;
    }
    const reason = (result.details as { reason?: string } | undefined)?.reason;
    const busy = result.status === 409 && reason === "preview_busy";
    const transient =
      result.status === 0 || result.status >= 500 || reason === "preview_timeout";
    if ((busy && attempt < 12) || (transient && attempt < 1)) {
      retryTimerRef.current = setTimeout(
        () => {
          retryTimerRef.current = null;
          void runRef.current(attempt + 1);
        },
        busy ? 10_000 : 2_000,
      );
      return;
    }
    setLoading(false);
    setError(result.error);
  }, [api.execute]);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    bodyRef.current = body;
    // A pending automatic retry is for a body that no longer applies.
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // No body: nothing to fetch. The hook reports nothing for it (below)
    // instead of clearing state inside this effect.
    if (!body) return;
    const t = setTimeout(() => void runRef.current(0), debounceMs);
    return () => clearTimeout(t);
    // api.execute is stable (useCallback with no deps); listed for the lint.
  }, [body, debounceMs, api.execute]);

  useEffect(() => {
    // Reset on (re)mount: React StrictMode mounts, unmounts and remounts in
    // dev, and a flag left true by the simulated unmount dropped every result.
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  return {
    answer: body ? answer : null,
    loading: body ? loading : false,
    error: body ? error : null,
    retry: () => void runRef.current(0),
  };
}
