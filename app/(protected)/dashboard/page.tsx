"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  ArrowUpRight,
  DollarSign,
  MessageSquare,
  TrendingUp,
  UserMinus,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

// =============== Types ===============

type StatsResponse = {
  range: { from: string; to: string };
  campaigns: {
    active: number;
    paused: number;
    draft: number;
    completed_in_range: number;
  };
  stages: {
    sent_in_range: number;
    success_in_range: number;
    failed_in_range: number;
    cancelled_in_range: number;
  };
  totals: {
    sms_sent: number;
    delivered: number;
    opt_outs_added: number;
    clickers_added: number;
    total_spend: number;
  };
};

type DailyResponse = {
  days: Array<{
    date: string;
    campaigns_created: number;
    stages_sent: number;
    sms_count: number;
    cost: number;
    opt_outs: number;
    clickers: number;
  }>;
};

type ActiveCampaign = {
  id: number;
  name: string;
  slug: string;
  human_id: string | null;
  status: "active" | "paused";
  brand: { id: number; name: string; color: string | null } | null;
  offer: { id: number; name: string; color: string | null } | null;
  audience_snapshot_count: number;
  stage_count_total: number;
  stage_count_by_status: Record<string, number>;
  last_stage_sent_at: string | null;
  created_at: string;
};

type ActiveCampaignsResponse = { campaigns: ActiveCampaign[] };

type RecentStage = {
  id: number;
  stage_number: number;
  label: string | null;
  status: string;
  sent_at: string;
  sms_count: number;
  delivered_count: number;
  opt_out_count: number;
  click_count: number;
  total_cost: number;
  campaign: { id: number; name: string; slug: string; status: string };
  creative: { id: number; slug: string; text: string } | null;
  brand: { id: number; name: string; color: string | null } | null;
};

type RecentStagesResponse = { stages: RecentStage[] };

type BaseStatsResponse = {
  total: number;
  archived: number;
  opt_out_count: number;
  opt_in_count: number;
  clicker_count: number;
};

// =============== Helpers ===============

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  pending: "bg-amber-100 text-amber-700 border-amber-200",
  sent: "bg-blue-100 text-blue-700 border-blue-200",
  success: "bg-emerald-100 text-emerald-700 border-emerald-200",
  cancelled: "bg-zinc-100 text-zinc-700 border-zinc-200",
  failed: "bg-rose-100 text-rose-700 border-rose-200",
  active: "bg-emerald-100 text-emerald-700 border-emerald-200",
  paused: "bg-amber-100 text-amber-700 border-amber-200",
};

