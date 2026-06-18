"use client";

import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Mirrors lib/links/click-report.ts. Source keyed off campaigns.link_mode.
interface TrackedStageRow {
  stage_id: number;
  stage_number: number;
  raw: number;
  clean: number;
  human: number;
  suspect: number;
  bot: number;
  prefetch: number;
  unknown: number;
  unscored: number;
  enriched: number;
}
interface ManualStageRow {
  stage_id: number;
  stage_number: number;
  click_count: number;
}
type ClickReport =
  | { source: "tracked"; stages: TrackedStageRow[] }
  | { source: "csv"; stages: ManualStageRow[] };

function sum<T>(rows: T[], pick: (r: T) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

export function ClickReportSection({ campaignId }: { campaignId: string | number }) {
  const { execute } = useApiCall<ClickReport>();
  const [report, setReport] = useState<ClickReport | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await execute(`/api/campaigns/${campaignId}/click-report`);
      if (active && r.ok) setReport(r.data);
    })();
    return () => {
      active = false;
    };
  }, [campaignId, execute]);

  if (!report) return null;

  const isTracked = report.source === "tracked";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Click attribution</h2>
        {/* Loud, unmissable source indicator — CSV vs tracked is never a footnote. */}
        {isTracked ? (
          <span className="inline-flex items-center rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
            Tracked · live per-recipient clicks
          </span>
        ) : (
          <span className="inline-flex items-center rounded-md bg-amber-500 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
            CSV · imported counts
          </span>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {report.stages.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No stages yet.</p>
          ) : isTracked ? (
            <TrackedTable stages={(report as { stages: TrackedStageRow[] }).stages} />
          ) : (
            <CsvTable stages={(report as { stages: ManualStageRow[] }).stages} />
          )}
        </CardContent>
      </Card>

      {isTracked ? (
        <>
          <EnrichmentHealth stages={(report as { stages: TrackedStageRow[] }).stages} />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Clean</span> excludes bot, prefetch, and
            suspected-bot clicks. Raw is every logged click. Unscored clicks
            haven&apos;t been through the scoring job yet.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Counts imported from the provider / CSV. Switch this campaign to
          tracked link mode for per-click bot filtering.
        </p>
      )}
    </div>
  );
}

// Human-visible enrichment canary. Of the clicks that have been scored, how
// many resolved an ASN (MaxMind enrichment). A low % — or a large pending
// backlog — is the unmissable signal that enrichment is degraded (MaxMind 429 /
// missing key), since degraded scoring runs deliberately leave clicks pending.
function EnrichmentHealth({ stages }: { stages: TrackedStageRow[] }) {
  const raw = sum(stages, (s) => s.raw);
  const unscored = sum(stages, (s) => s.unscored);
  const enriched = sum(stages, (s) => s.enriched);
  const scored = raw - unscored;
  if (raw === 0) return null;
  const pct = scored > 0 ? Math.round((enriched / scored) * 100) : null;
  const degraded = (pct != null && pct < 90) || (scored === 0 && unscored > 0);
  return (
    <p className={`text-xs ${degraded ? "font-medium text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}>
      ASN-enriched: {enriched} of {scored} scored {scored === 1 ? "click" : "clicks"}
      {pct != null ? ` (${pct}%)` : ""}
      {unscored > 0 ? ` · ${unscored} pending` : ""}
      {degraded ? " — low enrichment can mean MaxMind is degraded; check the score-pending cron logs." : "."}
    </p>
  );
}

function TrackedTable({ stages }: { stages: TrackedStageRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs uppercase text-muted-foreground">
        <tr>
          <th className="px-4 py-2 font-medium">Stage</th>
          <th className="px-4 py-2 text-right font-medium">Clean</th>
          <th className="px-4 py-2 text-right font-medium">Raw</th>
          <th className="px-4 py-2 text-right font-medium">Human</th>
          <th className="px-4 py-2 text-right font-medium">Suspect</th>
          <th className="px-4 py-2 text-right font-medium">Bot</th>
          <th className="px-4 py-2 text-right font-medium">Prefetch</th>
          <th className="px-4 py-2 text-right font-medium">Unscored</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((s) => (
          <tr key={s.stage_id} className="border-b last:border-0">
            <td className="px-4 py-2">Stage {s.stage_number}</td>
            <td className="px-4 py-2 text-right font-semibold text-emerald-700 dark:text-emerald-400">
              {s.clean}
            </td>
            <td className="px-4 py-2 text-right">{s.raw}</td>
            <td className="px-4 py-2 text-right">{s.human}</td>
            <td className="px-4 py-2 text-right">{s.suspect}</td>
            <td className="px-4 py-2 text-right">{s.bot}</td>
            <td className="px-4 py-2 text-right">{s.prefetch}</td>
            <td className="px-4 py-2 text-right text-muted-foreground">
              {s.unscored}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t font-medium">
        <tr>
          <td className="px-4 py-2">Total</td>
          <td className="px-4 py-2 text-right font-semibold text-emerald-700 dark:text-emerald-400">
            {sum(stages, (s) => s.clean)}
          </td>
          <td className="px-4 py-2 text-right">{sum(stages, (s) => s.raw)}</td>
          <td className="px-4 py-2 text-right">{sum(stages, (s) => s.human)}</td>
          <td className="px-4 py-2 text-right">{sum(stages, (s) => s.suspect)}</td>
          <td className="px-4 py-2 text-right">{sum(stages, (s) => s.bot)}</td>
          <td className="px-4 py-2 text-right">{sum(stages, (s) => s.prefetch)}</td>
          <td className="px-4 py-2 text-right text-muted-foreground">
            {sum(stages, (s) => s.unscored)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function CsvTable({ stages }: { stages: ManualStageRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs uppercase text-muted-foreground">
        <tr>
          <th className="px-4 py-2 font-medium">Stage</th>
          <th className="px-4 py-2 text-right font-medium">Clicks</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((s) => (
          <tr key={s.stage_id} className="border-b last:border-0">
            <td className="px-4 py-2">Stage {s.stage_number}</td>
            <td className="px-4 py-2 text-right">{s.click_count}</td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t font-medium">
        <tr>
          <td className="px-4 py-2">Total</td>
          <td className="px-4 py-2 text-right">{sum(stages, (s) => s.click_count)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
