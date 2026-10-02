"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Link as LinkIcon, Loader2, Plus, RefreshCw } from "lucide-react";
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
import { CopyableId } from "@/components/ui/copyable-id";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { partnerBase } from "@/lib/app-origin";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Partner intake keys (Drip Phase 2).
//
// ⚠️ The plaintext secret exists in this component's state for exactly as long
// as the "created" dialog is open, and is never fetched again — only its SHA-256
// is stored server-side. That is why the dialog is deliberately hard to dismiss
// by accident (FormDialog blocks backdrop/Escape): closing it loses the secret,
// and the only recovery is a rotation that breaks the partner's integration.

type PartnerKeyRow = {
  id: number;
  partner_slug: string;
  name: string;
  interest_tag_mode: "force" | "default";
  interest_tag: string | null;
  field_mapping: Record<string, string>;
  sandbox: boolean;
  rate_per_sec: number;
  rate_per_day: number;
  max_payload_bytes: number;
  status: string;
  created_at: string;
  rotated_at: string | null;
  last_seen_at: string | null;
  secret_last4: string | null;
  // Signed report link STATE. The token itself is never sent to the browser —
  // it is hashed at rest and shown once at issue, like the secret.
  report_link_active: boolean;
  report_token_issued_at: string | null;
  report_token_expires_at: string | null;
  report_show_revenue: boolean;
  leads_24h: number;
  auth_fails_today: number;
  total_leads: number;
};

type CreatedKey = { id: number; partner_slug: string; token: string; secret: string };

