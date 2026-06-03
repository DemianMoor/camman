"use client";

import { useEffect, useState } from "react";
import { KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Masked credential row from GET /api/providers/[id]/credentials — never the
// plaintext key.
type Cred = {
  id: number;
  brand_id: number | null;
  brand_name: string | null;
  last4: string;
  masked: string;
  updated_at: string;
};
type Brand = { id: number; name: string };

const DEFAULT_LABEL = "Default (all brands)";

export function ProviderCredentialsSection({ providerId }: { providerId: number }) {
  const listApi = useApiCall<{ data: Cred[] }>();
  const brandsApi = useApiCall<{ data: Brand[] }>();
  const saveApi = useApiCall<unknown>();
  const deleteApi = useApiCall<unknown>();
  const { execute: listExec } = listApi;
  const { execute: brandsExec } = brandsApi;

  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [tick, setTick] = useState(0);

  // Add/rotate dialog. brandId === undefined means "choosing" (add mode).
  const [dialog, setDialog] = useState<
    | { mode: "add" }
    | { mode: "rotate"; brandId: number | null; label: string }
    | null
  >(null);
  const [formBrandId, setFormBrandId] = useState<string>("default"); // "default" | "<id>"
  const [apiKey, setApiKey] = useState("");
  const [deleting, setDeleting] = useState<Cred | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await listExec(`/api/providers/${providerId}/credentials`);
      if (active && r.ok) setCreds(r.data.data);
    })();
    return () => {
      active = false;
    };
  }, [providerId, tick, listExec]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await brandsExec(`/api/brands/list?pageSize=100`);
      if (active && r.ok) setBrands(r.data.data);
    })();
    return () => {
      active = false;
    };
  }, [brandsExec]);

  function openAdd() {
    setDialog({ mode: "add" });
    setFormBrandId("default");
    setApiKey("");
  }
  function openRotate(c: Cred) {
    setDialog({ mode: "rotate", brandId: c.brand_id, label: c.brand_name ?? DEFAULT_LABEL });
    setApiKey("");
  }

  async function handleSave() {
    if (!apiKey.trim()) return;
    const brand_id =
      dialog?.mode === "rotate"
        ? dialog.brandId
        : formBrandId === "default"
          ? null
          : Number(formBrandId);
    const r = await saveApi.execute(`/api/providers/${providerId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_id, api_key: apiKey }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't save key");
      return;
    }
    toast.success(dialog?.mode === "rotate" ? "Key rotated" : "Key saved");
    setDialog(null);
    setApiKey(""); // don't keep the secret in component state
    setTick((n) => n + 1);
  }

  async function handleDelete() {
    if (!deleting) return;
    const r = await deleteApi.execute(
      `/api/providers/${providerId}/credentials/${deleting.id}`,
      { method: "DELETE" },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't remove key");
      return;
    }
    toast.success("Key removed");
    setDeleting(null);
    setTick((n) => n + 1);
  }

  // Brands that don't already have their own key (eligible for a new one).
  const usedBrandIds = new Set((creds ?? []).map((c) => c.brand_id));
  const hasDefault = usedBrandIds.has(null);
  const addableBrands = brands.filter((b) => !usedBrandIds.has(b.id));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">API keys</h2>
          <p className="text-sm text-muted-foreground">
            Per-brand TextHub keys (plus an optional default). Keys are stored
            securely and shown masked.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="size-4" aria-hidden /> Add key
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {creds === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : creds.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No API keys yet. Add a default key, or a key per brand.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Scope</th>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      {c.brand_id === null ? (
                        <span className="text-muted-foreground">{DEFAULT_LABEL}</span>
                      ) : (
                        c.brand_name ?? `Brand #${c.brand_id}`
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono">
                      <span className="inline-flex items-center gap-1.5">
                        <KeyRound className="size-3.5 opacity-50" aria-hidden />
                        {c.masked}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(c.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openRotate(c)}>
                          <RotateCw className="size-4" aria-hidden /> Rotate
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove key"
                          onClick={() => setDeleting(c)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Add / rotate dialog */}
      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setApiKey("");
          }
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{dialog?.mode === "rotate" ? "Rotate API key" : "Add API key"}</DialogTitle>
          <DialogDescription>
            {dialog?.mode === "rotate"
              ? `Replace the key for ${dialog.label}. The old key is overwritten.`
              : "The key is write-only — it's stored securely and never shown again."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {dialog?.mode === "add" ? (
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="cred-brand">
                Scope
              </label>
              <select
                id="cred-brand"
                value={formBrandId}
                onChange={(e) => setFormBrandId(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {!hasDefault ? <option value="default">{DEFAULT_LABEL}</option> : null}
                {addableBrands.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
              {hasDefault && addableBrands.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Every brand and the default already have a key — rotate an existing one instead.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="cred-key">
              API key
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <Input
              id="cred-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste the TextHub api_key"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setApiKey("");
              }}
              disabled={saveApi.isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={
                saveApi.isLoading ||
                !apiKey.trim() ||
                // Add mode with nothing left to scope (default + every brand taken).
                (dialog?.mode === "add" && hasDefault && addableBrands.length === 0)
              }
            >
              {dialog?.mode === "rotate" ? "Rotate key" : "Save key"}
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* Delete confirm */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this API key?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `The ${deleting.brand_id === null ? "default" : deleting.brand_name ?? "brand"} key will be removed. Tracked sends that rely on it will fail until a key is set again.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteApi.isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              disabled={deleteApi.isLoading}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
