"use client";

import { useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { CopyableId } from "@/components/ui/copyable-id";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { partnerBase } from "@/lib/app-origin";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import type { PartnerKeyJson } from "@/lib/partners/queries";

// One partner intake key (Drip Phase 2), nested under its partner since 0200.
// The signed report link and the revenue switch are NOT here any more — they
// are partner-level controls (components/settings/partners.tsx).
//
// ⚠️ The plaintext secret exists in this component's state for exactly as long
// as the "rotated" dialog is open, and is never fetched again — only its SHA-256
// is stored server-side. That is why the dialog is deliberately hard to dismiss
// by accident (FormDialog blocks backdrop/Escape): closing it loses the secret,
// and the only recovery is another rotation that breaks the partner's integration.

// The URL an operator copies and hands to a partner. It must be the
// PARTNER-FACING hostname regardless of which hostname the operator is
// browsing — copying this box from a preview deployment used to hand out a
// URL that later 404s. Falls back to the current origin only on a
// single-hostname deployment where NEXT_PUBLIC_PARTNER_HOST is unset.
export const endpointUrl = (token: string) =>
  `${partnerBase(typeof window === "undefined" ? "" : window.location.origin)}/api/intake/leads/${token}`;

/** The one-time secret dialog, shared by create (with the endpoint URL) and rotate (secret only). */
export function SecretOnceDialog({
  shown,
  onClose,
}: {
  shown: { token: string; secret: string } | null;
  onClose: () => void;
}) {
  return (
    <FormDialog open={shown !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogHeader>
        <DialogTitle>Save this secret now</DialogTitle>
        <DialogDescription>
          It is stored only as a hash and cannot be shown again. Losing it means rotating,
          which breaks the partner&apos;s integration until they redeploy.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {shown?.token ? (
          <CopyableId
            value={endpointUrl(shown.token)}
            label="Endpoint URL"
            copiedMessage="Endpoint URL copied"
          />
        ) : null}
        <CopyableId
          value={shown?.secret ?? ""}
          label="Secret"
          helperText="Sent as `Authorization: Bearer <secret>` or `X-Partner-Secret`. Never in the body."
          copiedMessage="Secret copied"
        />
        <div className="flex justify-end pt-2">
          <Button type="button" onClick={onClose}>
            I have saved it
          </Button>
        </div>
      </div>
    </FormDialog>
  );
}

export function PartnerKeyCard({
  row,
  canManage,
  onChanged,
}: {
  row: PartnerKeyJson;
  canManage: boolean;
  /** The list reloads after any mutation; the parent owns the data. */
  onChanged: () => void;
}) {
  const mutateApi = useApiCall<unknown>();
  const detailApi = useApiCall<{ token: string }>();
  const [shownToken, setShownToken] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotated, setRotated] = useState<{ token: string; secret: string } | null>(null);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    const r = await mutateApi.execute(`/api/partner-keys/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!r.ok) return toastApiError(r);
    toast.success(ok);
    onChanged();
  };

  const rotate = async () => {
    const r = await mutateApi.execute(`/api/partner-keys/${row.id}/rotate`, { method: "POST" });
    if (!r.ok) return toastApiError(r);
    const d = r.data as { secret: string };
    setRotateOpen(false);
    setRotated({ token: "", secret: d.secret });
    onChanged();
  };

  const revealToken = async () => {
    const r = await detailApi.execute(`/api/partner-keys/${row.id}`);
    if (!r.ok) return toastApiError(r);
    setShownToken(r.data.token);
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="text-muted-foreground size-4" />
          <span className="font-medium">{row.name}</span>
          <code className="text-muted-foreground text-xs">{row.partner_slug}</code>
          {row.sandbox && <Badge variant="secondary">sandbox</Badge>}
          {row.status !== "active" && <Badge variant="outline">disabled</Badge>}
          {row.auth_fails_today > 0 && (
            <Badge variant="destructive">
              {row.auth_fails_today} auth failure{row.auth_fails_today === 1 ? "" : "s"} today
            </Badge>
          )}
        </div>

        <div className="text-muted-foreground grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <span>
            Leads (24h): <span className="text-foreground font-medium">{row.leads_24h}</span>
          </span>
          <span>
            Leads (total): <span className="text-foreground font-medium">{row.total_leads}</span>
          </span>
          <span>Limits: {row.rate_per_sec}/s · {row.rate_per_day.toLocaleString()}/day</span>
          <span>
            Last seen:{" "}
            {row.last_seen_at ? formatCampaignDateTime(row.last_seen_at) : "never"}
          </span>
          <span>
            Tag: {row.interest_tag ?? "—"}
            {row.interest_tag_mode === "force" && " (forced)"}
          </span>
          <span>Secret: …{row.secret_last4 ?? "????"}</span>
          <span>Max payload: {Math.round(row.max_payload_bytes / 1024)} KB</span>
          <span>
            Rotated: {row.rotated_at ? formatCampaignDateTime(row.rotated_at) : "never"}
          </span>
        </div>

        {shownToken && (
          <CopyableId
            value={endpointUrl(shownToken)}
            label="Endpoint URL"
            helperText="Give this to the partner together with the secret. It is half the credential — treat it as sensitive."
            copiedMessage="Endpoint URL copied"
          />
        )}

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={detailApi.isLoading}
              onClick={() => void revealToken()}
            >
              Show endpoint URL
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutateApi.isLoading}
              onClick={() => setRotateOpen(true)}
            >
              <RefreshCw className="mr-1 size-4" /> Rotate secret
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutateApi.isLoading}
              onClick={() =>
                void patch(
                  { status: row.status === "active" ? "disabled" : "active" },
                  row.status === "active" ? "Key disabled" : "Key enabled",
                )
              }
            >
              {row.status === "active" ? "Disable" : "Enable"}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor={`sandbox-${row.id}`} className="text-xs">
                Sandbox
              </Label>
              <Switch
                id={`sandbox-${row.id}`}
                checked={row.sandbox}
                disabled={mutateApi.isLoading}
                onCheckedChange={(v) =>
                  void patch({ sandbox: v }, v ? "Key moved to sandbox" : "Key is now LIVE")
                }
              />
            </div>
          </div>
        )}
      </CardContent>

      {/* ---- rotate confirmation ---- */}
      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the secret for {row.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This takes effect immediately and there is no grace period — the partner&apos;s next
              request with the old secret is rejected, and their leads stop arriving until they
              deploy the new one. The endpoint URL does not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void rotate()}>Rotate secret</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SecretOnceDialog shown={rotated} onClose={() => setRotated(null)} />
    </Card>
  );
}
