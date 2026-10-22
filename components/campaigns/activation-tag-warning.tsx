"use client";

// P4 (spec R1, point 1): on draft → active, list every stage whose
// personalization would skip more than half its audience. A warning only — the
// dialog's confirm button never waits on it. Rendered behind the message-formats
// UI flag by the caller.
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { SKIP_WARN_PCT, tagSkipShare, usesContactTag } from "@/lib/messages/skip-share";

type StageRow = {
  id: number;
  stage_number: number | null;
  label: string | null;
  creative_id: number | null;
  creative: { text: string | null } | null;
  custom_text: string | null;
  message_format_id: number | null;
  stop_text: string | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  short_url: string | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
};

export function ActivationTagWarning({ campaignId }: { campaignId: number }) {
  const [over, setOver] = useState<{ name: string; pct: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/stages`);
      if (!res.ok) return;
      const stages = ((await res.json()).data ?? []) as StageRow[];
      const found: { name: string; pct: number }[] = [];
      for (const s of stages.filter((st) => usesContactTag(st.creative?.text, st.custom_text))) {
        const p = await fetch(`/api/campaigns/${campaignId}/stages/audience-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            include_no_status: s.include_no_status,
            include_clickers: s.include_clickers,
            exclude_clickers: s.exclude_clickers,
            split_index: s.split_index,
            split_total: s.split_total,
            creative_id: s.creative_id,
            message_format_id: s.message_format_id,
            custom_text: s.custom_text,
            stop_text: s.stop_text,
            sms_provider_id: s.sms_provider_id,
            provider_phone_id: s.provider_phone_id,
            short_url: s.short_url,
          }),
        });
        if (!p.ok) continue;
        const e = (await p.json()).eligibility as {
          will_send: number | null;
          excluded_lifecycle?: Record<string, number>;
        };
        const share = tagSkipShare({
          willSend: e.will_send,
          missingData: e.excluded_lifecycle?.missing_tag_data ?? 0,
          segmentLimit: e.excluded_lifecycle?.segment_limit ?? 0,
        });
        if (share && share.pct > SKIP_WARN_PCT) {
          found.push({ name: s.label ?? `Stage ${s.stage_number ?? s.id}`, pct: share.pct });
        }
      }
      if (!cancelled) setOver(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (over.length === 0) return null;
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Personalized stages would skip more than {SKIP_WARN_PCT}% of their audience (missing data or too long):{" "}
        {over.map((o) => `${o.name} — ${o.pct}%`).join(" · ")}. You can still activate.
      </span>
    </div>
  );
}
