"use client";

import { useEffect, useState } from "react";
import { KeyRound, Plus, RotateCw, SendHorizonal, Trash2 } from "lucide-react";
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

  // Test-send dialog: send one real SMS using a specific stored key to confirm
  // it works + URLs in `text` arrive un-rewritten.
  const testApi = useApiCall<{
    ok: boolean;
    to: string;
    sentText: string;
    messageId: string | null;
    error: string | null;
  }>();
  const [testing, setTesting] = useState<Cred | null>(null);
  const [testNumber, setTestNumber] = useState("");
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<
    { ok: boolean; to: string; sentText: string; messageId: string | null; error: string | null } | null
  >(null);

  function openTest(c: Cred) {
    setTesting(c);
    setTestNumber("");
    setTestText("CamMan self-test https://go.yourbrand.co/r/SELFTEST1 (please ignore)");
    setTestResult(null);
  }

  async function handleTest() {
    if (!testing || !testNumber.trim() || !testText.trim()) return;
    const r = await testApi.execute(`/api/providers/${providerId}/credentials/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential_id: testing.id, number: testNumber, text: testText }),
    });
    if (!r.ok) {
      toastApiError(r, "Test send failed");
      return;
    }
    setTestResult(r.data);
    if (r.data.ok) toast.success("Test SMS sent — check the phone");
    else toast.error("TextHub rejected the test send");
  }

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
                        <Button variant="ghost" size="sm" onClick={() => openTest(c)}>
                          <SendHorizonal className="size-4" aria-hidden /> Send test
                        </Button>
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

      {/* Send test dialog */}
      <FormDialog
        open={testing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTesting(null);
            setTestResult(null);
          }
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Send a test SMS</DialogTitle>
          <DialogDescription>
            Sends one real SMS using the{" "}
            {testing?.brand_id === null ? "default" : testing?.brand_name ?? "brand"} key.
            Put your own number and a link you&apos;ll recognize, then check the phone:
            the URL should arrive exactly as typed (no rewriting/shortening).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="test-number">
              Recipient number
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <Input
              id="test-number"
              value={testNumber}
              onChange={(e) => setTestNumber(e.target.value)}
              placeholder="+1 415 555 0123"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="test-text">
              Message
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <textarea
              id="test-text"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              rows={3}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Swap in your real short link (e.g. https://&lt;your short domain&gt;/r/TEST).
            </p>
          </div>

          {testResult ? (
            <div
              className={
                "rounded-md border p-3 text-sm " +
                (testResult.ok
                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
                  : "border-destructive/40 bg-destructive/5")
              }
            >
              {testResult.ok ? (
                <>
                  <p className="font-medium">Sent to {testResult.to}.</p>
                  <p className="mt-1">
                    Now open the SMS and confirm this URL arrived unchanged:
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">{testResult.sentText}</p>
                  {testResult.messageId ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      TextHub id: {testResult.messageId}
                    </p>
                  ) : null}
                </>
              ) : (
                <p>TextHub rejected it: {testResult.error ?? "unknown error"}</p>
              )}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setTesting(null);
                setTestResult(null);
              }}
              disabled={testApi.isLoading}
            >
              Close
            </Button>
            <Button
              onClick={() => void handleTest()}
              disabled={testApi.isLoading || !testNumber.trim() || !testText.trim()}
            >
              {testApi.isLoading ? "Sending…" : "Send test"}
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
