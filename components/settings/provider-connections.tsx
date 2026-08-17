"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Info, Loader2, Save } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

type ProviderRow = {
  id: number;
  name: string;
  sms_provider_id: string;
  adapter_code: string | null;
  status: string;
  supports_api_send: boolean;
  sends_enabled: boolean;
  opt_out_footer: string | null;
  send_paused: boolean;
  send_paused_reason: string | null;
  send_paused_at: string | null;
  max_sends_per_run: number | null;
  max_sends_per_minute: number | null;
  max_sends_per_24h: number | null;
  accounts_count: number;
  numbers_count: number;
  connection_type: string | null;
  connection_type_name: string | null;
  connection_type_blurb: string | null;
  notes: string[];
  capabilities: {
    api_send: boolean;
    can_validate: boolean;
    test_send: boolean;
    opt_out_callback: boolean;
  };
};

// Per-provider connection settings. Sectioned over the PROVIDER ROW so
// per-provider limits and country restrictions can slot in later as additional
// sections without a redesign.
//
// Three separate send-posture facts are shown separately on purpose — collapsing
// them into one "is it sending?" badge is exactly the confusion this panel
// exists to remove:
//   • Connection    (supports_api_send) — CAPABILITY: can it API-send at all
//   • Sending       (sends_enabled)     — POSTURE:    should it, right now
//   • Circuit       (send_paused)       — LATCH:      a breaker tripped
export function ProviderConnections() {
  const { can } = useAuth();
  const listApi = useApiCall<{ data: ProviderRow[] }>();
  const { execute: listExec } = listApi;
  const toggleApi = useApiCall<{ ok: boolean }>();
  const footerApi = useApiCall<{ ok: boolean }>();

  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [tick, setTick] = useState(0);
  const [confirmOn, setConfirmOn] = useState<ProviderRow | null>(null);
  // Local edit buffer per provider id, so typing in one STOP-text field never
  // re-renders or clobbers another's.
  const [footerDraft, setFooterDraft] = useState<Record<number, string>>({});

  const canManage = can("providers.update");

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await listExec("/api/settings/providers");
      if (active && r.ok) {
        setRows(r.data.data);
        setFooterDraft(
          Object.fromEntries(r.data.data.map((p) => [p.id, p.opt_out_footer ?? ""])),
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [tick, listExec]);

  const applyToggle = useCallback(
    async (p: ProviderRow, enabled: boolean) => {
      const r = await toggleApi.execute(`/api/providers/${p.id}/sends-enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) {
        toastApiError(r, "Couldn't change this provider's sending switch");
        return;
      }
      toast.success(
        enabled ? `Sending is ON for ${p.name}` : `Sending is OFF for ${p.name}`,
      );
      setTick((n) => n + 1);
    },
    [toggleApi],
  );

  async function saveFooter(p: ProviderRow) {
    const value = (footerDraft[p.id] ?? "").trim();
    const r = await footerApi.execute(`/api/providers/${p.id}/opt-out-footer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opt_out_footer: value.length ? value : null }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't save the STOP text");
      return;
    }
    toast.success(value.length ? `STOP text saved for ${p.name}` : `STOP text cleared for ${p.name}`);
    setTick((n) => n + 1);
  }

  if (!rows) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading providers…
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No SMS providers yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {rows.map((p) => {
        const archived = p.status === "archived";
        const dirty = (footerDraft[p.id] ?? "") !== (p.opt_out_footer ?? "");
        return (
          <Card key={p.id} className={archived ? "opacity-60" : undefined}>
            <CardContent className="space-y-5 py-5">
              {/* ── Identity ───────────────────────────────────────────── */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{p.name}</h2>
                    {/* Identity and type are DIFFERENT facts and are labelled as
                        such: several rows can share a connection type (both
                        TextHub accounts are adapter_code 'txh'). */}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {p.sms_provider_id}
                    </code>
                    {archived ? <Badge variant="outline">Archived</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.connection_type_name
                      ? `Connection type: ${p.connection_type_name} (${p.connection_type})`
                      : "No API connection type — this provider is sent through manually."}
                  </p>
                </div>

                {/* ── Sending posture ─────────────────────────────────── */}
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-sm font-medium">
                      {p.sends_enabled ? "Sending on" : "Sending off"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Operator switch
                    </div>
                  </div>
                  <Switch
                    checked={p.sends_enabled}
                    disabled={!canManage || toggleApi.isLoading}
                    aria-label={`Sending for ${p.name}`}
                    onCheckedChange={(next) => {
                      if (!canManage) return;
                      // Turning ON permits real, money-spending sends — confirm.
                      // Turning OFF is the safe direction, so apply immediately.
                      if (next) setConfirmOn(p);
                      else void applyToggle(p, false);
                    }}
                  />
                </div>
              </div>

              {/* ── Capability badges ──────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={p.capabilities.api_send ? "default" : "outline"}>
                  {p.capabilities.api_send ? "API sending enabled" : "API sending off"}
                </Badge>
                {/* Absence of a check is stated, never implied by a missing
                    badge — a connection type with no non-sending way to prove a
                    key must SAY so rather than offer a test that cannot fail. */}
                <Badge variant={p.capabilities.can_validate ? "secondary" : "outline"}>
                  {p.capabilities.can_validate
                    ? "Key can be verified"
                    : "Key cannot be verified without sending"}
                </Badge>
                {p.capabilities.test_send ? <Badge variant="secondary">Test send</Badge> : null}
                {p.capabilities.opt_out_callback ? (
                  <Badge variant="secondary">STOP callback</Badge>
                ) : null}
                {p.send_paused ? (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Circuit paused
                  </Badge>
                ) : null}
              </div>

              {p.send_paused ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  A circuit breaker latched this provider
                  {p.send_paused_reason ? `: ${p.send_paused_reason}` : "."}
                  {p.send_paused_at
                    ? ` (${formatCampaignDateTime(p.send_paused_at)})`
                    : null}{" "}
                  Turning the sending switch on does <strong>not</strong> clear it — a
                  paused circuit needs a deliberate resume on the provider page.
                </p>
              ) : null}

              {/* ── Accounts + numbers ─────────────────────────────────── */}
              <div className="flex flex-wrap gap-6 text-sm">
                <div>
                  <div className="font-medium">{p.accounts_count}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.accounts_count === 1 ? "account" : "accounts"}
                  </div>
                </div>
                <div>
                  <div className="font-medium">{p.numbers_count}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.numbers_count === 1 ? "sending number" : "sending numbers"}
                  </div>
                </div>
                <div>
                  <div className="font-medium">
                    {p.max_sends_per_24h?.toLocaleString() ?? "default"}
                  </div>
                  <div className="text-xs text-muted-foreground">24-hour ceiling</div>
                </div>
              </div>

              {/* ── STOP text ──────────────────────────────────────────── */}
              <div className="space-y-2">
                <Label htmlFor={`footer-${p.id}`}>Provider STOP text</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={`footer-${p.id}`}
                    value={footerDraft[p.id] ?? ""}
                    disabled={!canManage}
                    placeholder="Empty — messages use the stage's STOP text"
                    maxLength={160}
                    className="max-w-md"
                    onChange={(e) =>
                      setFooterDraft((d) => ({ ...d, [p.id]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage || !dirty || footerApi.isLoading}
                    onClick={() => void saveFooter(p)}
                  >
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    Save
                  </Button>
                </div>
                {/* An editable field that silently does nothing is a trap. Say
                    exactly what it does today. */}
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Stored, but <strong>not yet applied to outgoing messages</strong>. Every
                    message still takes its opt-out wording from the stage&apos;s STOP text.
                    This value becomes active when the per-provider footer chain ships; until
                    then, leaving it empty and setting it here read the same on the wire.
                  </span>
                </p>
              </div>

              {/* ── About this provider ────────────────────────────────── */}
              {p.notes.length > 0 ? (
                <div className="space-y-1.5">
                  <h3 className="text-sm font-medium">About this provider</h3>
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {p.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      <AlertDialog open={confirmOn !== null} onOpenChange={(o) => !o && setConfirmOn(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Turn sending on for {confirmOn?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Stages on this provider become eligible to send real SMS again, subject to
              the org-wide sending switch, the send window, and any latched circuit
              breaker. This action is recorded against your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirmOn;
                setConfirmOn(null);
                if (target) void applyToggle(target, true);
              }}
            >
              Turn sending on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
