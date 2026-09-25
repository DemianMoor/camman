"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  History,
  MoreHorizontal,
  Pause,
  Pencil,
  PenLine,
  Play,
  Send,
  Split,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { type AudienceFilters } from "@/components/campaigns/campaign-form";
import { DripConfigPanel } from "@/components/campaigns/drip-config-panel";
import { CampaignSendMode } from "@/components/campaigns/campaign-send-mode";
import { CampaignActivitySection } from "@/components/campaigns/campaign-activity-section";
import { ClickReportSection } from "@/components/campaigns/click-report-section";
// The PURE rules module — importing "@/lib/reporting/tracking-gap" here would
// drag drizzle-orm into the client bundle. Same rule object either way.
import {
  shouldSubstituteClickers,
  substitutionDominates,
} from "@/lib/reporting/tracking-gap-rules";
// The SAME per-event surfaces the report tables mount, and for the same reason:
// there is exactly one definition of what a per-event segment says and of what
// the unclassified count beside it says. Each component renders the breakdown
// and its residual TOGETHER — see StageEventBreakdown.
//
// (This chain does NOT drag db/client into the client bundle the way
// "@/lib/reporting/tracking-gap" would: lib/reporting/event-columns imports the
// db only as a TYPE.)
import {
  addEventMaps,
  EventTotalsTiles,
  StageEventBreakdown,
  visibleEventTypes,
  type EventBreakdownSource,
} from "@/components/reports/event-columns-view";
import type { EventMap, EventTypeSpec } from "@/lib/reporting/event-columns";
import { ExportClickersDialog } from "@/components/campaigns/export-clickers-dialog";
import {
  StagePrepareDialog,
  type PrepareTarget,
} from "@/components/campaigns/stage-prepare-dialog";
import { StageStatusLegend } from "@/components/campaigns/stage-status-legend";
import {
  deriveStageOperationalStatus,
  STAGE_STATUS_META,
} from "@/lib/stages/stage-status";
import type { SplitLanePreview } from "@/lib/stages/split-group";
import { PhoneUploadForm } from "@/components/phone-upload-form";
import {
  combineSales,
  formatRevenue,
  formatRoi,
  manualSalesTopup,
  stageRoi,
} from "@/lib/stage-results";
import { StageInlineEditor } from "@/components/campaigns/stage-inline-creator";
import {
  StatusChangeDialog,
  type CampaignTransition,
  transitionToStatus,
} from "@/components/campaigns/status-change-dialog";
import { DataTable } from "@/components/data-table";
import { DeferUntilVisible } from "@/components/defer-until-visible";
import { useAuth } from "@/components/protected/auth-context";
import {
  StatusDropdown,
  type StatusOption,
} from "@/components/status-dropdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { exclTimingInput } from "@/lib/campaigns/excl-timing-warning";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

// These heavy dialog/panel bodies are each mounted only when their `{state ?
// <Comp/> : null}` guard opens the dialog, so load their code on demand rather
// than in the campaign-detail page's initial bundle. ResultsImportForm (~793
// lines) and StageSendPanel (~517 lines) are the biggest. ssr:false — they only
// ever render client-side inside an opened dialog.
const dlgLoading = () => (
  <div className="p-6 text-sm text-muted-foreground">Loading…</div>
);
const ResultsImportForm = dynamic(
  () =>
    import("@/components/campaigns/results-import-form").then(
      (m) => m.ResultsImportForm,
    ),
  { ssr: false, loading: dlgLoading },
);
const ManualResultsForm = dynamic(
  () =>
    import("@/components/campaigns/manual-results-form").then(
      (m) => m.ManualResultsForm,
    ),
  { ssr: false, loading: dlgLoading },
);
const ImportHistoryDialog = dynamic(
  () =>
    import("@/components/campaigns/import-history-dialog").then(
      (m) => m.ImportHistoryDialog,
    ),
  { ssr: false, loading: dlgLoading },
);
const StageSendPanel = dynamic(
  () =>
    import("@/components/campaigns/stage-send-panel").then(
      (m) => m.StageSendPanel,
    ),
  { ssr: false, loading: dlgLoading },
);

// =============== Types ===============

type Info = { id: number; name: string; color: string | null };
type Offer = Info & {
  sales_pages?: { label: string; url: string }[];
  base_url?: string | null;
  postfix?: string | null;
};
type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";
type StageStatus =
  | "draft"
  | "pending"
  | "sent"
  | "success"
  | "cancelled"
  | "failed"
  | "archived";
type ActiveStageStatus = Exclude<StageStatus, "archived">;

type CampaignDetail = {
  id: number;
  slug: string;
  human_id: string | null;
  name: string;
  // 'regular' | 'drip' (Drip Phase 4). Absent on an older cached response,
  // which renders as regular — the same fail-toward-existing-behaviour default.
  type?: string;
  notes: string | null;
  brand_id: number;
  offer_id: number;
  routing_type_id: number | null;
  traffic_type_id: number | null;
  assigned_to_user_id: string | null;
  created_by_user_id: string | null;
  audience_segment_ids: number[];
  // Needed by the Excl-timing warning; GET /api/campaigns/[campaignId] has
  // always returned it, the client type just never carried it.
  audience_exclude_segment_ids: number[] | null;
  audience_contact_group_ids: number[];
  audience_filters: AudienceFilters;
  audience_snapshot_count: number;
  audience_cap: number | null;
  exclude_in_use_contacts: boolean;
  start_date: string | null;
  end_date: string | null;
  status: CampaignStatus;
  status_changed_at: string;
  tracking_id: string | null;
  link_mode: "manual" | "tracked";
  // campaigns.lifecycle_rules (migration 0187).
  lifecycle_rules?: boolean;
  // Default send-from phone for new stages (Task 7/9, migration 0115). NULL
  // when the campaign has no default — new stages then fall back to
  // StageForm's own null defaults.
  default_provider_phone_id: number | null;
  archived_at: string | null;
  created_at: string;
  brand: (Info & { short_domain: string | null }) | null;
  offer: Offer | null;
  routing_type: Info | null;
  traffic_type: Info | null;
  stage_count_total: number;
  stage_count_by_status: Record<string, number>;
};

type Stage = {
  // Drip P5 window fields. Absent on a regular stage.
  window_start_min?: number | null;
  window_end_min?: number | null;
  drip_active?: boolean | null;
  id: number;
  campaign_id: number;
  stage_number: number;
  label: string | null;
  creative_id: number | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  sales_page_label: string | null;
  short_url: string | null;
  full_url: string | null;
  // 1b: WHICH PAGE the stage points at; the URL is built at mint time.
  landing_page_id: number | null;
  utm_tag_ids: number[] | null;
  stop_text: string;
  include_clickers: boolean;
  exclude_clickers: boolean;
  include_no_status: boolean;
  scheduled_at: string | null;
  sent_at: string | null;
  materialized_at: string | null;
  schedule_missed_at: string | null;
  send_approved: boolean;
  status: StageStatus;
  sms_count: number;
  total_cost: string;
  // When false, total_cost is auto = cost_per_sms × (sms_count + opt_out_count).
  // When true, it's an operator override / CSV-imported provider cost.
  total_cost_manual: boolean;
  delivered_count: number;
  opt_out_count: number;
  // Inbound STOP opt-outs attributed to this stage via the poller's 72h-window
  // match (migration 0075) — campaign_stages.inbound_opt_out_count, the same
  // source the Reports page reads. Distinct from the import-fed opt_out_count.
  inbound_stop_count: number;
  click_count: number;
  scrubbed_count: number;
  bounced_count: number;
  checkout_click_count: number;
  sales_count: number;
  // Keitaro conversions for this stage (added on top of the manual sales_count).
  keitaro_sales_count: number;
  // Real per-conversion revenue from Keitaro (summed across stat_dates). The
  // revenue source of truth — never sales × the offer's current CPA.
  keitaro_revenue: string;
  // Same money, still pending approval — never added into revenue/ROI/EPC.
  keitaro_pending_revenue: string;
  // The same conversions, split per event_types.key (migration 0185), and the
  // ones that matched NO mapping. The two travel together everywhere: the
  // unmapped count is in no other field, so it is the only account of why the
  // segments need not sum to Sales.
  keitaro_events: EventMap;
  keitaro_unmapped: number;
  // Tracking-gap inputs. When a tracked stage's landing page ships without the
  // Keitaro visit script, these stay 0 while CamMan keeps recording every tap —
  // so the Clickers total substitutes counted_clickers. See the totals memo.
  keitaro_visit_clicks_raw: number;
  keitaro_visit_clicks_clean: number;
  counted_clickers: number;
  sales_payout_each: string | null;
  notes: string | null;
  tracking_id: string | null;
  split_index: number | null;
  split_total: number | null;
  // Behavioral lane (step 5). behavioral_tier NULL ⇒ ordinary stage; 0/1/2/3 ⇒ a
  // lane hanging off parent_stage_id (the prior position); 3 is Registered since
  // Phase 4. audience_count is the LIVE lane preview for lanes (alive + exact
  // tier − opt-outs, Purchased contacts excluded).
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  archived_at: string | null;
  created_at: string;
  // Non-lane stages carry their batched count. Behavioral lanes come back null
  // from the list (their live count is deferred to the lane-counts endpoint) and
  // are patched in after first paint — null renders as a "computing…" state.
  audience_count: number | null;
  // WS4 §0: campaign link mode (propagated from the parent) + stage_sends
  // materialization counts. Drive the derived operational status / row color.
  link_mode: "manual" | "tracked";
  send_counts: {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    skippedDuplicate: number;
  };
  creative: { id: number; slug: string; text: string } | null;
  provider: Info | null;
  provider_phone: {
    id: number;
    phone_number: string;
    cost_per_sms: string;
  } | null;
  offer: {
    id: number;
    name: string;
    color: string | null;
    payout_cpa: string | null;
  } | null;
};

/**
 * ⭐ ONE STAGE ROW → THE BREAKDOWN AND BOTH ITS RESIDUALS, FROM ONE OBJECT.
 *
 * The counts, the strays and the manual top-up are read off the SAME row here,
 * so a Results cell cannot show one stage's segments beside another number — the
 * hole the report tables closed by deriving their bar from the very `totals`
 * the columns came from. The top-up is computed rather than fetched because the
 * row already carries both sides of it, and manualSalesTopup() is the same
 * definition `sales` itself uses (lib/stage-results.ts) — not a second one.
 */
function stageEventSource(s: Stage): EventBreakdownSource {
  return {
    events: s.keitaro_events ?? {},
    unmapped: s.keitaro_unmapped ?? 0,
    manual_topup: manualSalesTopup(s.sales_count, s.keitaro_sales_count),
  };
}

type StagesListResponse = {
  data: Stage[];
  totalCount: number;
  // Campaign-level DISTINCT contacts attributed an inbound STOP (migration 0075).
  inbound_stop_contacts: number;
  // The org's event-type registry, once per response. The Results cell and the
  // totals tiles are generated from THIS, never from the keys present in the
  // data, so a configured type with no conversions reads 0 instead of vanishing.
  event_types: EventTypeSpec[];
};

type Member = {
  id: string;
  email: string | null;
  display_name: string | null;
};

