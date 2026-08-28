"use client";

import Link from "next/link";
import { Ban, Send } from "lucide-react";

import { SendWindowIndicator } from "@/components/sends/send-window-indicator";
import { Button } from "@/components/ui/button";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { formatPhoneInternational } from "@/lib/phone-validation";
import {
  numberTypeAbbrev,
  type PhoneGroup,
} from "@/lib/sends/group-stages-by-phone";
import { STAGE_STATUS_META, type StageOperationalStatus } from "@/lib/stages/stage-status";
import { cn } from "@/lib/utils";

export type FleetStage = {
  stage_id: number;
  stage_number: number;
  label: string | null;
  campaign_id: number;
  campaign_name: string;
  tracking_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  schedule_missed_at: string | null;
  provider_phone_id: number | null;
  phone_number: string | null;
  number_type: string | null;
  provider_name: string | null;
  provider_color: string | null;
  provider_paused: boolean;
  campaign_paused: boolean;
  campaign_paused_reason: string | null;
  campaign_paused_at: string | null;
  operational_status: StageOperationalStatus;
  counts: {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    skippedDuplicate: number;
    skippedOptedOut: number;
  };
  window_opens_at: string | null;
  window_closes_at: string | null;
};

/** Display label for a sending number. Short codes (e.g. "621637") aren't
 *  parseable as phone numbers and fall through to their raw digits. */
export function formatSendingNumber(phone: string | null): string {
  if (!phone) return "No number assigned";
  return formatPhoneInternational(phone);
}

/**
 * One sending number's section: a header identifying the number, then its
 * stages in band order.
 *
 * The SAME component renders a section on the "All" tab and the body of a
 * single-number tab, so the two views cannot drift apart.
 */
export function PhoneStageGroup({
  group,
  canActivate,
  onPrepare,
}: {
  group: PhoneGroup<FleetStage>;
  canActivate: boolean;
  onPrepare: (stage: FleetStage) => void;
}) {
  const typeBadge = numberTypeAbbrev(group.number_type);

  return (
    <section className="space-y-2">
      {/* Number header — owns number/provider identity so the rows below don't
          have to repeat it on every line. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b pb-1.5">
        <span
          className="size-2 shrink-0 self-center rounded-full"
          style={{ backgroundColor: group.provider_color ?? "#64748B" }}
          aria-hidden
        />
        <h2 className="font-mono text-sm font-semibold">
          {formatSendingNumber(group.phone_number)}
        </h2>
        {group.provider_name ? (
          <span className="text-sm text-muted-foreground">
            ({group.provider_name})
          </span>
        ) : null}
        {typeBadge ? (
          <span className="rounded border px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
            {typeBadge}
          </span>
        ) : null}
        {group.provider_paused ? (
          <span className="inline-flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            <Ban className="size-2.5" aria-hidden /> provider paused
          </span>
        ) : null}

        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {group.stages.length} stage{group.stages.length === 1 ? "" : "s"}
          {group.totalPrepared > 0 ? (
            <>
              {" · "}
              {group.totalSent.toLocaleString()}/
              {group.totalPrepared.toLocaleString()} sent
            </>
          ) : null}
        </span>
      </div>

      <div className="space-y-2">
        {group.stages.map((s) => {
          const meta = STAGE_STATUS_META[s.operational_status];
          return (
            <div
              key={s.stage_id}
              className={cn(
                "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-l-4 bg-background p-3",
                meta.rowClass,
              )}
            >
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                  meta.badgeClass,
                )}
                title={meta.meaning}
              >
                <span className={cn("size-1.5 rounded-full", meta.dotClass)} />
                {meta.label}
              </span>

              <div className="min-w-0 flex-1">
                <Link
                  href={`/campaigns/${s.campaign_id}`}
                  className="text-sm font-medium hover:underline"
                >
                  {s.campaign_name}
                </Link>
                <span className="text-muted-foreground">
                  {" "}
                  · Stage {s.stage_number}
                  {s.label ? ` — ${s.label}` : ""}
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {s.campaign_paused ? (
                    <span
                      className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
                      title={s.campaign_paused_reason ?? "Campaign send paused"}
                    >
                      <Ban className="size-3" aria-hidden /> campaign paused
                    </span>
                  ) : null}
                  {s.scheduled_at ? (
                    <span>{formatCampaignDateTime(s.scheduled_at)}</span>
                  ) : null}
                  <SendWindowIndicator
                    opensAt={s.window_opens_at}
                    closesAt={s.window_closes_at}
                  />
                </div>
              </div>

              <div className="text-right text-xs tabular-nums text-muted-foreground">
                {s.counts.total > 0 ? (
                  <span>
                    {s.counts.sent}/{s.counts.total} sent
                    {s.counts.failed > 0 ? (
                      <span className="text-red-600">
                        {" "}
                        · {s.counts.failed} failed
                      </span>
                    ) : null}
                    {s.counts.pending > 0 ? (
                      <span>
                        {" "}
                        · {s.counts.pending.toLocaleString()} pending
                        {s.campaign_paused ? (
                          <span className="text-rose-600">
                            {" "}
                            · held by campaign pause
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    {s.counts.skippedOptedOut > 0 ? (
                      <span className="text-amber-600">
                        {" "}
                        · {s.counts.skippedOptedOut} STOP-cancel
                      </span>
                    ) : null}
                    {s.counts.skippedDuplicate > 0 ? (
                      <span> · {s.counts.skippedDuplicate} skipped (1h)</span>
                    ) : null}
                  </span>
                ) : (
                  <span>not prepared</span>
                )}
              </div>

              {/* One-click Prepare on Orange rows (same shared popup). */}
              {s.operational_status === "scheduled_unprepared" && canActivate ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => onPrepare(s)}
                >
                  <Send className="size-3" aria-hidden /> Prepare
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
