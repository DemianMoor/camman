"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, Handshake, Link as LinkIcon, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
import { PartnerKeyCard } from "@/components/settings/partner-key-card";
import { PartnerKeyCreateDialog } from "@/components/settings/partner-key-create-dialog";
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
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import type { PartnerJson, PartnerKeyJson } from "@/lib/partners/queries";

// Settings → Partners (partner attribution Phase 1, migration 0200). One card
// per PARTNER; its intake keys are nested cards. The signed report link and
// the revenue switch are partner-level controls (rulings Q7 / Q10): a partner
// with two keys, or a file-only partner with no key, has exactly one link.
//
// ⚠️ The plaintext report URL exists in this component's state for exactly as
// long as its dialog is open, and is never fetched again — only its SHA-256 is
// stored. Same contract as the intake secret.

type ListJson = { data: PartnerJson[]; unassigned_keys: PartnerKeyJson[] };

export function Partners() {
  const { can } = useAuth();
  const canManage = can("partner_keys.manage");

  const listApi = useApiCall<ListJson>();
  const mutateApi = useApiCall<unknown>();
  const reportLinkApi = useApiCall<{ token: string; url: string | null }>();

  const [partners, setPartners] = useState<PartnerJson[]>([]);
  const [unassigned, setUnassigned] = useState<PartnerKeyJson[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const [newOpen, setNewOpen] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [createKeyFor, setCreateKeyFor] = useState<PartnerJson | null>(null);
  const [reportLink, setReportLink] = useState<{ slug: string; url: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PartnerJson | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<PartnerJson | null>(null);

  const load = listApi.execute;
  useEffect(() => {
    (async () => {
      const r = await load("/api/partners");
      if (r.ok) {
        setPartners(r.data.data);
        setUnassigned(r.data.unassigned_keys);
      }
    })();
  }, [load, tick]);

  const createPartner = async () => {
    const r = await mutateApi.execute("/api/partners", {
      method: "POST",
      body: JSON.stringify({ slug: newSlug.trim(), name: newName.trim() }),
    });
    if (!r.ok) return toastApiError(r);
    setNewOpen(false);
    setNewSlug("");
    setNewName("");
    toast.success("Partner created");
    reload();
  };

  const patchPartner = async (p: PartnerJson, body: Record<string, unknown>, ok: string) => {
    const r = await mutateApi.execute(`/api/partners/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!r.ok) return toastApiError(r);
    toast.success(ok);
    reload();
  };

  // Issue or rotate the partner's signed report link. Rotation is the same
  // call: it overwrites the stored hash, so the previous URL dies instantly and
  // there is only ever one live link per partner.
  const issueReportLink = async (p: PartnerJson) => {
    const r = await reportLinkApi.execute(`/api/partners/${p.id}/report-link`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!r.ok) return toastApiError(r);
    if (!r.data.url) {
      toast.error("Link issued, but no public host is configured for it");
      reload();
      return;
    }
    setReportLink({ slug: p.slug, url: r.data.url });
    reload();
  };

  const revokeReportLink = async (p: PartnerJson) => {
    const r = await reportLinkApi.execute(`/api/partners/${p.id}/report-link`, { method: "DELETE" });
    if (!r.ok) return toastApiError(r);
    toast.success("Report link revoked — the URL now 404s");
    setRevokeTarget(null);
    reload();
  };

  const archive = async (p: PartnerJson) => {
    const r = await mutateApi.execute(`/api/partners/${p.id}/archive`, { method: "POST" });
    if (!r.ok) return toastApiError(r);
    toast.success(`${p.name} archived — intake and its report link are off`);
    setArchiveTarget(null);
    reload();
  };

  const restore = async (p: PartnerJson) => {
    const r = await mutateApi.execute(`/api/partners/${p.id}/restore`, { method: "POST" });
    if (!r.ok) return toastApiError(r);
    toast.success(`${p.name} restored — intake and its report link are back`);
    reload();
  };

  const linkHint = (p: PartnerJson) =>
    p.status !== "active"
      ? "Restore the partner first."
      : !p.can_have_link
        ? "Report links work for partners with a live key, or with no keys at all. Switch one key out of sandbox first."
        : undefined;

  return (
    <div className="space-y-4">
      {canManage && (
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="mr-1 size-4" /> New partner
        </Button>
      )}

      {listApi.isLoading && partners.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : partners.length === 0 && unassigned.length === 0 ? (
        <p className="text-muted-foreground text-sm">No partners yet.</p>
      ) : (
        <div className="space-y-4">
          {partners.map((p) => (
            <Card key={p.id}>
              <CardContent className="space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Handshake className="text-muted-foreground size-4" />
                  <span className="text-base font-semibold">{p.name}</span>
                  <Badge variant="outline">{p.slug}</Badge>
                  {p.status === "archived" && <Badge variant="secondary">archived</Badge>}
                  {p.report_link_active && <Badge>report link</Badge>}
                  <span className="text-muted-foreground text-xs">
                    {p.keys.length} key{p.keys.length === 1 ? "" : "s"}
                  </span>
                </div>

                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={p.status !== "active" || mutateApi.isLoading}
                      title={p.status !== "active" ? "Restore the partner first." : undefined}
                      onClick={() => setCreateKeyFor(p)}
                    >
                      <Plus className="mr-1 size-4" /> New key
                    </Button>
                    {/* ---- signed report link (Drip P7, on the partner since 0200) ----
                        The precondition is stated on the control instead of handing
                        the operator a dead URL: a sandbox-only partner never resolves. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={reportLinkApi.isLoading || p.status !== "active" || !p.can_have_link}
                      title={linkHint(p)}
                      onClick={() => void issueReportLink(p)}
                    >
                      <LinkIcon className="mr-1 size-4" />
                      {p.report_link_active ? "Rotate report link" : "Generate report link"}
                    </Button>
                    {p.status === "active" && !p.can_have_link && (
                      <span className="text-muted-foreground text-xs">
                        Report links need a live key (or no keys at all)
                      </span>
                    )}
                    {p.report_link_active && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={reportLinkApi.isLoading}
                        onClick={() => setRevokeTarget(p)}
                      >
                        Revoke report link
                      </Button>
                    )}
                    {p.status === "active" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={mutateApi.isLoading}
                        onClick={() => setArchiveTarget(p)}
                      >
                        <Archive className="mr-1 size-4" /> Archive
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={mutateApi.isLoading}
                        onClick={() => void restore(p)}
                      >
                        <ArchiveRestore className="mr-1 size-4" /> Restore
                      </Button>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {/* Revenue is OFF by default (P7 R2) — it is our margin,
                          not the partner's number. */}
                      <Label htmlFor={`revenue-${p.id}`} className="text-xs">
                        Show revenue
                      </Label>
                      <Switch
                        id={`revenue-${p.id}`}
                        checked={p.report_show_revenue}
                        disabled={mutateApi.isLoading}
                        onCheckedChange={(v) =>
                          void patchPartner(
                            p,
                            { report_show_revenue: v },
                            v
                              ? "Revenue is now visible in this partner's report"
                              : "Revenue hidden from this partner's report",
                          )
                        }
                      />
                    </div>
                  </div>
                )}

                {p.keys.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No keys yet — this partner delivers files only, or add a key.
                  </p>
                ) : (
                  <div className="space-y-3 pl-2 sm:pl-6">
                    {p.keys.map((k) => (
                      <PartnerKeyCard key={k.id} row={k} canManage={canManage} onChanged={reload} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {unassigned.length > 0 && (
            <Card>
              <CardContent className="space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold">Keys without a partner</span>
                  <Badge variant="secondary">{unassigned.length}</Badge>
                </div>
                <p className="text-muted-foreground text-sm">
                  Created before partners existed. Create the partner and re-create the key under
                  it; this list disappears once the follow-up migration makes the link required.
                </p>
                <div className="space-y-3 pl-2 sm:pl-6">
                  {unassigned.map((k) => (
                    <PartnerKeyCard key={k.id} row={k} canManage={canManage} onChanged={reload} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ---- new partner ---- */}
      <FormDialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogHeader>
          <DialogTitle>New partner</DialogTitle>
          <DialogDescription>
            A partner owns its intake keys, its signed report link and whether that report shows
            revenue. Add keys after creating it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="p-name">
              Name<span aria-hidden className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="p-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Leads"
            />
          </div>
          <div>
            <Label htmlFor="p-slug">
              Slug<span aria-hidden className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="p-slug"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
              placeholder="acme"
              className="font-mono"
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Stamped on every lead and used as a report dimension, so it cannot be changed
              later. Lowercase letters, digits, <code>_</code> and <code>-</code>.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                !newName.trim() || !/^[a-z0-9][a-z0-9_-]*$/.test(newSlug.trim()) || mutateApi.isLoading
              }
              onClick={() => void createPartner()}
            >
              Create partner
            </Button>
          </div>
        </div>
      </FormDialog>

      <PartnerKeyCreateDialog
        partner={createKeyFor}
        onOpenChange={(o) => !o && setCreateKeyFor(null)}
        onCreated={reload}
      />

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
              {revokeTarget?.slug}&apos;s report URL stops working immediately and returns a
              404. Their intake keys are unaffected — leads keep arriving. You can issue a new
              link at any time.
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

      {/* ---- archive confirmation (ruling Q7: it says BOTH consequences) ---- */}
      <AlertDialog open={archiveTarget !== null} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiveTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving <span className="font-medium">{archiveTarget?.name}</span> disables lead
              intake on all {archiveTarget?.keys.length ?? 0} of its keys and kills its report
              link. Nothing is deleted; Restore re-enables both.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (archiveTarget) void archive(archiveTarget);
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
