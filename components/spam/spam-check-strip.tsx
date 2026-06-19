"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  RotateCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

// =============== Types ===============

export type SpamLabel = "ham" | "suspicious" | "spam";
export type SpamVerdict = "spam" | "not_spam";

export interface SpamCheckResult {
  score: number;
  label: SpamLabel;
  verdict: SpamVerdict;
  cached: boolean;
  latencyMs: number;
  textHash: string;
  error: string | null;
}

interface ScoreResponse extends SpamCheckResult {
  confidence: number | null;
  provider: string;
  modelVersion: string | null;
}

export interface SpamCheckStripProps {
  text: string;
  // Optional: if the parent already knows a cached score (e.g. from a list
  // endpoint that joined spam_scores), prefill the strip with it so we
  // don't show "—" for already-known creatives.
  initialResult?: SpamCheckResult | null;
  // Disable the button (e.g. while form is submitting).
  disabled?: boolean;
  className?: string;
}

const LABEL_BADGE: Record<SpamLabel, string> = {
  ham: "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  suspicious:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  spam: "border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
};

const LABEL_TEXT: Record<SpamLabel, string> = {
  ham: "Ham",
  suspicious: "Suspicious",
  spam: "Spam",
};

// Button-triggered spam check. Shows a compact horizontal strip below the
// caller's textarea. Re-checking the same text is free (server-side cache);
// the explicit "Force re-score" path isn't exposed here — operators who
// need that can use the API directly. Errors render inline (don't crash
// the form). The score result becomes stale when `text` changes: we clear
// it on any text edit so the user knows they need to re-check.
export function SpamCheckStrip({
  text,
  initialResult,
  disabled,
  className,
}: SpamCheckStripProps) {
  const scoreApi = useApiCall<ScoreResponse>();
  const [result, setResult] = useState<SpamCheckResult | null>(
    initialResult ?? null,
  );
  const [staleText, setStaleText] = useState<string>(text);

  // If the parent passes a different initialResult later (e.g. on edit-form
  // open), reflect it. Compare by hash for cheap equality.
  useEffect(() => {
    if (initialResult && initialResult.textHash !== result?.textHash) {
      setResult(initialResult);
      setStaleText(text);
    }
    // We don't react to `text` here — that's handled in the next effect.
  }, [initialResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark the existing result stale when text changes (so the user knows
  // to re-check). We don't auto-clear so the prior score remains visible
  // for context, just dimmed.
  useEffect(() => {
    if (text !== staleText) {
      // result stays but becomes "stale". staleText tracks the text at
      // the moment of the last check.
    }
  }, [text, staleText]);

  const isStale = result !== null && text !== staleText;

  const handleCheck = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const r = await scoreApi.execute("/api/spam/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok) {
      setResult({
        score: r.data.score,
        label: r.data.label,
        verdict: r.data.verdict,
        cached: r.data.cached,
        latencyMs: r.data.latencyMs,
        textHash: r.data.textHash,
        error: r.data.error,
      });
      setStaleText(text);
    } else {
      toastApiError(r, "Couldn't score message");
    }
  }, [text, scoreApi]);

  const buttonDisabled =
    disabled || scoreApi.isLoading || text.trim().length === 0;

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-sm", className)}>
      <Button
        type="button"
        size="sm"
        variant={result ? "outline" : "secondary"}
        onClick={handleCheck}
        disabled={buttonDisabled}
      >
        {scoreApi.isLoading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : result ? (
          <RotateCw className="size-3.5" aria-hidden />
        ) : (
          <ShieldCheck className="size-4" aria-hidden />
        )}
        {scoreApi.isLoading
          ? "Checking…"
          : result
            ? isStale
              ? "Re-check"
              : "Re-check"
            : "Check spam"}
      </Button>

      {result ? (
        <ResultDisplay result={result} stale={isStale} />
      ) : !scoreApi.isLoading ? (
        <span className="text-xs text-muted-foreground">Not checked yet</span>
      ) : null}
    </div>
  );
}

function ResultDisplay({
  result,
  stale,
}: {
  result: SpamCheckResult;
  stale: boolean;
}) {
  // A scoring failure (timeout / classifier unreachable) comes back as a
  // fallback score of 50 with `error` set. Don't dress it up as a real
  // verdict — show it as a failure the operator should re-check, not as
  // "50 / NOT SPAM".
  if (result.error) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300",
          stale && "opacity-50",
        )}
        title={result.error}
      >
        <XCircle className="size-3.5" aria-hidden />
        Couldn&apos;t score — try Re-check
      </span>
    );
  }

  const isSpam = result.verdict === "spam";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        stale && "opacity-50",
      )}
      title={stale ? "Text has changed since last check" : undefined}
    >
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          result.score <= 30 && "text-green-700 dark:text-green-300",
          result.score > 30 &&
            result.score <= 70 &&
            "text-amber-700 dark:text-amber-300",
          result.score > 70 && "text-red-700 dark:text-red-300",
        )}
      >
        {result.score}
        <span className="text-xs text-muted-foreground">/100</span>
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
          isSpam
            ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            : "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
        )}
      >
        {isSpam ? (
          <XCircle className="size-3" aria-hidden />
        ) : (
          <CheckCircle2 className="size-3" aria-hidden />
        )}
        {isSpam ? "SPAM" : "NOT SPAM"}
      </span>
      <Badge className={cn("text-xs", LABEL_BADGE[result.label])}>
        {LABEL_TEXT[result.label]}
      </Badge>
      {result.cached ? (
        <span className="text-xs text-muted-foreground">cached</span>
      ) : null}
      {stale ? (
        <span className="text-xs italic text-amber-700 dark:text-amber-300">
          text changed
        </span>
      ) : null}
    </div>
  );
}

// Helper for callers that have a raw score + label/verdict and want to
// construct an `initialResult` from list-endpoint data.
export function buildInitialResult(opts: {
  score: number;
  label: SpamLabel;
  verdict: SpamVerdict;
  textHash: string;
  cached?: boolean;
}): SpamCheckResult {
  return {
    score: opts.score,
    label: opts.label,
    verdict: opts.verdict,
    textHash: opts.textHash,
    cached: opts.cached ?? true,
    latencyMs: 0,
    error: null,
  };
}
