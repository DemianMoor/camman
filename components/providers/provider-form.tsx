"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { type Control, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApiCall } from "@/lib/hooks/use-api-call";
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
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/color-picker";
import {
  DEFAULT_SEND_WINDOW_END_MIN,
  DEFAULT_SEND_WINDOW_START_MIN,
  hhmmToMinutes,
  minutesToHhmm,
} from "@/lib/quiet-hours";
import {
  providerCreateSchema,
  type ProviderFormValues,
} from "@/lib/validators/providers";

export type { ProviderFormValues };

export interface ProviderFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<ProviderFormValues>;
  // Current server value of the go-live gate. DISPLAY ONLY — this form cannot
  // change it (see the note where the switch used to be); it only decides
  // whether the sending-hours block is shown.
  supportsApiSend?: boolean;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

// Sentinel for the escape hatch. Not a registry key — a provider row with no
// adapter at all (snx, smpl), sent through manually.
const CUSTOM_TYPE = "__custom__";

type ConnectionTypeOption = {
  key: string;
  display_name: string;
  blurb: string;
  can_validate: boolean;
  credential_fields: {
    name: string;
    label: string;
    placeholder: string | null;
    help: string | null;
    secret: boolean;
  }[];
  existing_providers: {
    id: number;
    name: string;
    sms_provider_id: string;
    status: string;
  }[];
};