export function PartnerKeys() {
  const { can } = useAuth();
  const canManage = can("partner_keys.manage");

  const listApi = useApiCall<{ data: PartnerKeyRow[] }>();
  const mutateApi = useApiCall<unknown>();
  const detailApi = useApiCall<{ token: string }>();

  const [rows, setRows] = useState<PartnerKeyRow[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [rotateTarget, setRotateTarget] = useState<PartnerKeyRow | null>(null);
  const [shownToken, setShownToken] = useState<{ id: number; token: string } | null>(null);
  // The signed report link, visible for exactly as long as this dialog is open.
  // Same contract as the secret above: hashed at rest, never retrievable again.
  const [reportLink, setReportLink] = useState<{ slug: string; url: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PartnerKeyRow | null>(null);
  const reportLinkApi = useApiCall<{ token: string; url: string | null }>();

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [tagMode, setTagMode] = useState<"force" | "default">("default");
  const [tag, setTag] = useState("");

  const load = listApi.execute;
  useEffect(() => {
    (async () => {
      const r = await load("/api/partner-keys");
      if (r.ok) setRows(r.data.data);
    })();
  }, [load, tick]);

  const create = async () => {
    const r = await mutateApi.execute("/api/partner-keys", {
      method: "POST",
      body: JSON.stringify({
        partner_slug: slug.trim(),
        name: name.trim(),
        interest_tag_mode: tagMode,
        interest_tag: tag.trim() || null,
      }),
    });
    if (!r.ok) return toastApiError(r);
    const k = r.data as CreatedKey;
    setCreateOpen(false);
    setCreated(k);
    setSlug("");
    setName("");
    setTag("");
    setTagMode("default");
    reload();
  };

  // Issue or rotate the partner's signed report link. Rotation is the same call:
  // it overwrites the stored hash, so the previous URL dies instantly and there
  // is only ever one live link per key.
  const issueReportLink = async (row: PartnerKeyRow) => {
    const r = await reportLinkApi.execute(`/api/partner-keys/${row.id}/report-link`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!r.ok) return toastApiError(r);
    if (!r.data.url) {
      toast.error("Link issued, but no public host is configured for it");
      reload();
      return;
    }
    setReportLink({ slug: row.partner_slug, url: r.data.url });
    reload();
  };

  const revokeReportLink = async (row: PartnerKeyRow) => {
    const r = await reportLinkApi.execute(`/api/partner-keys/${row.id}/report-link`, {
      method: "DELETE",
    });
    if (!r.ok) return toastApiError(r);
    toast.success("Report link revoked — the URL now 404s");
    setRevokeTarget(null);
    reload();
  };

  const patch = async (row: PartnerKeyRow, body: Record<string, unknown>, ok: string) => {
    const r = await mutateApi.execute(`/api/partner-keys/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!r.ok) return toastApiError(r);
    toast.success(ok);
    reload();
  };

  const rotate = async () => {
    if (!rotateTarget) return;
    const r = await mutateApi.execute(`/api/partner-keys/${rotateTarget.id}/rotate`, {
      method: "POST",
    });
    if (!r.ok) return toastApiError(r);
    const d = r.data as { secret: string };
    setCreated({
      id: rotateTarget.id,
      partner_slug: rotateTarget.partner_slug,
      token: "",
      secret: d.secret,
    });
    setRotateTarget(null);
    reload();
  };

  const revealToken = async (row: PartnerKeyRow) => {
    const r = await detailApi.execute(`/api/partner-keys/${row.id}`);
    if (!r.ok) return toastApiError(r);
    setShownToken({ id: row.id, token: r.data.token });
  };

  // The URL an operator copies and hands to a partner. It must be the
  // PARTNER-FACING hostname regardless of which hostname the operator is
  // browsing — copying this box from a preview deployment used to hand out a
  // URL that later 404s. Falls back to the current origin only on a
  // single-hostname deployment where NEXT_PUBLIC_PARTNER_HOST is unset.
  const endpointUrl = (token: string) =>
    `${partnerBase(typeof window === "undefined" ? "" : window.location.origin)}/api/intake/leads/${token}`;

  return (
    <div className="space-y-4">
      {canManage && (
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 size-4" /> New partner key
        </Button>
      )}

      {listApi.isLoading && rows.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No partner keys yet.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id}>
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

                {shownToken?.id === row.id && (
                  <CopyableId
                    value={endpointUrl(shownToken.token)}
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
                      onClick={() => void revealToken(row)}
                    >
                      Show endpoint URL
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={mutateApi.isLoading}
                      onClick={() => setRotateTarget(row)}
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
                          row,
                          { status: row.status === "active" ? "disabled" : "active" },
                          row.status === "active" ? "Key disabled" : "Key enabled",
                        )
                      }
                    >
                      {row.status === "active" ? "Disable" : "Enable"}
                    </Button>
                    {/* ---- signed report link (Drip P7) ----
                        ⚠️ resolveReportToken requires `sandbox = false`, so a link
                        issued on a sandbox key resolves to null and the public page
                        404s. Issuing one here would hand the operator a dead URL,
                        so the control states the precondition instead. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={reportLinkApi.isLoading || row.sandbox}
                      title={
                        row.sandbox
                          ? "The public report only resolves for live keys. Switch this key out of sandbox first."
                          : undefined
                      }
                      onClick={() => void issueReportLink(row)}
                    >
                      <LinkIcon className="mr-1 size-4" />
                      {row.report_link_active ? "Rotate report link" : "Generate report link"}
                    </Button>
                    {row.sandbox && (
                      <span className="text-muted-foreground text-xs">
                        Report links work on live keys only
                      </span>
                    )}
                    {row.report_link_active && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={reportLinkApi.isLoading}
                        onClick={() => setRevokeTarget(row)}
                      >
                        Revoke report link
                      </Button>
                    )}
                    <div className="ml-auto flex items-center gap-4">
                      {/* Revenue is OFF by default (P7 R2) — it is our margin,
                          not the partner's number. */}
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`revenue-${row.id}`} className="text-xs">
                          Show revenue
                        </Label>
                        <Switch
                          id={`revenue-${row.id}`}
                          checked={row.report_show_revenue}
                          disabled={mutateApi.isLoading}
                          onCheckedChange={(v) =>
                            void patch(
                              row,
                              { report_show_revenue: v },
                              v
                                ? "Revenue is now visible in this partner's report"
                                : "Revenue hidden from this partner's report",
                            )
                          }
                        />
                      </div>
                      <div className="flex items-center gap-2">
                      <Label htmlFor={`sandbox-${row.id}`} className="text-xs">
                        Sandbox
                      </Label>
                      <Switch
                        id={`sandbox-${row.id}`}
                        checked={row.sandbox}
                        disabled={mutateApi.isLoading}
                        onCheckedChange={(v) =>
                          void patch(
                            row,
                            { sandbox: v },
                            v ? "Key moved to sandbox" : "Key is now LIVE",
                          )
                        }
                      />
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ---- create ---- */}
      <FormDialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogHeader>
          <DialogTitle>New partner key</DialogTitle>
          <DialogDescription>
            The secret is shown once, immediately after creation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="pk-name">
              Name<span aria-hidden className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="pk-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Leads"
            />
          </div>
          <div>
            <Label htmlFor="pk-slug">
              Partner slug<span aria-hidden className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="pk-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="acme"
              className="font-mono"
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Stamped on every lead and used as a report dimension, so it cannot be changed
              later. Lowercase letters, digits, <code>_</code> and <code>-</code>.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Interest tag mode</Label>
              <Select value={tagMode} onValueChange={(v) => setTagMode(v as "force" | "default")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default — used only if absent</SelectItem>
                  <SelectItem value="force">Force — always override</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="pk-tag">
                Interest tag
                {tagMode === "force" && (
                  <span aria-hidden className="text-destructive ml-0.5">*</span>
                )}
              </Label>
              <Input
                id="pk-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="ACA"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                !name.trim() ||
                !/^[a-z0-9][a-z0-9_-]*$/.test(slug.trim()) ||
                (tagMode === "force" && !tag.trim()) ||
                mutateApi.isLoading
              }
              onClick={() => void create()}
            >
              Create key
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* ---- the one and only time the report link is visible ---- */}
      <FormDialog open={reportLink !== null} onOpenChange={(o) => !o && setReportLink(null)}>
        <DialogHeader>
          <DialogTitle>Save this report link now</DialogTitle>
          <DialogDescription>
            Anyone with this URL can see {reportLink?.slug}&apos;s own lead performance —
            no login required. It is stored only as a hash and cannot be shown again;
            generating a new one immediately kills this URL.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <CopyableId
            value={reportLink?.url ?? ""}
            label="Partner report URL"
            helperText="Scoped to this partner only. Revoke it any time — the URL then 404s."
            copiedMessage="Report link copied"
          />
          <div className="flex justify-end pt-2">
            <Button type="button" onClick={() => setReportLink(null)}>
              I have saved it
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* ---- revoke confirmation ---- */}
      <AlertDialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this report link?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.partner_slug}&apos;s report URL stops working immediately and
              returns a 404. Their intake key is unaffected — leads keep arriving. You can
              issue a new link at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (revokeTarget) void revokeReportLink(revokeTarget);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- the one and only time the secret is visible ---- */}
      <FormDialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogHeader>
          <DialogTitle>Save this secret now</DialogTitle>
          <DialogDescription>
            It is stored only as a hash and cannot be shown again. Losing it means rotating,
            which breaks the partner&apos;s integration until they redeploy.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {created?.token ? (
            <CopyableId
              value={endpointUrl(created.token)}
              label="Endpoint URL"
              copiedMessage="Endpoint URL copied"
            />
          ) : null}
          <CopyableId
            value={created?.secret ?? ""}
            label="Secret"
            helperText="Sent as `Authorization: Bearer <secret>` or `X-Partner-Secret`. Never in the body."
            copiedMessage="Secret copied"
          />
          <div className="flex justify-end pt-2">
            <Button type="button" onClick={() => setCreated(null)}>
              I have saved it
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* ---- rotate confirmation ---- */}
      <AlertDialog open={rotateTarget !== null} onOpenChange={(o) => !o && setRotateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the secret for {rotateTarget?.name}?</AlertDialogTitle>
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
    </div>
  );
}
