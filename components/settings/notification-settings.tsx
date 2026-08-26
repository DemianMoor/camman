"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

type NotifSettings = {
  daily_report_enabled: boolean;
  hourly_report_enabled: boolean;
  stall_alert_enabled: boolean;
  unjoinable_alert_enabled: boolean;
  daily_report_hour: number;
  hourly_window_from: number;
  hourly_window_to: number;
  hourly_interval_hours: 1 | 2 | 3;
  active_weekdays: number[];
  updated_at: string | null;
};

const WEEKDAYS = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
] as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function hourLabel(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display}:00 ${ampm}`;
}

// A window whose end hour is before its start hour runs past midnight, and the
// hours after midnight belong to the day the window STARTED on — Sat 16:00–01:00
// covers Sunday 00:00 and 01:00. That is not guessable from two dropdowns
// reading "4:00 PM" and "1:00 AM", so the page says it outright.
function windowSummary(from: number, to: number, intervalHours: number): string {
  const every =
    intervalHours === 1 ? "every hour" : `every ${intervalHours} hours`;
  if (from === to) return `Once a day at ${hourLabel(from)}.`;
  if (from > to) {
    return `${hourLabel(from)} until ${hourLabel(to)} the next morning, ${every} — the hours after midnight count towards the previous day.`;
  }
  return `${hourLabel(from)} until ${hourLabel(to)} the same day, ${every}.`;
}

export function NotificationSettings() {
  const { can } = useAuth();
  const getApi = useApiCall<NotifSettings>();
  const putApi = useApiCall<{ ok: boolean }>();
  const { execute: fetchSettings } = getApi;

  const [settings, setSettings] = useState<NotifSettings | null>(null);
  const [tick, setTick] = useState(0);

  const canEdit = can("campaigns.drain");

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await fetchSettings("/api/settings/notifications");
      if (active && r.ok) setSettings(r.data);
    })();
    return () => {
      active = false;
    };
  }, [tick, fetchSettings]);

  async function patch(update: Partial<NotifSettings>) {
    if (!settings) return;
    const next = { ...settings, ...update };
    setSettings(next); // optimistic
    const r = await putApi.execute("/api/settings/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!r.ok) {
      setSettings(settings); // rollback
      toastApiError(r, "Couldn't save notification settings");
      return;
    }
    toast.success("Notification settings saved");
    setTick((n) => n + 1);
  }

  function toggleWeekday(iso: number) {
    if (!settings) return;
    const current = settings.active_weekdays;
    const next = current.includes(iso)
      ? current.filter((d) => d !== iso)
      : [...current, iso].sort((a, b) => a - b);
    if (next.length === 0) {
      toast.error("At least one day must be active");
      return;
    }
    void patch({ active_weekdays: next });
  }

  if (!settings) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  }

  const saving = putApi.isLoading;

  return (
    <div className="space-y-6">
      {/* Notification Types */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Notification types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <NotifRow
            label="Daily summary"
            description="End-of-day performance recap (sales, revenue, ROI, opt-outs)."
            checked={settings.daily_report_enabled}
            disabled={!canEdit || saving}
            onChange={(v) => void patch({ daily_report_enabled: v })}
          />
          <NotifRow
            label="Hourly updates"
            description="Intra-day performance snapshots during the active window."
            checked={settings.hourly_report_enabled}
            disabled={!canEdit || saving}
            onChange={(v) => void patch({ hourly_report_enabled: v })}
          />
          <NotifRow
            label="Queue stall alerts"
            description="Fires when an approved stage stops draining for too long."
            checked={settings.stall_alert_enabled}
            disabled={!canEdit || saving}
            onChange={(v) => void patch({ stall_alert_enabled: v })}
          />
          <NotifRow
            label="Unjoinable attribution watch"
            description="Warns when rising share of opt-outs can't be linked to a send."
            checked={settings.unjoinable_alert_enabled}
            disabled={!canEdit || saving}
            onChange={(v) => void patch({ unjoinable_alert_enabled: v })}
          />
        </CardContent>
      </Card>

      {/* Schedule */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Schedule</CardTitle>
          <p className="text-xs text-muted-foreground">All times are Warsaw (Europe/Warsaw).</p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Daily report hour */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Daily summary time</Label>
            <p className="text-xs text-muted-foreground">
              Warsaw hour at which the previous ET day&apos;s final summary is sent.
            </p>
            <Select
              disabled={!canEdit || saving || !settings.daily_report_enabled}
              value={String(settings.daily_report_hour)}
              onValueChange={(v) => void patch({ daily_report_hour: Number(v) })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {hourLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Hourly window */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hourly updates window</Label>
            <p className="text-xs text-muted-foreground">
              Warsaw hours during which intra-day snapshots are sent. Setting the
              end hour earlier than the start hour runs the window past midnight.
            </p>
            <div className="flex items-center gap-3">
              <Select
                disabled={!canEdit || saving || !settings.hourly_report_enabled}
                value={String(settings.hourly_window_from)}
                onValueChange={(v) => void patch({ hourly_window_from: Number(v) })}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">to</span>
              <Select
                disabled={!canEdit || saving || !settings.hourly_report_enabled}
                value={String(settings.hourly_window_to)}
                onValueChange={(v) => void patch({ hourly_window_to: Number(v) })}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {windowSummary(
                settings.hourly_window_from,
                settings.hourly_window_to,
                settings.hourly_interval_hours,
              )}
            </p>
          </div>

          {/* Hourly interval */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hourly update frequency</Label>
            <p className="text-xs text-muted-foreground">
              How often to send an update within the active window.
            </p>
            <Select
              disabled={!canEdit || saving || !settings.hourly_report_enabled}
              value={String(settings.hourly_interval_hours)}
              onValueChange={(v) =>
                void patch({ hourly_interval_hours: Number(v) as 1 | 2 | 3 })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Every hour</SelectItem>
                <SelectItem value="2">Every 2 hours</SelectItem>
                <SelectItem value="3">Every 3 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Active weekdays */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Active days for hourly updates</Label>
            <p className="text-xs text-muted-foreground">
              Which days run the hourly window above. A window that crosses
              midnight counts as the day it started on, so unticking Sun also
              stops Monday&rsquo;s small hours. The daily summary is not affected
              by this — turn it off with its own switch.
            </p>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map(({ iso, label }) => {
                const active = settings.active_weekdays.includes(iso);
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={!canEdit || saving}
                    onClick={() => toggleWeekday(iso)}
                    className={
                      "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors " +
                      (active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-accent/60") +
                      (!canEdit || saving ? " cursor-not-allowed opacity-50" : "")
                    }
                    aria-pressed={active}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {!canEdit ? (
        <p className="text-xs text-muted-foreground">
          You can view these settings but only a manager or owner can change them.
        </p>
      ) : null}
    </div>
  );
}

function NotifRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const icon = checked ? (
    <Bell className="size-4 text-primary" aria-hidden />
  ) : (
    <BellOff className="size-4 text-muted-foreground" aria-hidden />
  );

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">{icon}</span>
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={`Toggle ${label}`}
      />
    </div>
  );
}