export function ProviderForm({
  mode,
  initialValues,
  supportsApiSend = false,
  onSubmit,
  onCancel,
  isSubmitting,
}: ProviderFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(providerCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      sms_provider_id: initialValues?.sms_provider_id ?? "",
      short_link_supported: initialValues?.short_link_supported ?? false,
      short_link_example: initialValues?.short_link_example ?? "",
      send_window_weekday_start: initialValues?.send_window_weekday_start ?? null,
      send_window_weekday_end: initialValues?.send_window_weekday_end ?? null,
      send_window_weekend_start: initialValues?.send_window_weekend_start ?? null,
      send_window_weekend_end: initialValues?.send_window_weekend_end ?? null,
      max_sends_per_run: initialValues?.max_sends_per_run ?? null,
      max_sends_per_minute: initialValues?.max_sends_per_minute ?? null,
      max_sends_per_24h: initialValues?.max_sends_per_24h ?? null,
      avatar_url: initialValues?.avatar_url ?? "",
      color: initialValues?.color ?? "",
    },
  });

  const shortLinkSupported = form.watch("short_link_supported");
  // Read-only: the form can no longer WRITE supports_api_send, but the sending-
  // hours block is only meaningful for an API-sending provider, so it still
  // needs to know. Comes in as a prop from the current server value, never from
  // form state — that's the whole point of the carve-out.
  const apiSendEnabled = supportsApiSend;

  // ── Connection type (create only, 869egmakh P3) ────────────────────────────
  const typesApi = useApiCall<{ data: ConnectionTypeOption[] }>();
  const { execute: typesExec } = typesApi;
  const [types, setTypes] = useState<ConnectionTypeOption[]>([]);
  const [typesLoading, setTypesLoading] = useState(!isEdit);
  const [connectionType, setConnectionType] = useState<string>("");
  const [separateRow, setSeparateRow] = useState(false);

  useEffect(() => {
    if (isEdit) return;
    let active = true;
    void (async () => {
      const r = await typesExec("/api/provider-types");
      if (!active) return;
      if (r.ok) setTypes(r.data.data);
      setTypesLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [isEdit, typesExec]);

  const isKnownType = connectionType !== "" && connectionType !== CUSTOM_TYPE;
  const selectedType = types.find((t) => t.key === connectionType) ?? null;
  const collidingProviders = isKnownType ? (selectedType?.existing_providers ?? []) : [];

  function handleTypeChange(next: string) {
    setConnectionType(next);
    setSeparateRow(false);
    // Clear any typed code when moving to a derived type, so a leftover value
    // can't be submitted for a type that derives its own.
    if (next !== CUSTOM_TYPE) form.setValue("sms_provider_id", "");
  }

  // Submit through a wrapper so the connection-type decision travels with the
  // payload. The SERVER derives the final code and re-enforces the collision
  // rule — this only tells it which path the operator chose.
  async function handleSubmit(values: ProviderFormValues) {
    if (isEdit) return onSubmit(values);
    await onSubmit({
      ...values,
      connection_type: isKnownType ? connectionType : undefined,
      create_separate_row: isKnownType && separateRow ? true : undefined,
      // Derived server-side; don't send a stale typed value.
      sms_provider_id:
        isKnownType && !separateRow ? undefined : values.sms_provider_id,
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="grid gap-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. SendNexus"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* ── Connection type (create only) ────────────────────────────────
            Replaces the free-text provider ID. Typing `texthub` instead of
            `txh` used to produce a provider row that passed every check and
            then threw UnknownProviderError at drain time, after the campaign
            was activated and scheduled. Picking a type removes the guess. */}
        {!isEdit ? (
          <FormItem>
            <FormLabel required>Connection type</FormLabel>
            <Select
              value={connectionType}
              onValueChange={handleTypeChange}
              disabled={isSubmitting || typesLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={typesLoading ? "Loading…" : "Pick a connection type"} />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.display_name}
                    {t.existing_providers.length > 0 ? " — already added" : ""}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_TYPE}>Custom / no API</SelectItem>
              </SelectContent>
            </Select>
            <FormDescription>
              {selectedType?.blurb ??
                "Choose “Custom / no API” for a provider you send through manually."}
            </FormDescription>
          </FormItem>
        ) : null}

        {/* Collision steer. Picking a type that already has a provider row is
            refused by default and points at the right action: a second ACCOUNT
            on the existing provider, not a second provider row. A second row
            fragments that provider's circuit breakers, send windows and
            reporting — the cost txh2 already imposes. */}
        {!isEdit && collidingProviders.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              {selectedType?.display_name} is already set up
            </p>
            <p className="mt-1 text-muted-foreground">
              It exists as{" "}
              {collidingProviders.map((p, i) => (
                <span key={p.id}>
                  {i > 0 ? ", " : ""}
                  <Link
                    href={`/providers/${p.id}`}
                    className="font-mono underline underline-offset-2"
                  >
                    {p.sms_provider_id}
                  </Link>
                </span>
              ))}
              . To use another {selectedType?.display_name} account, add an{" "}
              <strong>account</strong> to that provider — its key and sending
              numbers travel together — rather than creating a second provider.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" asChild>
                <Link href={`/providers/${collidingProviders[0].id}`}>
                  Go to {collidingProviders[0].sms_provider_id} accounts
                </Link>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSeparateRow((v) => !v)}
                disabled={isSubmitting}
              >
                {separateRow ? "Cancel separate provider" : "Create separate provider row anyway"}
              </Button>
            </div>
            {separateRow ? (
              <p className="mt-2 text-xs text-muted-foreground">
                A separate row is occasionally right, but it splits this
                provider&apos;s pacing caps and reporting in two. It needs its own
                distinct provider ID below — nothing is auto-generated.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Provider ID. Derived and READ-ONLY when a type is picked (the code is
            load-bearing in drain errors and reports, so it stays visible);
            editable only for a custom provider or a deliberate separate row. */}
        <FormField
          control={form.control}
          name="sms_provider_id"
          render={({ field }) => {
            const derived = !isEdit && isKnownType && !separateRow;
            return (
              <FormItem>
                <FormLabel required={!derived}>Provider ID</FormLabel>
                <FormControl>
                  <Input
                    placeholder={isKnownType ? "" : "sendnexus"}
                    disabled={isEdit || derived || isSubmitting}
                    readOnly={isEdit || derived}
                    {...field}
                    value={derived ? connectionType : (field.value ?? "")}
                  />
                </FormControl>
                <FormDescription>
                  {isEdit
                    ? "Provider ID can't be changed after creation."
                    : derived
                      ? "Set by the connection type. Shown because this code appears in send errors and reports."
                      : "Letters, digits, hyphens, and underscores only."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        <FormField
          control={form.control}
          name="short_link_supported"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-3 rounded-md border p-3">
              <FormControl>
                <Switch
                  checked={!!field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              </FormControl>
              <div className="grid gap-1">
                <FormLabel>Short links supported</FormLabel>
                <FormDescription>
                  This provider can shorten links automatically.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

        {shortLinkSupported ? (
          <FormField
            control={form.control}
            name="short_link_example"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Short link example</FormLabel>
                <FormControl>
                  <Input
                    placeholder="lnk.example.com/abc123"
                    disabled={isSubmitting}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        {/*
          The "API sending enabled" switch used to live here. It was REMOVED
          (ClickUp 869ehjwtf): this form submits every field on every save with
          no concurrency check, so a stale page wrote back a `true` that a
          deliberate act had already cleared. The go-live gate now has its own
          audited control on the provider detail page. Same carve-out as
          `send_paused`. Do not re-add it here.
        */}

        {apiSendEnabled ? (
          <div className="grid gap-3 rounded-md border p-3">
            <div className="grid gap-1">
              <FormLabel>Sending hours (ET)</FormLabel>
              <FormDescription>
                Scheduled sends only auto-fire within these hours
                (America/New_York). Leave blank to use the default{" "}
                {minutesToHhmm(DEFAULT_SEND_WINDOW_START_MIN)}–
                {minutesToHhmm(DEFAULT_SEND_WINDOW_END_MIN)}. Evaluated in ET,
                not each recipient&apos;s local zone.
              </FormDescription>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TimeField
                control={form.control}
                name="send_window_weekday_start"
                label="Weekday start"
                disabled={isSubmitting}
              />
              <TimeField
                control={form.control}
                name="send_window_weekday_end"
                label="Weekday end"
                disabled={isSubmitting}
              />
              <TimeField
                control={form.control}
                name="send_window_weekend_start"
                label="Weekend start"
                disabled={isSubmitting}
              />
              <TimeField
                control={form.control}
                name="send_window_weekend_end"
                label="Weekend end"
                disabled={isSubmitting}
              />
            </div>
          </div>
        ) : null}

        {apiSendEnabled ? (
          <div className="grid gap-3 rounded-md border p-3">
            <div className="grid gap-1">
              <FormLabel>Circuit-breaker caps</FormLabel>
              <FormDescription>
                Volume limits for automated sending. Leave blank for the defaults
                (1000 per run, 100 per minute, 10,000 per 24h). The per-run cap
                only paces a single drain — large audiences still complete across
                ticks without tripping. (The per-second rate limit is set per
                phone number, not here — it&apos;s a carrier limit that differs by
                number type.)
              </FormDescription>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField
                control={form.control}
                name="max_sends_per_run"
                label="Max per run"
                placeholder="1000"
                disabled={isSubmitting}
              />
              <NumberField
                control={form.control}
                name="max_sends_per_minute"
                label="Max per minute"
                placeholder="100"
                disabled={isSubmitting}
              />
              <NumberField
                control={form.control}
                name="max_sends_per_24h"
                label="Max per 24h"
                placeholder="10000"
                disabled={isSubmitting}
              />
            </div>
          </div>
        ) : null}

        <FormField
          control={form.control}
          name="avatar_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Avatar URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://…"
                  disabled={isSubmitting}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Color</FormLabel>
              <FormControl>
                <ColorPicker
                  value={field.value || null}
                  onChange={(c) => field.onChange(c ?? "")}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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
            {isEdit ? "Save changes" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// A nullable integer cap field. Empty input → null (use the built-in default);
// the wire/DB carry a plain integer.
function NumberField({
  control,
  name,
  label,
  placeholder,
  disabled,
}: {
  control: Control<ProviderFormValues>;
  name: "max_sends_per_run" | "max_sends_per_minute" | "max_sends_per_24h";
  label: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={1}
              placeholder={placeholder}
              disabled={disabled}
              value={field.value == null ? "" : String(field.value)}
              onChange={(e) =>
                field.onChange(e.target.value === "" ? null : Number(e.target.value))
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// A single send-window bound. The form value is minute-of-day (number | null);
// HH:mm is only the rendered input value, so the wire/DB stay in minutes.
function TimeField({
  control,
  name,
  label,
  disabled,
}: {
  control: Control<ProviderFormValues>;
  name:
    | "send_window_weekday_start"
    | "send_window_weekday_end"
    | "send_window_weekend_start"
    | "send_window_weekend_end";
  label: string;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="time"
              disabled={disabled}
              value={field.value == null ? "" : minutesToHhmm(field.value)}
              onChange={(e) =>
                field.onChange(
                  e.target.value === "" ? null : hhmmToMinutes(e.target.value),
                )
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
