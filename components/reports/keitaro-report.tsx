"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { BarChart3, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { useAuth } from "@/components/protected/auth-context";
import {
  EventColumnsBar,
  eventCellValue,
  eventColumnBlock,
  fmtEventCell,
  type EventColumnBlock,
} from "@/components/reports/event-columns-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CAMPAIGN_TIMEZONE_LABEL,
  formatCampaignDateTime,
  formatInCampaignTimezone,
} from "@/lib/campaign-timezone";
import {
  formatPhoneInternational,
  formatPhoneLast4,
} from "@/lib/phone-validation";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import type { DeliveryFreshness } from "@/lib/reporting/delivery-rollup";
import {
  eventColumnById,
  type EventMap,
  type EventTypeSpec,
} from "@/lib/reporting/event-columns";

// The "Overview" tab of /reports — the Keitaro Clickers → Offer Redirect → Sales
// funnel, per stage or per campaign. Moved verbatim out of app/(protected)/reports
// /page.tsx (which is now a thin tab router) when the five performance reports were
// added; the page's <h1> + tab bar now live in the router, so this renders its own
// controls/table only.
type ReportRow = {
  stage_id: number | null;
  campaign_id: number;
  campaign_name: string;
  stage_number: number | null;
  stage_name: string | null;
  stage_tracking_id: string | null;
  stage_count: number | null;
  // Send number(s) behind the row — one for a stage row, the distinct set
  // across the campaign's stages for a campaign row. Empty when the stage has
  // no provider phone assigned.
  phones: { phone_number: string; number_type: string | null }[];
  opt_outs: number;
  total_sent: number;
  opt_out_rate: number;
  clickers: number;
  click_rate: number;
  // True when `clickers` is CamMan's count standing in for a missing Keitaro
  // visit count. Marks the value and blanks click_rate/redirect_rate — not
  // because both divide by the missing denominator (only redirect_rate does;
  // click_rate's denominator is total_sent and the substitute is its
  // numerator), but because both would mix a Keitaro basis with a CamMan one.
  clickers_is_fallback: boolean;
  offer_redirect: number;
  redirect_rate: number;
  sales: number;
  sales_cr: number;
  revenue: number;
  pending_revenue: number;
  cost: number;
  epc: number; // PERIOD — the selected date range
  counted_clickers: number;
  lifetime_epc: number; // LIFETIME — ignores the date filter; the PRIMARY figure
  lifetime_clickers: number;
  profit: number;
  // Delivery receipts (lib/reporting/delivery.ts — the same layer behind
  // /reports/delivery and the undelivered tripwire). null when the grain has no
  // DLR-capable sends, or when the selected range exceeds the delivery cap.
  delivered_pct: number | null;
  // < 100 ⇒ a MIXED-capability campaign; the figure must be labelled with its
  // coverage or a 4%-coverage number is indistinguishable from a 100% one.
  delivery_coverage_pct: number | null;
  // The per-event-type breakdown of sales / revenue, keyed by event_types.key.
  // The columns over it are GENERATED from the registry the response carries.
  events: EventMap;
  // Conversions in scope that matched no mapping. Counted in NO other field —
  // which is why only the amber badge can tell you they exist.
  unmapped: number;
  // The part of `sales` that came from the manual tally rather than the tracker:
  //   sales = Σ (is_purchase) events[t].n + manual_topup + unmapped strays
  manual_topup: number;
};

// Delivered % header. The cells come from stage_delivery_rollup (migration 0186),
// refreshed every 10 min (today + yesterday) and every 3 h (the 7 days before),
// so the header says how current they are — and says so in amber when a refresh
// missed its schedule, because a stale percentage looks exactly like a fresh one.
function DeliveredHeader({
  freshness,
  available,
}: {
  freshness: DeliveryFreshness | null;
  available: boolean;
}) {
  let note: ReactNode = null;
  if (available && freshness) {
    const asOf = freshness.as_of
      ? `as of ${formatInCampaignTimezone(freshness.as_of, "h:mm a")} ${CAMPAIGN_TIMEZONE_LABEL}`
      : null;
    if (freshness.stale) {
      note = (
        <span
          className="text-amber-600"
          title={
            `The delivery refresh has missed its schedule, so these percentages may be behind` +
            (freshness.as_of ? ` (receipts counted up to ${formatCampaignDateTime(freshness.as_of)}).` : ".")
          }
        >
          stale{asOf ? ` · ${asOf}` : ""}
        </span>
      );
    } else if (freshness.final) {
      note = (
        <span title="Every day in this range is more than 7 days old — these delivery numbers are final.">
          final
        </span>
      );
    } else if (asOf) {
      note = (
        <span
          title={
            `Delivery receipts counted up to ${formatCampaignDateTime(freshness.as_of)}. ` +
            `Today and yesterday refresh every 10 minutes; the 7 days before, every 3 hours.`
          }
        >
          {asOf}
        </span>
      );
    }
  }
  return (
    <span className="inline-flex flex-col leading-tight">
      <span>Delivered, %</span>
      {note ? <span className="text-[10px] font-normal text-muted-foreground">{note}</span> : null}
    </span>
  );
}

