"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

type CodeMap = Record<
  string,
  { label: string; hard: string[]; soft: string[]; ignore: string[]; aliases?: Record<string, string> }
>;

type Thresholds = { hard_threshold: number; soft_threshold: number; soft_window_days: number };

type Settings = Thresholds & {
  enabled: boolean;
  flagged_count: number;
  evaluated_at: string | null;
  codes: CodeMap;
};

// Bounds mirror CHECK org_settings_carrier_rejection_thresholds_check.
const FIELDS: { key: keyof Thresholds; label: string; min: number; max: number; help: string }[] = [
  { key: "hard_threshold", label: "Hard rejections", min: 1, max: 100, help: "All time. Default 2." },
  { key: "soft_threshold", label: "Soft rejections", min: 1, max: 100, help: "Inside the soft window. Default 3." },
  { key: "soft_window_days", label: "Soft window (days)", min: 1, max: 365, help: "Default 30." },
];

// Code with its webhook alias, e.g. "30005 / 2001" (Text Request reports one
// failure under both).
function withAliases(code: string, aliases?: Record<string, string>): string {
  const alts = Object.entries(aliases ?? {})
    .filter(([, canonical]) => canonical === code)
    .map(([alt]) => alt);
  return [code, ...alts].join(" / ");
}

// Settings > Sending: carrier-rejected numbers (ClickUp 1amdve2850v). The live
// count shows whether or not the toggle is on, so the effect can be checked
// before enabling it. Changing anything is manager+ (campaigns.drain); a
// threshold save recomputes the flagged set before it returns.
export function CarrierRejectionSettings() {
  const { can } = useAuth();
  const canEdit = can("campaigns.drain");
  const canExport = can("contacts.export");
  const getApi = useApiCall<Settings>();
  const putApi = useApiCall<{ ok: boolean; refresh: { flagged: number } | null }>();
  const fetchSettings = getApi.execute;

  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Thresholds | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await fetchSettings("/api/settings/carrier-rejection");
      if (!active) return;
      if (r.ok) {
        setSaved(r.data);
        setDraft({
          hard_threshold: r.data.hard_threshold,
          soft_threshold: r.data.soft_threshold,
          soft_window_days: r.data.soft_window_days,
        });
      } else {
        toastApiError(r, "Could not load carrier-rejection settings");
      }
    })();
    return () => {
      active = false;
    };
  }, [tick, fetchSettings]);

  async function put(body: Partial<Thresholds & { enabled: boolean }>, done: string) {
    const r = await putApi.execute("/api/settings/carrier-rejection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      toastApiError(r, "Could not save");
      return;
    }
    toast.success(
      r.data.refresh ? `${done} ${r.data.refresh.flagged.toLocaleString()} numbers now meet the rule.` : done,
    );
    setTick((t) => t + 1);
  }

  if (!saved || !draft) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  }

  const dirty = FIELDS.some((f) => saved[f.key] !== draft[f.key]);
  // An emptied number input reads as 0; catch it before the server does.
  const invalid = FIELDS.some(
    (f) => !Number.isInteger(draft[f.key]) || draft[f.key] < f.min || draft[f.key] > f.max,
  );
  const busy = putApi.isLoading;
  const on = saved.enabled;

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium">Suppress carrier-rejected numbers</span>
              <span
                className={
                  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium " +
                  (on
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                    : "bg-muted text-muted-foreground")
                }
              >
                {on ? "ON" : "OFF"}
              </span>
            </div>
            <p className="max-w-prose text-sm text-muted-foreground">
              While on, numbers that carriers keep rejecting as dead or landline are left out of
              new campaign audiences, stage sends and drip routing (reason &ldquo;Rejected by
              carriers&rdquo;). This is not an opt-out: turning it off makes them eligible again,
              and messages already queued are not touched.
            </p>
          </div>
          <Switch
            checked={on}
            disabled={!canEdit || busy}
            onCheckedChange={(next) => (next ? setConfirmOn(true) : void put({ enabled: false }, "Suppression is OFF."))}
            aria-label="Toggle carrier-rejected number suppression"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <p className="text-sm">
            <span className="text-lg font-semibold">{saved.flagged_count.toLocaleString()}</span>{" "}
            {saved.flagged_count === 1 ? "number currently meets" : "numbers currently meet"} the rule
            {saved.evaluated_at ? (
              <span className="text-muted-foreground">
                {" "}
                · checked {formatCampaignDateTime(saved.evaluated_at)}
              </span>
            ) : null}
          </p>
          {canExport ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open("/api/settings/carrier-rejection/export", "_blank", "noopener")}
            >
              <Download className="size-4" aria-hidden /> Export CSV
            </Button>
          ) : null}
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Rule</p>
          <p className="max-w-prose text-xs text-muted-foreground">
            A number meets the rule when its hard rejections reach the hard threshold, or its soft
            rejections inside the window reach the soft threshold. One outcome per message; a
            delivered message resets the count.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={`cr-${f.key}`}>{f.label}</Label>
                <Input
                  id={`cr-${f.key}`}
                  type="number"
                  min={f.min}
                  max={f.max}
                  disabled={!canEdit || busy}
                  value={draft[f.key]}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">{f.help}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void put(draft, "Saved.")} disabled={!canEdit || busy || !dirty || invalid}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
            {invalid ? (
              <span className="text-xs text-destructive">
                Thresholds must be whole numbers from 1 to 100, the window 1 to 365 days.
              </span>
            ) : dirty ? (
              <span className="text-xs text-muted-foreground">
                Unsaved changes — saving recomputes the count.
              </span>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Provider codes</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Hard</TableHead>
                <TableHead>Soft</TableHead>
                <TableHead>Ignored</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(saved.codes).map(([key, m]) => (
                <TableRow key={key} className="align-top">
                  <TableCell className="font-medium">{m.label}</TableCell>
                  {(["hard", "soft", "ignore"] as const).map((cls) => (
                    <TableCell key={cls} className="whitespace-normal text-xs">
                      {m[cls].map((c) => (
                        <div key={c}>{withAliases(c, m.aliases)}</div>
                      ))}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">TextHub</TableCell>
                <TableCell colSpan={3} className="text-xs text-muted-foreground">
                  Not counted — its delivery receipts are not reliable.
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Any code not listed is ignored. Reasons are matched ignoring case and surrounding spaces.
          </p>
        </div>

        {!canEdit ? (
          <p className="text-xs text-muted-foreground">
            You can view this setting but only a manager or owner can change it.
          </p>
        ) : null}
      </CardContent>

      <AlertDialog open={confirmOn} onOpenChange={setConfirmOn}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suppress carrier-rejected numbers?</AlertDialogTitle>
            <AlertDialogDescription>
              {saved.flagged_count.toLocaleString()} numbers will be left out of new campaign
              audiences, the next stage sends of running campaigns, and drip routing. Messages
              already queued still go out. You can switch it back off at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmOn(false);
                void put({ enabled: true }, "Suppression is ON.");
              }}
              disabled={busy}
            >
              Turn ON
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
