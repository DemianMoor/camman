"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { ENGAGEMENT_STATUSES, type LifecycleThresholds } from "@/lib/engagement/constants";
import { ENGAGEMENT_STATUS_LABELS } from "@/lib/engagement/labels";
import { useApiCall } from "@/lib/hooks/use-api-call";

type Settings = LifecycleThresholds & {
  engine_mode: "off" | "write";
  updated_at: string | null;
  has_row: boolean;
  defaults: LifecycleThresholds;
};

type Preview = {
  evaluated: number;
  currentCounts: Record<string, number>;
  projectedCounts: Record<string, number>;
  transitions: Record<string, number>;
  durationMs: number;
};

const FIELDS: {
  key: keyof LifecycleThresholds;
  label: string;
  help: string;
  min: number;
  max: number;
}[] = [
  {
    key: "hot_days",
    label: "Hot window (days)",
    min: 1,
    max: 365,
    help: "A human click this recent makes a contact hot. Applies to every group.",
  },
  {
    key: "warm_days",
    label: "Warm window (days)",
    min: 2,
    max: 730,
    help: "Past the hot window but within this one, a contact is warm. Applies to every group.",
  },
  {
    key: "freeze_after_messages",
    label: "Freeze after messages",
    min: 1,
    max: 1000,
    help: "Messages since the last click before a contact freezes. A contact group can override this.",
  },
  {
    key: "freeze_cadence_days",
    label: "Freeze cadence (days)",
    min: 1,
    max: 365,
    help: "A frozen contact becomes eligible again only this long after its last message.",
  },
  {
    key: "suppress_after_days",
    label: "Suppress after (days in freeze)",
    min: 1,
    max: 730,
    help: "Days since the first message sent while frozen before a contact is suppressed.",
  },
  {
    key: "suppress_min_freeze_messages",
    label: "Suppress after (messages in freeze)",
    min: 1,
    max: 100,
    help: "Messages that must have been sent while frozen before suppression can happen.",
  },
];