// Delivered % cell. Three distinct "no number" cases, which must not look alike:
//   · range too wide  — the column is capped at 14 days (a kept product limit,
//                       no longer a cost one — see the route), so not computed
//   · no capable sends — this grain sends only via providers with no DLR intake
//   · partial coverage — a MIXED campaign: show the figure AND label its coverage,
//                        because 91.4% over 4% of sends is not the same claim as
//                        91.4% over all of them
function DeliveredCell({ row, available }: { row: ReportRow; available: boolean }) {
  if (!available) {
    return (
      <span className="text-muted-foreground/60" title="Delivery % is only computed for ranges of 14 days or less. Narrow the date range to see it.">
        —
      </span>
    );
  }
  if (row.delivered_pct === null) {
    return (
      <span className="text-muted-foreground/60" title="No delivery-receipt data: these sends went via a provider with no DLR intake.">
        —
      </span>
    );
  }
  const coverage = row.delivery_coverage_pct;
  const partial = coverage !== null && coverage < 100;
  return (
    <span className="tabular-nums">
      {row.delivered_pct.toFixed(1)}%
      {partial ? (
        <span
          className="ml-1 text-[11px] text-muted-foreground"
          title="This campaign sends via more than one provider and only some of them report delivery receipts. The percentage covers only that measurable share of its sends."
        >
          (of {coverage.toFixed(0)}% of sends)
        </span>
      ) : null}
    </span>
  );
}

type Totals = Omit<
  ReportRow,
  | "stage_id"
  | "campaign_id"
  | "campaign_name"
  | "stage_number"
  | "stage_name"
  | "stage_tracking_id"
  | "stage_count"
  // Deliberately NOT in the totals card. An org-wide "Delivered %" would need a
  // denominator choice (all sends? DLR-capable sends?) that no single number can
  // carry honestly while ~99.9% of volume has no receipts. /reports/delivery
  // shows the per-provider breakdown instead, where the denominator is explicit.
  | "delivered_pct"
  | "delivery_coverage_pct"
>;

type GroupBy = "stage" | "campaign";

type ReportResponse = {
  data: ReportRow[];
  totalCount: number;
  totals: Totals;
  // The event-type registry. The per-event columns are GENERATED from it, so an
  // empty array simply means no event columns — never a broken table.
  event_types: EventTypeSpec[];
  // available=false ⇒ the selected range exceeds the delivery cap and the
  // Delivered % column was not computed at all (see DeliveredCell).
  delivery?: { available: boolean; max_days: number; freshness?: DeliveryFreshness | null };
  range: { from: string; to: string; timezone: string };
};

type PollResponse = {
  ok: boolean;
  degraded: boolean;
  matched: number;
  upserted: number;
  unmatched: number;
  classification_degraded: boolean;
  error: string | null;
};

type Filters = {
  from: string;
  to: string;
  search: string;
  groupBy: GroupBy;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  // Per-browser, off by default. It governs ONLY the per-event money columns
  // (tier B), each of which duplicates an aggregate column already on screen.
  showEvents: boolean;
};

function etDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const DEFAULT_FILTERS: Filters = {
  from: etDate(-6),
  to: etDate(0),
  search: "",
  groupBy: "stage",
  page: 0,
  pageSize: 20,
  sortBy: "revenue",
  sortDir: "desc",
  showEvents: false,
};

