"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Star, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

type DomainRow = {
  id: number;
  domain: string;
  status: string;
  is_default: boolean;
};

type BrandRow = { id: number; name: string; brand_id: string };

// Brand short-domain management (B1). This is the ONLY write surface for brand
// domains — the brand form's single text field was removed, because a brand may
// hold several domains since migration 0136 and one field cannot express a list.
//
// Every operation is targeted at ONE domain row by id. There is deliberately no
// brand-wide mutation: the helper this replaced deleted by (org_id, brand_id),
// which post-0136 wiped every domain a brand had instead of the one being
// removed.
export function BrandShortDomains({ brands }: { brands: BrandRow[] }) {
  const { can } = useAuth();
  const listApi = useApiCall<{ data: DomainRow[] }>();
  const mutateApi = useApiCall<{ ok: boolean }>();
  const { execute: listExec } = listApi;

  const [byBrand, setByBrand] = useState<Record<number, DomainRow[]>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ brandId: number; row: DomainRow } | null>(null);
  const [confirmActivate, setConfirmActivate] = useState<{ brandId: number; row: DomainRow } | null>(null);

  const canManage = can("brands.update");

  useEffect(() => {
    let active = true;
    void (async () => {
      // PARALLEL, not a serial for-loop. Each request is independent, and the
      // serial version multiplied the per-brand latency by the brand count —
      // which is what turned a slow query into a page that took ~20s to paint.
      const results = await Promise.all(
        brands.map(async (b) => [b.id, await listExec(`/api/brands/${b.id}/short-domains`)] as const),
      );
      if (!active) return;
      const out: Record<number, DomainRow[]> = {};
      for (const [id, r] of results) if (r.ok) out[id] = r.data.data;
      setByBrand(out);
      setLoaded(true);
    })();
    return () => {
      active = false;
    };
  }, [tick, brands, listExec]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Apply a mutation's outcome to local state IMMEDIATELY, then refetch to
  // reconcile. The refetch alone used to be the only feedback, and while it was
  // slow (see listBrandShortDomains) a successful click looked like it had done
  // nothing at all. Even now that the refetch is fast, a mutation whose result
  // is already known should not wait on a round trip to become visible.
  const patchLocal = useCallback(
    (brandId: number, fn: (rows: DomainRow[]) => DomainRow[]) => {
      setByBrand((prev) => ({ ...prev, [brandId]: fn(prev[brandId] ?? []) }));
    },
    [],
  );

  async function addDomain(brandId: number) {
    const domain = (drafts[brandId] ?? "").trim();
    if (!domain) return;
    const r = await mutateApi.execute(`/api/brands/${brandId}/short-domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't add that domain");
      return;
    }
    toast.success(`${domain} added as pending — activate it once it routes here`);
    setDrafts((d) => ({ ...d, [brandId]: "" }));
    refresh();
  }

  async function setStatus(brandId: number, row: DomainRow, status: "active" | "pending") {
    const r = await mutateApi.execute(`/api/brands/${brandId}/short-domains/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't change that domain's status");
      return;
    }
    // Mirror the server's rule: deactivating also clears is_default.
    patchLocal(brandId, (rows) =>
      rows.map((d) =>
        d.id === row.id
          ? { ...d, status, is_default: status === "active" ? d.is_default : false }
          : d,
      ),
    );
    toast.success(status === "active" ? `${row.domain} is active` : `${row.domain} deactivated`);
    refresh();
  }

  async function makeDefault(brandId: number, row: DomainRow) {
    const r = await mutateApi.execute(`/api/brands/${brandId}/short-domains/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't set the brand default");
      return;
    }
    // The badge moves NOW. Exactly one default per brand, mirroring the DB
    // constraint, so the previous holder is cleared in the same update.
    patchLocal(brandId, (rows) =>
      rows.map((d) => ({ ...d, is_default: d.id === row.id })),
    );
    toast.success(`${row.domain} is now the brand default`);
    refresh();
  }

  async function removeDomain(brandId: number, row: DomainRow) {
    const r = await mutateApi.execute(`/api/brands/${brandId}/short-domains/${row.id}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      // Includes the server's `domain_in_use` refusal, which is now the ONLY
      // signal that a domain has minted links (the pre-emptive disable went
      // away with the count). toastApiError surfaces the server's message
      // verbatim: "…has minted links and can't be removed. Deactivate it instead."
      toastApiError(r, "Couldn't remove that domain");
      return;
    }
    patchLocal(brandId, (rows) => rows.filter((d) => d.id !== row.id));
    toast.success(`${row.domain} removed`);
    refresh();
  }

  if (!loaded) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading short domains…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {brands.map((b) => {
        const rows = byBrand[b.id] ?? [];
        const activeRows = rows.filter((r) => r.status === "active");
        return (
          <Card key={b.id}>
            <CardContent className="space-y-4 py-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">{b.name}</h2>
                  <code className="text-xs text-muted-foreground">{b.brand_id}</code>
                </div>
                {/* A brand with no ACTIVE domain cannot send tracked campaigns
                    at all — kickoff refuses with no_short_domain. Say it here
                    rather than leaving the operator to discover it at send time. */}
                {activeRows.length === 0 ? (
                  <Badge variant="destructive">
                    No active domain — tracked sending will refuse
                  </Badge>
                ) : null}
              </div>

              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No short domains yet.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <code className="text-sm">{row.domain}</code>
                      <Badge variant={row.status === "active" ? "default" : "outline"}>
                        {row.status === "active" ? "Active" : "Pending"}
                      </Badge>
                      {row.is_default ? (
                        <Badge variant="secondary" className="gap-1">
                          <Star className="h-3 w-3" />
                          Brand default
                        </Badge>
                      ) : null}

                      <div className="ml-auto flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Active</span>
                        <Switch
                          checked={row.status === "active"}
                          disabled={!canManage || mutateApi.isLoading}
                          aria-label={`Active: ${row.domain}`}
                          onCheckedChange={(next) => {
                            if (!canManage) return;
                            // Activating makes a host mintable for real traffic —
                            // confirm. Deactivating is the safe direction.
                            if (next) setConfirmActivate({ brandId: b.id, row });
                            else void setStatus(b.id, row, "pending");
                          }}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            !canManage || mutateApi.isLoading || row.is_default || row.status !== "active"
                          }
                          title={
                            row.status !== "active"
                              ? "Activate this domain before making it the brand default"
                              : undefined
                          }
                          onClick={() => void makeDefault(b.id, row)}
                        >
                          Make default
                        </Button>
                        {/* No longer pre-disabled on a minted-link count: that
                            count cost a full seq scan of a 3.2M-row table per
                            domain (see listBrandShortDomains). The server
                            re-checks and refuses with `domain_in_use`, and the
                            refusal is surfaced as a toast — the guard is real
                            either way, only the pre-emptive greying is gone. */}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canManage || mutateApi.isLoading}
                          title="Remove this domain (refused if it has minted links)"
                          onClick={() => setConfirmDelete({ brandId: b.id, row })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="g.brand.co"
                  className="max-w-xs"
                  value={drafts[b.id] ?? ""}
                  disabled={!canManage}
                  onChange={(e) => setDrafts((d) => ({ ...d, [b.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canManage || !(drafts[b.id] ?? "").trim() || mutateApi.isLoading}
                  onClick={() => void addDomain(b.id)}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add
                </Button>
                <span className="text-xs text-muted-foreground">
                  Added as <strong>pending</strong>. Nothing mints under it until you activate it.
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <AlertDialog
        open={confirmActivate !== null}
        onOpenChange={(o) => !o && setConfirmActivate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate {confirmActivate?.row.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tracked links for this brand can mint under this host from now on. Only
              activate it once you have confirmed the domain actually reaches this app —
              a host that does not resolve here produces links that 404 and silently lose
              attribution.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmActivate;
                setConfirmActivate(null);
                if (t) void setStatus(t.brandId, t.row, "active");
              }}
            >
              Activate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmDelete?.row.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the domain row. Only this one row is affected — no other domain
              of this brand is touched. A domain with minted links cannot be removed at all.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmDelete;
                setConfirmDelete(null);
                if (t) void removeDomain(t.brandId, t.row);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
