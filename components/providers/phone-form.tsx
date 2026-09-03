"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { isEntityAvailable } from "@/lib/feature-flags";
import { CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";
import { NAMED_CARRIERS } from "@/lib/sends/carrier-policy";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";
import {
  NUMBER_TYPES,
  NUMBER_TYPE_LABELS,
  providerPhoneCreateSchema,
  providerPhoneUpdateSchema,
} from "@/lib/validators/provider-phones";

// Shape of "create" form values (raw input phone_number + number_type + cost +
// optional brand). In edit mode we omit phone_number/number_type from the
// submit (both immutable) and just send the cost/brand patch.
export type PhoneFormValues = z.input<typeof providerPhoneCreateSchema>;

type Brand = {
  id: number;
  name: string;
  color: string | null;
  avatar_url: string | null;
};
type BrandsListResponse = { data: Brand[]; totalCount: number };

// A per-number setting declared by the provider's connection type. `name` is the
// provider_phones column the input binds to.
export type PhoneSettingField = {
  name: string;
  label: string;
  placeholder: string | null;
  help: string | null;
  /** Declared by the connection type's descriptor. The asterisk here is the
   *  visible half; the route that writes the number enforces the same flag. */
  required?: boolean;
};

// A short domain this number could mint links under. `status` is carried so the
// picker can show a pending domain as unselectable-and-why rather than hiding
// it — an omitted row reads as "my domain didn't save" and gets re-added.
type ShortDomainOption = {
  id: number;
  domain: string;
  brand_id: number;
  status: string;
};

type ProviderOption = { id: number; name: string };

const UNASSIGNED = "__unassigned__";

/** Edit submit may carry a move target (`provider_id`) alongside the field edits. */
/** One row of a number's per-carrier policy. `allowed=false` excludes that
 *  carrier from the number's audience; `daily_limit` is the Q5 cap. */
export type CarrierLimit = {
  carrier_norm: string;
  allowed: boolean;
  daily_limit: number | null;
};

/** Edit submit may carry a move target and the number's carrier policy
 *  alongside the field edits. Both live outside the zod-resolved form — the
 *  resolver strips unknown keys on submit. */
export type PhoneSubmitValues = PhoneFormValues & {
  provider_id?: number;
  allow_unknown_carrier?: boolean;
  carrier_limits?: CarrierLimit[];
  /** Per-number opt-out footer (migration 0141). `null` clears the override and
   *  returns the number to the account's text. */
  opt_out_footer?: string | null;
};

export interface PhoneFormProps {
  mode: "create" | "edit";
  /** Per-number settings this provider's CONNECTION TYPE declares, resolved
   *  server-side from adapter_code (869ej8r00 Q2) and delivered on the provider
   *  detail response.
   *
   *  Replaces the old `providerKey === "txr"` gate. Two reasons that mattered:
   *  keying on sms_provider_id meant a SECOND account of a type (the txh2 row)
   *  would not get its type's fields; and every new provider-specific field
   *  needed another hardcoded branch here. Empty array = this type declares
   *  none, which is every provider except Text Request today. */
  phoneSettingFields?: PhoneSettingField[];
  /** create mode: only `cost_per_sms` / `brand_id` are used.
   *  edit mode: `phone_number` / `number_type` are used for read-only display. */
  initialValues?: Partial<PhoneFormValues>;
  /** Required in edit mode for the read-only display. */
  existingPhoneNumber?: string;
  /** edit mode: the number's current provider — the picker's default value. */
  currentProviderId?: number;
  /** edit mode: providers the picker lists — INCLUDES the current one (its default label). */
  providers?: ProviderOption[];
  /** edit mode: the number's stored `allow_unknown_carrier` (Q4). */
  initialAllowUnknownCarrier?: boolean;
  /** edit mode: the number's stored opt-out footer (migration 0141). */
  initialOptOutFooter?: string | null;
  /** The account-level footer this number would fall back to, and the account's
   *  name — shown as the placeholder so the operator can see what they are
   *  overriding rather than guessing. */
  providerOptOutFooter?: string | null;
  providerName?: string | null;
  /** True when the connection type appends its OWN opt-out text, in which case
   *  nothing set here (or anywhere) is used. */
  providerAppendsOwnOptOut?: boolean;
  /** edit mode: the number's stored carrier policy rows (Q4). Absent carrier =
   *  allowed and uncapped, so an empty array is a complete, meaningful state. */
  initialCarrierLimits?: CarrierLimit[];
  onSubmit: (values: PhoneSubmitValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function PhoneForm({
  mode,
  phoneSettingFields,
  initialValues,
  existingPhoneNumber,
  currentProviderId,
  providers,
  providerOptOutFooter,
  providerName,
  providerAppendsOwnOptOut,
  initialAllowUnknownCarrier,
  initialOptOutFooter,
  initialCarrierLimits,
  onSubmit,
  onCancel,
  isSubmitting,
}: PhoneFormProps) {
  const isEdit = mode === "edit";
  const settingFields = phoneSettingFields ?? [];

  // Move target — defaults to the current provider (no move). Local state, not
  // part of the zod-resolved form (which would strip an unknown key on submit).
  const [targetProviderId, setTargetProviderId] = useState<number | undefined>(
    currentProviderId,
  );

  // ── Q4 carrier policy ──────────────────────────────────────────────────
  // Local state for the same reason as targetProviderId: the zod resolver
  // strips keys it does not know, so a policy carried inside the form values
  // would validate and then vanish before submit.
  //
  // Seeded ONCE from props (the dialog is remounted per phone via a `key`), so
  // there is no effect that could re-run on a later render and overwrite the
  // operator's edits with the stored values.
  const [allowUnknownCarrier, setAllowUnknownCarrier] = useState(
    initialAllowUnknownCarrier !== false,
  );
  // Per-number opt-out footer (0141). Outside the zod form for the same reason
  // as the carrier policy: it lives on the UPDATE schema only, and the create
  // resolver would strip it on submit. Seeded once — the dialog is remounted
  // per phone via a `key`, so no effect can later overwrite an operator's edit
  // with the stored value (the bug that used to wipe the short-domain override).
  const [optOutFooter, setOptOutFooter] = useState<string>(
    initialOptOutFooter ?? "",
  );
  // Kept as the FULL row set, not just a list of blocked names, so a Q5 daily
  // cap on a carrier survives an allow-list edit instead of being replaced away
  // by this form's own save.
  const [carrierLimits, setCarrierLimits] = useState<CarrierLimit[]>(
    () => initialCarrierLimits ?? [],
  );
  const isCarrierAllowed = (carrier: string) =>
    carrierLimits.find((r) => r.carrier_norm === carrier)?.allowed !== false;
  function setCarrierAllowed(carrier: string, allowed: boolean) {
    setCarrierLimits((prev) => {
      const existing = prev.find((r) => r.carrier_norm === carrier);
      if (existing) {
        return prev.map((r) =>
          r.carrier_norm === carrier ? { ...r, allowed } : r,
        );
      }
      return [...prev, { carrier_norm: carrier, allowed, daily_limit: null }];
    });
  }
  const blockedCarriers = NAMED_CARRIERS.filter((c) => !isCarrierAllowed(c));
  // Q5 daily cap. Null = uncapped, which is also what "no row" means.
  const carrierDailyLimit = (carrier: string) =>
    carrierLimits.find((r) => r.carrier_norm === carrier)?.daily_limit ?? null;
  function setCarrierDailyLimit(carrier: string, daily_limit: number | null) {
    setCarrierLimits((prev) => {
      const existing = prev.find((r) => r.carrier_norm === carrier);
      if (existing) {
        return prev.map((r) =>
          r.carrier_norm === carrier ? { ...r, daily_limit } : r,
        );
      }
      return [...prev, { carrier_norm: carrier, allowed: true, daily_limit }];
    });
  }
  const cappedCarriers = NAMED_CARRIERS.filter(
    (c) => isCarrierAllowed(c) && carrierDailyLimit(c) != null,
  );

  // In edit mode we hide phone_number/number_type from validation by using the
  // update schema (which omits them). In create mode we use the create schema.
  const form = useForm<PhoneFormValues>({
    resolver: zodResolver(
      isEdit
        ? (providerPhoneUpdateSchema as unknown as typeof providerPhoneCreateSchema)
        : providerPhoneCreateSchema,
    ),
    defaultValues: {
      phone_number: initialValues?.phone_number ?? "",
      number_type: initialValues?.number_type ?? "10dlc",
      cost_per_sms: initialValues?.cost_per_sms ?? 0,
      brand_id: initialValues?.brand_id ?? null,
      max_sends_per_second: initialValues?.max_sends_per_second ?? null,
      dashboard_id: initialValues?.dashboard_id ?? null,
      short_domain_id: initialValues?.short_domain_id ?? null,
    },
  });

  const watchedType = form.watch("number_type");
  const isShortCode = watchedType === "short_code";

  // Brands picker — gated on feature flag (brands is true, so the fetch fires).
  const brandsAvailable = isEntityAvailable("brands");
  const brandsApi = useApiCall<BrandsListResponse>();
  const [brands, setBrands] = useState<Brand[]>([]);

  useEffect(() => {
    if (!brandsAvailable) return;
    let cancelled = false;
    (async () => {
      const result = await brandsApi.execute("/api/brands/list?pageSize=100");
      if (cancelled) return;
      if (result.ok) setBrands(result.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [brandsAvailable, brandsApi.execute]);

  // Short domains for the SELECTED brand (migration 0137). Re-fetched when the
  // brand changes, because the override only makes sense within the brand whose
  // campaigns this number sends for — offering another brand's host would mint
  // links on a domain that brand doesn't control.
  const watchedBrandId = form.watch("brand_id");
  const domainsApi = useApiCall<{ data: ShortDomainOption[] }>();
  const { execute: domainsExec } = domainsApi;
  const [domains, setDomains] = useState<ShortDomainOption[]>([]);
  // Which brand the current `domains` array actually describes. NULL means "not
  // loaded yet" — distinct from "loaded and empty", and that distinction is the
  // whole fix below.
  const [domainsFor, setDomainsFor] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (watchedBrandId == null) { setDomains([]); setDomainsFor(null); return; }
      const r = await domainsExec(`/api/short-domains/list?brand_id=${watchedBrandId}`);
      if (cancelled) return;
      if (r.ok) { setDomains(r.data.data); setDomainsFor(watchedBrandId); }
    })();
    return () => { cancelled = true; setDomainsFor(null); };
  }, [watchedBrandId, domainsExec]);

  // Clear a stale override when the brand changes: a domain belonging to the
  // previous brand must not survive the switch. The server refuses a cross-brand
  // assignment outright (`brand_mismatch` in
  // lib/providers/short-domain-assignment.ts), so a stale value here would be
  // rejected rather than stored; clearing it just avoids showing the operator a
  // selection that is about to fail.
  //
  // ⚠️ IT MUST NOT RUN BEFORE `domains` HAS LOADED. `domains` starts as [], so
  // the original version fired on mount with an empty list, concluded the saved
  // override "isn't in the options", and wiped it — every time the Edit-phone
  // modal opened. That is why a saved per-number domain always redisplayed as
  // "Brand default" even though the row was stored correctly (phone 224 really
  // did hold short_domain_id=30). Worse than cosmetic: the cleared NULL was a
  // real form value, so pressing Save then DELETED the override from the
  // database — silent data loss on an unrelated edit.
  //
  // Guarding on `domainsFor === watchedBrandId` is what separates "not loaded
  // yet" from "loaded, and this id is genuinely not among the options"; only the
  // second is grounds for clearing.
  useEffect(() => {
    const cur = form.getValues("short_domain_id");
    if (cur == null) return;
    // No brand ⇒ no override is coherent (the server refuses one), so clear.
    if (watchedBrandId == null) {
      form.setValue("short_domain_id", null);
      return;
    }
    // Options not yet loaded FOR THIS BRAND — say nothing, decide nothing.
    if (domainsFor !== watchedBrandId) return;
    if (!domains.some((d) => d.id === cur)) {
      form.setValue("short_domain_id", null);
    }
  }, [domains, domainsFor, watchedBrandId, form]);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) =>
          onSubmit(
            isEdit
              ? {
                  ...values,
                  provider_id: targetProviderId,
                  allow_unknown_carrier: allowUnknownCarrier,
                  carrier_limits: carrierLimits,
                  // "" means NO PREFERENCE, not an empty footer — send null so
                  // the column clears and the chain falls through.
                  opt_out_footer:
                    optOutFooter.trim() === "" ? null : optOutFooter.trim(),
                }
              : values,
          ),
        )}
        className="grid gap-4"
        noValidate
      >
        {/* Number type — one per number. Immutable after creation. */}
        {isEdit ? (
          <FormItem>
            <FormLabel>Number type</FormLabel>
            <FormControl>
              <Input
                readOnly
                disabled
                value={
                  NUMBER_TYPE_LABELS[
                    (initialValues?.number_type ?? "10dlc") as
                      | "10dlc"
                      | "toll_free"
                      | "short_code"
                  ]
                }
              />
            </FormControl>
            <FormDescription>
              Number type can&apos;t be changed after creation.
            </FormDescription>
          </FormItem>
        ) : (
          <FormField
            control={form.control}
            name="number_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Number type</FormLabel>
                <div className="flex flex-wrap gap-2">
                  {NUMBER_TYPES.map((t) => {
                    const active = field.value === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        disabled={isSubmitting}
                        onClick={() =>
                          form.setValue("number_type", t, {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }
                        className={cn(
                          "rounded-full border px-3 py-1 text-sm transition-colors",
                          active
                            ? "border-foreground bg-foreground text-background"
                            : "border-border bg-background text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {NUMBER_TYPE_LABELS[t]}
                      </button>
                    );
                  })}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {isEdit ? (
          <FormItem>
            <FormLabel>
              {initialValues?.number_type === "short_code"
                ? "Short code"
                : "Phone number"}
            </FormLabel>
            <FormControl>
              <Input
                readOnly
                disabled
                value={
                  existingPhoneNumber
                    ? initialValues?.number_type === "short_code"
                      ? existingPhoneNumber
                      : formatPhoneInternational(existingPhoneNumber)
                    : ""
                }
              />
            </FormControl>
            <FormDescription>
              {initialValues?.number_type === "short_code"
                ? "Short code can't be changed after creation."
                : "Phone number can't be changed after creation."}
            </FormDescription>
          </FormItem>
        ) : (
          <FormField
            control={form.control}
            name="phone_number"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>
                  {isShortCode ? "Short code" : "Phone number"}
                </FormLabel>
                <FormControl>
                  {isShortCode ? (
                    <Input
                      inputMode="numeric"
                      placeholder="12345"
                      maxLength={6}
                      disabled={isSubmitting}
                      {...field}
                    />
                  ) : (
                    <Input
                      placeholder="+1 202 555 0199 or 2025550199"
                      disabled={isSubmitting}
                      {...field}
                    />
                  )}
                </FormControl>
                <FormDescription>
                  {isShortCode
                    ? "A 5- or 6-digit numeric short code."
                    : "E.164 (international) format preferred. US numbers without a country code will be auto-prepended with +1."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Provider — edit mode only. Changing it moves the number to another
            provider (reassigns in place). */}
        {isEdit && providers && providers.length > 1 ? (
          <FormItem>
            <FormLabel>Provider</FormLabel>
            <Select
              value={
                targetProviderId != null ? String(targetProviderId) : undefined
              }
              onValueChange={(v) => setTargetProviderId(Number(v))}
              disabled={isSubmitting}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targetProviderId !== currentProviderId ? (
              <FormDescription>
                Moving clears this number&apos;s account link and re-attributes
                its past sends to the new provider in number-level reports.
              </FormDescription>
            ) : null}
          </FormItem>
        ) : null}

        <FormField
          control={form.control}
          name="cost_per_sms"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Cost per SMS (USD)</FormLabel>
              <FormControl>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    type="number"
                    step="0.0001"
                    min="0"
                    className="pl-7"
                    placeholder="0.0000"
                    disabled={isSubmitting}
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      field.onChange(v === "" ? 0 : Number(v));
                    }}
                  />
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="max_sends_per_second"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max sends per second</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  placeholder="default 10"
                  disabled={isSubmitting}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    field.onChange(v === "" ? null : Number(v));
                  }}
                />
              </FormControl>
              <FormDescription>
                Carrier rate limit for this number — e.g. TextHub allows 60/s on a
                short code and 3/s on a toll-free number. The drain paces sends to
                never exceed it. Leave blank for the default (10/s).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Per-number provider settings, rendered from the connection type's
            descriptor. `name` matches the provider_phones column, so the field
            binds directly. Nothing renders when the type declares none. */}
        {settingFields.map((sf) => (
          <FormField
            key={sf.name}
            control={form.control}
            name={sf.name as "dashboard_id"}
            render={({ field }) => (
              <FormItem>
                <FormLabel required={sf.required === true}>{sf.label}</FormLabel>
                <FormControl>
                  <Input
                    placeholder={sf.placeholder ?? ""}
                    disabled={isSubmitting}
                    value={(field.value as string | null) ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      field.onChange(v === "" ? null : v);
                    }}
                  />
                </FormControl>
                {sf.help ? <FormDescription>{sf.help}</FormDescription> : null}
                <FormMessage />
              </FormItem>
            )}
          />
        ))}

        <FormField
          control={form.control}
          name="brand_id"
          render={({ field }) => {
            const value =
              field.value == null ? UNASSIGNED : String(field.value);
            return (
              <FormItem>
                <FormLabel>Brand</FormLabel>
                <Select
                  value={value}
                  onValueChange={(v) =>
                    field.onChange(v === UNASSIGNED ? null : Number(v))
                  }
                  disabled={isSubmitting || !brandsAvailable}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {brands.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="size-3 rounded-full"
                            style={{ backgroundColor: b.color ?? "#64748B" }}
                          />
                          {b.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Associate this number with a brand for reporting.
                </FormDescription>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        {/* Short-domain override (migration 0137). Sits after Brand because it
            is scoped to it: only the selected brand's domains are offered, and
            changing the brand clears a stale pick. Leaving it on the default
            reproduces today's behaviour exactly — the brand's own domain. */}
        <FormField
          control={form.control}
          name="short_domain_id"
          render={({ field }) => {
            const value = field.value == null ? UNASSIGNED : String(field.value);
            const active = domains.filter((d) => d.status === "active");
            const pending = domains.filter((d) => d.status !== "active");
            return (
              <FormItem>
                <FormLabel>Short domain</FormLabel>
                <Select
                  value={value}
                  onValueChange={(v) => field.onChange(v === UNASSIGNED ? null : Number(v))}
                  disabled={isSubmitting || watchedBrandId == null}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Brand default" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Brand default</SelectItem>
                    {active.map((d) => (
                      <SelectItem key={d.id} value={String(d.id)}>
                        {d.domain}
                      </SelectItem>
                    ))}
                    {/* Pending domains are shown but NOT selectable: hiding them
                        makes a just-added domain look like it failed to save. */}
                    {pending.map((d) => (
                      <SelectItem key={d.id} value={String(d.id)} disabled>
                        {d.domain} — not verified yet
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  {watchedBrandId == null
                    ? "Pick a brand first — short domains belong to a brand."
                    : active.length === 0
                      ? "This brand has no verified short domain yet. Tracked sends need one."
                      : "Leave on Brand default unless this number should mint links under a different host."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        {/* Per-number opt-out footer (migration 0141). Same shape as the
            short-domain override above it: leaving it empty INHERITS, and the
            inherited value is shown rather than implied. Edit mode only — the
            chain is a property of a number that already exists. */}
        {isEdit
          ? (() => {
              const inherited = (providerOptOutFooter ?? "").trim();
              const own = optOutFooter.trim();
              // What this number will actually send, by the same precedence the
              // send path uses. The stage level is not knowable here (a number
              // is not bound to one stage), so the honest statement stops at
              // "falls through to the stage's STOP text".
              const winner = providerAppendsOwnOptOut
                ? "provider_appends"
                : own
                  ? "number"
                  : inherited
                    ? "provider"
                    : "stage";
              return (
                <FormItem>
                  <FormLabel>Opt-out text</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={
                        providerAppendsOwnOptOut
                          ? "Not used — this provider appends its own"
                          : inherited
                            ? `${inherited}  (from ${providerName ?? "the account"})`
                            : "Falls through to the stage's STOP text"
                      }
                      disabled={isSubmitting || providerAppendsOwnOptOut}
                      value={optOutFooter}
                      onChange={(e) => setOptOutFooter(e.target.value)}
                    />
                  </FormControl>
                  <FormDescription>
                    {providerAppendsOwnOptOut ? (
                      <>
                        {providerName ?? "This provider"} appends its own opt-out
                        wording, so nothing set here is sent.
                      </>
                    ) : winner === "number" ? (
                      <>
                        This number&apos;s own opt-out text{" "}
                        <strong>replaces</strong> the account&apos;s and the
                        stage&apos;s on every message sent from it. It must
                        contain a STOP keyword, or those stages are refused.
                      </>
                    ) : winner === "provider" ? (
                      <>
                        Leave empty to use {providerName ?? "the account"}&apos;s
                        opt-out text (shown above). Set it only if this number
                        must say something different.
                      </>
                    ) : (
                      <>
                        Leave empty to fall through to each stage&apos;s own STOP
                        text. Set it only if this number must say something
                        different on every message.
                      </>
                    )}
                  </FormDescription>
                </FormItem>
              );
            })()
          : null}

        {/* ── Q4: per-number carrier policy ─────────────────────────────
            Edit mode only: the policy rows are keyed on the phone id, which
            does not exist until the number is created. A new number therefore
            starts fully permissive — which is the same state every existing
            number ships in. */}
        {isEdit ? (
          <>
            <Separator />
            <div className="grid gap-3">
              <div>
                <FormLabel>Carrier policy</FormLabel>
                <p className="mt-1 text-sm text-muted-foreground">
                  Turn a carrier off and this number stops texting contacts on
                  it. Contacts are dropped when the audience is built, so they
                  never enter the send at all.
                </p>
              </div>

              <div className="grid gap-2 rounded-md border p-3">
                {NAMED_CARRIERS.map((carrier) => {
                  const allowed = isCarrierAllowed(carrier);
                  return (
                    <div
                      key={carrier}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className={allowed ? "" : "text-muted-foreground line-through"}>
                        {carrier}
                      </span>
                      <div className="flex items-center gap-2">
                        {/* Daily cap (Q5). Hidden when the carrier is off —
                            capping a carrier this number may not text at all is
                            a contradiction, and offering the box invites it. */}
                        {allowed ? (
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="No cap"
                            aria-label={`${carrier} daily cap`}
                            className="h-8 w-28"
                            disabled={isSubmitting}
                            value={carrierDailyLimit(carrier) ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setCarrierDailyLimit(
                                carrier,
                                v === "" ? null : Number(v),
                              );
                            }}
                          />
                        ) : null}
                        <Switch
                          checked={allowed}
                          onCheckedChange={(v) => setCarrierAllowed(carrier, v)}
                          disabled={isSubmitting}
                          aria-label={`Allow ${carrier}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div>
                  <p className="text-sm">Unknown carriers</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Covers contacts we looked up but could not identify, ones
                    still awaiting a carrier mapping, and ones never looked up.
                    All three move together — the question is only whether this
                    number may text people whose carrier we do not know.
                  </p>
                </div>
                <Switch
                  checked={allowUnknownCarrier}
                  onCheckedChange={setAllowUnknownCarrier}
                  disabled={isSubmitting}
                  aria-label="Allow unknown carriers"
                />
              </div>

              {/* THE AND STATEMENT. Mirrored word-for-word on the campaign
                  audience screen, because an operator who sets a campaign
                  carrier filter and an operator who sets a number policy are
                  usually the same person on different days — and the failure
                  mode (an empty audience nobody can explain) is silent. */}
              <p className="text-xs text-muted-foreground">
                A campaign&apos;s own carrier filter and this list are combined
                with <strong>AND</strong>: a contact must be allowed by both.
                Neither one widens the other, so if a campaign targets a carrier
                this number has turned off, the audience for that stage is
                empty.
              </p>

              {blockedCarriers.length > 0 || !allowUnknownCarrier ? (
                <p className="text-xs text-muted-foreground">
                  This number will not text:{" "}
                  <strong>
                    {[
                      ...blockedCarriers,
                      ...(allowUnknownCarrier ? [] : ["unknown carriers"]),
                    ].join(", ")}
                  </strong>
                  .
                </p>
              ) : cappedCarriers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No carrier restrictions — this number texts every carrier.
                </p>
              ) : null}

              {cappedCarriers.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Daily cap:{" "}
                  <strong>
                    {cappedCarriers
                      .map((c) => `${c} ${carrierDailyLimit(c)}/day`)
                      .join(", ")}
                  </strong>
                  . Counted per{" "}
                  {CAMPAIGN_TIMEZONE_LABEL} calendar day and reset at midnight{" "}
                  {CAMPAIGN_TIMEZONE_LABEL} — not a rolling 24 hours. Sending
                  pauses for that carrier when the cap is reached and resumes on
                  its own; a batch already in flight can go slightly over.
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {isEdit ? "Save changes" : "Add phone"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