// ⭐ A PERSISTED SORT CAN NAME A COLUMN THIS TABLE NO LONGER HAS. `Human clicks`
// and `Human clicks (all time)` were removed from Overview on 2026-09-23 and
// their ids left the route's SORTABLE whitelist with them — but a browser that
// had sorted by either still holds `sortBy: "counted_clickers"` in
// localStorage["reports.filters"]. Sent as-is, the request is accepted, the
// server silently falls back to revenue, and no header on screen carries an
// indicator: rows in a real order with nothing saying so, which is
// indistinguishable from an unsorted table (07-conventions.md, "A curated
// default view must never hide the column the table is SORTED BY").
//
// Normalised ON READ, in ONE named helper used for BOTH the request and the
// indicator, so the two cannot disagree — and so the sort work that follows has
// a single place to extend rather than a second copy to keep in step.
//
// ⭐ FIXED IDS ONLY IN THE ROSTER, DELIBERATELY. The GENERATED per-event columns
// are `evt:<key>:<kind>` / `evtfunnel:<key>:<key>` over a per-org registry that
// arrives WITH the response, so they cannot be enumerated at module scope. They
// are accepted by SHAPE through eventColumnById() — the one parser of that id
// grammar, and exactly how /api/keitaro/reports accepts them. Without that
// clause an operator who sorted by an event column would be thrown back to
// revenue on every page load.
const OVERVIEW_SORTABLE_IDS: ReadonlySet<string> = new Set([
  "campaign_name",
  "total_sent",
  "opt_outs",
  "opt_out_rate",
  "clickers",
  "click_rate",
  "offer_redirect",
  "redirect_rate",
  "sales",
  "sales_cr",
  "revenue",
  "pending_revenue",
  "cost",
  "lifetime_epc",
  "epc",
  "profit",
]);

export function normalizeOverviewSort(
  sortBy: string,
  sortDir: "asc" | "desc",
): { sortBy: string; sortDir: "asc" | "desc" } {
  if (OVERVIEW_SORTABLE_IDS.has(sortBy) || eventColumnById(sortBy)) {
    return { sortBy, sortDir };
  }
  return { sortBy: DEFAULT_FILTERS.sortBy, sortDir: DEFAULT_FILTERS.sortDir };
}

