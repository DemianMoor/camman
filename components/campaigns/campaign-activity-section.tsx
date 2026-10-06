"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { conversionAmountLabel, conversionBadgeClass } from "@/lib/conversion-badge";
import { useApiCall } from "@/lib/hooks/use-api-call";

// ---- Wire types (mirror app/api/campaigns/[id]/activity/*). ----
interface StageRollup {
  stage_id: number;
  stage_number: number;
  sent: number;
  failed: number;
  filtered: number;
  skipped_duplicate: number;
  pending: number;
  total: number;
  last_sent_at: string | null;
}
// Mirrors DeliveryCardCells in lib/reporting/campaign-activity.ts. The DLR
// fields are null — never 0 — when nothing behind them is DLR-capable.
interface DeliveryCells {
  sent: number;
  dlr_capable: boolean;
  capable_sent: number | null;
  matured: number | null;
  delivered: number | null;
  undelivered: number | null;
  no_receipt: number | null;
  pending: number | null;
  delivered_pct: number | null;
  undelivered_pct: number | null;
  no_receipt_pct: number | null;
  pending_pct: number | null;
}
interface StagePhoneDelivery extends DeliveryCells {
  stage_id: number;
  provider_phone_id: number | null;
  phone_number: string | null;
  provider_key: string | null;
}
interface CampaignDelivery extends DeliveryCells {
  maturity_minutes: number;
  by_stage_phone: StagePhoneDelivery[];
}
interface ActivitySummary {
  sent: number;
  failed: number;
  rejected: number;
  filtered: number;
  skipped_duplicate: number;
  skipped_opted_out: number;
  skipped_ineligible: number;
  pending: number;
  sending: number;
  total: number;
  opt_outs: number;
  last_sent_at: string | null;
  by_stage: StageRollup[];
  delivery: CampaignDelivery;
}
interface ActivityEvent {
  id: string;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  stage_id: number | null;
  created_at: string;
  actor_user_id: string | null;
  actor_name: string | null;
}
interface ActivityResponse {
  summary: ActivitySummary;
  events: {
    data: ActivityEvent[];
    totalCount: number;
    page: number;
    pageSize: number;
  };
}
interface MessageRow {
  id: string;
  stage_id: number;
  stage_number: number;
  phone: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  texthub_message_id: string | null;
  attempts: number;
  last_error: string | null;
  conversion_event: string | null;
  conversion_status: string | null;
  conversion_revenue: string | null;
  conversion_is_purchase: boolean | null;
  reply_result: string | null;
  reply_received_at: string | null;
}
interface MessagesResponse {
  data: MessageRow[];
  totalCount: number;
  page: number;
  pageSize: number;
}

type StageOption = { id: number; stage_number: number };

const ALL = "__all__";
const EVENTS_PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;

// Status → badge color. Terminal-good = emerald, terminal-bad = red, in-flight
// = amber/blue. Mirrors the stage_sends status check constraint. `filtered`
// (TextHub-suppressed) gets its own violet — visually distinct from red
// (genuine failure): "blocked on TextHub's side," not a delivery failure.
const STATUS_STYLES: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  filtered: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  // 1-hour dedup gate excluded this number (already messaged within the window) —
  // warning amber/orange, distinct from a genuine failure or a provider block.
  skipped_duplicate: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  // A STOP arrived after materialization (migration 0116) — same orange family
  // as the dedup gate: expected safety behaviour, not a failure.
  skipped_opted_out: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  // Dropped at dispatch by a lifecycle check (migration 0190) — suppressed,
  // freeze cadence or bought this offer. Same family, same reason.
  skipped_ineligible: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  sending: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
};

// The conversion badge's colour + amount live in lib/conversion-badge.ts, so the
// proof script can assert the real rendering decisions (an approved $0
// registration is not purchase-green, and prints no money) without importing a
// client component. Do not re-implement them here.

// Event type → a short human label + an accent dot color for the timeline.
const EVENT_META: Record<string, { label: string; dot: string }> = {
  campaign_created: { label: "Created", dot: "bg-sky-500" },
  campaign_status_changed: { label: "Status", dot: "bg-violet-500" },
  stage_created: { label: "Stage", dot: "bg-sky-400" },
  stage_status_changed: { label: "Stage status", dot: "bg-violet-400" },
  stage_scheduled: { label: "Scheduled", dot: "bg-amber-500" },
  send_approved: { label: "Approved", dot: "bg-teal-500" },
  send_kickoff: { label: "Kickoff", dot: "bg-indigo-500" },
  send_drain: { label: "Sent", dot: "bg-emerald-500" },
  results_imported: { label: "Import", dot: "bg-cyan-500" },
  results_reverted: { label: "Revert", dot: "bg-orange-500" },
};

