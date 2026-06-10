"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { cn } from "@/lib/utils";
import type { CreativeSequencePlacement } from "@/lib/validators/creatives";

// What the picker needs from a creative. Superset of the stage form's own
// Creative type so the chosen one can be merged straight back into its state.
export type PickerCreative = {
  id: number;
  slug: string;
  text: string;
  status: string;
  sequence_placement: CreativeSequencePlacement;
  spam_score: number | null;
  spam_verdict: "spam" | "not_spam" | null;
  metrics: {
    ctr: number | null;
    epc: number | null;
  };
};

type OfferOption = { id: number; name: string; color: string | null };

type ListResponse = { data: PickerCreative[] };
type OffersResponse = { data: OfferOption[] };

// The sequence positions the operator actually filters on (mockup pills).
// "any"/"unknown" creatives are surfaced only when no pill is active.
const SEQUENCE_PILLS: { value: CreativeSequencePlacement; label: string }[] = [
  { value: "1st", label: "1st" },
  { value: "2nd", label: "2nd" },
  { value: "3rd", label: "3rd" },
  { value: "warmup", label: "WarmUp" },
];

const SEQUENCE_LABEL: Record<CreativeSequencePlacement, string> = {
  warmup: "WarmUp",
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  any: "Any",
  unknown: "Unknown",
};

function SpamDot({
  score,
  verdict,
}: {
  score: number | null;
  verdict: "spam" | "not_spam" | null;
}) {
  if (score === null) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title="Not scored yet"
      >
        <span className="size-2 rounded-full bg-muted-foreground/30" aria-hidden />
        <span className="font-mono">—</span>
      </span>
    );
  }
  const isSpam = verdict === "spam";
  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      title={`Spam score: ${score}/100 (${isSpam ? "SPAM" : "NOT SPAM"})`}
    >
      <span
        className={cn("size-2 rounded-full", isSpam ? "bg-red-500" : "bg-green-500")}
        aria-hidden
      />
      <span
        className={cn(
          "font-mono tabular-nums",
          isSpam
            ? "text-red-700 dark:text-red-300"
            : "text-green-700 dark:text-green-300",
        )}
      >
        {score}
      </span>
    </span>
  );
}

