"use client";

import { Loader2, Lock, Search } from "lucide-react";

import { MultiSelectPicker } from "@/components/multi-select-picker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { CAMPAIGN_CARRIER_FILTER_VALUES } from "@/lib/validators/campaigns";
import { cn } from "@/lib/utils";

import { NONE, type CampaignFormState } from "./campaign-form-state";

export interface CampaignFormFieldsProps {
  state: CampaignFormState;
  // Page mode renders the Name field in the sticky header; skip it here
  // to avoid duplicate registration.
  omitName?: boolean;
  // Page mode relocates the audience preview to a right rail; skip the
  // inline card so it doesn't render twice.
  omitAudiencePreview?: boolean;
}

export function CampaignFormFields({
  state,
  omitName = false,
  omitAudiencePreview = false,
}: CampaignFormFieldsProps) {
  const {
    form,
    isEdit,
    brands,
    offers,
    routingTypes,
    trafficTypes,
    segments,
    contactGroups,
    contactGroupsLoading,
    members,
    activePhones,
    audienceLocked,
    anySubmitting,
    segmentSearch,
    setSegmentSearch,
    filteredSegments,
    watchedSegments,
    watchedContactGroups,
    watchedFilters,
    watchedExcludeInUse,
    watchedExcludePriorOffer,
    watchedLinkMode,
    selectedBrandShortDomain,
    setLinkMode,
    toggleSegment,
    setFilter,
    setCarrierFilter,
    dateError,
  } = state;

  return (
    <>
      {/* ============ Identity ============ */}
      <section className="grid gap-4">
        <SectionHeader title="Identity" />
        {omitName ? null : (
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Q1 New Customer Push"
                    disabled={anySubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="human_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Human ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="Q1-PROMO-2026"
                  disabled={anySubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Letters, digits, hyphens, underscores. Useful when this
                campaign maps to an external system.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="Anything worth remembering — context, links to specs, etc."
                  disabled={anySubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </section>

      <Separator />

      {/* ============ Core ============ */}
      <section className="grid gap-4">
        <SectionHeader title="Core" />
        <FormField
          control={form.control}
          name="brand_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Brand</FormLabel>
              <Select
                value={field.value === null ? "" : String(field.value)}
                onValueChange={(v) => field.onChange(Number(v))}
                disabled={anySubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a brand" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {brands.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: b.color ?? "#64748B" }}
                        />
                        {b.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="offer_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Offer</FormLabel>
              <Select
                value={field.value === null ? "" : String(field.value)}
                onValueChange={(v) => field.onChange(Number(v))}
                disabled={anySubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an offer" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {offers.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: o.color ?? "#64748B" }}
                        />
                        <span>{o.name}</span>
                        <span className="text-xs text-muted-foreground">
                          ·{" "}
                          {o.payout_model === "cpa"
                            ? `$${o.payout_cpa ?? "0"} CPA`
                            : "revshare"}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        {/* Send method (link_mode). Create-mode only; existing campaigns flip
            it from the detail page. API Send is disabled until the selected
            brand has an active short domain. */}
        {!isEdit ? (
        <div className="grid gap-1.5">
          <Label>Send method</Label>
          <Select
            value={watchedLinkMode}
            onValueChange={(v) => setLinkMode(v as "manual" | "tracked")}
            disabled={anySubmitting}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual Send</SelectItem>
              <SelectItem value="tracked" disabled={!selectedBrandShortDomain}>
                API Send
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {watchedLinkMode === "tracked"
              ? "Mints a unique tracked link per recipient at send time."
              : "Uses the operator-pasted Short URL on each stage."}
            {!selectedBrandShortDomain
              ? " API Send needs an active short domain on the brand (set it in Brands)."
              : ""}
          </p>
        </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="routing_type_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Routing type</FormLabel>
                <Select
                  value={field.value === null ? NONE : String(field.value)}
                  onValueChange={(v) =>
                    field.onChange(v === NONE ? null : Number(v))
                  }
                  disabled={anySubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {routingTypes.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="traffic_type_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Traffic type</FormLabel>
                <Select
                  value={field.value === null ? NONE : String(field.value)}
                  onValueChange={(v) =>
                    field.onChange(v === NONE ? null : Number(v))
                  }
                  disabled={anySubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {trafficTypes.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="default_provider_phone_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Default send-from number</FormLabel>
              <Select
                value={field.value === null ? NONE : String(field.value)}
                onValueChange={(v) =>
                  field.onChange(v === NONE ? null : Number(v))
                }
                disabled={anySubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="No default" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE}>No default</SelectItem>
                  {activePhones.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span className="font-mono text-xs">
                        {formatPhoneInternational(p.phone_number)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {p.provider_name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                New stages start from this number. Optional; each stage can
                override.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="assigned_to_user_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Assigned to</FormLabel>
              <Select
                value={field.value === null ? NONE : field.value}
                onValueChange={(v) =>
                  field.onChange(v === NONE ? null : v)
                }
                disabled={anySubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.display_name ?? m.email ?? m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                Defaults to you. Reassign later from the actions menu
                (requires manager+).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </section>

      <Separator />

      {/* ============ Audience ============ */}
      <section className="grid gap-4">
        <SectionHeader title="Audience" />
        {audienceLocked ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
            <Lock
              className="size-4 mt-0.5 text-amber-700 dark:text-amber-300"
              aria-hidden
            />
            <div className="text-amber-800 dark:text-amber-200">
              Audience is locked once a campaign is activated. To change
              the audience, create a new campaign.
            </div>
          </div>
        ) : null}

        {/* Segments
            TODO: this inline scrollable list with search predates
            <MultiSelectPicker>. It scales fine (already has search +
            scroll), but a future cleanup could migrate to the shared
            picker for UI consistency. The current pattern is
            "visible-by-default" rather than popover-collapsed, which
            suits the campaign builder's main step better. */}
        <div className="grid gap-2">
          <Label>
            Segments
            <span aria-hidden className="text-destructive ml-0.5">*</span>
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              (segment or contact group required to activate)
            </span>
          </Label>
          <div className="relative">
            <Search
              className="absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={segmentSearch}
              onChange={(e) => setSegmentSearch(e.target.value)}
              placeholder="Search segments…"
              disabled={audienceLocked || anySubmitting}
              className="pl-9"
            />
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border bg-background">
            {filteredSegments.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {segments.length === 0
                  ? "No segments available."
                  : "No segments match your search."}
              </p>
            ) : (
              <ul className="divide-y">
                {filteredSegments.map((s) => {
                  const selected = watchedSegments.includes(s.id);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        disabled={audienceLocked || anySubmitting}
                        onClick={() => toggleSegment(s.id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50",
                          selected && "bg-muted/30",
                          (audienceLocked || anySubmitting) &&
                            "cursor-not-allowed opacity-60",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected}
                            readOnly
                            tabIndex={-1}
                            className="size-4 cursor-pointer"
                          />
                          <span className="font-medium">{s.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {s.segment_id}
                          </span>
                          {(s.active_rules_count ?? 0) > 0 ? (
                            <span
                              className="rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
                              title={`This segment uses ${s.active_rules_count} audience rule${s.active_rules_count === 1 ? "" : "s"} combined with its manual membership. The audience count reflects the rule-filtered+manual UNION.`}
                            >
                              Has rules
                            </span>
                          ) : null}
                        </span>
                        <Badge variant="secondary">
                          {s.stats.total_count.toLocaleString()}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {watchedSegments.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {watchedSegments.length} segment
              {watchedSegments.length === 1 ? "" : "s"} selected
            </p>
          ) : null}
        </div>

        {/* Contact groups — UNION'd into the audience alongside segments. */}
        <div className="grid gap-2">
          <Label>Contact groups</Label>
          <MultiSelectPicker
            options={contactGroups.map((g) => ({
              id: g.id,
              label: g.name,
              color: g.color,
            }))}
            value={watchedContactGroups}
            onChange={(next) =>
              form.setValue(
                "audience_contact_group_ids",
                next as number[],
                { shouldDirty: true },
              )
            }
            placeholder="Add contact groups…"
            selectedLabel={(n) =>
              `${n} contact group${n === 1 ? "" : "s"} selected`
            }
            isLoading={contactGroupsLoading && contactGroups.length === 0}
            disabled={audienceLocked || anySubmitting}
            emptyMessage="No contact groups exist yet."
            searchPlaceholder="Search groups…"
          />
          <p className="text-xs text-muted-foreground">
            Contacts in any selected group are included in the audience
            alongside contacts from the selected segments (UNION).
          </p>
        </div>

        {/* Filter toggles */}
        <div className="grid gap-3">
          <FilterToggle
            label="Include no-status contacts"
            description="People in your segments without recorded opt-in or click activity"
            checked={watchedFilters.include_no_status}
            onChange={(v) => setFilter("include_no_status", v)}
            disabled={audienceLocked || anySubmitting}
          />
          <FilterToggle
            label="Include opt-in contacts"
            description="People who explicitly opted in"
            checked={watchedFilters.include_opt_in}
            onChange={(v) => setFilter("include_opt_in", v)}
            disabled={audienceLocked || anySubmitting}
          />
          <FilterToggle
            label="Include clickers"
            description="People who clicked a link in a past send"
            checked={watchedFilters.include_clickers}
            onChange={(v) => setFilter("include_clickers", v)}
            disabled={audienceLocked || anySubmitting}
          />
          <FilterToggle
            label="Include not-clicked contacts"
            description="People uploaded but with no click recorded"
            checked={watchedFilters.include_not_clicked}
            onChange={(v) => setFilter("include_not_clicked", v)}
            disabled={audienceLocked || anySubmitting}
          />
          <p className="text-xs text-muted-foreground">
            Opt-outs are always excluded from sends — this is non-overridable.
          </p>
        </div>

        {/* Carrier filter (optional). Empty = no filter. When set, only the
            chosen carriers qualify and never-looked-up numbers are dropped. */}
        <div className="grid gap-2">
          <Label>Carrier filter</Label>
          <MultiSelectPicker
            options={CAMPAIGN_CARRIER_FILTER_VALUES.map((c) => ({
              id: c,
              label: c,
            }))}
            value={watchedFilters.carrier_filter}
            onChange={(next) => setCarrierFilter(next as string[])}
            placeholder="All carriers (no filter)"
            selectedLabel={(n) =>
              `${n} carrier${n === 1 ? "" : "s"} selected`
            }
            disabled={audienceLocked || anySubmitting}
            searchPlaceholder="Search carriers…"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to send to every carrier. When set, only contacts on
            the selected carriers are included; numbers never looked up
            (unidentified) are excluded.
          </p>
        </div>

        {/* Audience cap */}
        <FormField
          control={form.control}
          name="audience_cap"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Audience cap</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="No cap"
                  disabled={audienceLocked || anySubmitting}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") {
                      field.onChange(null);
                      return;
                    }
                    const n = Number(v);
                    field.onChange(
                      Number.isFinite(n) && n > 0 ? Math.floor(n) : null,
                    );
                  }}
                />
              </FormControl>
              <FormDescription>
                Leave blank to use the full matching audience. When set, a
                random sample of N contacts is selected at activation. The
                sample is frozen — re-activating won&apos;t pick different
                contacts.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Exclude contacts already in use by another active campaign */}
        <FilterToggle
          label="Exclude contacts in use"
          description="Drop contacts already in another active campaign's audience. The cap then draws from unused contacts only."
          checked={watchedExcludeInUse}
          onChange={(v) =>
            form.setValue("exclude_in_use_contacts", v, { shouldDirty: true })
          }
          disabled={audienceLocked || anySubmitting}
        />

        {/* Exclude leads who already received this offer in a previous campaign
            (content dedup LAYER 3). The always-on hard creative rule applies
            regardless of this toggle. */}
        <FilterToggle
          label="Exclude leads who already got this offer"
          description="Drop contacts who already received this campaign's offer in a previous campaign. The same creative is never re-sent to a lead regardless of this setting."
          checked={watchedExcludePriorOffer}
          onChange={(v) =>
            form.setValue("exclude_prior_offer_contacts", v, {
              shouldDirty: true,
            })
          }
          disabled={audienceLocked || anySubmitting}
        />

        {omitAudiencePreview ? null : <AudiencePreviewCard state={state} />}
      </section>

      <Separator />

      {/* ============ Schedule ============ */}
      <section className="grid gap-4">
        <SectionHeader title="Schedule" />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="start_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start date</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    disabled={anySubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="end_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End date</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    disabled={anySubmitting}
                    {...field}
                  />
                </FormControl>
                {dateError ? (
                  <p className="text-sm text-destructive">{dateError}</p>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </section>
    </>
  );
}

// Renders one line per carrier bucket dropped by an active carrier filter.
// "Unidentified" (never-looked-up numbers) gets its own phrasing. Renders
// nothing when no carrier filter is active or nothing was removed.
export function CarrierRemovedLines({
  carrierFilter,
  carrierRemoved,
}: {
  carrierFilter: string[];
  carrierRemoved: Record<string, number>;
}) {
  if (carrierFilter.length === 0) return null;
  const unidentified = carrierRemoved["Unidentified"] ?? 0;
  const others = Object.entries(carrierRemoved).filter(
    ([bucket, n]) => bucket !== "Unidentified" && n > 0,
  );
  if (unidentified === 0 && others.length === 0) return null;
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      {unidentified > 0 ? (
        <div>
          <span className="font-mono tabular-nums text-foreground">
            {unidentified.toLocaleString()}
          </span>{" "}
          number{unidentified === 1 ? "" : "s"} removed as unidentified (never
          looked up)
        </div>
      ) : null}
      {others.map(([bucket, n]) => (
        <div key={bucket}>
          <span className="font-mono tabular-nums text-foreground">
            {n.toLocaleString()}
          </span>{" "}
          removed — {bucket}
        </div>
      ))}
    </div>
  );
}

export function AudiencePreviewCard({ state }: { state: CampaignFormState }) {
  const {
    hasAudienceSource,
    previewCount,
    previewTotalMatching,
    previewError,
    previewLoading,
    watchedFilters,
    previewCarrierRemoved,
  } = state;
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 pt-6 text-sm">
        <div className="grid gap-1.5">
          <div className="text-xs uppercase text-muted-foreground">
            Estimated audience
          </div>
          {!hasAudienceSource ? (
            <div className="text-muted-foreground">
              0 contacts (pick segments or contact groups to see your
              reach)
            </div>
          ) : previewError ? (
            <div className="text-sm text-muted-foreground">
              Could not preview audience — fix any issues above
            </div>
          ) : previewCount === null ||
            previewTotalMatching === null ? (
            <div className="text-2xl font-semibold tabular-nums">—</div>
          ) : previewCount < previewTotalMatching ? (
            <>
              <div className="text-sm text-muted-foreground">
                Total matching:{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {previewTotalMatching.toLocaleString()}
                </span>{" "}
                contacts
              </div>
              <div className="text-2xl font-semibold tabular-nums">
                Will send to: {previewCount.toLocaleString()}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  (random sample, applied at activation)
                </span>
              </div>
            </>
          ) : (
            <div className="text-2xl font-semibold tabular-nums">
              {previewCount.toLocaleString()} contacts
            </div>
          )}
          {hasAudienceSource && !previewError ? (
            <CarrierRemovedLines
              carrierFilter={watchedFilters.carrier_filter}
              carrierRemoved={previewCarrierRemoved}
            />
          ) : null}
        </div>
        {previewLoading ? (
          <Loader2
            className="size-4 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h3 className="text-sm font-semibold text-foreground">{title}</h3>;
}

function FilterToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
