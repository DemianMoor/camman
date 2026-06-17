"use client";

import { Loader2 } from "lucide-react";
import { type Control, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function ProviderForm({
  mode,
  initialValues,
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
      supports_api_send: initialValues?.supports_api_send ?? false,
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
  const apiSendEnabled = form.watch("supports_api_send");

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
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

        <FormField
          control={form.control}
          name="sms_provider_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Provider ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="sendnexus"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Provider ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
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

        <FormField
          control={form.control}
          name="supports_api_send"
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
                <FormLabel>API sending enabled</FormLabel>
                <FormDescription>
                  This provider can be sent through via API (TextHub). Tracked
                  campaigns also need an API key set below.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

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
