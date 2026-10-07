"use client";

import { Badge } from "@/components/ui/badge";
import type { DripFunnel } from "@/lib/drip/funnel";

// The journey funnel for one drip campaign (Drip Phase 7, ruling R4).
//
// ⚠️ THE TWO BLOCKS ARE NOT TWO VIEWS OF THE SAME NUMBERS, and the copy says so
// on the page rather than leaving the reader to assume. Progression is NESTED
// (a converted journey is also counted as clicked, so the rows do not sum to the
// total); outcomes are DISJOINT (they do sum to it). A reader who takes the
// first for the second concludes the funnel loses nobody.
//
// ⚠️ "Completed — unengaged" IS ITS OWN ROW, never folded into "completed". It
// is the campaign's bad news, and merging it with a finished sequence is exactly
// how bad news disappears.
//
// ⚠️ THE TODAY COLUMN IS EVENTS, NOT A COHORT — and shows no percentages. A
// click today may belong to a journey routed yesterday, so "% of today's routed"
// would mislead. Live states are a snapshot, so their number is shown ONCE,
// spanning both columns, rather than duplicated as if it happened today.

const TODAY_HINT =
  "Events during the current ET day, any journey — a click today may belong to a lead routed earlier.";

function ColumnHeads({ todayNote, hint }: { todayNote: string; hint: string }) {
  return (
    <>
      <span className="text-muted-foreground text-right text-xs">Total</span>
      <span className="text-muted-foreground text-right text-xs" title={hint}>
        Today <span className="block text-[10px] leading-tight">{todayNote}</span>
      </span>
    </>
  );
}

function Bar({ value, of }: { value: number; of: number }) {
  const w = of > 0 ? Math.round((value / of) * 100) : 0;
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div className="bg-primary h-full rounded-full" style={{ width: `${w}%` }} />
    </div>
  );
}

export function JourneyFunnel({ funnel }: { funnel: DripFunnel }) {
  const p = funnel.progression;
  const t = funnel.today;
  const steps: [string, number, number][] = [
    ["Routed", p.routed, t.routed],
    ["Sent", p.sent, t.sent],
    ["Clicked", p.clicked, t.clicked],
    ["Reached offer", p.reached_offer, t.reached_offer],
    ["Converted", p.converted, t.converted],
  ];

  if (p.routed === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No journeys yet — the funnel fills in once leads are routed.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h4 className="mb-1 text-xs font-medium tracking-wide uppercase">How far they got</h4>
        <p className="text-muted-foreground mb-3 text-xs">
          Cumulative — every converted journey is also counted as clicked, so these
          do not add up to the total. Reach and conversion are dated by when we
          detected them.
        </p>
        <div className="space-y-2">
          <div className="grid grid-cols-[7rem_1fr_5.5rem_4.5rem] items-end gap-3 sm:grid-cols-[9rem_1fr_5.5rem_5.5rem]">
            <span />
            <span />
            <ColumnHeads todayNote="events today, any journey" hint={TODAY_HINT} />
          </div>
          {steps.map(([label, n, today]) => (
            <div
              key={label}
              className="grid grid-cols-[7rem_1fr_5.5rem_4.5rem] items-center gap-3 sm:grid-cols-[9rem_1fr_5.5rem_5.5rem]"
            >
              <span className="text-sm">{label}</span>
              <Bar value={n} of={p.routed} />
              <span className="text-right text-sm tabular-nums">
                {n.toLocaleString()}
                <span className="text-muted-foreground ml-1 text-xs">
                  {p.routed > 0 ? `${((n / p.routed) * 100).toFixed(0)}%` : ""}
                </span>
              </span>
              <span className="text-right text-sm tabular-nums" title={TODAY_HINT}>
                {today.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-medium tracking-wide uppercase">How they ended</h4>
        <p className="text-muted-foreground mb-3 text-xs">
          One row per journey — the totals add up to {p.routed.toLocaleString()}.
          Today counts journeys that ended today; live rows are the current count.
        </p>
        <ul className="divide-y rounded-md border text-sm">
          <li className="grid grid-cols-[1fr_5.5rem_4.5rem] items-end gap-3 px-3 py-2 sm:grid-cols-[1fr_5.5rem_5.5rem]">
            <span />
            <ColumnHeads
              todayNote="ended today (ET)"
              hint="Journeys that entered this ending during the current ET day."
            />
          </li>
          {funnel.outcomes.map((o) => (
            <li
              key={`${o.state}|${o.close_reason ?? ""}`}
              className="grid grid-cols-[1fr_5.5rem_4.5rem] items-center gap-3 px-3 py-2 sm:grid-cols-[1fr_5.5rem_5.5rem]"
            >
              <span className="flex items-center gap-2">
                {o.label}
                {o.close_reason === "unengaged" && (
                  <Badge variant="outline" className="text-[10px]">
                    no engagement
                  </Badge>
                )}
              </span>
              {o.today_count == null ? (
                <span
                  className="col-span-2 text-center tabular-nums"
                  title="A live journey has not ended — this is the current count, the same in both columns."
                >
                  {o.count.toLocaleString()}
                  <span className="text-muted-foreground ml-1 text-xs">now</span>
                </span>
              ) : (
                <>
                  <span className="text-right tabular-nums">{o.count.toLocaleString()}</span>
                  <span className="text-right tabular-nums">
                    {o.today_count.toLocaleString()}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      {funnel.stages.length > 0 && (
        <div>
          <h4 className="mb-3 text-xs font-medium tracking-wide uppercase">Per stage</h4>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="p-2 text-left">Stage</th>
                  <th className="p-2 text-right">Sent</th>
                  <th className="p-2 text-right">Clicks</th>
                  <th className="p-2 text-right">Opt-outs</th>
                </tr>
              </thead>
              <tbody>
                {funnel.stages.map((s) => (
                  <tr key={s.stage_id} className="border-t">
                    <td className="p-2">{s.label}</td>
                    <td className="p-2 text-right tabular-nums">{s.sent.toLocaleString()}</td>
                    <td className="p-2 text-right tabular-nums">{s.clicks.toLocaleString()}</td>
                    <td className="p-2 text-right tabular-nums">{s.opt_outs.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