function formatPercent(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function formatEpc(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(3)}`;
}

export interface CreativePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Campaign context: the offer is pre-selected (and locked on) in the offers
  // panel; brand + link state drive the SMS preview.
  campaignOffer: { id: number; name: string } | null;
  brandName: string;
  stopText: string;
  // Already-resolved link line for the preview (tracked-link preview or the
  // manual short_url). Empty string when there's none.
  linkPreviewUrl: string;
  selectedCreativeId: number | null;
  onSelect: (creative: PickerCreative) => void;
  // Opens the inline "new creative" form (handled by the parent).
  onCreateNew?: () => void;
}

export function CreativePickerDialog({
  open,
  onOpenChange,
  campaignOffer,
  brandName,
  stopText,
  linkPreviewUrl,
  selectedCreativeId,
  onSelect,
  onCreateNew,
}: CreativePickerDialogProps) {
  const creativesApi = useApiCall<ListResponse>();
  const offersApi = useApiCall<OffersResponse>();

  const [search, setSearch] = useState("");
  const [sequences, setSequences] = useState<CreativeSequencePlacement[]>([]);
  const [offers, setOffers] = useState<OfferOption[]>([]);
  // Extra offers (beyond the campaign's) the operator checked to widen the list.
  const [extraOfferIds, setExtraOfferIds] = useState<number[]>([]);
  // "All offers" toggle. OFF by default: creatives marked applies_to_all_offers
  // are hidden until the operator opts in. ON ⇒ they're added to the list.
  const [includeAllOffers, setIncludeAllOffers] = useState(false);
  const [creatives, setCreatives] = useState<PickerCreative[]>([]);
  // Highlighted (preview) row — seeded from the stage's current selection. The
  // dialog is mounted fresh each time it opens (parent gates on `open`), so
  // this initializer is the reset; no reset-on-open effect needed.
  const [activeId, setActiveId] = useState<number | null>(selectedCreativeId);

  const offerIds = useMemo(() => {
    const ids = new Set<number>(extraOfferIds);
    if (campaignOffer) ids.add(campaignOffer.id);
    return Array.from(ids);
  }, [extraOfferIds, campaignOffer]);

  // Fetch the active org offers for the "show more creatives" panel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=500&status=active");
      if (!cancelled && r.ok) setOffers(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [offersApi.execute]);

  // Fetch creatives only when the offer SET or the ALL toggle changes — these
  // change the server-side eligibility. Search and sequence are filtered
  // client-side below (instant, no round-trip), which is the main win when
  // rapidly switching filters. setState lands inside the async callback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sp = new URLSearchParams({
        pageSize: "200",
        status: "active",
        sortBy: "epc",
        sortDir: "desc",
        include_all_offers: includeAllOffers ? "true" : "false",
      });
      if (offerIds.length > 0) sp.set("offer_ids", offerIds.join(","));
      const r = await creativesApi.execute(`/api/creatives/list?${sp.toString()}`);
      if (!cancelled && r.ok) setCreatives(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [creativesApi.execute, offerIds, includeAllOffers]);

  // Client-side search (text/slug) + sequence filter over the fetched set. The
  // server already ranked by EPC desc; filtering preserves that order.
  const visibleCreatives = useMemo(() => {
    const q = search.trim().toLowerCase();
    return creatives.filter((c) => {
      if (sequences.length > 0 && !sequences.includes(c.sequence_placement))
        return false;
      if (q) {
        const hay = `${c.text} ${c.slug}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [creatives, search, sequences]);

  const activeCreative = useMemo(
    () => creatives.find((c) => c.id === activeId) ?? null,
    [creatives, activeId],
  );

  const assembledSms = buildStageSms({
    brandName,
    creativeText: activeCreative?.text,
    linkUrl: linkPreviewUrl,
    stopText,
  });
  const segments = useMemo(
    () => calculateSmsSegments(assembledSms),
    [assembledSms],
  );

  // Warnings for the highlighted creative (spam / multi-segment / unicode).
  const warnings = useMemo(() => {
    if (!activeCreative) return [] as string[];
    const w: string[] = [];
    if (activeCreative.spam_verdict === "spam") w.push("Flagged as spam");
    if (segments.segments > 1) w.push(`${segments.segments} segments`);
    if (segments.charset !== "GSM-7") w.push("Unicode (UCS-2)");
    return w;
  }, [activeCreative, segments]);

  function toggleSequence(value: CreativeSequencePlacement) {
    setSequences((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
  }
  function toggleOffer(id: number) {
    setExtraOfferIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function confirmSelection() {
    if (activeCreative) onSelect(activeCreative);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Select a creative</DialogTitle>
          <DialogDescription>
            Filter and preview creatives
            {campaignOffer ? ` for “${campaignOffer.name}”` : ""}, then pick one
            for this stage.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[calc(92vh-9rem)] grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2">
          {/* ---- Left column: search + list + sequence filters ---- */}
          <div className="flex min-w-0 flex-col gap-3">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search creatives by text or ID…"
              aria-label="Search creatives"
            />

            <div className="rounded-md border">
              <div className="max-h-[44vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-muted/60 text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="px-2 py-2 text-left font-medium">Spam</th>
                      <th className="px-2 py-2 text-left font-medium">Creative</th>
                      <th className="px-2 py-2 text-left font-medium">Seq</th>
                      <th className="px-2 py-2 text-right font-medium">EPC</th>
                      <th className="px-2 py-2 text-right font-medium">CTR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Spinner only on the first load (no rows yet). On a
                        refetch (offer / ALL change) we keep the current rows
                        visible so the list doesn't flash empty. */}
                    {creativesApi.isLoading && creatives.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-10 text-center text-muted-foreground">
                          <Loader2 className="mx-auto size-4 animate-spin" />
                        </td>
                      </tr>
                    ) : visibleCreatives.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                          No matching creatives.
                        </td>
                      </tr>
                    ) : (
                      visibleCreatives.map((c) => {
                        const isActive = c.id === activeId;
                        return (
                          <tr
                            key={c.id}
                            onClick={() => setActiveId(c.id)}
                            className={cn(
                              "cursor-pointer border-t hover:bg-muted/40",
                              isActive && "bg-accent hover:bg-accent",
                            )}
                          >
                            <td className="px-2 py-1.5 align-top">
                              <SpamDot score={c.spam_score} verdict={c.spam_verdict} />
                            </td>
                            <td className="max-w-[18rem] px-2 py-1.5 align-top">
                              <div className="flex items-center gap-1.5">
                                {isActive ? (
                                  <Check className="size-3.5 shrink-0 text-foreground" aria-hidden />
                                ) : null}
                                {/* Full text on hover via title. */}
                                <span className="truncate" title={c.text}>
                                  {c.text}
                                </span>
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {c.slug}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 align-top">
                              <Badge variant="outline" className="font-mono text-[10px]">
                                {SEQUENCE_LABEL[c.sequence_placement]}
                              </Badge>
                            </td>
                            <td className="px-2 py-1.5 text-right align-top tabular-nums">
                              {formatEpc(c.metrics.epc)}
                            </td>
                            <td className="px-2 py-1.5 text-right align-top tabular-nums">
                              {formatPercent(c.metrics.ctr)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                Sequence
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SEQUENCE_PILLS.map((p) => {
                  const on = sequences.includes(p.value);
                  return (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => toggleSequence(p.value)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs transition-colors",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-background hover:bg-muted",
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---- Right column: SMS preview + offers ---- */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="rounded-md border">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2 text-xs">
                <span className="tabular-nums text-muted-foreground">
                  {segments.characters.toLocaleString()} chars
                </span>
                <span className="text-muted-foreground/50">|</span>
                <span className="tabular-nums text-muted-foreground">
                  {segments.segments} segment{segments.segments === 1 ? "" : "s"} (
                  {segments.charset})
                </span>
                <span className="text-muted-foreground/50">|</span>
                {warnings.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5" aria-hidden />
                    {warnings.join(" · ")}
                  </span>
                ) : (
                  <span className="text-muted-foreground">No warnings</span>
                )}
              </div>
              <div className="p-3">
                {activeCreative ? (
                  <pre className="max-h-[34vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-sm">
                    {assembledSms}
                  </pre>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Select a creative to preview the SMS.
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Offers — check more to show their creatives
              </div>
              {offersApi.isLoading && offers.length === 0 ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <div className="flex max-h-[18vh] flex-col gap-1.5 overflow-y-auto">
                  {/* "All offers": when on, creatives flagged applies_to_all_offers
                      are added to the list. Off by default — they stay hidden. */}
                  <label className="flex cursor-pointer items-center gap-2 border-b pb-1.5 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={includeAllOffers}
                      onChange={() => setIncludeAllOffers((v) => !v)}
                      className="size-4"
                    />
                    <span>ALL</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      include creatives for all offers
                    </span>
                  </label>
                  {offers.map((o) => {
                    const isCampaignOffer = campaignOffer?.id === o.id;
                    const checked = isCampaignOffer || extraOfferIds.includes(o.id);
                    return (
                      <label
                        key={o.id}
                        className={cn(
                          "flex items-center gap-2 text-sm",
                          isCampaignOffer
                            ? "cursor-default text-foreground"
                            : "cursor-pointer",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isCampaignOffer}
                          onChange={() => toggleOffer(o.id)}
                          className="size-4"
                        />
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: o.color ?? "#64748B" }}
                          aria-hidden
                        />
                        <span className="truncate">{o.name}</span>
                        {isCampaignOffer ? (
                          <Badge variant="secondary" className="ml-auto text-[10px]">
                            Campaign
                          </Badge>
                        ) : null}
                      </label>
                    );
                  })}
                  {offers.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No offers.</span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-3 sm:justify-between">
          <div>
            {onCreateNew && campaignOffer ? (
              <Button type="button" variant="ghost" size="sm" onClick={onCreateNew}>
                <Plus className="size-4" aria-hidden /> Create new creative
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={!activeCreative} onClick={confirmSelection}>
              Select creative
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