const CAMPAIGN_STATUS_COLOR: Record<CampaignStatus, string> = {
  draft:
    "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
  active:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  paused:
    "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
  completed:
    "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  archived:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

const STAGE_STATUS_COLOR: Record<StageStatus, string> = {
  draft:
    "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
  pending:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  sent: "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  success:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  cancelled:
    "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  failed:
    "border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  archived:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

const ALL_STAGE_STATUSES: StageStatus[] = [
  "draft",
  "pending",
  "sent",
  "success",
  "cancelled",
  "failed",
];

// Behavioral-lane tier → human label + chip color. A LOCAL duplicate of
// LANE_TIERS in lib/stages/behavioral-split.ts on purpose: this is a client
// component and that module pulls in the db client. Tier 4 (purchased) is never
// a lane — those contacts exit the sequence — so it is intentionally absent.
const BEHAVIORAL_TIER_META: Record<
  number,
  { label: string; className: string }
> = {
  0: {
    label: "Ignored",
    className:
      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  },
  1: {
    label: "Clicked",
    className:
      "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  },
  2: {
    label: "Reached offer",
    className:
      "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  3: {
    label: "Registered",
    className:
      "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
};

// The client's copy of DEFAULT_LANE_TIERS (lib/stages/behavioral-split.ts). It
// CANNOT be imported — this is a client component and that module pulls in the
// db client — so it is duplicated on purpose and named once here instead of
// twice inline. If the server default changes, this changes with it, and the
// two must be edited together: the server's is what an omitted request body
// gets, this one is what the picker ticks.
// ⚠️ FROZEN, AND COPIED AT EVERY USE. It was a plain array handed BY REFERENCE
// to both useState and the reset below, so one future non-mutating-by-accident
// handler (`prev.push(…)`, `prev.sort()`) would have rewritten "the default" for
// the rest of the session — silently, and only after the first tick. The server's
// counterpart is already `readonly number[]`; this one now matches it, and
// Object.freeze makes the mistake throw in strict mode instead of sticking.
const DEFAULT_SELECTED_TIERS: readonly number[] = Object.freeze([1, 2]);

// Stage status is freely assignable among the non-archived states via an
// inline dropdown, so an operator can record the resulting status directly.
// (archived is reached through the Archive action, not this list.)
const STAGE_STATUS_OPTIONS: StatusOption<ActiveStageStatus>[] = [
  { value: "draft", label: "Draft", color: "gray" },
  { value: "pending", label: "Pending", color: "amber" },
  { value: "sent", label: "Sent", color: "sky" },
  { value: "success", label: "Success", color: "green" },
  { value: "cancelled", label: "Cancelled", color: "gray" },
  { value: "failed", label: "Failed", color: "red" },
];

type StagesFilters = {
  statuses: StageStatus[];
  showArchived: boolean;
  pageSize: number;
};

const DEFAULT_STAGE_FILTERS: StagesFilters = {
  statuses: [],
  showArchived: false,
  pageSize: 20,
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = Number(params.id);
  const { auth, can } = useAuth();

  const campaignApi = useApiCall<CampaignDetail>();
  const stagesApi = useApiCall<StagesListResponse>();
  // Behavioral-lane audience counts are fetched separately (deferred off the
  // stages list so the table paints fast) and patched into `stages`.
  const laneCountsApi = useApiCall<{ counts: Record<number, number> }>();
  const membersApi = useApiCall<{ data: Member[] }>();
  const campaignStatusApi = useApiCall<CampaignDetail>();
  const campaignArchiveApi = useApiCall<CampaignDetail>();
  const campaignRestoreApi = useApiCall<CampaignDetail>();
  const stageStatusApi = useApiCall<Stage>();
  const stageArchiveApi = useApiCall<Stage>();
  const stageRestoreApi = useApiCall<Stage>();
  const stageDeleteApi = useApiCall<{
    deleted: boolean;
    id: number;
    split_reset_stage_id: number | null;
  }>();
  const stageCancelApi = useApiCall<{ ok: boolean; discarded: number }>();
  const stageDuplicateApi = useApiCall<Stage>();
  const behavioralSplitApi = useApiCall<{
    split_group_id: string;
    anchor_stage_id: number;
    source_stage_ids_preview: number[];
    lane_stage_ids: number[];
    tiers: (number | null)[];
  }>();
  const splitPreviewApi = useApiCall<SplitLanePreview>();

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignTick, setCampaignTick] = useState(0);
  const refetchCampaign = useCallback(() => setCampaignTick((n) => n + 1), []);

  const [stages, setStages] = useState<Stage[]>([]);
  // Campaign-level distinct contacts who STOPped (server-computed; see the
  // stages list endpoint). Drives the "Inbound STOPs" rollup metric.
  const [inboundStopContacts, setInboundStopContacts] = useState(0);
  // The org's event-type registry, as the stages endpoint returned it.
  const [eventTypes, setEventTypes] = useState<EventTypeSpec[]>([]);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const [stagesTick, setStagesTick] = useState(0);
  const refetchStages = useCallback(() => setStagesTick((n) => n + 1), []);

  // Bulk-selection state for stages. Set of stage IDs currently checked.
  // Cleared on every fresh stages fetch so stale ids don't survive a
  // filter change.
  const [selectedStageIds, setSelectedStageIds] = useState<Set<number>>(
    new Set(),
  );
  const [stageBulkBusy, setStageBulkBusy] = useState(false);
  useEffect(() => {
    setSelectedStageIds(new Set());
  }, [stages]);
  const stageBulkApi = useApiCall<{
    succeeded: number[];
    failed: { id: number; reason: string }[];
  }>();
  async function runStageBulk(
    target: "success" | "failed" | "cancelled" | "archived",
  ) {
    if (selectedStageIds.size === 0) return;
    setStageBulkBusy(true);
    const result = await stageBulkApi.execute(
      `/api/campaigns/${campaignId}/stages/bulk-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage_ids: Array.from(selectedStageIds),
          target_status: target,
          confirm: true,
        }),
      },
    );
    setStageBulkBusy(false);
    if (!result.ok) {
      toastApiError(result, "Couldn't apply bulk action");
      return;
    }
    const { succeeded, failed } = result.data;
    if (succeeded.length > 0 && failed.length === 0) {
      toast.success(`${succeeded.length} stages updated`);
    } else if (succeeded.length > 0) {
      toast.warning(
        `${succeeded.length} updated, ${failed.length} skipped: ${failed
          .map((f) => f.reason)
          .slice(0, 3)
          .join(", ")}${failed.length > 3 ? "…" : ""}`,
      );
    } else {
      toast.error(
        `0 updated, ${failed.length} skipped: ${failed
          .map((f) => f.reason)
          .slice(0, 3)
          .join(", ")}`,
      );
    }
    setSelectedStageIds(new Set());
    refetchStages();
  }

  const [members, setMembers] = useState<Member[]>([]);

  // Per-campaign persisted filters for the stages table.
  const [stageFilters, updateStageFilters, resetStageFilters] =
    usePersistedFilters<StagesFilters>(
      `campaign-${campaignId}.stages.filters`,
      DEFAULT_STAGE_FILTERS,
    );

  useEffect(() => {
    if (!Number.isInteger(campaignId) || campaignId <= 0) return;
    let cancelled = false;
    (async () => {
      const r = await campaignApi.execute(`/api/campaigns/${campaignId}`);
      if (cancelled) return;
      if (r.ok) setCampaign(r.data);
      else setCampaignError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, campaignTick, campaignApi.execute]);

  useEffect(() => {
    if (!Number.isInteger(campaignId) || campaignId <= 0) return;
    let cancelled = false;
    const sp = new URLSearchParams();
    if (stageFilters.statuses.length > 0)
      sp.set("status", stageFilters.statuses.join(","));
    if (stageFilters.showArchived) sp.set("showArchived", "true");
    const qs = sp.toString();
    (async () => {
      const r = await stagesApi.execute(
        `/api/campaigns/${campaignId}/stages${qs ? `?${qs}` : ""}`,
      );
      if (cancelled) return;
      if (r.ok) {
        setStages(r.data.data);
        setInboundStopContacts(r.data.inbound_stop_contacts ?? 0);
        setEventTypes(r.data.event_types ?? []);
        // Lane audience counts are deferred (their live-tier scan is slow). Fetch
        // them in the background only when lanes are actually on screen, then
        // patch the null placeholders in place. First paint doesn't wait on this.
        const hasLanes = r.data.data.some((s) => s.behavioral_tier != null);
        if (hasLanes) {
          const lr = await laneCountsApi.execute(
            `/api/campaigns/${campaignId}/stages/lane-counts${qs ? `?${qs}` : ""}`,
          );
          if (cancelled) return;
          if (lr.ok) {
            const counts = lr.data.counts;
            setStages((prev) =>
              prev.map((s) =>
                s.behavioral_tier != null && counts[s.id] != null
                  ? { ...s, audience_count: counts[s.id] }
                  : s,
              ),
            );
          }
        }
      } else setStagesError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    campaignId,
    stageFilters.statuses,
    stageFilters.showArchived,
    stagesTick,
    stagesApi.execute,
    laneCountsApi.execute,
  ]);

  useEffect(() => {
    (async () => {
      const r = await membersApi.execute("/api/members");
      if (r.ok) setMembers(r.data.data);
    })();
  }, [membersApi.execute]);

  // ============ Dialog state ============
  // When the transition dialog was opened. Captured in the handler because
  // Date.now() during render is impure (react-hooks/purity) AND would re-run on
  // every render, quietly moving the 24h boundary under the dialog.
  const [transitionOpenedAt, setTransitionOpenedAt] = useState(0);
  const [campaignTransition, setCampaignTransition] =
    useState<CampaignTransition | null>(null);
  const [campaignArchiveConfirm, setCampaignArchiveConfirm] = useState<
    null | "archive" | "restore"
  >(null);

  const [addStageOpen, setAddStageOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<Stage | null>(null);

  // Deep-link from the Reports page: `?stage=<id>` opens that stage's editor
  // once the stages list has loaded. Captured at first render, consumed once.
  const [pendingStageFocus, setPendingStageFocus] = useState<number | null>(
    () => {
      if (typeof window === "undefined") return null;
      const raw = new URLSearchParams(window.location.search).get("stage");
      const id = raw ? Number(raw) : NaN;
      return Number.isInteger(id) && id > 0 ? id : null;
    },
  );
  useEffect(() => {
    if (pendingStageFocus == null || stages.length === 0) return;
    const target = stages.find((s) => s.id === pendingStageFocus);
    if (target) {
      setEditingStage(target);
      setAddStageOpen(true);
    }
    setPendingStageFocus(null);
  }, [pendingStageFocus, stages]);
  const [stageArchiveConfirm, setStageArchiveConfirm] = useState<{
    kind: "archive" | "restore";
    stage: Stage;
  } | null>(null);
  const [stageDeleteConfirm, setStageDeleteConfirm] = useState<Stage | null>(
    null,
  );
  const [stageCancelConfirm, setStageCancelConfirm] = useState<Stage | null>(
    null,
  );
  // 0174: the split is CAMPAIGN-level now, so there is no target stage — just
  // "is the confirm modal open" plus the provisional preview it renders.
  const [behavioralSplitOpen, setBehavioralSplitOpen] = useState(false);
  const [splitPreview, setSplitPreview] = useState<SplitLanePreview | null>(
    null,
  );
  // Which behavioural lanes the split will create — DEFAULT_SELECTED_TIERS, the
  // client's named copy of the server's DEFAULT_LANE_TIERS. Tier 0 ("Ignored")
  // starts OFF because the operator deleted it by hand after all but 4 of the
  // first 77 splits, and a forgotten one silently freezes its scheduled
  // siblings. Tier 3 ("Registered", Phase 4) starts OFF too, so adding the lane
  // changes nobody's workflow until it is ticked deliberately. Reset in
  // openBehavioralSplit (an event handler), never in an effect.
  const [selectedTiers, setSelectedTiers] = useState<number[]>([
    ...DEFAULT_SELECTED_TIERS,
  ]);
  const [importStage, setImportStage] = useState<Stage | null>(null);
  const [manualStage, setManualStage] = useState<Stage | null>(null);
  const [historyStage, setHistoryStage] = useState<Stage | null>(null);
  const [sendStage, setSendStage] = useState<Stage | null>(null);
  // WS4 §A4: one-click Prepare target from the stages-list row (Orange rows).
  const [prepareTarget, setPrepareTarget] = useState<PrepareTarget | null>(
    null,
  );
  const [uploadContactsOpen, setUploadContactsOpen] = useState(false);

  const canUpdateCampaign = can("campaigns.update");
  const canUploadContacts = canUpdateCampaign && can("contacts.upload");
  const canActivate = can("campaigns.activate");
  const canPause = can("campaigns.pause");
  const canComplete = can("campaigns.complete");
  const canArchiveCampaign = can("campaigns.archive");
  const canRestoreCampaign = can("campaigns.restore");
  const canCreateStage = can("stages.create");
  const canUpdateStage = can("stages.update");
  const canSendStage = can("stages.send");
  const canArchiveStage = can("stages.archive");
  const canRestoreStage = can("stages.restore");
  const canDeleteStage = can("stages.delete");
  const canImportResults = can("result_imports.create");
  const canViewImports = can("result_imports.view");

  // ============ Handlers ============

  async function handleCampaignTransition() {
    if (!campaign || !campaignTransition) return;
    const next = transitionToStatus(campaignTransition);
    const result = await campaignStatusApi.execute(
      `/api/campaigns/${campaign.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't change status");
      return;
    }
    toast.success(`Campaign ${next}`);
    setCampaignTransition(null);
    refetchCampaign();
  }

  async function handleCampaignArchiveRestore() {
    if (!campaign || !campaignArchiveConfirm) return;
    const isArchive = campaignArchiveConfirm === "archive";
    const api = isArchive ? campaignArchiveApi : campaignRestoreApi;
    const result = await api.execute(
      `/api/campaigns/${campaign.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Campaign archived" : "Campaign restored");
    setCampaignArchiveConfirm(null);
    refetchCampaign();
  }

  async function handleStageStatusChange(
    stage: Stage,
    next: ActiveStageStatus,
  ) {
    const result = await stageStatusApi.execute(
      `/api/campaigns/${campaignId}/stages/${stage.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't change stage status");
      return;
    }
    toast.success(`Stage marked ${next}`);
    refetchStages();
    refetchCampaign();
  }

  async function handleStageDuplicate(stage: Stage) {
    const result = await stageDuplicateApi.execute(
      `/api/campaigns/${campaignId}/stages/${stage.id}/duplicate`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't duplicate stage");
      return;
    }
    toast.success(`Stage ${result.data.stage_number} created`);
    refetchStages();
    refetchCampaign();
  }

  async function handleStageArchiveRestore() {
    if (!stageArchiveConfirm) return;
    const isArchive = stageArchiveConfirm.kind === "archive";
    const api = isArchive ? stageArchiveApi : stageRestoreApi;
    const result = await api.execute(
      `/api/campaigns/${campaignId}/stages/${stageArchiveConfirm.stage.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Stage archived" : "Stage restored");
    setStageArchiveConfirm(null);
    refetchStages();
    refetchCampaign();
  }

  async function handleStageDelete() {
    if (!stageDeleteConfirm) return;
    const result = await stageDeleteApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageDeleteConfirm.id}`,
      { method: "DELETE" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success("Stage deleted");
    setStageDeleteConfirm(null);
    refetchStages();
    refetchCampaign();
  }

  // Cancel a materialized-but-unsent stage: discards the pending rows (kept as
  // 'rejected' for audit), un-approves, and resets materialized_at so the stage
  // is editable + re-preparable. Same endpoint the (now-removed) Send-panel
  // cancel used; guard rejects anything already sent/sending.
  async function handleStageCancel() {
    if (!stageCancelConfirm) return;
    const result = await stageCancelApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageCancelConfirm.id}/send/abort`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't cancel the send");
      return;
    }
    toast.success(
      `Send cancelled — ${result.data.discarded.toLocaleString()} pending message${result.data.discarded === 1 ? "" : "s"} discarded. The stage is editable again.`,
    );
    setStageCancelConfirm(null);
    refetchStages();
    refetchCampaign();
  }

  // 0174: open the confirm modal and fetch the PROVISIONAL preview (source scope
  // + live per-tier counts). The preview is a seconds-long live tier scan, so it
  // is fetched on open — never inline in the stages list.
  async function openBehavioralSplit() {
    setSplitPreview(null);
    setSelectedTiers([...DEFAULT_SELECTED_TIERS]);
    setBehavioralSplitOpen(true);
    const result = await splitPreviewApi.execute(
      `/api/campaigns/${campaignId}/behavioral-split/preview`,
    );
    if (result.ok) setSplitPreview(result.data);
    else toastApiError(result, "Couldn't compute the split preview");
  }

  async function handleBehavioralSplit() {
    const result = await behavioralSplitApi.execute(
      `/api/campaigns/${campaignId}/behavioral-split`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiers: selectedTiers }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't create behavioral lanes");
      return;
    }
    // Name the lanes ACTUALLY created — the old copy hard-coded "3 lanes", which
    // stops being true the moment the operator unticks one. Reuses the page's
    // existing tier→label map; the lib's LANE_TIERS can't be imported here
    // because this is a client component and that module pulls in the db client.
    const created = [...selectedTiers]
      .sort((a, b) => a - b)
      .map((t) => BEHAVIORAL_TIER_META[t]?.label ?? `Tier ${t}`);
    toast.success(
      `Behavioral split — ${created.length} lane${created.length === 1 ? "" : "s"} created (${created.join(" / ")}). Set a send time on each lane.`,
    );
    setBehavioralSplitOpen(false);
    setSplitPreview(null);
    refetchStages();
    refetchCampaign();
  }

  // ============ Behavioral-lane derivations ============
  // parent_stage_id → its LIVE (non-archived) lane stages, and id → stage_number,
  // so lane rows can show "from #N" and parent rows can show a "N lanes" badge.
  // Archived lanes are excluded so a re-split (old lanes archived, new trio
  // created) shows the current trio's count, not archived+live — matches the
  // backend's own "already has lanes" gate (ne(status, "archived") in
  // lib/stages/behavioral-split.ts). Derived from the already-loaded stages
  // list — no extra fetch.
  const lanesByParent = useMemo(() => {
    const m = new Map<number, Stage[]>();
    for (const s of stages) {
      if (s.parent_stage_id != null && s.status !== "archived") {
        const arr = m.get(s.parent_stage_id) ?? [];
        arr.push(s);
        m.set(s.parent_stage_id, arr);
      }
    }
    return m;
  }, [stages]);
  const stageNumberById = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of stages) m.set(s.id, s.stage_number);
    return m;
  }, [stages]);
  const hasBehavioralLanes = lanesByParent.size > 0;

  // 0174: gate for the campaign-level "Behavioral split…" button. MIRRORS the
  // server predicate in lib/sends/stage-complete.ts — sent_at set AND no
  // pending/sending rows left — deliberately NOT `status`, which is the
  // operator's manual record and disagrees with the pipeline on real stages.
  // Lanes are excluded here for the same reason the server excludes them.
  // This only decides whether the button is ENABLED; the endpoint re-checks and
  // returns `no_completed_stages` on its own.
  const hasCompletedStage = useMemo(
    () =>
      stages.some(
        (s) =>
          s.behavioral_tier == null &&
          s.status !== "archived" &&
          s.sent_at != null &&
          s.send_counts.pending === 0 &&
          s.send_counts.sending === 0,
      ),
    [stages],
  );

  // The event types this campaign's table renders a segment for — computed ONCE
  // for the whole table, so every row carries the same segments in the same
  // order and the totals tiles agree with the rows above them.
  //
  // An ACTIVE type is always in, with or without conversions (that is what
  // "generated from the registry" buys); an ARCHIVED one only while some stage
  // on screen still has a non-zero entry for it, so retiring a type eventually
  // retires its segment without erasing history that is still displayed.
  const shownEventTypes = useMemo(
    () =>
      visibleEventTypes(
        eventTypes,
        stages.map((s) => s.keitaro_events ?? {}),
      ),
    [eventTypes, stages],
  );

  // ============ Stage columns ============

  function activityFilterLabel(s: Stage): string {
    if (s.include_clickers) return "Clickers only";
    if (s.exclude_clickers) return "Excluding clickers";
    return "All";
  }

  // WS4 §0: derived operational status for a stage (null = off the model:
  // manual campaign or archived stage → falls back to the manual-status color).
  function stageOpStatus(s: Stage) {
    return deriveStageOperationalStatus({
      linkMode: s.link_mode,
      status: s.status,
      scheduledAt: s.scheduled_at,
      sentAt: s.sent_at,
      scheduleMissedAt: s.schedule_missed_at,
      materializedAt: s.materialized_at,
      counts: s.send_counts,
    });
  }

  const stageColumns = useMemo<ColumnDef<Stage>[]>(
    () => [
      {
        id: "select",
        header: () => null,
        enableSorting: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedStageIds.has(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() =>
              setSelectedStageIds((prev) => {
                const next = new Set(prev);
                if (next.has(row.original.id)) next.delete(row.original.id);
                else next.add(row.original.id);
                return next;
              })
            }
            aria-label="Select stage"
            className="size-4 cursor-pointer"
          />
        ),
      },
      {
        id: "stage_number",
        header: "#",
        enableSorting: true,
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.original.stage_number}
          </Badge>
        ),
      },
      {
        id: "label",
        header: "Label",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          const tierMeta =
            s.behavioral_tier != null
              ? BEHAVIORAL_TIER_META[s.behavioral_tier]
              : null;
          const parentNumber =
            s.parent_stage_id != null
              ? stageNumberById.get(s.parent_stage_id)
              : undefined;
          const laneCount = lanesByParent.get(s.id)?.length ?? 0;
          return (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Lane chip: a lane belongs to a parent position. The ↳ + "from #N"
                  makes the parent→lanes relationship obvious in the flat table. */}
                {tierMeta ? (
                  <Badge
                    variant="outline"
                    className={cn("text-[10px]", tierMeta.className)}
                    title={
                      parentNumber != null
                        ? `Behavioral lane (tier ${s.behavioral_tier}) from stage #${parentNumber}`
                        : `Behavioral lane (tier ${s.behavioral_tier})`
                    }
                  >
                    ↳ {tierMeta.label}
                    {parentNumber != null ? (
                      <span className="ml-1 opacity-70">
                        · from #{parentNumber}
                      </span>
                    ) : null}
                  </Badge>
                ) : null}
                {row.original.label ? (
                  <span className="text-sm">{row.original.label}</span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    (no label)
                  </span>
                )}
                {row.original.split_total && row.original.split_index ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Split {row.original.split_index}/{row.original.split_total}
                  </Badge>
                ) : null}
                {/* Parent position: announce that this stage spawned lanes. */}
                {laneCount > 0 ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {laneCount} behavioral lane{laneCount === 1 ? "" : "s"}
                  </Badge>
                ) : null}
              </div>
              {row.original.tracking_id ? (
                <button
                  type="button"
                  className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                  title="Click to copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard
                      .writeText(row.original.tracking_id as string)
                      .then(() => toast.success("Tracking ID copied"))
                      .catch(() => toast.error("Couldn't copy"));
                  }}
                >
                  {row.original.tracking_id}
                </button>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "creative",
        header: "Creative",
        enableSorting: false,
        cell: ({ row }) => {
          const c = row.original.creative;
          if (!c) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="min-w-0" title={c.text}>
              <div className="font-mono text-xs text-muted-foreground">
                {c.slug}
              </div>
              <div className="truncate text-sm">
                {c.text.slice(0, 50)}
                {c.text.length > 50 ? "…" : ""}
              </div>
            </div>
          );
        },
      },
      {
        id: "provider",
        header: "Provider",
        enableSorting: false,
        cell: ({ row }) => {
          const p = row.original.provider;
          const phone = row.original.provider_phone;
          if (!p && !phone)
            return <span className="text-muted-foreground">—</span>;
          return (
            <div className="min-w-0">
              {p ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: p.color ?? "#64748B" }}
                  />
                  <span className="text-sm">{p.name}</span>
                </span>
              ) : null}
              {phone ? (
                <div className="font-mono text-xs text-muted-foreground">
                  {formatPhoneInternational(phone.phone_number)}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "activity",
        header: "Activity",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-[10px]">
            {activityFilterLabel(row.original)}
          </Badge>
        ),
      },
      {
        id: "audience_count",
        header: "Audience",
        accessorKey: "audience_count",
        enableSorting: true,
        cell: ({ row }) => {
          const s = row.original;
          const n = s.audience_count;
          // Lane rows: the LIVE behavioral preview. Always show the number
          // (even 0 — honest "no one alive at this tier yet", not "no data")
          // with a "live" hint, so it reads as a moving target, not a snapshot.
          if (s.behavioral_tier != null) {
            // null = the deferred lane-counts fetch hasn't landed yet.
            if (n === null) {
              return (
                <span
                  className="font-mono text-xs text-muted-foreground animate-pulse"
                  title="Computing live audience…"
                >
                  computing…
                </span>
              );
            }
            return (
              <span
                className="font-mono text-sm tabular-nums"
                title="Live preview — alive + at this exact tier, minus opt-outs (Purchased contacts exit). Changes until send."
              >
                {n.toLocaleString()}
                <span className="ml-1 align-middle text-[9px] uppercase tracking-wide text-muted-foreground">
                  live
                </span>
              </span>
            );
          }
          // Non-lane rows never carry null; coalesce so TS narrows off number|null.
          const count = n ?? 0;
          // Non-lane rows show the ADDRESSABLE pool (pool ∩ stage filters,
          // before content dedup). The post-dedup count that will actually send
          // — after removing leads who already got this creative/offer — is
          // shown in the Prepare popup, so the two numbers can differ by design.
          const addressableTitle =
            "Addressable pool (before content dedup). The post-dedup number that will actually send is shown in Prepare.";
          if (count === 0)
            return (
              <span className="text-muted-foreground" title={addressableTitle}>
                —
              </span>
            );
          return (
            <span
              className="font-mono text-sm tabular-nums"
              title={addressableTitle}
            >
              {count.toLocaleString()}
            </span>
          );
        },
      },
      {
        id: "scheduled",
        header: "Scheduled",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.scheduled_at ? (
            <span className="text-sm text-muted-foreground">
              {formatCampaignDateTime(row.original.scheduled_at)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "sent_at",
        header: "Sent",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.sent_at ? (
            <span
              className="text-sm text-muted-foreground"
              title={formatDistanceToNow(new Date(row.original.sent_at), {
                addSuffix: true,
              })}
            >
              {formatCampaignDateTime(row.original.sent_at)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "send_state",
        header: "Send",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          const op = stageOpStatus(s);
          if (!op) return <span className="text-muted-foreground">—</span>;
          const meta = STAGE_STATUS_META[op];
          return (
            <div className="flex flex-col items-start gap-1">
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
              {/* §A4: one-click Prepare on Orange rows — opens the shared popup
                  (full readiness checklist) in place, no editor. */}
              {op === "scheduled_unprepared" && canActivate ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPrepareTarget({
                      campaignId,
                      stageId: s.id,
                      stageLabel: s.label,
                      scheduledAt: s.scheduled_at,
                      scheduleMissedAt: s.schedule_missed_at,
                    });
                  }}
                >
                  <Send className="size-3" aria-hidden /> Prepare
                </Button>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          if (s.status === "archived") {
            return (
              <Badge className={cn("capitalize", STAGE_STATUS_COLOR.archived)}>
                archived
              </Badge>
            );
          }
          // Tracked stages are sent by the API pipeline, which owns 'sent'
          // (and its sent_at fire-lock). Marking them 'sent' manually is
          // rejected server-side, so hide the option here.
          const statusOptions =
            campaign?.link_mode === "tracked"
              ? STAGE_STATUS_OPTIONS.filter((o) => o.value !== "sent")
              : STAGE_STATUS_OPTIONS;
          return (
            <StatusDropdown<ActiveStageStatus>
              current={s.status as ActiveStageStatus}
              options={statusOptions}
              onChange={(next) => handleStageStatusChange(s, next)}
              isUpdating={stageStatusApi.isLoading}
              isTerminal={!canSendStage}
            />
          );
        },
      },
      {
        id: "sms_count",
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
        id: "cost",
        header: "Cost",
        enableSorting: false,
        cell: ({ row }) => {
          const v = Number(row.original.total_cost);
          if (v === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="font-mono text-sm tabular-nums">
              ${v.toFixed(2)}
            </span>
          );
        },
      },
      {
        id: "results",
        header: "Results",
        enableSorting: false,
        cell: ({ row }) => {
          const {
            sms_count: sms,
            delivered_count: delivered,
            opt_out_count: oo,
            click_count: cl,
            checkout_click_count: chk,
            sales_count: manualSales,
            keitaro_sales_count: keitaroSales,
            keitaro_events: events,
            keitaro_unmapped: unmapped,
          } = row.original;
          // Keitaro wins when it reports the conversion; manual tally fills gaps.
          const sales = combineSales(manualSales, keitaroSales);
          // Results are considered entered (manually or imported) once any
          // send/outcome counter is non-zero. Clicks/checkout/sales auto-fill
          // from the Keitaro */5 poll; opt-out from the inbound-STOP poll.
          //
          // ⭐ THE PER-EVENT COUNTS AND THE UNMAPPED COUNT ARE IN THIS TEST TOO.
          // `sms_count` is 0 on API sends, so a stage whose only signal is a
          // conversion is not hypothetical — and a stray that counts as nothing
          // anywhere else would have been swallowed by the em dash, which is the
          // one reading this cell must never give it.
          const hasEvents = Object.values(events ?? {}).some((t) => t.n > 0);
          const hasResults =
            sms > 0 ||
            delivered > 0 ||
            oo > 0 ||
            cl > 0 ||
            chk > 0 ||
            sales > 0 ||
            hasEvents ||
            unmapped > 0;
          if (!hasResults)
            return <span className="text-muted-foreground">—</span>;
          // Rate denominator: delivered, falling back to SMS sent.
          const denom = delivered > 0 ? delivered : sms;
          const pct = (n: number) =>
            denom > 0 ? `${((n / denom) * 100).toFixed(1)}%` : "—";
          return (
            // ⚠️ `Checkout` STAYS, and it is NOT the registration segment. It is
            // keitaro_type = 'lead', which means a REGISTRATION for one network
            // and a PAID PURCHASE for two others (migration 0181's mapping
            // seed). The registry-driven counts land beside it; where the two
            // disagree, that disagreement is the point. Retiring
            // checkout_click_count is a separate card — it is hand-editable
            // (manual-results-form.tsx) and exact-mirrored from the projection
            // every five minutes.
            //
            // The generated segments and the unmapped marker come out of ONE
            // component: the line can never explain part of itself.
            <span className="font-mono text-xs tabular-nums">
              Clicks: {cl} · Checkout: {chk} ·{" "}
              <StageEventBreakdown
                types={shownEventTypes}
                source={stageEventSource(row.original)}
              />
              Sales: {sales} · CTR: {pct(cl)} · OptOut: {pct(oo)}
            </span>
          );
        },
      },
      {
        id: "revenue",
        header: "Revenue / ROI",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          // Revenue is the real per-conversion payout recorded by the tracker,
          // NOT sales × the offer's current CPA (a mid-flight CPA change would
          // retro-misprice prior sales) — and APPROVED only. `pending` is the
          // same money still held; it is shown beside ROI and never inside it.
          const revenue = Number(s.keitaro_revenue);
          const pending = Number(s.keitaro_pending_revenue);
          if (!(revenue > 0) && !(pending > 0))
            return <span className="text-muted-foreground">—</span>;
          // Pending is passed so a stage with ONLY held money reads
          // "$0.00 · — · pending $X" rather than "$0.00 · -100% · pending $X".
          const roi = stageRoi(revenue, Number(s.total_cost), pending);
          return (
            <span className="font-mono text-xs tabular-nums">
              {formatRevenue(revenue)} · {formatRoi(roi)}
              {pending > 0 ? ` · pending ${formatRevenue(pending)}` : ""}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          const showEdit = canUpdateStage && s.status !== "archived";
          const showArchive = s.status !== "archived" && canArchiveStage;
          const showRestore = s.status === "archived" && canRestoreStage;
          const audienceEmpty = s.audience_count === 0;
          const exportTitle = audienceEmpty
            ? "Stage has no audience — adjust filters to enable export."
            : undefined;
          if (!showEdit && !showArchive && !showRestore) return null;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={audienceEmpty}
                title={exportTitle ?? "Export this stage's phones as a CSV"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (audienceEmpty) return;
                  window.open(
                    `/api/campaigns/${campaignId}/stages/${s.id}/export-phones`,
                    "_blank",
                    "noopener",
                  );
                }}
              >
                <Download className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">Export phones</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {showEdit ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditingStage(s);
                        setAddStageOpen(true);
                      }}
                    >
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {canCreateStage ? (
                    <DropdownMenuItem
                      onSelect={() => void handleStageDuplicate(s)}
                    >
                      <Copy className="size-4" aria-hidden /> Duplicate
                    </DropdownMenuItem>
                  ) : null}
                  {/* Behavioral split lives in the stage editor's audience block
                      (beside the A/B "Split for A/B test…" button), not here —
                      both split actions sit in the same place. */}
                  {canActivate ? (
                    <DropdownMenuItem onSelect={() => setSendStage(s)}>
                      <Send className="size-4" aria-hidden /> Send…
                    </DropdownMenuItem>
                  ) : null}
                  {/* Cancel a materialized-but-unsent stage → revert to editable.
                      Mirrors the server abort guard: pending rows exist and
                      nothing has gone out (no sent/sending, not released). */}
                  {canActivate &&
                  !s.sent_at &&
                  s.send_counts.pending > 0 &&
                  s.send_counts.sending === 0 &&
                  s.send_counts.sent === 0 ? (
                    <DropdownMenuItem onSelect={() => setStageCancelConfirm(s)}>
                      <Ban className="size-4" aria-hidden /> Cancel send
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  {canImportResults ? (
                    <DropdownMenuItem onSelect={() => setImportStage(s)}>
                      <Upload className="size-4" aria-hidden /> Import results
                      (CSV)
                    </DropdownMenuItem>
                  ) : null}
                  {canImportResults ? (
                    <DropdownMenuItem onSelect={() => setManualStage(s)}>
                      <PenLine className="size-4" aria-hidden /> Enter results
                      manually
                    </DropdownMenuItem>
                  ) : null}
                  {canViewImports ? (
                    <DropdownMenuItem onSelect={() => setHistoryStage(s)}>
                      <History className="size-4" aria-hidden /> View import
                      history
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive || showRestore ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setStageArchiveConfirm({ kind: "archive", stage: s })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setStageArchiveConfirm({ kind: "restore", stage: s })
                      }
                    >
                      <ArchiveRestore className="size-4" aria-hidden /> Restore
                    </DropdownMenuItem>
                  ) : null}
                  {canDeleteStage &&
                  !s.sent_at &&
                  !s.materialized_at &&
                  s.send_counts.total === 0 &&
                  s.sms_count === 0 &&
                  s.delivered_count === 0 &&
                  s.opt_out_count === 0 &&
                  s.inbound_stop_count === 0 &&
                  s.click_count === 0 &&
                  s.sales_count === 0 &&
                  s.keitaro_sales_count === 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setStageDeleteConfirm(s)}
                      >
                        <Trash2 className="size-4" aria-hidden /> Delete
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [
      campaignId,
      campaign?.link_mode,
      canUpdateStage,
      canArchiveStage,
      canRestoreStage,
      canDeleteStage,
      canSendStage,
      canActivate,
      canImportResults,
      canViewImports,
      canCreateStage,
      selectedStageIds,
      stageStatusApi.isLoading,
      lanesByParent,
      stageNumberById,
      // The Results cell closes over the registry — without this the segments
      // keep rendering the set the table was first built with.
      shownEventTypes,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stageOpStatus and
    // setPrepareTarget are stable; STAGE_STATUS_META is a module constant.
  );

  // Aggregate results across non-archived stages. Shown above the stage
  // table once there's any send activity. Archived stages are excluded so
  // operators can keep historical stages around without inflating totals.
  const campaignTotals = useMemo(() => {
    let sms = 0;
    let delivered = 0;
    let optOuts = 0;
    let clickers = 0;
    let scrubbed = 0;
    let bounced = 0;
    let checkoutClicks = 0;
    let sales = 0;
    let cost = 0;
    // Revenue is summed from real per-conversion Keitaro payout
    // (keitaro_revenue), never sales × the offer's current CPA. revenueKnown
    // stays false until at least one stage carries tracked revenue, so we can
    // render "—" rather than a misleading $0 for purely-manual campaigns.
    let revenue = 0;
    let revenueKnown = false;
    let pendingRevenue = 0;
    // The same conversions split per event type, and the TWO residuals that
    // explain why the tiles need not sum to Sales:
    //
    //   unmapped     — a conversion the ORG-SCOPED registry join could not
    //                  place. It is counted by `sales` (which resolves
    //                  is_purchase through a NON-org-scoped list) and by no key
    //                  of `events`, so it is the only account of that half of
    //                  the difference.
    //   manual_topup — the part of `sales` the operator's tally contributed.
    //                  `sales` is max(manual, tracker) per stage while `events`
    //                  counts TRACKER events only, so a hand-entered sale is in
    //                  the total and in no tile.
    //
    // Both are accumulated here, beside the counts, so the tiles can never show
    // one without the others. addEventMaps deep-copies a key it does not have
    // yet (never aliasing the shared EMPTY_TALLY), which is why the fold is not
    // written out by hand.
    const events: EventMap = {};
    let unmapped = 0;
    let manualTopup = 0;
    // Tracking-gap substitution, the SAME rule the Reports Overview tab applies
    // (shouldSubstituteClickers / substitutionDominates in
    // lib/reporting/tracking-gap.ts — imported, never transcribed, so the two
    // screens cannot drift). A tracked stage whose landing page lacks the
    // Keitaro visit script reports 0 visits forever while CamMan keeps
    // recording taps; without this the card reads "Clickers 0" as though nobody
    // clicked. The substitute is counted_clickers (human-classified people),
    // NOT raw taps — raw runs ~11x Keitaro's clean visits because most SMS taps
    // are carrier scanners.
    let substitutedClickers = 0;
    const now = new Date();
    for (const s of stages) {
      if (s.archived_at) continue;
      sms += s.sms_count;
      delivered += s.delivered_count;
      optOuts += s.opt_out_count;
      if (
        shouldSubstituteClickers({
          linkMode: s.link_mode,
          visitClicksRaw: s.keitaro_visit_clicks_raw,
          visitClicksClean: s.keitaro_visit_clicks_clean,
          countedClickers: s.counted_clickers,
          stageSentAt: s.sent_at,
          now,
        })
      ) {
        clickers += s.counted_clickers;
        substitutedClickers += s.counted_clickers;
      } else {
        clickers += s.click_count;
      }
      scrubbed += s.scrubbed_count;
      bounced += s.bounced_count;
      checkoutClicks += s.checkout_click_count;
      // ⭐ ONE SOURCE PER STAGE, the same object the Results cell renders from:
      // the counts and both residuals are read off one row, never assembled
      // field by field from two places.
      const src = stageEventSource(s);
      addEventMaps(events, src.events);
      unmapped += src.unmapped;
      manualTopup += src.manual_topup;
      // Keitaro wins when it reports the conversion; manual tally fills gaps.
      const stageSales = combineSales(s.sales_count, s.keitaro_sales_count);
      sales += stageSales;
      cost += Number(s.total_cost);
      const r = Number(s.keitaro_revenue);
      if (r > 0) {
        revenue += r;
        revenueKnown = true;
      }
      pendingRevenue += Number(s.keitaro_pending_revenue);
    }
    return {
      sms,
      delivered,
      optOuts,
      // Campaign-level DISTINCT contacts who STOPped (server-computed) — not a
      // sum of per-stage credits, which window-attribution would over-count.
      inboundStops: inboundStopContacts,
      clickers,
      // Marker only when the substitute DOMINATES the total — one patched stage
      // beside four healthy ones is a Keitaro reading, not a CamMan one.
      clickersSubstituted: substitutionDominates(substitutedClickers, clickers),
      scrubbed,
      bounced,
      checkoutClicks,
      sales,
      cost,
      events,
      unmapped,
      manual_topup: manualTopup,
      revenue: revenueKnown ? revenue : null,
      // Same "—, not $0.00" rule as revenue above, for the same reason: a
      // manual campaign has no held money to report, and a tile reading
      // "$0.00" beside a Revenue tile reading "—" asserts a fact about money
      // this screen does not have. Non-zero only when some stage actually
      // carries a pending payout.
      pendingRevenue: pendingRevenue > 0 ? pendingRevenue : null,
    };
  }, [stages, inboundStopContacts]);
  // ⭐ THE WHOLE CARD IS GATED, AND THAT IS WHY IT IS SAFE — written down here
  // because it is the obvious thing to "fix".
  //
  // sms_count is 0 on API sends, so this gate can hide the card on a campaign
  // that really did send: the per-stage Results cells carry the same numbers and
  // are NOT gated (their own test includes the per-event counts and the strays),
  // so nothing is unreachable — this is a summary card, not the only reading.
  //
  // What matters for the breakdown is that the gate is ALL-OR-NOTHING. It hides
  // the event tiles, the manual-tally tile and the unmapped badge together, so
  // the card can be absent but never present-and-under-explaining. Adding a
  // per-event disjunct here (sales > 0, any events, unmapped > 0) would be the
  // hazard: the card would then appear for a campaign with conversions and no
  // sends, carrying tiles whose residuals were computed over the same stages but
  // whose SMS/Delivered/Clickers tiles read 0 — a breakdown shown beside an
  // empty frame. Leave the gate coarse; if it ever needs to widen, widen it to
  // "any stage has any activity", never to one component of the breakdown.
  const hasResults = campaignTotals.sms > 0 || campaignTotals.inboundStops > 0;

  if (!auth) return null;

  if (campaignError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{campaignError}</p>
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // ============ Campaign-level transitions menu ============
  const possibleCampaignTransitions: {
    label: string;
    t: CampaignTransition;
    icon: React.ReactNode;
  }[] = [];
  if (campaign.status === "draft" && canActivate)
    possibleCampaignTransitions.push({
      label: "Activate",
      t: "activate",
      icon: <Send className="size-4" aria-hidden />,
    });
  if (campaign.status === "active" && canPause)
    possibleCampaignTransitions.push({
      label: "Pause",
      t: "pause",
      icon: <Pause className="size-4" aria-hidden />,
    });
  if (campaign.status === "active" && canComplete)
    possibleCampaignTransitions.push({
      label: "Mark complete",
      t: "complete",
      icon: <CheckCircle2 className="size-4" aria-hidden />,
    });
  if (campaign.status === "paused" && canPause)
    possibleCampaignTransitions.push({
      label: "Resume",
      t: "resume",
      icon: <Play className="size-4" aria-hidden />,
    });
  if (campaign.status === "paused" && canComplete)
    possibleCampaignTransitions.push({
      label: "Mark complete",
      t: "complete",
      icon: <CheckCircle2 className="size-4" aria-hidden />,
    });
  if (campaign.status === "completed" && canActivate)
    possibleCampaignTransitions.push({
      label: "Reactivate",
      t: "reactivate",
      icon: <Play className="size-4" aria-hidden />,
    });

  const memberLabel = (userId: string | null) => {
    if (!userId) return null;
    const m = members.find((mm) => mm.id === userId);
    return m?.display_name ?? m?.email ?? userId;
  };

  // Stage roll-up subtitle
  const roleUpParts: string[] = [];
  for (const status of ALL_STAGE_STATUSES) {
    const n = campaign.stage_count_by_status?.[status] ?? 0;
    if (n > 0) roleUpParts.push(`${n} ${status}`);
  }
  const rollupSubtitle =
    campaign.stage_count_total === 0
      ? "No stages yet"
      : `${campaign.stage_count_total} stage${campaign.stage_count_total === 1 ? "" : "s"} — ${roleUpParts.join(", ")}`;

  return (
    <div className="space-y-6">
      <BackLink />

      {/* ============ Header ============ */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {campaign.name}
            </h1>
            <Badge
              className={cn(
                "capitalize",
                CAMPAIGN_STATUS_COLOR[campaign.status],
              )}
            >
              {campaign.status}
            </Badge>
            {campaign.human_id ? (
              <Badge variant="outline" className="font-mono text-xs">
                {campaign.human_id}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {campaign.slug}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canUpdateCampaign && campaign.status !== "archived" ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/campaigns/${campaign.id}/edit`}>
                <Pencil className="size-4" aria-hidden /> Edit
              </Link>
            </Button>
          ) : null}
          {/* Upload contacts straight onto a draft campaign's audience via CSV
              or paste. Draft-only: the audience snapshot freezes at activation. */}
          {canUploadContacts && campaign.status === "draft" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUploadContactsOpen(true)}
            >
              <Upload className="size-4" aria-hidden /> Upload contacts
            </Button>
          ) : null}
          {/* Union-of-all-stages export. Disabled for drafts because the
              audience snapshot is computed at activation time — no stage
              rows yet. Also hidden when every stage is archived, since
              the endpoint excludes archived stages anyway. */}
          {campaign.status !== "draft" &&
          stages.some((s) => s.status !== "archived") ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.open(
                  `/api/campaigns/${campaignId}/export-all-phones`,
                  "_blank",
                  "noopener",
                )
              }
              title="Export the union of all non-archived stages' phones as one CSV"
            >
              <Download className="size-4" aria-hidden /> Export all phones
            </Button>
          ) : null}
          {/* Tracked-clicker export — only for tracked campaigns, where clicks
              are attributed via minted links. Manual campaigns have no tracked
              clicks (use the manual clicker CSV workflow instead). */}
          {campaign.link_mode === "tracked" && campaign.status !== "draft" ? (
            <ExportClickersDialog campaignId={campaign.id} stages={stages} />
          ) : null}
          {possibleCampaignTransitions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Status actions
                  <ChevronDown className="size-3" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {possibleCampaignTransitions.map((tr) => (
                  <DropdownMenuItem
                    key={tr.t}
                    onSelect={() => {
                      setTransitionOpenedAt(Date.now());
                      setCampaignTransition(tr.t);
                    }}
                  >
                    {tr.icon} {tr.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {campaign.status !== "archived" && canArchiveCampaign ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCampaignArchiveConfirm("archive")}
            >
              <ArchiveIcon className="size-4" aria-hidden /> Archive
            </Button>
          ) : null}
          {campaign.status === "archived" && canRestoreCampaign ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCampaignArchiveConfirm("restore")}
            >
              <ArchiveRestore className="size-4" aria-hidden /> Restore
            </Button>
          ) : null}
        </div>
      </header>

      {/* ============ Send method (Manual vs API/tracked) ============ */}
      <CampaignSendMode
        campaignId={campaign.id}
        linkMode={campaign.link_mode}
        brandName={campaign.brand?.name ?? null}
        brandShortDomain={campaign.brand?.short_domain ?? null}
        canEdit={canUpdateCampaign}
        onChanged={refetchCampaign}
      />

      {/* ============ Metadata (compact two-line summary + expand) ============ */}
      <CampaignMetaCompact campaign={campaign} memberLabel={memberLabel} />

      {/* ============ Drip settings (drip campaigns only) ============ */}
      {campaign.type === "drip" ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-medium">Drip settings</h2>
            <p className="text-sm text-muted-foreground">
              Which leads this campaign accepts, and what it has routed so far.
              Sending is not wired yet — a routed lead is an assignment, not a
              message.
            </p>
          </div>
          <DripConfigPanel
            campaignId={campaign.id}
            canEdit={can("campaigns.update")}
          />
        </section>
      ) : null}

      {/* ============ Stages section ============ */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">Stages</h2>
            <p className="text-sm text-muted-foreground">{rollupSubtitle}</p>
          </div>
          {campaign.link_mode === "tracked" ? <StageStatusLegend /> : null}
        </div>

        {/* Behavioral-lane explainer — shown once any lanes exist so the
            operator understands why lane counts don't add up to the pool. */}
        {hasBehavioralLanes ? (
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Split className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p>
              <span className="font-medium text-foreground">
                Behavioral lanes
              </span>{" "}
              route each recipient by their{" "}
              <span className="font-medium">current</span> tier in this campaign
              — <span className="font-medium">Ignored</span> /{" "}
              <span className="font-medium">Clicked</span> /{" "}
              <span className="font-medium">Reached offer</span> /{" "}
              <span className="font-medium">Registered</span>. A contact lands
              in exactly one lane (their highest tier reached), and{" "}
              <span className="font-medium">Registered</span> outranks{" "}
              <span className="font-medium">Reached offer</span> — so someone
              who registered is <em>not</em> in the Reached-offer lane and gets
              no message unless a Registered lane exists.{" "}
              {/* The space after this span is an explicit {" "} because the
                  words rendered JOINED without it. WHAT WAS ESTABLISHED: the
                  symptom, read out of the rendered DOM of a DEV build — the copy
                  showed "Convertedcontacts exit the sequence". The CAUSE was not
                  isolated: under plain JSX semantics a space following </span> on
                  the same line is preserved, so this is likely transform- or
                  mode-specific, and nobody has confirmed a production build ever
                  rendered them joined. The {" "} fix is transform-independent and
                  correct either way, which is why it stays without the diagnosis. */}
              <span className="font-medium">Purchased</span> contacts exit the
              sequence (no lane) and opted-out contacts are suppressed, so lane
              counts won&apos;t sum to the full audience. The{" "}
              <span className="font-mono">live</span> audience numbers are a
              preview computed from current behavior — they change until the
              stage is sent.
            </p>
          </div>
        ) : null}

        {hasResults ? (
          <Card>
            <CardContent className="grid grid-cols-2 gap-3 pt-6 sm:grid-cols-4 lg:grid-cols-6">
              <TotalsMetric label="SMS sent" value={campaignTotals.sms} />
              <TotalsMetric
                label="Delivered"
                value={campaignTotals.delivered}
              />
              <TotalsMetric label="Opt-outs" value={campaignTotals.optOuts} />
              <TotalsMetric
                label="Inbound STOPs"
                value={campaignTotals.inboundStops}
              />
              <TotalsMetric
                label="Clickers"
                value={
                  campaignTotals.clickersSubstituted
                    ? `${campaignTotals.clickers.toLocaleString()}*`
                    : campaignTotals.clickers
                }
                title={
                  campaignTotals.clickersSubstituted
                    ? "Keitaro recorded no landing-page visits for this campaign, so this is CamMan's own count of human clickers on the tracked link. The landing page is probably missing the Keitaro visit script."
                    : undefined
                }
              />
              <TotalsMetric label="Scrubbed" value={campaignTotals.scrubbed} />
              <TotalsMetric label="Bounced" value={campaignTotals.bounced} />
              <TotalsMetric
                label="Checkout Clicks"
                value={campaignTotals.checkoutClicks}
              />
              <TotalsMetric label="Sales" value={campaignTotals.sales} />
              {/* One tile per event type, generated from the registry — and BOTH
                  residuals, which come out of the SAME component and the SAME
                  totals object so the tiles cannot be on screen without them.
                  Sales is the sum of the is_purchase tiles PLUS the manual
                  top-up PLUS the strays the badge counts; carrying only one of
                  the two left the row under-explaining itself by the other. */}
              <EventTotalsTiles
                types={shownEventTypes}
                source={campaignTotals}
                renderTile={({ key, label, value, title }) => (
                  <TotalsMetric
                    key={key}
                    label={label}
                    value={value}
                    title={title}
                  />
                )}
              />
              <TotalsMetric
                label="Revenue"
                value={formatRevenue(campaignTotals.revenue)}
                raw
              />
              <TotalsMetric
                label="Pending revenue"
                value={formatRevenue(campaignTotals.pendingRevenue)}
                title="Money a conversion has earned that the network has not approved yet. Never counted in Revenue, ROI or EPC — it may still be rejected."
                raw
              />
              <TotalsMetric
                label="ROI"
                // Pending is passed only so a campaign with held money and no
                // approved revenue reads "—" instead of "-100%" — it is never
                // IN the ratio (lib/stage-results.ts).
                value={formatRoi(
                  stageRoi(
                    campaignTotals.revenue,
                    campaignTotals.cost,
                    campaignTotals.pendingRevenue ?? 0,
                  ),
                )}
                raw
              />
              <TotalsMetric
                label="Total cost"
                value={`$${campaignTotals.cost.toFixed(2)}`}
                raw
              />
            </CardContent>
            {campaignTotals.clickersSubstituted ? (
              // A tooltip alone is not discoverable enough for a number that
              // changed source. Say it in the open, and name the likely cause so
              // the operator can act rather than just distrust the figure.
              <CardContent className="border-t pt-3 text-xs text-muted-foreground">
                <span className="font-medium">*</span> Keitaro recorded no
                landing-page visits, so Clickers shows CamMan&apos;s own count
                of human clickers on the tracked link. Usually means the landing
                page is missing the Keitaro visit script — sales, checkout
                clicks and revenue stay unreported until it&apos;s added.
              </CardContent>
            ) : null}
          </Card>
        ) : null}

        {campaign.stage_count_total === 0 && !stagesApi.isLoading ? (
          // Truly empty: no stages exist in this campaign at all.
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-center">
            <Send className="size-10 text-muted-foreground/40" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-medium">No stages yet</p>
              <p className="text-sm text-muted-foreground">
                Each stage is a discrete SMS send to a slice of the frozen
                audience.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {ALL_STAGE_STATUSES.map((s) => {
                  const active = stageFilters.statuses.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        const set = new Set(stageFilters.statuses);
                        if (set.has(s)) set.delete(s);
                        else set.add(s);
                        updateStageFilters({
                          statuses: Array.from(set) as StageStatus[],
                        });
                      }}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors",
                        active
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-background text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="stages-show-archived"
                  checked={stageFilters.showArchived}
                  onCheckedChange={(checked) =>
                    updateStageFilters({ showArchived: checked })
                  }
                />
                <Label htmlFor="stages-show-archived" className="text-sm">
                  Show archived
                </Label>
              </div>
              {stageFilters.statuses.length > 0 || stageFilters.showArchived ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => resetStageFilters()}
                >
                  Reset filters
                </Button>
              ) : null}
            </div>

            {stagesError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                <p className="text-destructive">
                  Couldn&apos;t load stages: {stagesError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={refetchStages}
                >
                  Retry
                </Button>
              </div>
            ) : stages.length === 0 && !stagesApi.isLoading ? (
              // Filtered to zero: stages exist in this campaign, but the
              // current filter set hides all of them. Surface the count and
              // a one-click reset so the user isn't stranded.
              <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-center">
                <Send
                  className="size-10 text-muted-foreground/40"
                  aria-hidden
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    No stages match the current filters
                  </p>
                  <p className="text-sm text-muted-foreground">
                    This campaign has {campaign.stage_count_total} stage
                    {campaign.stage_count_total === 1 ? "" : "s"} (
                    {rollupSubtitle.includes("—")
                      ? rollupSubtitle.split("—")[1]?.trim()
                      : ""}
                    ). Reset filters or toggle{" "}
                    <span className="font-mono">Show archived</span> to see
                    them.
                  </p>
                </div>
                {stageFilters.statuses.length > 0 ||
                stageFilters.showArchived ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resetStageFilters()}
                  >
                    Reset filters
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={refetchStages}>
                    Refresh
                  </Button>
                )}
              </div>
            ) : (
              <>
                {selectedStageIds.size > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">
                        {selectedStageIds.size}
                      </span>{" "}
                      stage{selectedStageIds.size === 1 ? "" : "s"} selected
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedStageIds(new Set())}
                        disabled={stageBulkBusy}
                      >
                        Clear
                      </Button>
                      {canSendStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("success")}
                          disabled={stageBulkBusy}
                        >
                          Mark success
                        </Button>
                      ) : null}
                      {canSendStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("failed")}
                          disabled={stageBulkBusy}
                        >
                          Mark failed
                        </Button>
                      ) : null}
                      {canSendStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("cancelled")}
                          disabled={stageBulkBusy}
                        >
                          Mark cancelled
                        </Button>
                      ) : null}
                      {canArchiveStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("archived")}
                          disabled={stageBulkBusy}
                        >
                          Archive
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <DataTable<Stage>
                  data={stages}
                  columns={stageColumns}
                  isLoading={stagesApi.isLoading}
                  pageIndex={0}
                  pageSize={stageFilters.pageSize}
                  totalCount={stages.length}
                  onPageChange={() => {}}
                  onPageSizeChange={(s) => updateStageFilters({ pageSize: s })}
                  sortBy="stage_number"
                  sortDir="asc"
                  onSortChange={() => {}}
                  onRowClick={
                    canUpdateStage
                      ? (s) => {
                          setEditingStage(s);
                          setAddStageOpen(true);
                        }
                      : undefined
                  }
                  rowClassName={(s) => {
                    const op = stageOpStatus(s);
                    return op
                      ? cn("border-l-4", STAGE_STATUS_META[op].rowClass)
                      : undefined;
                  }}
                />
              </>
            )}
          </>
        )}

        {canCreateStage && campaign.status !== "archived" ? (
          <div className="flex flex-wrap items-center gap-2">
            <StageInlineEditor
              campaign={campaign}
              campaignId={campaignId}
              campaignType={campaign.type}
              siblingWindows={stages
                .filter(
                  (s) =>
                    s.drip_active === true &&
                    s.window_start_min != null &&
                    s.window_end_min != null &&
                    s.id !== editingStage?.id,
                )
                .map((s) => ({
                  stage_id: s.id,
                  window_start_min: s.window_start_min as number,
                  window_end_min: s.window_end_min as number,
                }))}
              campaignTrackingId={campaign.tracking_id}
              nextStageNumber={
                stages.reduce((m, s) => Math.max(m, s.stage_number), 0) + 1
              }
              stage={editingStage}
              isOpen={addStageOpen}
              onOpenChange={(open) => {
                setAddStageOpen(open);
                if (!open) setEditingStage(null);
              }}
              onSaved={() => {
                refetchStages();
                refetchCampaign();
              }}
              onImportResults={
                canImportResults && editingStage
                  ? () => {
                      setImportStage(editingStage);
                      setAddStageOpen(false);
                      setEditingStage(null);
                    }
                  : undefined
              }
              onManualResults={
                canImportResults && editingStage
                  ? () => {
                      setManualStage(editingStage);
                      setAddStageOpen(false);
                      setEditingStage(null);
                    }
                  : undefined
              }
              onViewImportHistory={
                canViewImports && editingStage
                  ? () => {
                      setHistoryStage(editingStage);
                      setAddStageOpen(false);
                      setEditingStage(null);
                    }
                  : undefined
              }
            />
            {/* 0174: the behavioural split lives HERE, at campaign level, beside
              "Add stage" — it is taken against the campaign's completed stages,
              not against one chosen predecessor, so a per-stage entry point would
              misrepresent what it does. The A/B split stays inside the stage
              editor because it genuinely IS per-stage. Two entry points for two
              different actions; deliberately not two for the same one.
              Hidden while the editor is open so the row stays a single action. */}
            {!addStageOpen && campaign.link_mode === "tracked" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void openBehavioralSplit()}
                disabled={!hasCompletedStage}
                title={
                  hasCompletedStage
                    ? "Split this campaign into Ignored / Clicked / Reached offer / Registered lanes"
                    : "Needs at least one stage that has finished sending"
                }
              >
                <Split className="size-4" aria-hidden /> Behavioral split…
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ============ Click attribution section ============ */}
      {/* Below the fold + self-fetches a heavy clicks aggregation on mount —
          defer until scrolled near so it's off the initial-paint critical path. */}
      <section className="space-y-4">
        <DeferUntilVisible minHeight={240}>
          <ClickReportSection campaignId={campaignId} />
        </DeferUntilVisible>
      </section>

      {/* ============ Activity log section ============ */}
      {/* Below the fold + self-fetches the activity endpoint on mount — defer too. */}
      <section className="space-y-4">
        <DeferUntilVisible minHeight={240}>
          <CampaignActivitySection
            campaignId={campaignId}
            stages={stages.map((s) => ({
              id: s.id,
              stage_number: s.stage_number,
            }))}
          />
        </DeferUntilVisible>
      </section>

      {/* ============ Dialogs ============ */}
      {/* Behavioral split confirm (0174) — CAMPAIGN-level. Shows the SOURCE
          SCOPE (which completed stages feed the classification) and a live
          per-tier count before anything is created. Both are PROVISIONAL: the
          tier is read live and the source set is re-resolved ~15 min before the
          lanes materialize, so a stage that completes in between widens it. */}
      <AlertDialog
        open={behavioralSplitOpen}
        onOpenChange={(open) => {
          if (!open) {
            setBehavioralSplitOpen(false);
            setSplitPreview(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Behavioral split</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Pick the behavioural lanes to stamp out for this campaign.
                  Each lane starts as a copy of the most recently completed
                  stage; edit its message and set its send time afterward.
                </p>
                <p>
                  <span className="font-medium">Ignored</span> is off by default
                  — a lane you create but never schedule can never be prepared,
                  and the split holds <em>every</em> lane back until all of them
                  are, so it would silently block the ones you did schedule.
                </p>
                <p>
                  <span className="font-medium">Registered</span> is a new lane:
                  someone who registered but has not purchased. It outranks{" "}
                  <span className="font-medium">Reached offer</span>, so those
                  contacts are no longer in that lane — leave Registered
                  unticked and they get nothing at this position.
                </p>

                {splitPreviewApi.isLoading || splitPreview === null ? (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    Computing lane counts…
                  </div>
                ) : !splitPreview.can_split ? (
                  <div className="rounded-md border border-dashed p-3 text-xs">
                    This campaign has no completed stages yet. A behavioral
                    split classifies contacts by how they behaved in stages that
                    have already sent, so at least one must finish first.
                  </div>
                ) : (
                  <>
                    <div className="grid gap-1.5 rounded-md border border-dashed p-3">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Source scope — {splitPreview.source_stages.length}{" "}
                        completed stage
                        {splitPreview.source_stages.length === 1 ? "" : "s"}
                      </span>
                      <p className="text-xs text-muted-foreground">
                        {splitPreview.source_stages
                          .map((st) => `#${st.stage_number}`)
                          .join(", ")}{" "}
                        · {splitPreview.source_contacts.toLocaleString()}{" "}
                        contacts reached
                      </p>
                    </div>

                    <div className="grid gap-1 rounded-md border border-dashed p-3">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Lanes to create — counts provisional
                      </span>
                      {splitPreview.lanes.map((ln) => {
                        const checked = selectedTiers.includes(ln.tier);
                        return (
                          <button
                            key={ln.tier}
                            type="button"
                            role="checkbox"
                            aria-checked={checked}
                            onClick={() =>
                              setSelectedTiers((prev) =>
                                prev.includes(ln.tier)
                                  ? prev.filter((t) => t !== ln.tier)
                                  : [...prev, ln.tier].sort((a, b) => a - b),
                              )
                            }
                            className="-mx-1 flex items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                          >
                            <span className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "flex size-4 shrink-0 items-center justify-center rounded border",
                                  checked
                                    ? "border-foreground bg-foreground text-background"
                                    : "border-muted-foreground/40 bg-background",
                                )}
                                aria-hidden
                              >
                                {checked ? <Check className="size-3" /> : null}
                              </span>
                              <span
                                className={
                                  checked
                                    ? "text-foreground"
                                    : "text-muted-foreground"
                                }
                              >
                                {ln.label}
                              </span>
                            </span>
                            <span className="font-medium tabular-nums text-foreground">
                              {ln.count.toLocaleString()}
                            </span>
                          </button>
                        );
                      })}
                      <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1 text-xs text-muted-foreground">
                        <span>Purchased (exits — no lane)</span>
                        <span className="tabular-nums">
                          {splitPreview.converted_excluded.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>Opted out (suppressed)</span>
                        <span className="tabular-nums">
                          {splitPreview.opted_out_excluded.toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {splitPreview.source_contacts === 0 ? (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                        <span className="font-medium">
                          These completed stages reached nobody.
                        </span>{" "}
                        Every lane would be empty right now. This usually means
                        the stage that actually sent still has messages in
                        flight, so it doesn&apos;t count as completed yet. You
                        can still create the split — the source scope is
                        re-resolved shortly before the lanes send — but nothing
                        will go out unless more stages finish first.
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      These numbers are a live preview and will change until the
                      lanes are prepared. The source scope is re-resolved
                      shortly before they send, so a stage that finishes in the
                      meantime is included. A lane that ends up with nobody is
                      skipped, not failed — its siblings still send.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={behavioralSplitApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBehavioralSplit();
              }}
              disabled={
                behavioralSplitApi.isLoading ||
                splitPreviewApi.isLoading ||
                splitPreview?.can_split !== true ||
                selectedTiers.length === 0
              }
            >
              {selectedTiers.length === 0
                ? "Pick at least one lane"
                : `Create ${selectedTiers.length} lane${selectedTiers.length === 1 ? "" : "s"}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* §A4: shared Prepare popup, opened from a stages-list Orange row. */}
      <StagePrepareDialog
        target={prepareTarget}
        onClose={() => setPrepareTarget(null)}
        onPrepared={() => {
          refetchStages();
          refetchCampaign();
        }}
      />

      <FormDialog
        open={sendStage !== null}
        onOpenChange={(open) => {
          if (!open) setSendStage(null);
        }}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Send — Stage {sendStage?.stage_number}</DialogTitle>
          <DialogDescription>
            Approve, materialize + mint links, then send. Sending is gated and
            irreversible.
          </DialogDescription>
        </DialogHeader>
        {sendStage ? (
          <StageSendPanel campaignId={campaignId} stageId={sendStage.id} />
        ) : null}
      </FormDialog>

      {/* Upload contacts onto the campaign audience (draft only) */}
      <FormDialog
        open={uploadContactsOpen}
        onOpenChange={setUploadContactsOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Upload contacts to this campaign</DialogTitle>
          <DialogDescription>
            Paste or upload a CSV of phone numbers. New numbers are created,
            existing ones are reused, and all are tagged with the selected
            contact group(s) — which are added to this campaign&apos;s audience.
          </DialogDescription>
        </DialogHeader>
        <PhoneUploadForm
          endpoint={`/api/campaigns/${campaignId}/upload-contacts`}
          enableContactGroups
          requireContactGroups
          enableLookup
          submitLabel="Upload to campaign"
          successLabel="Contacts uploaded to campaign"
          onSuccess={() => {
            toast.success("Audience updated");
            refetchCampaign();
          }}
          onCancel={() => setUploadContactsOpen(false)}
        />
      </FormDialog>

      <StatusChangeDialog
        transition={campaignTransition}
        campaignName={campaign.name}
        isPending={campaignStatusApi.isLoading}
        onCancel={() => setCampaignTransition(null)}
        onConfirm={handleCampaignTransition}
        // Both inputs are already in client state here; the list page has to
        // prefetch them. Both build the argument through exclTimingInput so
        // neither page decides anything itself.
        exclTiming={exclTimingInput({
          lifecycleRules: campaign.lifecycle_rules === true,
          excludeSegmentIds: campaign.audience_exclude_segment_ids,
          stageScheduledAt: stages.map((s) => s.scheduled_at),
          now: transitionOpenedAt,
        })}
      />

      <AlertDialog
        open={campaignArchiveConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setCampaignArchiveConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {campaignArchiveConfirm === "archive"
                ? "Archive this campaign?"
                : "Restore this campaign?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {campaignArchiveConfirm === "archive"
                ? "Archived campaigns are hidden from the active list. Data is preserved."
                : "Restoring brings the campaign back as a draft so any subsequent activation is an explicit action."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                campaignArchiveApi.isLoading || campaignRestoreApi.isLoading
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleCampaignArchiveRestore();
              }}
              disabled={
                campaignArchiveApi.isLoading || campaignRestoreApi.isLoading
              }
            >
              {campaignArchiveConfirm === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={stageArchiveConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setStageArchiveConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {stageArchiveConfirm?.kind === "archive"
                ? "Archive this stage?"
                : "Restore this stage?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {stageArchiveConfirm?.kind === "archive"
                ? "Archived stages are hidden from the active list. Data is preserved."
                : "Restoring brings the stage back as a draft."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={stageArchiveApi.isLoading || stageRestoreApi.isLoading}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleStageArchiveRestore();
              }}
              disabled={stageArchiveApi.isLoading || stageRestoreApi.isLoading}
            >
              {stageArchiveConfirm?.kind === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={stageDeleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setStageDeleteConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete stage {stageDeleteConfirm?.stage_number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the stage and all of its records. This
              can&apos;t be undone. Stages that were sent or have imported
              results can&apos;t be deleted — archive those instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stageDeleteApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={stageDeleteApi.isLoading}
              onClick={(e) => {
                e.preventDefault();
                void handleStageDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel materialized send → revert to editable. */}
      <AlertDialog
        open={stageCancelConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setStageCancelConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Cancel send for stage {stageCancelConfirm?.stage_number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Discards the{" "}
              {(stageCancelConfirm?.send_counts.pending ?? 0).toLocaleString()}{" "}
              pending message
              {stageCancelConfirm?.send_counts.pending === 1 ? "" : "s"}{" "}
              materialized for this stage and un-approves it, so you can edit
              and re-prepare. Nothing has been sent yet. The schedule is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stageCancelApi.isLoading}>
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={stageCancelApi.isLoading}
              onClick={(e) => {
                e.preventDefault();
                void handleStageCancel();
              }}
            >
              Cancel send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import results — multi-step long-flow form, FormDialog gates dismissal */}
      <FormDialog
        open={importStage !== null}
        onOpenChange={(open) => {
          if (!open) setImportStage(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>Import results (CSV)</DialogTitle>
          <DialogDescription>
            {importStage
              ? `Stage ${importStage.stage_number}${importStage.label ? ` · ${importStage.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {importStage ? (
          <ResultsImportForm
            key={`import-${importStage.id}`}
            campaignId={campaignId}
            stageId={importStage.id}
            stage={{
              stage_number: importStage.stage_number,
              sms_provider_id: importStage.sms_provider_id,
              provider: importStage.provider,
            }}
            onClose={() => setImportStage(null)}
            onComplete={() => {
              refetchCampaign();
              refetchStages();
            }}
          />
        ) : null}
      </FormDialog>

      {/* Manual results entry — set the stage's totals by hand */}
      <FormDialog
        open={manualStage !== null}
        onOpenChange={(open) => {
          if (!open) setManualStage(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Enter results manually</DialogTitle>
          <DialogDescription>
            {manualStage
              ? `Stage ${manualStage.stage_number}${manualStage.label ? ` · ${manualStage.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {manualStage ? (
          <ManualResultsForm
            key={`manual-${manualStage.id}`}
            campaignId={campaignId}
            stageId={manualStage.id}
            initial={{
              sms_count: manualStage.sms_count,
              delivered_count: manualStage.delivered_count,
              opt_out_count: manualStage.opt_out_count,
              click_count: manualStage.click_count,
              scrubbed_count: manualStage.scrubbed_count,
              bounced_count: manualStage.bounced_count,
              checkout_click_count: manualStage.checkout_click_count,
              sales_count: manualStage.sales_count,
              total_cost: manualStage.total_cost,
              total_cost_manual: manualStage.total_cost_manual,
            }}
            costPerSms={
              manualStage.provider_phone
                ? Number(manualStage.provider_phone.cost_per_sms)
                : null
            }
            // Real messages accepted by the provider (API/tracked stages keep
            // their dispatched count here, not in sms_count). Drives the auto
            // cost preview so it matches what the server recomputes.
            sentCount={manualStage.send_counts?.sent ?? 0}
            // Whether the stage has actually been sent — cost only calculates
            // after the send (sent_at), or once results are hand-entered.
            isSent={manualStage.sent_at != null}
            offerPayoutCpa={
              manualStage.offer?.payout_cpa != null
                ? Number(manualStage.offer.payout_cpa)
                : null
            }
            onClose={() => setManualStage(null)}
            onComplete={() => {
              refetchCampaign();
              refetchStages();
            }}
          />
        ) : null}
      </FormDialog>

      {/* Import history */}
      <FormDialog
        open={historyStage !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryStage(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>Import history</DialogTitle>
          <DialogDescription>
            {historyStage
              ? `Stage ${historyStage.stage_number}${historyStage.label ? ` · ${historyStage.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {historyStage ? (
          <ImportHistoryDialog
            key={`history-${historyStage.id}`}
            campaignId={campaignId}
            stageId={historyStage.id}
            stageNumber={historyStage.stage_number}
            members={members.map((m) => ({
              user_id: m.id,
              display_name: m.display_name,
            }))}
            onClose={() => setHistoryStage(null)}
            onReverted={() => {
              refetchCampaign();
              refetchStages();
            }}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

// =============== Sub-components ===============

function TotalsMetric({
  label,
  value,
  raw,
  title,
}: {
  label: string;
  value: number | string;
  raw?: boolean;
  // Hover explanation. Used by the Clickers tile to say why the figure carries
  // a "*" (CamMan's count standing in for absent Keitaro visits).
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">
        {raw
          ? value
          : typeof value === "number"
            ? value.toLocaleString()
            : value}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/campaigns"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3" aria-hidden /> All campaigns
    </Link>
  );
}

function MetaCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs uppercase text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function CampaignMetaCompact({
  campaign,
  memberLabel,
}: {
  campaign: CampaignDetail;
  memberLabel: (userId: string | null) => string | null;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const assigned = memberLabel(campaign.assigned_to_user_id) ?? "Unassigned";
  const createdBy = memberLabel(campaign.created_by_user_id) ?? "—";
  const createdDate = format(new Date(campaign.created_at), "MMM d, yyyy");
  const audienceCount = campaign.audience_snapshot_count;
  const capSuffix =
    campaign.audience_cap !== null
      ? ` (cap ${campaign.audience_cap.toLocaleString()})`
      : "";
  const dateRange =
    campaign.start_date || campaign.end_date
      ? `${campaign.start_date ?? "—"} → ${campaign.end_date ?? "—"}`
      : "—";

  return (
    <Card>
      <CardContent className="grid gap-2 p-4 text-sm">
        {/* Line 1: Brand · Offer · Routing */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {campaign.brand ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: campaign.brand.color ?? "#64748B" }}
                aria-hidden
              />
              <span className="font-medium">{campaign.brand.name}</span>
            </span>
          ) : null}
          {campaign.brand && campaign.offer ? (
            <span className="text-muted-foreground">·</span>
          ) : null}
          {campaign.offer ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: campaign.offer.color ?? "#64748B" }}
                aria-hidden
              />
              <span>{campaign.offer.name}</span>
            </span>
          ) : null}
          {campaign.routing_type ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span>{campaign.routing_type.name}</span>
            </>
          ) : null}
        </div>

        {/* Line 2: Traffic · Assigned · Created · Audience · Tracking ID [Details ▾] */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            Traffic:{" "}
            <span className="text-foreground">
              {campaign.traffic_type?.name ?? "—"}
            </span>
          </span>
          <span>·</span>
          <span>
            Assigned: <span className="text-foreground">{assigned}</span>
          </span>
          <span>·</span>
          <span>
            Created <span className="text-foreground">{createdDate}</span>
          </span>
          <span>·</span>
          <span>
            Audience:{" "}
            <span className="font-mono tabular-nums text-foreground">
              {audienceCount.toLocaleString()}
            </span>{" "}
            frozen
            {capSuffix}
          </span>
          {campaign.tracking_id ? (
            <>
              <span>·</span>
              <span>
                Tracking:{" "}
                <button
                  type="button"
                  className="font-mono text-foreground hover:underline"
                  title="Click to copy"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(campaign.tracking_id as string)
                      .then(() => toast.success("Tracking ID copied"))
                      .catch(() => toast.error("Couldn't copy"));
                  }}
                >
                  {campaign.tracking_id}
                </button>
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setShowDetails((s) => !s)}
            className="ml-auto inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
            aria-expanded={showDetails}
          >
            Details
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                showDetails && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        </div>

        {showDetails ? (
          <div className="grid gap-3 border-t pt-3 md:grid-cols-3">
            <MetaCell label="Created by" value={createdBy} />
            <MetaCell label="Start / End" value={dateRange} />
            <MetaCell
              label="Segments"
              value={
                campaign.audience_segment_ids.length > 0
                  ? campaign.audience_segment_ids.join(", ")
                  : "—"
              }
            />
            <MetaCell
              label="Contact groups"
              value={
                campaign.audience_contact_group_ids.length > 0
                  ? campaign.audience_contact_group_ids.join(", ")
                  : "—"
              }
            />
            <MetaCell
              label="Audience cap"
              value={
                campaign.audience_cap !== null
                  ? campaign.audience_cap.toLocaleString()
                  : "None"
              }
            />
            <MetaCell
              label="Filters"
              value={
                <span className="font-mono text-xs">
                  {Object.entries(campaign.audience_filters)
                    .filter(([, v]) => v === true)
                    .map(([k]) => k.replace(/^include_/, ""))
                    .join(", ") || "—"}
                </span>
              }
            />
            <MetaCell
              label="Exclude in-use"
              value={campaign.exclude_in_use_contacts ? "Yes" : "No"}
            />
          </div>
        ) : null}

        {campaign.notes ? (
          <div className="border-t pt-3">
            <div className="text-xs uppercase text-muted-foreground">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm">{campaign.notes}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
