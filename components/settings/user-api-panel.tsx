"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { CopyableId } from "@/components/ui/copyable-id";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

// API access for ONE member (ClickUp 869evpmbz): the on/off switch, their
// tokens, and what those tokens have been doing.
//
// A sheet rather than a row expansion because there are three unrelated things
// here (a switch, a credential list, a usage log) and the roster table is
// already six columns wide.

export type ApiTokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  read_only: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  expired: boolean;
};

type UsageResponse = {
  days: number;
  api_enabled: boolean;
  hourly_limit: number;
  totals: { requests: number; denied: number; rate_limited: number };
  last_ip: string | null;
  last_seen_at: string | null;
  series: { hour: string; requests: number; denied: number }[];
  top_endpoints: { endpoint: string | null; method: string | null; n: number }[];
  denials: {
    action: string;
    endpoint: string | null;
    method: string | null;
    reason: string | null;
    n: number;
    last_at: string;
  }[];
};

export interface UserApiPanelProps {
  memberId: string;
  memberLabel: string;
  apiEnabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after any change that the roster's own row should reflect. */
  onChanged: () => void;
}

export function UserApiPanel({
  memberId,
  memberLabel,
  apiEnabled,
  open,
  onOpenChange,
  onChanged,
}: UserApiPanelProps) {
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  // The plaintext, held in component state for exactly as long as the dialog is
  // open. It is never persisted, never re-fetchable, and cleared on close.
  const [issued, setIssued] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenRow | null>(null);

  // Destructured to `execute` — the hook's own docblock warns that including
  // the whole return object in a dep array re-creates it every render and
  // loops forever. Only `.execute` has a stable identity.
  const { execute: fetchTokens } = useApiCall<{ tokens: ApiTokenRow[] }>();
  const { execute: fetchUsage } = useApiCall<UsageResponse>();
  const createApi = useApiCall<{ plaintext: string; api_enabled: boolean }>();
  const revokeApi = useApiCall<unknown>();
  const toggleApi = useApiCall<{ api_enabled: boolean }>();

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      const [t, u] = await Promise.all([
        fetchTokens(`/api/users/${memberId}/tokens`),
        fetchUsage(`/api/users/${memberId}/api-usage?days=7`),
      ]);
      if (!active) return;
      if (t.ok) setTokens(t.data.tokens);
      if (u.ok) setUsage(u.data);
    })();
    return () => {
      active = false;
    };
  }, [open, memberId, tick, fetchTokens, fetchUsage]);

  const toggleApiEnabled = useCallback(
    async (next: boolean) => {
      const r = await toggleApi.execute(`/api/users/${memberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_enabled: next }),
      });
      if (!r.ok) {
        toastApiError(r, "Couldn't change API access");
        return;
      }
      toast.success(
        next
          ? `API access on for ${memberLabel}.`
          : `API access off. Every token of theirs stops working on its next request.`,
      );
      onChanged();
      refresh();
    },
    [toggleApi, memberId, memberLabel, onChanged, refresh],
  );

  const onCreate = useCallback(async () => {
    const r = await createApi.execute(`/api/users/${memberId}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't create that token");
      return;
    }
    setIssued(r.data.plaintext);
    setNewName("");
    onChanged();
    refresh();
  }, [createApi, memberId, newName, onChanged, refresh]);

  const onRevoke = useCallback(
    async (token: ApiTokenRow) => {
      const r = await revokeApi.execute(
        `/api/users/${memberId}/tokens/${token.id}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        toastApiError(r, "Couldn't revoke that token");
        return;
      }
      toast.success(`Token "${token.name}" revoked.`);
      setRevokeTarget(null);
      onChanged();
      refresh();
    },
    [revokeApi, memberId, onChanged, refresh],
  );

  const live = (tokens ?? []).filter((t) => !t.revoked_at && !t.expired);
  const dead = (tokens ?? []).filter((t) => t.revoked_at || t.expired);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>API access — {memberLabel}</SheetTitle>
            <SheetDescription>
              Tokens let this person&apos;s tools read CamMan through their own
              permissions. They can never reach anything the person cannot.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 px-4 pb-8">
            {/* ── The switch ─────────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="api-enabled" className="text-sm font-medium">
                  API access
                </Label>
                <p className="text-xs text-muted-foreground">
                  Off switches every token off at once, and back on again
                  unchanged. Their browser sign-in is not affected.
                </p>
              </div>
              <Switch
                id="api-enabled"
                checked={apiEnabled}
                onCheckedChange={(v) => void toggleApiEnabled(v)}
                disabled={toggleApi.isLoading}
              />
            </div>

            {apiEnabled && live.length === 0 ? (
              <p className="flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                API access is on but there are no live tokens, so nothing can
                connect yet.
              </p>
            ) : null}
            {!apiEnabled && live.length > 0 ? (
              <p className="flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {live.length} live token{live.length === 1 ? "" : "s"}, but API
                access is off — every request returns 401.
              </p>
            ) : null}

            {/* ── Tokens ─────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Tokens</h3>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <KeyRound className="size-4" aria-hidden />
                  New token
                </Button>
              </div>

              {tokens === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Loading…
                </div>
              ) : tokens.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tokens yet.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {[...live, ...dead].map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between gap-3 p-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {t.name}
                          </span>
                          {t.revoked_at ? (
                            <Badge variant="destructive">Revoked</Badge>
                          ) : t.expired ? (
                            <Badge variant="destructive">Expired</Badge>
                          ) : (
                            <Badge variant="outline">Live</Badge>
                          )}
                          {t.read_only ? (
                            <Badge variant="outline" className="text-[10px]">
                              Read-only
                            </Badge>
                          ) : null}
                        </div>
                        <p className="font-mono text-xs text-muted-foreground">
                          {t.token_prefix}…
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t.last_used_at
                            ? `Last used ${formatCampaignDateTime(t.last_used_at)}`
                            : "Never used"}
                        </p>
                      </div>
                      {t.revoked_at ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevokeTarget(t)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                          Revoke
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── Usage ──────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Last 7 days</h3>
              {usage === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Loading…
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Requests" value={usage.totals.requests} />
                    <Stat
                      label="Denied"
                      value={usage.totals.denied}
                      alert={usage.totals.denied > 0}
                    />
                    <Stat
                      label="Rate-limited"
                      value={usage.totals.rate_limited}
                      alert={usage.totals.rate_limited > 0}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Limit {usage.hourly_limit} requests/hour per token
                    {usage.last_ip ? ` · last IP ${usage.last_ip}` : ""}
                    {usage.last_seen_at
                      ? ` · last seen ${formatCampaignDateTime(usage.last_seen_at)}`
                      : ""}
                  </p>

                  {usage.top_endpoints.length > 0 ? (
                    <div className="space-y-1 pt-2">
                      <p className="text-xs font-medium">Top endpoints</p>
                      <ul className="space-y-0.5">
                        {usage.top_endpoints.map((e) => (
                          <li
                            key={`${e.method}:${e.endpoint}`}
                            className="flex justify-between gap-2 text-xs text-muted-foreground"
                          >
                            <span className="truncate font-mono">
                              {e.method} {e.endpoint}
                            </span>
                            <span>{e.n}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {usage.denials.length > 0 ? (
                    <div className="space-y-1 pt-2">
                      <p className="text-xs font-medium text-destructive">
                        Denied attempts
                      </p>
                      <ul className="space-y-0.5">
                        {usage.denials.map((d, i) => (
                          <li
                            key={`${d.action}:${d.endpoint}:${i}`}
                            className="flex justify-between gap-2 text-xs text-muted-foreground"
                          >
                            <span className="truncate font-mono">
                              {d.method} {d.endpoint ?? d.action}
                              {d.reason ? ` (${d.reason})` : ""}
                            </span>
                            <span>{d.n}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Create ───────────────────────────────────────────────────────── */}
      <FormDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          // Clearing on close is what makes "shown once" true rather than
          // "shown until you navigate away".
          if (!o) setIssued(null);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {issued ? "Copy this token now" : "New API token"}
          </DialogTitle>
          <DialogDescription>
            {issued
              ? "This is the only time it will ever be shown. If it is lost, revoke it and issue another."
              : `A read-only token for ${memberLabel}. It inherits their permissions exactly.`}
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="grid gap-4">
            <CopyableId
              value={issued}
              label="API token"
              copiedMessage="Token copied"
              inputClassName="text-xs"
            />
            <div className="flex justify-end">
              <Button onClick={() => setCreateOpen(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="token-name">
                Name
                <span aria-hidden className="ml-0.5 text-destructive">
                  *
                </span>
              </Label>
              <Input
                id="token-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Claude Desktop"
                autoComplete="off"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void onCreate()}
                disabled={createApi.isLoading || newName.trim() === ""}
              >
                {createApi.isLoading ? "Creating…" : "Create token"}
              </Button>
            </div>
          </div>
        )}
      </FormDialog>

      {/* ── Revoke ───────────────────────────────────────────────────────── */}
      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke &ldquo;{revokeTarget?.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Anything using it stops working on its next request. This cannot be
              undone — issue a new token instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && void onRevoke(revokeTarget)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: number;
  alert?: boolean;
}) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          alert ? "text-lg font-semibold text-destructive" : "text-lg font-semibold"
        }
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}