function shortDay(date: string): string {
  // YYYY-MM-DD → "Mon May 6"
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sevenDaysAgoIso(): string {
  const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// =============== Page ===============

export default function DashboardPage() {
  const statsApi = useApiCall<StatsResponse>();
  const dailyApi = useApiCall<DailyResponse>();
  const activeApi = useApiCall<ActiveCampaignsResponse>();
  const stagesApi = useApiCall<RecentStagesResponse>();
  const baseApi = useApiCall<BaseStatsResponse>();

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [daily, setDaily] = useState<DailyResponse | null>(null);
  const [activeCampaigns, setActiveCampaigns] = useState<ActiveCampaign[]>([]);
  const [recentStages, setRecentStages] = useState<RecentStage[]>([]);
  const [baseStats, setBaseStats] = useState<BaseStatsResponse | null>(null);

  const refetch = useCallback(async () => {
    // Parallel fetch of all 5 endpoints. Independent — no waterfall.
    const [s, d, ac, rs, bs] = await Promise.all([
      statsApi.execute("/api/dashboard/stats"),
      dailyApi.execute("/api/dashboard/daily-activity?days=7"),
      activeApi.execute("/api/dashboard/active-campaigns"),
      stagesApi.execute("/api/dashboard/recent-stages"),
      baseApi.execute("/api/contacts/base-stats"),
    ]);
    if (s.ok) setStats(s.data);
    if (d.ok) setDaily(d.data);
    if (ac.ok) setActiveCampaigns(ac.data.campaigns);
    if (rs.ok) setRecentStages(rs.data.stages);
    if (bs.ok) setBaseStats(bs.data);
  }, [
    statsApi.execute,
    dailyApi.execute,
    activeApi.execute,
    stagesApi.execute,
    baseApi.execute,
  ]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // =============== Active-campaigns table columns ===============

  const activeColumns: ColumnDef<ActiveCampaign>[] = [
    {
      id: "name",
      header: "Campaign",
      enableSorting: false,
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium">{c.name}</div>
            <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              {c.human_id ? (
                <Badge variant="outline" className="text-[10px]">
                  {c.human_id}
                </Badge>
              ) : null}
              <span className="truncate">{c.slug}</span>
            </div>
          </div>
        );
      },
    },
    {
      id: "brand",
      header: "Brand",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.brand ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: row.original.brand.color ?? "#64748B" }}
            />
            <span className="text-sm">{row.original.brand.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "offer",
      header: "Offer",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.offer ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: row.original.offer.color ?? "#64748B" }}
            />
            <span className="text-sm">{row.original.offer.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "audience",
      header: "Audience",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.audience_snapshot_count > 0 ? (
          <span className="font-mono text-sm tabular-nums">
            {row.original.audience_snapshot_count.toLocaleString()}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "stages",
      header: "Stages",
      enableSorting: false,
      cell: ({ row }) => {
        const c = row.original;
        const sent =
          (c.stage_count_by_status.sent ?? 0) +
          (c.stage_count_by_status.success ?? 0);
        return (
          <span
            className="font-mono text-sm tabular-nums"
            title={`draft: ${c.stage_count_by_status.draft ?? 0} · pending: ${c.stage_count_by_status.pending ?? 0} · sent: ${c.stage_count_by_status.sent ?? 0} · success: ${c.stage_count_by_status.success ?? 0} · cancelled: ${c.stage_count_by_status.cancelled ?? 0} · failed: ${c.stage_count_by_status.failed ?? 0}`}
          >
            {sent} of {c.stage_count_total}
          </span>
        );
      },
    },
    {
      id: "last_activity",
      header: "Last activity",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.last_stage_sent_at ? (
          <span
            className="text-sm text-muted-foreground"
            title={formatCampaignDateTime(row.original.last_stage_sent_at)}
          >
            {formatDistanceToNow(new Date(row.original.last_stage_sent_at), {
              addSuffix: true,
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => (
        <Badge
          className={cn("capitalize", STATUS_COLOR[row.original.status])}
        >
          {row.original.status}
        </Badge>
      ),
    },
  ];

  // =============== Recent-stages table columns ===============

  const stageColumns: ColumnDef<RecentStage>[] = [
    {
      id: "n",
      header: "#",
      enableSorting: false,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono text-[10px]">
          {row.original.stage_number}
        </Badge>
      ),
    },
    {
      id: "campaign",
      header: "Campaign",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <Link
            href={`/campaigns/${row.original.campaign.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block truncate font-medium hover:underline"
          >
            {row.original.campaign.name}
          </Link>
          <div className="font-mono text-xs text-muted-foreground truncate">
            {row.original.campaign.slug}
          </div>
        </div>
      ),
    },
    {
      id: "creative",
      header: "Creative",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.creative ? (
          <div className="min-w-0">
            <div className="font-mono text-xs">{row.original.creative.slug}</div>
            <div className="line-clamp-1 text-xs text-muted-foreground">
              {row.original.creative.text}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "brand",
      header: "Brand",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.brand ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: row.original.brand.color ?? "#64748B" }}
            />
            <span className="text-sm">{row.original.brand.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "sent",
      header: "Sent",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatCampaignDateTime(row.original.sent_at)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => (
        <Badge
          className={cn("capitalize", STATUS_COLOR[row.original.status])}
        >
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: "sms",
      header: "SMS",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.sms_count > 0 ? (
          <span className="font-mono text-sm tabular-nums">
            {row.original.sms_count.toLocaleString()}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "metrics",
      header: "D / OO / CL",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs tabular-nums">
          {row.original.delivered_count} / {row.original.opt_out_count} /{" "}
          {row.original.click_count}
        </span>
      ),
    },
    {
      id: "cost",
      header: "Cost",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.total_cost > 0 ? (
          <span className="font-mono text-sm tabular-nums">
            {fmtUsd(row.original.total_cost)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  // =============== Tiles ===============

  const fromIso = sevenDaysAgoIso();
  const totalActiveOrPaused =
    (stats?.campaigns.active ?? 0) + (stats?.campaigns.paused ?? 0);
  const chartHasData =
    daily?.days.some((d) => d.stages_sent > 0 || d.sms_count > 0) ?? false;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          What&apos;s happening across your campaigns right now.
        </p>
      </header>

      {/* ============ Top stat tiles ============ */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          icon={<Activity className="size-4" aria-hidden />}
          label="Active campaigns"
          value={totalActiveOrPaused}
          sublabel={
            stats?.campaigns.paused
              ? `${stats.campaigns.paused} paused`
              : "running"
          }
          href="/campaigns?status=active,paused"
          loading={statsApi.isLoading && stats === null}
        />
        <StatTile
          icon={<MessageSquare className="size-4" aria-hidden />}
          label="SMS this week"
          value={stats?.totals.sms_sent ?? 0}
          sublabel={`${(stats?.totals.delivered ?? 0).toLocaleString()} delivered`}
          href="/campaigns?status=active,paused"
          loading={statsApi.isLoading && stats === null}
        />
        <StatTile
          icon={<DollarSign className="size-4" aria-hidden />}
          label="Spend this week"
          value={fmtUsd(stats?.totals.total_spend ?? 0)}
          sublabel={
            totalActiveOrPaused > 0
              ? `${fmtUsd((stats?.totals.total_spend ?? 0) / totalActiveOrPaused)} per active campaign`
              : "no active campaigns"
          }
          href="/campaigns"
          loading={statsApi.isLoading && stats === null}
          isString
        />
        <StatTile
          icon={<UserMinus className="size-4" aria-hidden />}
          label="Opt-outs this week"
          value={stats?.totals.opt_outs_added ?? 0}
          sublabel={`${(baseStats?.opt_out_count ?? 0).toLocaleString()} total`}
          href={`/opt-outs?from=${fromIso}`}
          loading={statsApi.isLoading && stats === null}
        />
        <StatTile
          icon={<UserPlus className="size-4" aria-hidden />}
          label="Clickers this week"
          value={stats?.totals.clickers_added ?? 0}
          sublabel={`${(baseStats?.clicker_count ?? 0).toLocaleString()} total`}
          href={`/clickers?from=${fromIso}`}
          loading={statsApi.isLoading && stats === null}
        />
      </div>

      {/* ============ Activity charts ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last 7 days</CardTitle>
        </CardHeader>
        <CardContent>
          {dailyApi.isLoading && daily === null ? (
            <Skeleton className="h-[220px] w-full" />
          ) : !chartHasData ? (
            <div className="rounded-md border bg-muted/30 py-12 text-center text-sm text-muted-foreground">
              No activity in the last 7 days yet.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartPanel
                title="Stages sent per day"
                data={daily!.days.map((d) => ({
                  date: shortDay(d.date),
                  value: d.stages_sent,
                }))}
                color="#3b82f6"
                yLabel="stages"
              />
              <ChartPanel
                title="SMS volume per day"
                data={daily!.days.map((d) => ({
                  date: shortDay(d.date),
                  value: d.sms_count,
                }))}
                color="#10b981"
                yLabel="messages"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ============ Active campaigns ============ */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Active campaigns</h2>
          <Link
            href="/campaigns"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            All campaigns <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        </div>
        {activeApi.isLoading && activeCampaigns.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : activeCampaigns.length === 0 ? (
          <div className="rounded-md border bg-muted/30 py-8 text-center text-sm text-muted-foreground">
            No active campaigns.{" "}
            <Link href="/campaigns" className="text-foreground hover:underline">
              Create one →
            </Link>
          </div>
        ) : (
          <DataTable<ActiveCampaign>
            data={activeCampaigns}
            columns={activeColumns}
            isLoading={false}
            pageIndex={0}
            pageSize={activeCampaigns.length || 10}
            totalCount={activeCampaigns.length}
            onPageChange={() => {}}
            onPageSizeChange={() => {}}
            sortBy={null}
            sortDir="desc"
            onSortChange={() => {}}
            onRowClick={(c) => {
              window.location.href = `/campaigns/${c.id}`;
            }}
          />
        )}
      </section>

      {/* ============ Recent stages ============ */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Recent stages</h2>
          <span className="text-xs text-muted-foreground">
            10 most recent · times in ET
          </span>
        </div>
        {stagesApi.isLoading && recentStages.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : recentStages.length === 0 ? (
          <div className="rounded-md border bg-muted/30 py-8 text-center text-sm text-muted-foreground">
            No stages have been sent yet.
          </div>
        ) : (
          <DataTable<RecentStage>
            data={recentStages}
            columns={stageColumns}
            isLoading={false}
            pageIndex={0}
            pageSize={recentStages.length || 10}
            totalCount={recentStages.length}
            onPageChange={() => {}}
            onPageSizeChange={() => {}}
            sortBy={null}
            sortDir="desc"
            onSortChange={() => {}}
            onRowClick={(s) => {
              window.location.href = `/campaigns/${s.campaign.id}`;
            }}
          />
        )}
      </section>

      {/* ============ Audience snapshot ============ */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Audience</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            icon={<TrendingUp className="size-4" aria-hidden />}
            label="Total contacts"
            value={
              (baseStats?.total ?? 0) + (baseStats?.archived ?? 0)
            }
            sublabel={`${(baseStats?.archived ?? 0).toLocaleString()} archived`}
            href="/contacts"
            loading={baseApi.isLoading && baseStats === null}
          />
          <StatTile
            icon={<TrendingUp className="size-4" aria-hidden />}
            label="Active contacts"
            value={baseStats?.total ?? 0}
            sublabel="not archived"
            href="/contacts"
            loading={baseApi.isLoading && baseStats === null}
          />
          <StatTile
            icon={<UserMinus className="size-4" aria-hidden />}
            label="Total opt-outs"
            value={baseStats?.opt_out_count ?? 0}
            sublabel="unique contacts"
            href="/opt-outs"
            loading={baseApi.isLoading && baseStats === null}
          />
          <StatTile
            icon={<UserPlus className="size-4" aria-hidden />}
            label="Total clickers"
            value={baseStats?.clicker_count ?? 0}
            sublabel="unique contacts"
            href="/clickers"
            loading={baseApi.isLoading && baseStats === null}
          />
        </div>
      </section>
    </div>
  );
}

// =============== Sub-components ===============

function StatTile({
  icon,
  label,
  value,
  sublabel,
  href,
  loading,
  isString,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sublabel: string;
  href: string;
  loading?: boolean;
  isString?: boolean;
}) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:bg-muted/30">
        <CardContent className="grid gap-1.5 py-5">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            {icon}
            {label}
          </div>
          {loading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <div className="text-2xl font-semibold tabular-nums">
              {isString
                ? value
                : typeof value === "number"
                  ? value.toLocaleString()
                  : value}
            </div>
          )}
          <div className="text-xs text-muted-foreground">{sublabel}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

function ChartPanel({
  title,
  data,
  color,
  yLabel,
}: {
  title: string;
  data: Array<{ date: string; value: number }>;
  color: string;
  yLabel: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(value) => [
              typeof value === "number" ? value.toLocaleString() : String(value),
              yLabel,
            ]}
            labelFormatter={(label) => String(label)}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="value" fill={color} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