const SEARCH_DEBOUNCE_MS = 300;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
function fmtUsd(n: number): string {
  return usd.format(n);
}
function fmtInt(n: number): string {
  return n.toLocaleString();
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Why Sales does not equal the sum of the purchase columns beside it. Said on
// the column AND on the stat card, because whichever one is read first is the
// one that has to explain itself.
const SALES_NOTE =
  "Tracker conversions plus the manual tally. The per-event columns count tracker events only, so they sum to Sales minus the manual top-up (and minus any unmapped conversions, which the amber badge counts).";

// The Campaign cell carries two lines (name + send number), so an unbounded
// name would push the metric columns off screen. Anything past 50 characters
// is cut here and the full name is reachable by hovering the link.
const MAX_CAMPAIGN_NAME_CHARS = 50;
function truncateCampaignName(name: string): string {
  return name.length > MAX_CAMPAIGN_NAME_CHARS
    ? name.slice(0, MAX_CAMPAIGN_NAME_CHARS - 1).trimEnd() + "…"
    : name;
}

// The number(s) a row was sent from, under the campaign name. Short codes are
// only recognisable in full; every other type collapses to its last 4 digits.
// A campaign row can span stages on different numbers — the first few are
// listed and the rest counted, with all of them in full on hover.
const MAX_PHONES_SHOWN = 3;
function fullPhoneLabel(p: ReportRow["phones"][number]): string {
  return p.number_type === "short_code"
    ? p.phone_number
    : formatPhoneInternational(p.phone_number);
}
function SendNumbers({ phones }: { phones: ReportRow["phones"] }) {
  if (phones.length === 0) return null;
  const shown = phones.slice(0, MAX_PHONES_SHOWN);
  const hidden = phones.length - shown.length;
  return (
    <span
      className="font-mono text-[11px] text-muted-foreground"
      title={phones.map(fullPhoneLabel).join(", ")}
    >
      {shown
        .map((p) => formatPhoneLast4(p.phone_number, p.number_type))
        .join(", ")}
      {hidden > 0 ? ` +${hidden}` : ""}
    </span>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function KeitaroReport() {
  const { auth, can } = useAuth();
  const canRefresh = can("result_imports.create");

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "reports.filters",
    DEFAULT_FILTERS,
  );

  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);
  useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => {
      updateFilters({ search: searchInput, page: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, filters.search, updateFilters]);

  const listApi = useApiCall<ReportResponse>();
  const pollApi = useApiCall<PollResponse>();

  const [data, setData] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [eventTypes, setEventTypes] = useState<EventTypeSpec[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Whether the server computed the Delivered % column at all for this range.
  const [deliveryAvailable, setDeliveryAvailable] = useState(true);
  const [deliveryFreshness, setDeliveryFreshness] = useState<DeliveryFreshness | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  // The persisted sort, made safe to send AND safe to display — see
  // normalizeOverviewSort above. Both the request below and the DataTable's
  // indicator read these two, never `filters.sortBy` / `filters.sortDir`.
  const { sortBy: sortById, sortDir: sortDirection } = normalizeOverviewSort(
    filters.sortBy,
    filters.sortDir,
  );

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);
    const params = new URLSearchParams({
      from: filters.from,
      to: filters.to,
      groupBy: filters.groupBy,
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: sortById,
      sortDir: sortDirection,
    });
    if (filters.search) params.set("search", filters.search);

    (async () => {
      const result = await listApi.execute(
        `/api/keitaro/reports?${params.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) {
        setData(result.data.data);
        setTotals(result.data.totals);
        setEventTypes(result.data.event_types ?? []);
        setTotalCount(result.data.totalCount);
        setDeliveryAvailable(result.data.delivery?.available ?? true);
        setDeliveryFreshness(result.data.delivery?.freshness ?? null);
      } else {
        // ⭐ THE STALE RESPONSE GOES WITH IT. The error block replaces the
        // TABLE, but the stat cards and the unmapped badge sit above it — so a
        // failed fetch used to leave an amber "12 unmapped" and a full set of
        // totals beside "Couldn't load reports", describing a range the screen
        // is no longer showing. Cleared, the cards and the badge render nothing
        // and the error is the only claim on the page. Retry refills them.
        setData([]);
        setTotals(null);
        setEventTypes([]);
        setTotalCount(0);
        setDeliveryFreshness(null);
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    filters.from,
    filters.to,
    filters.search,
    filters.groupBy,
    filters.page,
    filters.pageSize,
    sortById,
    sortDirection,
    refreshTick,
    listApi.execute,
  ]);

  async function handleRefresh() {
    const result = await pollApi.execute("/api/keitaro/poll", {
      method: "POST",
    });
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    const p = result.data;
    if (p.degraded) {
      toast.error(`Keitaro sync failed: ${p.error ?? "unknown error"}`);
    } else {
      toast.success(
        `Synced ${p.upserted} stage-day${p.upserted === 1 ? "" : "s"}` +
          (p.classification_degraded
            ? " — visit/redirect classification degraded (campaigns list unavailable)"
            : ""),
      );
    }
    refetch();
  }

  // The generated columns AND the bar's numbers, from ONE call over ONE
  // response: the unmapped count the bar renders is read off the same `totals`
  // these columns were built from, and the toggle's governed count is a constant
  // of the registry rather than of the toggle's state (bar W12).
  // ⭐ `showAllColumns` IS A LITERAL `true` HERE, AND DELIBERATELY SO. The
  // curated default view was specified for /reports' dimension tabs and for
  // /creatives; Overview was not part of it, and quietly hiding four of its
  // columns because a shared helper grew a parameter would be a change nobody
  // asked for. Overview therefore renders the full generated set exactly as it
  // did. Give it its own toggle the day it is asked for — the parameter is
  // already here.
  const block = useMemo<EventColumnBlock>(
    () => eventColumnBlock(eventTypes, data, totals, filters.showEvents, true),
    [eventTypes, data, totals, filters.showEvents],
  );

  const columns = useMemo<ColumnDef<ReportRow>[]>(() => {
    const campaignCol: ColumnDef<ReportRow> = {
      id: "campaign_name",
      header: "Campaign",
      enableSorting: true,
      cell: ({ row }) => {
        const name = row.original.campaign_name;
        const shortName = truncateCampaignName(name);
        return (
          <div className="flex max-w-[22rem] flex-col gap-0.5">
            <Link
              href={`/campaigns/${row.original.campaign_id}`}
              className="font-medium text-primary hover:underline"
              title={shortName === name ? undefined : name}
            >
              {shortName}
            </Link>
            <SendNumbers phones={row.original.phones} />
          </div>
        );
      },
    };
    const stageCol: ColumnDef<ReportRow> =
      filters.groupBy === "campaign"
        ? {
            id: "stages",
            header: "Stages",
            enableSorting: false,
            cell: ({ row }) => (
              <span className="tabular-nums text-muted-foreground">
                {fmtInt(row.original.stage_count ?? 0)}
              </span>
            ),
          }
        : {
            id: "stage",
            header: "Stage",
            enableSorting: false,
            cell: ({ row }) => (
              <Link
                href={`/campaigns/${row.original.campaign_id}?stage=${row.original.stage_id}`}
                className="flex flex-col gap-0.5 hover:underline"
              >
                <span className="text-primary">{row.original.stage_name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {row.original.stage_tracking_id}
                </span>
              </Link>
            ),
          };
    const rest: ColumnDef<ReportRow>[] = [
      {
        id: "total_sent",
        header: "Total Sent",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtInt(row.original.total_sent)}</span>
        ),
      },
      {
        id: "opt_outs",
        header: "Opt-outs",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtInt(row.original.opt_outs)}
          </span>
        ),
      },
      {
        id: "opt_out_rate",
        header: "OptOut, %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtPct(row.original.opt_out_rate)}
          </span>
        ),
      },
      {
        id: "delivered_pct",
        header: () => <DeliveredHeader freshness={deliveryFreshness} available={deliveryAvailable} />,
        enableSorting: false,
        cell: ({ row }) => <DeliveredCell row={row.original} available={deliveryAvailable} />,
      },
      {
        id: "clickers",
        // ⭐ `Clickers` HERE, `Landing visits` ON THE BY-X TABS — and the split
        // is deliberate (owner, 2026-09-23). The 2026-09-20 rename applied one
        // name everywhere because a people-word sat FOUR COLUMNS from the real
        // EPC denominator, `Human clicks` (counted_clickers), and the two were
        // confusable. Overview no longer carries either human-click column —
        // both were removed in this same change — so on THIS tab there is no
        // second click-shaped number for `Clickers` to be mistaken for, and the
        // shorter name is what the owner reads the funnel by. The By-X tables
        // still show `Human clicks` beside it, so the trap is still live there
        // and they keep `Landing visits`. "One metric, one name" held while the
        // tabs showed the same columns; they no longer do.
        //
        // ⚠️ The field is unchanged: `visit_clicks_clean`, Keitaro's
        // bot-filtered landing-page VISIT count, display-only, and the
        // denominator of NOTHING EPC touches. Do not spell "human" over it on
        // either tab (V23). The `id` stays `clickers` — sorts and the Operator
        // API key off it. Bar V24 pins the split in both directions.
        header: "Clickers",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            title={
              row.original.clickers_is_fallback
                ? "CamMan clicks — Keitaro visits unavailable"
                : undefined
            }
          >
            {fmtInt(row.original.clickers)}
            {row.original.clickers_is_fallback ? (
              <sup className="text-muted-foreground">*</sup>
            ) : null}
          </span>
        ),
      },
      {
        id: "click_rate",
        header: "CR, %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.clickers_is_fallback ? "—" : fmtPct(row.original.click_rate)}
          </span>
        ),
      },
      {
        id: "offer_redirect",
        header: "Offer Redirect",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {fmtInt(row.original.offer_redirect)}
          </span>
        ),
      },
      {
        id: "redirect_rate",
        header: "Redirect %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.clickers_is_fallback ? "—" : fmtPct(row.original.redirect_rate)}
          </span>
        ),
      },
      {
        id: "sales",
        header: () => <span title={SALES_NOTE}>Sales</span>,
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtInt(row.original.sales)}</span>
        ),
      },
      {
        id: "sales_cr",
        header: "Sales CR",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtPct(row.original.sales_cr)}
          </span>
        ),
      },
      {
        id: "revenue",
        header: "Revenue",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtUsd(row.original.revenue)}</span>
        ),
      },
      {
        id: "pending_revenue",
        header: "Pending $",
        enableSorting: true,
        // "—" when nothing is held, like the totals tile and the campaign page's
        // stage cell: held money is shown where it exists, and a column of
        // "$0.00" reads as a measured zero rather than "no held conversions".
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.pending_revenue > 0 ? fmtUsd(row.original.pending_revenue) : "—"}
          </span>
        ),
      },
      {
        id: "cost",
        header: "Cost",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtUsd(row.original.cost)}
          </span>
        ),
      },
      // ⭐ THE TWO HUMAN-CLICK COLUMNS ARE GONE FROM THIS TAB (owner,
      // 2026-09-23) — `Human clicks (all time)` (`lifetime_clickers`) and
      // `Human clicks` (`counted_clickers`). REMOVED, not hidden: Overview has
      // no curated-view toggle (`showAllColumns` is a literal `true` below), so
      // there is no place to hide a column to. Each EPC therefore sits here
      // WITHOUT the count it divided by, which is a real cost and an accepted
      // one: this is the tab the owner keeps narrow and every column competes
      // for the same horizontal room, and the denominator is one tab away on
      // By Number / By Offer / By Sequence, which read the same stages out of
      // the same stage-funnel.ts figures and keep both columns. Dropping the
      // two people-worded columns is also what let `Clickers` regain its
      // meaning above. See docs/07-conventions.md for the decision and its cost.
      //
      // ⚠️ `counted_clickers` and `lifetime_clickers` REMAIN on the row type and
      // in the response. `counted_clickers` is still read by every generated
      // per-event rate/EPC cell below, and both still feed the server's EPC
      // figures. NOTHING NUMERIC CHANGED — only two column declarations went.
      //
      // LIFETIME first — the primary figure, ignoring the date filter entirely,
      // which is why it alone still names its basis in the header (V21).
      {
        id: "lifetime_epc",
        header: "EPC (all time)",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums font-medium">
            {fmtUsd(row.original.lifetime_epc)}
          </span>
        ),
      },
      {
        id: "epc",
        header: "EPC",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtUsd(row.original.epc)}
          </span>
        ),
      },
      {
        id: "profit",
        header: "Profit",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className={
              row.original.profit >= 0
                ? "tabular-nums text-emerald-600 dark:text-emerald-400"
                : "tabular-nums text-destructive"
            }
          >
            {fmtUsd(row.original.profit)}
          </span>
        ),
      },
    ];
    // The GENERATED block, spliced by the ID of the column it sits BEFORE rather
    // than by an index — an index would silently move the block the next time a
    // column is added. ⭐ THE ANCHOR MOVED FROM `sales` TO `cost` (owner,
    // 2026-09-23): the four money columns the owner reads together — Sales,
    // Sales CR, Revenue, Pending $ — now sit as one group immediately after the
    // funnel, and the per-event breakdown that elaborates them follows, ahead of
    // Cost / EPC / Profit. Keep the by-id form; the reasoning for it is the
    // reason the move was a one-word change rather than an index audit.
    const generated: ColumnDef<ReportRow>[] = block.columns.map((e) => ({
      id: e.id,
      header: e.header,
      enableSorting: true,
      cell: ({ row }) => (
        <span className={`tabular-nums${e.muted ? " text-muted-foreground" : ""}`}>
          {fmtEventCell(
            eventCellValue(e, row.original.events ?? {}, row.original.counted_clickers),
            e.kind,
          )}
        </span>
      ),
    }));
    const at = rest.findIndex((c) => c.id === "cost");
    const withEvents =
      at < 0 ? [...rest, ...generated] : [...rest.slice(0, at), ...generated, ...rest.slice(at)];
    return [campaignCol, stageCol, ...withEvents];
  }, [filters.groupBy, deliveryAvailable, deliveryFreshness, block]);

  const isAuthLoading = !auth;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Live campaign performance from Keitaro: the Clickers → Offer Redirect
          → Sales funnel, per stage or rolled up per campaign. Times in{" "}
          {CAMPAIGN_TIMEZONE_LABEL}.
        </p>
        {canRefresh ? (
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={pollApi.isLoading}
          >
            <RefreshCw
              className={pollApi.isLoading ? "size-4 animate-spin" : "size-4"}
              aria-hidden
            />
            {pollApi.isLoading ? "Syncing…" : "Refresh from Keitaro"}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => updateFilters({ from: e.target.value, page: 0 })}
            className="h-9 w-[160px]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => updateFilters({ to: e.target.value, page: 0 })}
            className="h-9 w-[160px]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Group by</Label>
          <div className="flex h-9 items-center rounded-md border p-0.5">
            {(["stage", "campaign"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => updateFilters({ groupBy: g, page: 0 })}
                className={
                  "h-8 rounded px-3 text-sm capitalize transition-colors " +
                  (filters.groupBy === g
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {g}
              </button>
            ))}
          </div>
        </div>
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search campaign, stage, tracking id…"
          className="h-9 w-full max-w-xs"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            resetFilters();
            setSearchInput("");
          }}
        >
          Reset
        </Button>
      </div>

      {totals ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-8">
            <StatCard
              label="Clickers"
              value={`${fmtInt(totals.clickers)}${totals.clickers_is_fallback ? "*" : ""}`}
            />
            <StatCard
              label="Offer Redirect"
              value={fmtInt(totals.offer_redirect)}
            />
            <StatCard
              label="Sales"
              value={fmtInt(totals.sales)}
              hint={totals.manual_topup > 0 ? `${fmtInt(totals.manual_topup)} from the manual tally` : undefined}
            />
            <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
            {/* Held money, beside the revenue it is NOT part of. The table has
                carried a "Pending $" column since Task 6; without the tile the
                totals card silently dropped the figure at the one grain an
                operator reads first. "—" when nothing is held, matching the
                campaign page's tile rather than asserting $0.00. */}
            <StatCard
              label="Pending $"
              value={totals.pending_revenue > 0 ? fmtUsd(totals.pending_revenue) : "—"}
            />
            <StatCard label="Cost" value={fmtUsd(totals.cost)} />
            <StatCard label="Profit" value={fmtUsd(totals.profit)} />
            <StatCard label="Avg Opt-out" value={fmtPct(totals.opt_out_rate)} />
          </div>
          {totals.clickers_is_fallback ? (
            <p className="mt-2 text-xs text-muted-foreground">
              * CamMan clicks — Keitaro visits unavailable for this period. Rates that
              divide by Keitaro visits show —.
            </p>
          ) : null}
        </>
      ) : null}

      {/* ⭐ MOUNTED UNCONDITIONALLY, AND NEVER INSIDE A `showEvents` BRANCH.
          EventColumnsBar carries the Event-breakdown toggle AND the unmapped
          badge together (they are not separately exported), so the breakdown
          cannot be on screen while the count of conversions it fails to explain
          is hidden. It takes the same `block` the columns came from, so the two
          cannot describe different responses. It sits OUTSIDE the empty state: a
          wholly unmapped conversion resolves to no stage, so it appears in no
          row and a range whose table is empty can still have strays worth
          seeing. On a fetch ERROR there is nothing to describe — the response is
          cleared, so the block is empty and the bar renders nothing. */}
      <EventColumnsBar block={block} onShowEventsChange={(v) => updateFilters({ showEvents: v })} />

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load reports: {fetchError}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>
            Retry
          </Button>
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-16 text-center">
          <BarChart3 className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No results in this range</p>
            <p className="text-sm text-muted-foreground">
              Keitaro data appears here once a tracked campaign gets clicks. Try a
              wider date range
              {canRefresh ? " or refresh from Keitaro" : ""}.
            </p>
          </div>
        </div>
      ) : (
        <DataTable<ReportRow>
          data={data}
          columns={columns}
          isLoading={listApi.isLoading}
          pageIndex={filters.page}
          pageSize={filters.pageSize}
          totalCount={totalCount}
          onPageChange={(p) => updateFilters({ page: p })}
          onPageSizeChange={(s) => updateFilters({ pageSize: s, page: 0 })}
          sortBy={sortById || null}
          sortDir={sortDirection}
          // ⭐ THE ONLY SCREEN ON THE NEW CYCLE, AND DELIBERATELY OPT-IN. A
          // header click here opens DESCENDING — for a report column the
          // interesting end is the top of the list — flips to ascending, and
          // never clears (owner: an unsorted report is a step he will never
          // want). Every other DataTable in the app keeps asc → desc → clear,
          // which is why this is a prop and not a change to the wrapper's
          // default. The By-X tabs' own `toggleSort` already behaves this way.
          sortCycle="desc-asc"
          onSortChange={(by, dir) =>
            updateFilters({ sortBy: by ?? "revenue", sortDir: dir, page: 0 })
          }
        />
      )}

      {isAuthLoading ? (
        <p className="sr-only" aria-live="polite">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