function eventMeta(type: string) {
  return EVENT_META[type] ?? { label: type, dot: "bg-muted-foreground" };
}

export function CampaignActivitySection({
  campaignId,
  stages,
}: {
  campaignId: string | number;
  stages: StageOption[];
}) {
  const activityApi = useApiCall<ActivityResponse>();
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [eventsPage, setEventsPage] = useState(1);

  const loadActivity = activityApi.execute;
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await loadActivity(
        `/api/campaigns/${campaignId}/activity?page=${eventsPage}&pageSize=${EVENTS_PAGE_SIZE}`,
      );
      if (active && r.ok) setActivity(r.data);
    })();
    return () => {
      active = false;
    };
  }, [campaignId, eventsPage, loadActivity]);

  if (!activity) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Activity</h2>
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Loading activity…
          </CardContent>
        </Card>
      </div>
    );
  }

  const s = activity.summary;
  const skipped = s.skipped_duplicate + s.skipped_opted_out + s.skipped_ineligible;

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Activity</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <SummaryCard label="Messages sent" value={s.sent} accent="text-emerald-700 dark:text-emerald-400" />
        <SummaryCard
          label="Failed at send"
          value={s.failed}
          accent={s.failed > 0 ? "text-red-700 dark:text-red-400" : undefined}
          hint="The send itself errored (provider API failure after retries) — no message went out. A send-time outcome, not a delivery receipt; see Failed delivery below for that."
        />
        <SummaryCard
          label="Filtered"
          value={s.filtered}
          accent={s.filtered > 0 ? "text-violet-700 dark:text-violet-400" : undefined}
          hint="Rejected by TextHub as suppressed/unsubscribed on their side. Not opted out here and not skipped in future campaigns — label only."
        />
        <SummaryCard
          label="Skipped"
          value={skipped}
          accent={skipped > 0 ? "text-orange-700 dark:text-orange-400" : undefined}
          hint={[
            "Not sent: dropped by a safety check before sending.",
            `1-hour dedup (messaged within the last hour, any campaign): ${s.skipped_duplicate.toLocaleString()}`,
            `Opted out after the audience was built: ${s.skipped_opted_out.toLocaleString()}`,
            `Lifecycle check (suppressed, freeze cadence or bought this offer): ${s.skipped_ineligible.toLocaleString()}`,
          ].join("\n")}
        />
        <SummaryCard label="In flight" value={s.pending + s.sending} />
        <SummaryCard
          label="Opt-outs"
          value={s.opt_outs}
          hint="Sends with a STOP reply linked to them, across every provider. Other replies are not counted."
        />
        <SummaryCard
          label="Last send"
          valueText={s.last_sent_at ? formatCampaignDateTime(s.last_sent_at) : "—"}
        />
      </div>

      <DeliveryCards d={s.delivery} />

      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="delivery">By stage &amp; number</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-3">
          <Timeline
            events={activity.events.data}
            totalCount={activity.events.totalCount}
            page={eventsPage}
            pageSize={EVENTS_PAGE_SIZE}
            onPage={setEventsPage}
          />
        </TabsContent>

        <TabsContent value="messages" className="mt-3">
          <MessagesPanel campaignId={campaignId} stages={stages} />
        </TabsContent>

        <TabsContent value="delivery" className="mt-3">
          <DeliveryByStagePhone rows={s.delivery.by_stage_phone} stages={stages} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  valueText,
  accent,
  hint,
  sub,
}: {
  label: string;
  value?: number;
  valueText?: string;
  accent?: string;
  hint?: string;
  /** A second, smaller line under the value (the delivery cards' %). */
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div
          className="text-xs uppercase tracking-wide text-muted-foreground"
          title={hint}
        >
          {label}
        </div>
        <div
          className={`mt-1 font-semibold ${valueText ? "text-sm" : "text-2xl"} ${accent ?? ""}`}
        >
          {valueText ?? (value ?? 0).toLocaleString()}
        </div>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

const fmtPct = (p: number | null) => (p === null ? "—" : `${p.toFixed(1)}%`);

const NO_STATUS_HINT =
  "No final delivery receipt recorded — either the provider didn't send one or our intake didn't capture it. txr receipts can keep arriving for a day or more, so this number shrinks over time.";

// Delivery receipts (DLR), every stage, whole lifetime. Delivered + Failed
// delivery + No status foot to the MATURED sends on DLR-capable numbers;
// Pending is every capable send younger than the maturity cutoff. A campaign
// with no DLR-capable sends shows N/A — never 0 / 0%, which would read as a
// total delivery outage.
function DeliveryCards({ d }: { d: CampaignDelivery }) {
  const mins = d.maturity_minutes;
  if (!d.dlr_capable) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Delivery</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {["Delivered", "Failed delivery", "No status", "Pending"].map((label) => (
            <SummaryCard key={label} label={label} valueText="N/A" sub="no reliable DLR" />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {d.sent > 0
            ? "None of this campaign's sends went out on a provider with trustworthy delivery receipts (TextHub has none)."
            : "Nothing sent yet."}
        </p>
      </div>
    );
  }
  const capable = d.capable_sent ?? 0;
  const matured = d.matured ?? 0;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Delivery</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          label="Delivered"
          value={d.delivered ?? 0}
          sub={fmtPct(d.delivered_pct)}
          accent="text-emerald-700 dark:text-emerald-400"
          hint="Final 'delivered' receipt from the provider. A message with both receipts counts as delivered."
        />
        <SummaryCard
          label="Failed delivery"
          value={d.undelivered ?? 0}
          sub={fmtPct(d.undelivered_pct)}
          accent={(d.undelivered ?? 0) > 0 ? "text-red-700 dark:text-red-400" : undefined}
          hint="Final 'undelivered' receipt from the provider: the message went out but the carrier did not deliver it. Not the same as Failed at send."
        />
        <SummaryCard
          label="No status"
          value={d.no_receipt ?? 0}
          sub={fmtPct(d.no_receipt_pct)}
          hint={NO_STATUS_HINT}
        />
        <SummaryCard
          label="Pending"
          value={d.pending ?? 0}
          sub={`${fmtPct(d.pending_pct)} of capable sent`}
          hint={`Sent less than ${mins} minutes ago, too recent for a receipt to be expected. Not in the % base until it matures.`}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Delivered, Failed delivery and No status are % of {matured.toLocaleString()} matured
        sends (sent ≥ {mins} min ago) on numbers with delivery receipts.
        {capable < d.sent
          ? ` Based on ${capable.toLocaleString()} of ${d.sent.toLocaleString()} sent; the rest went out on a provider with no reliable receipts.`
          : ""}
      </p>
    </div>
  );
}

function DeliveryByStagePhone({
  rows,
  stages,
}: {
  rows: StagePhoneDelivery[];
  stages: StageOption[];
}) {
  const stageNo = new Map(stages.map((st) => [st.id, st.stage_number]));
  const n = (v: number | null) => (v === null ? "N/A" : v.toLocaleString());
  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing sent yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Number</th>
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 text-right font-medium">Sent</th>
                  <th className="px-3 py-2 text-right font-medium">Delivered</th>
                  <th className="px-3 py-2 text-right font-medium">Failed delivery</th>
                  <th className="px-3 py-2 text-right font-medium" title={NO_STATUS_HINT}>
                    No status
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Pending</th>
                  <th className="px-3 py-2 text-right font-medium">Delivered %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.stage_id}|${r.provider_phone_id ?? "none"}`}
                    className="border-b last:border-0"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      Stage {stageNo.get(r.stage_id) ?? r.stage_id}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                      {r.phone_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.provider_key ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.sent.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{n(r.delivered)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{n(r.undelivered)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{n(r.no_receipt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{n(r.pending)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.dlr_capable ? fmtPct(r.delivered_pct) : "N/A"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Timeline({
  events,
  totalCount,
  page,
  pageSize,
  onPage,
}: {
  events: ActivityEvent[];
  totalCount: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(totalCount / pageSize));
  return (
    <Card>
      <CardContent className="p-0">
        {events.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No activity recorded yet. Lifecycle changes, sends, and imports will
            appear here.
          </p>
        ) : (
          <ul className="divide-y">
            {events.map((e) => {
              const m = eventMeta(e.event_type);
              const hasMeta = e.metadata && Object.keys(e.metadata).length > 0;
              return (
                <li key={e.id} className="flex gap-3 p-3">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${m.dot}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {m.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatCampaignDateTime(e.created_at)}
                      </span>
                    </div>
                    <p className="text-sm">{e.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.actor_name ?? "System / automatic"}
                    </p>
                    {hasMeta ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Details
                        </summary>
                        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                          {Object.entries(e.metadata as Record<string, unknown>).map(
                            ([k, v]) => (
                              <Fragment key={k}>
                                <dt className="text-muted-foreground">{k}</dt>
                                <dd className="break-all">{String(v)}</dd>
                              </Fragment>
                            ),
                          )}
                        </dl>
                      </details>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {totalCount > pageSize ? (
          <Pager
            page={page}
            lastPage={lastPage}
            totalCount={totalCount}
            onPage={onPage}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function MessagesPanel({
  campaignId,
  stages,
}: {
  campaignId: string | number;
  stages: StageOption[];
}) {
  const api = useApiCall<MessagesResponse>();
  const [resp, setResp] = useState<MessagesResponse | null>(null);
  const [page, setPage] = useState(1);
  const [stageId, setStageId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce the phone search so we don't fire on every keystroke; a new search
  // term also resets to page 1 (setState inside the timeout, not synchronously
  // in the effect body).
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = api.execute;
  const fetchPage = useCallback(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(MESSAGES_PAGE_SIZE),
    });
    if (stageId !== ALL) params.set("stageId", stageId);
    if (status !== ALL) params.set("status", status);
    if (debouncedSearch) params.set("search", debouncedSearch);
    return load(
      `/api/campaigns/${campaignId}/activity/messages?${params.toString()}`,
    );
  }, [campaignId, page, stageId, status, debouncedSearch, load]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await fetchPage();
      if (active && r.ok) setResp(r.data);
    })();
    return () => {
      active = false;
    };
  }, [fetchPage]);

  const lastPage = resp
    ? Math.max(1, Math.ceil(resp.totalCount / MESSAGES_PAGE_SIZE))
    : 1;

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={stageId}
          onValueChange={(v) => {
            setStageId(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All stages</SelectItem>
            {stages.map((st) => (
              <SelectItem key={st.id} value={String(st.id)}>
                Stage {st.stage_number}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {/* §B7 — one filter for everything that needs a human. */}
            <SelectItem value="attention">Needs attention</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="filtered">Filtered</SelectItem>
            <SelectItem value="skipped_duplicate">Skipped (1h dedup)</SelectItem>
            <SelectItem value="skipped_opted_out">Skipped (opted out)</SelectItem>
            <SelectItem value="skipped_ineligible">Skipped (lifecycle)</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="sending">Sending</SelectItem>
          </SelectContent>
        </Select>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search phone…"
          className="w-44"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {!resp ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : resp.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No messages match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Stage</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Conversion</th>
                    <th className="px-3 py-2 font-medium">Sent</th>
                    <th className="px-3 py-2 font-medium">Reply</th>
                    <th className="px-3 py-2 font-medium">Message ID</th>
                    <th className="px-3 py-2 text-right font-medium">Tries</th>
                    <th className="px-3 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {resp.data.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        Stage {r.stage_number}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                        {r.phone}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="secondary"
                          className={STATUS_STYLES[r.status] ?? ""}
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.conversion_event ? (
                          <Badge
                            variant="secondary"
                            className={conversionBadgeClass(r)}
                            title={`${r.conversion_event} · ${r.conversion_status ?? "unmapped"}${conversionAmountLabel(r)}`}
                          >
                            {r.conversion_event}
                            {r.conversion_status ? ` · ${r.conversion_status}` : " · unmapped"}
                            {conversionAmountLabel(r)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {r.sent_at ? formatCampaignDateTime(r.sent_at) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.reply_result ? (
                          <span title={r.reply_received_at ?? undefined}>
                            {r.reply_result}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {r.texthub_message_id ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right">{r.attempts}</td>
                      <td className="px-3 py-2 text-xs text-red-700 dark:text-red-400">
                        {r.last_error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {resp && resp.totalCount > MESSAGES_PAGE_SIZE ? (
            <Pager
              page={page}
              lastPage={lastPage}
              totalCount={resp.totalCount}
              onPage={setPage}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Pager({
  page,
  lastPage,
  totalCount,
  onPage,
}: {
  page: number;
  lastPage: number;
  totalCount: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
      <span>
        Page {page} of {lastPage} · {totalCount.toLocaleString()} total
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
