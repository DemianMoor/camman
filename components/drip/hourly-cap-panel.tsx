"use client";

import { Badge } from "@/components/ui/badge";
import type { FunnelHourly } from "@/lib/drip/funnel";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";

// Hourly send cap panel (0209). Queue size + oldest age are the owner's v1
// substitute for a queue age limit (R2). Blocked drops are flagged: they mean a
// system fault (gate/mint), not stale leads (R4).
export function HourlyCapPanel({ hourly }: { hourly: FunnelHourly }) {
  const fmtAge = (m: number | null) =>
    m == null ? "—" : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium tracking-wide uppercase">Hourly cap</h4>
      <p className="text-muted-foreground mb-3 text-xs">
        {hourly.cap.toLocaleString()} first sends per hour ·{" "}
        {hourly.carry ? "unsent leads carry to the next hour" : "leads that miss their hour are dropped"} ·
        hour from {formatCampaignDateTime(hourly.hour_start)}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div><dt className="text-muted-foreground text-xs">Sent this hour</dt><dd className="tabular-nums">{hourly.sent_this_hour.toLocaleString()} / {hourly.cap.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Due this hour</dt><dd className="tabular-nums">{hourly.assigned_unsent_this_hour.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Queued from earlier hours</dt><dd className="tabular-nums">{hourly.queued_from_earlier_hours.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Waiting for a window / room</dt><dd className="tabular-nums">{hourly.waiting.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Oldest unsent</dt><dd className="tabular-nums">{fmtAge(hourly.oldest_unsent_age_min)}</dd></div>
      </dl>
      {hourly.drops_by_day.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border text-sm">
          <li className="text-muted-foreground grid grid-cols-4 gap-3 px-3 py-1 text-xs">
            <span>Day (ET)</span><span className="text-right">Cap full</span>
            <span className="text-right">Window/daily</span><span className="text-right">Blocked</span>
          </li>
          {hourly.drops_by_day.map((d) => (
            <li key={d.day} className="grid grid-cols-4 gap-3 px-3 py-1">
              <span>{d.day}</span>
              <span className="text-right tabular-nums">{d.cap.toLocaleString()}</span>
              <span className="text-right tabular-nums">{d.closed.toLocaleString()}</span>
              <span className="text-right tabular-nums">
                {d.blocked > 0 ? <Badge variant="destructive">{d.blocked.toLocaleString()}</Badge> : 0}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
