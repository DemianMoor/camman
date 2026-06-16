"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleSlash } from "lucide-react";

import { cn } from "@/lib/utils";
import { useApiCall } from "@/lib/hooks/use-api-call";

// WS4 §B2 — live readiness checklist surfaced on the stage BEFORE Prepare (not
// only inside the confirm popup), so an operator sees green/red at a glance
// while configuring. Reads the same WS2 preflight data the popup uses. Spam
// score is advisory and NEVER a gate (locked decision: creative selected =
// approved).
type PreflightResult = {
  ok: boolean;
  recipient_count: number;
  checks: { key: string; ok: boolean; label: string }[];
};

export function StageReadinessChecklist({
  campaignId,
  stageId,
  refreshKey,
}: {
  campaignId: number;
  stageId: number;
  /** Bump to re-run preflight (e.g. after editing the stage). */
  refreshKey?: number;
}) {
  const api = useApiCall<PreflightResult>();
  const { execute } = api;
  const [result, setResult] = useState<PreflightResult | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await execute(
        `/api/campaigns/${campaignId}/stages/${stageId}/send/preflight`,
        { method: "POST" },
      );
      if (active && r.ok) setResult(r.data);
    })();
    return () => {
      active = false;
    };
  }, [campaignId, stageId, refreshKey, execute]);

  if (!result) return null;

  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          Readiness
        </span>
        <span
          className={cn(
            "text-xs font-medium",
            result.ok
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-destructive",
          )}
        >
          {result.ok ? "Ready to prepare" : "Not ready"}
        </span>
      </div>
      <ul className="space-y-1 text-xs">
        {result.checks.map((c) => (
          <li
            key={c.key}
            className={cn(
              "flex items-center gap-1.5",
              c.ok ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {c.ok ? (
              <CheckCircle2
                className="size-3.5 shrink-0 text-emerald-600"
                aria-hidden
              />
            ) : (
              <CircleSlash className="size-3.5 shrink-0" aria-hidden />
            )}
            {c.label}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Spam score is advisory — it never blocks sending.
      </p>
    </div>
  );
}