export function LifecycleSettings() {
  const { can } = useAuth();
  const canEdit = can("lifecycle.configure");
  const getApi = useApiCall<Settings>();
  const putApi = useApiCall<Settings>();
  const previewApi = useApiCall<Preview>();

  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<LifecycleThresholds | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmEngine, setConfirmEngine] = useState<"off" | "write" | null>(null);
  // Bumped after a save so the effect re-reads what the server actually stored,
  // rather than trusting the optimistic local copy.
  const [tick, setTick] = useState(0);

  const fetchSettings = getApi.execute;
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await fetchSettings("/api/settings/lifecycle");
      if (!active) return;
      if (r.ok) {
        setSaved(r.data);
        setDraft({
          hot_days: r.data.hot_days,
          warm_days: r.data.warm_days,
          freeze_after_messages: r.data.freeze_after_messages,
          freeze_cadence_days: r.data.freeze_cadence_days,
          suppress_after_days: r.data.suppress_after_days,
          suppress_min_freeze_messages: r.data.suppress_min_freeze_messages,
        });
      } else {
        toastApiError(r, "Could not load lifecycle settings");
      }
    })();
    return () => {
      active = false;
    };
  }, [tick, fetchSettings]);

  const dirty =
    saved != null && draft != null && FIELDS.some((f) => saved[f.key] !== draft[f.key]);
  // An emptied number input reads as 0 (NaN mid-edit), which the server would
  // reject after a round trip. Catch it here, including the cross-field rule the
  // database CHECK enforces.
  const invalid =
    draft == null ||
    FIELDS.some(
      (f) => !Number.isInteger(draft[f.key]) || draft[f.key] < f.min || draft[f.key] > f.max,
    ) ||
    draft.warm_days <= draft.hot_days;

  async function runPreview() {
    if (!draft) return;
    setPreview(null);
    const r = await previewApi.execute("/api/settings/lifecycle/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholds: draft }),
    });
    if (r.ok) setPreview(r.data);
    else toastApiError(r, "Could not preview the change");
  }

  async function save(patch: Partial<LifecycleThresholds & { engine_mode: "off" | "write" }>) {
    const r = await putApi.execute("/api/settings/lifecycle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      toast.success("Saved. The next status run applies it.");
      setPreview(null);
      setTick((t) => t + 1);
    } else {
      toastApiError(r, "Could not save");
    }
  }

  if (!saved || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const busy = putApi.isLoading || previewApi.isLoading;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Thresholds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!saved.has_row ? (
            <p className="text-sm text-muted-foreground">
              This organization has no saved row yet, so the values below are the defaults
              currently in force.
            </p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input
                  id={f.key}
                  type="number"
                  min={f.min}
                  max={f.max}
                  disabled={!canEdit || busy}
                  value={draft[f.key]}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">
                  {f.help} Default {saved.defaults[f.key]}.
                </p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => void runPreview()}
              disabled={!canEdit || busy || !dirty || invalid}
            >
              {previewApi.isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Preview changes
            </Button>
            <Button
              onClick={() => void save(draft)}
              disabled={!canEdit || busy || !dirty || invalid}
            >
              Save
            </Button>
            {invalid ? (
              <span className="text-xs text-destructive">
                Every value must be a whole number inside its range, and the warm window must be
                longer than the hot one.
              </span>
            ) : dirty ? (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            ) : null}
          </div>
          {preview ? (
            <div className="rounded-md border p-3 text-sm">
              {Object.keys(preview.transitions).length === 0 ? (
                <p>No contact changes status under these values.</p>
              ) : (
                <ul className="space-y-1">
                  {Object.entries(preview.transitions)
                    .sort((a, b) => b[1] - a[1])
                    .map(([move, n]) => (
                      <li key={move}>
                        <span className="font-medium">{move.replace("→", " → ")}</span>{" "}
                        {n.toLocaleString()}
                      </li>
                    ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {preview.evaluated.toLocaleString()} contacts evaluated ·{" "}
                {ENGAGEMENT_STATUSES.map(
                  (s) =>
                    `${ENGAGEMENT_STATUS_LABELS[s]} ${(preview.projectedCounts[s] ?? 0).toLocaleString()}`,
                ).join(" · ")}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status engine</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id="engine"
              checked={saved.engine_mode === "write"}
              disabled={!canEdit || busy}
              onCheckedChange={(on) => setConfirmEngine(on ? "write" : "off")}
            />
            <Label htmlFor="engine">
              {saved.engine_mode === "write"
                ? "Running — statuses update every 15 minutes"
                : "Off — statuses are frozen where they stand"}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Turning this off stops the job. Existing statuses are kept and go stale; nothing
            recomputes until it is switched back on.
          </p>
        </CardContent>
      </Card>

      {!canEdit ? (
        <p className="text-sm text-muted-foreground">
          You can view these settings but only a manager or owner can change them.
        </p>
      ) : null}

      {/* Both directions confirm: starting the engine rewrites statuses org-wide on
          the next run, which is as consequential as stopping it. */}
      <AlertDialog open={confirmEngine !== null} onOpenChange={(o) => !o && setConfirmEngine(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmEngine === "off"
                ? "Turn the status engine off?"
                : "Turn the status engine on?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEngine === "off" ? (
                <>
                  Statuses stop updating: no contact moves to hot on a click, none freezes on its
                  tenth message, and none is ever suppressed while this is off. Existing statuses
                  are kept and go stale, and the campaign rules that read them will treat a stale
                  status as if it were current. The change is audited.
                </>
              ) : (
                <>
                  The job starts maintaining statuses again, every 15 minutes, for every contact
                  in this organization. The first run applies everything that changed while it was
                  off — clicks, messages, and the thresholds as they stand now — so a large number
                  of contacts can move at once, and the campaign rules that read statuses will act
                  on the new values. Preview any pending threshold change before this. The change
                  is audited.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const mode = confirmEngine;
                setConfirmEngine(null);
                if (mode) void save({ engine_mode: mode });
              }}
            >
              {confirmEngine === "off" ? "Turn it off" : "Turn it on"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
