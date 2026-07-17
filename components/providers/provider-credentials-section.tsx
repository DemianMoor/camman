"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  KeyRound,
  Pencil,
  Plus,
  PlugZap,
  RotateCw,
  SendHorizonal,
  Trash2,
} from "lucide-react";
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
import {
  MultiSelectPicker,
  type MultiSelectOption,
} from "@/components/multi-select-picker";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Masked credential row from GET /api/providers/[id]/credentials — never the
// plaintext key. One row per account (Phase 3 multi-account: a provider can
// have several accounts, each with its own key + label + linked numbers).
type Cred = {
  id: number;
  brand_id: number | null;
  brand_name: string | null;
  label: string;
  last4: string;
  masked: string;
  linked_numbers: number;
  updated_at: string;
};
type Brand = { id: number; name: string };
// Only the fields this component needs from GET /api/providers/[id]/phones.
type Phone = {
  id: number;
  phone_number: string;
  credential_id: number | null;
  status: string;
};

const NONE_BRAND = "none";

// TextHub-family provider keys (txh + the second-account txh2 both reuse the
// TextHub adapter). The "Send test" action posts to a route that hardcodes
// TextHub's sendSms + the STOP-callback registers a TextHub callback, so both
// are only valid — and only shown — for these keys.
const TEXTHUB_KEYS = new Set(["txh", "txh2"]);
// SimpleTexting: the only provider with a non-sending connection check today.
const SIMPLETEXTING_KEY = "smpl";

function numberWord(n: number) {
  return `${n} number${n === 1 ? "" : "s"}`;
}

export function ProviderCredentialsSection({
  providerId,
  providerKey,
  canManage,
}: {
  providerId: number;
  providerKey: string;
  canManage: boolean;
}) {
  const isTextHub = TEXTHUB_KEYS.has(providerKey);
  const isSimpleTexting = providerKey === SIMPLETEXTING_KEY;
  const listApi = useApiCall<{ data: Cred[] }>();
  const brandsApi = useApiCall<{ data: Brand[] }>();
  const phonesApi = useApiCall<{ data: Phone[] }>();
  const saveApi = useApiCall<{ ok: boolean; id: number }>();
  const updateApi = useApiCall<unknown>();
  const deleteApi = useApiCall<unknown>();
  const { execute: listExec } = listApi;
  const { execute: brandsExec } = brandsApi;
  const { execute: phonesExec } = phonesApi;

  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [phones, setPhones] = useState<Phone[]>([]);
  // False until the phones fetch has resolved at least once. Both the Add
  // and Edit dialogs' numbers pickers stay disabled while this is false so a
  // dialog opened before the first fetch resolves can't be "touched" against
  // an incomplete/empty phones list (see the picker-disabling below).
  const [phonesLoaded, setPhonesLoaded] = useState(false);
  const [tick, setTick] = useState(0);

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

  // Provider's phones — populates the numbers picker in Add/Edit and lets us
  // flag a phone that's already linked to a DIFFERENT account. Refetched on
  // the same `tick` as credentials so a link/unlink via PATCH shows up.
  // Requests every status (including archived): the Edit dialog pre-selects
  // whichever phones are currently linked to the credential, and the PATCH
  // unlink sweep clears credential_id on ALL of a credential's phones,
  // archived included — if this list excluded archived phones, the picker
  // would silently drop them from the save and unlink them.
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await phonesExec(
        `/api/providers/${providerId}/phones?status=active,suspended,blocked,archived`,
      );
      // Only a successful fetch unblocks the picker — flipping this on
      // failure would unblock it against an incomplete/empty list, which is
      // the exact hazard this guard exists to prevent.
      if (active && r.ok) {
        setPhones(r.data.data);
        setPhonesLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [providerId, tick, phonesExec]);

  const credLabelById = useMemo(
    () => new Map((creds ?? []).map((c) => [c.id, c.label] as const)),
    [creds],
  );

  // Build the numbers picker's option list. `excludeCredentialId` is the
  // credential currently being edited (or null when adding) — a phone linked
  // to that same credential isn't "elsewhere", but a phone linked to any
  // other credential shows a "linked to <label>" hint (selecting it MOVES it).
  function phoneOptions(excludeCredentialId: number | null): MultiSelectOption[] {
    return phones.map((p) => {
      const other =
        p.credential_id !== null && p.credential_id !== excludeCredentialId
          ? credLabelById.get(p.credential_id)
          : undefined;
      const metaParts: string[] = [];
      if (other) metaParts.push(`linked to ${other}`);
      if (p.status === "archived") metaParts.push("archived");
      return {
        id: p.id,
        label: p.phone_number,
        meta: metaParts.length > 0 ? metaParts.join(" · ") : undefined,
      };
    });
  }

  // --- Add account dialog ---
  const [addOpen, setAddOpen] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addApiKey, setAddApiKey] = useState("");
  const [addBrandId, setAddBrandId] = useState<string>(NONE_BRAND);
  const [addPhoneIds, setAddPhoneIds] = useState<number[]>([]);

  function openAdd() {
    setAddOpen(true);
    setAddLabel("");
    setAddApiKey("");
    setAddBrandId(NONE_BRAND);
    setAddPhoneIds([]);
  }
  function closeAdd() {
    setAddOpen(false);
    setAddLabel("");
    setAddApiKey(""); // don't keep the secret in component state
    setAddBrandId(NONE_BRAND);
    setAddPhoneIds([]);
  }

  async function handleAdd() {
    if (!addLabel.trim() || !addApiKey.trim()) return;
    const brand_id = addBrandId === NONE_BRAND ? null : Number(addBrandId);
    const r = await saveApi.execute(`/api/providers/${providerId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: addLabel.trim(), api_key: addApiKey, brand_id }),
    });
    if (!r.ok) {
      // Surfaces the 409 numberless_stages_block_multi_account message (and
      // any other server error) verbatim via toastApiError's CONFLICT branch.
      toastApiError(r, "Couldn't add account");
      return;
    }

    // POST returns the new row's id — labels aren't unique, so the id is the
    // only safe way to address the account for the follow-up numbers link.
    let linkFailed = false;
    if (addPhoneIds.length > 0) {
      const linkResult = await updateApi.execute(
        `/api/providers/${providerId}/credentials/${r.data.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone_ids: addPhoneIds }),
        },
      );
      linkFailed = !linkResult.ok;
    }

    // Only one toast, ever — a partial failure (account created, link
    // failed) must not also claim full success.
    if (linkFailed) {
      toast.warning("Account created, but linking numbers failed — open Edit to link them");
    } else {
      toast.success("Account added");
    }
    closeAdd();
    setTick((n) => n + 1);
  }

  // --- Rotate key dialog ---
  const [rotating, setRotating] = useState<Cred | null>(null);
  const [rotateApiKey, setRotateApiKey] = useState("");

  function openRotate(c: Cred) {
    setRotating(c);
    setRotateApiKey("");
  }
  function closeRotate() {
    setRotating(null);
    setRotateApiKey("");
  }

  async function handleRotate() {
    if (!rotating || !rotateApiKey.trim()) return;
    const r = await updateApi.execute(
      `/api/providers/${providerId}/credentials/${rotating.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: rotateApiKey }),
      },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't rotate key");
      return;
    }
    toast.success("Key rotated");
    closeRotate();
    setTick((n) => n + 1);
  }

  // --- Edit account dialog ---
  const [editing, setEditing] = useState<Cred | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editBrandId, setEditBrandId] = useState<string>(NONE_BRAND);
  const [editPhoneIds, setEditPhoneIds] = useState<number[]>([]);
  const [editPhoneIdsTouched, setEditPhoneIdsTouched] = useState(false);

  function openEdit(c: Cred) {
    setEditing(c);
    setEditLabel(c.label);
    setEditBrandId(c.brand_id === null ? NONE_BRAND : String(c.brand_id));
    setEditPhoneIdsTouched(false);
    // editPhoneIds itself isn't set here — the picker's displayed value
    // (editPhoneIdsValue below) derives it live from `phones` while
    // untouched, so it's always the freshest snapshot rather than whatever
    // `phones` happened to hold at the moment Edit was opened.
  }
  function closeEdit() {
    setEditing(null);
    setEditPhoneIdsTouched(false);
  }

  // Derived selection for the Edit picker. While untouched, this always
  // mirrors the credential's currently-linked phones from the freshest
  // `phones` list — closing the race where opening Edit before the phones
  // fetch resolves would otherwise snapshot an empty/incomplete set as the
  // pre-selection. Once the operator touches the picker, editPhoneIdsTouched
  // flips true and this stops re-deriving, so it never clobbers their
  // in-progress edit.
  const editPhoneIdsValue = useMemo(() => {
    if (!editing || editPhoneIdsTouched) return editPhoneIds;
    return phones.filter((p) => p.credential_id === editing.id).map((p) => p.id);
  }, [editing, editPhoneIdsTouched, phones, editPhoneIds]);

  async function handleEditSave() {
    if (!editing || !editLabel.trim()) return;
    const patch: { label?: string; brand_id?: number | null; phone_ids?: number[] } = {};
    if (editLabel.trim() !== editing.label) patch.label = editLabel.trim();
    const brandId = editBrandId === NONE_BRAND ? null : Number(editBrandId);
    if (brandId !== editing.brand_id) patch.brand_id = brandId;
    // phone_ids is the COMPLETE desired set — send it whenever the picker was
    // touched, even if it round-trips to the same set (we can't cheaply tell
    // "touched but unchanged" from "matches on reload", and re-sending the
    // same set is a harmless no-op server-side).
    if (editPhoneIdsTouched) patch.phone_ids = editPhoneIdsValue;

    if (Object.keys(patch).length === 0) {
      closeEdit();
      return;
    }

    const r = await updateApi.execute(
      `/api/providers/${providerId}/credentials/${editing.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't save account");
      return;
    }
    toast.success("Account saved");
    closeEdit();
    setTick((n) => n + 1);
  }

  // --- Delete ---
  const [deleting, setDeleting] = useState<Cred | null>(null);

  async function handleDelete() {
    if (!deleting) return;
    const r = await deleteApi.execute(
      `/api/providers/${providerId}/credentials/${deleting.id}`,
      { method: "DELETE" },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't remove account");
      return;
    }
    toast.success("Account removed");
    setDeleting(null);
    setTick((n) => n + 1);
  }

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

  // Register opt-out (STOP) callback: points TextHub at our inbound webhook for
  // this key so STOPs are captured. Shows the raw TextHub response.
  const registerApi = useApiCall<{
    ok: boolean;
    callbackUrl: string;
    status: number;
    response: string | null;
    error: string | null;
  }>();
  const [registering, setRegistering] = useState<Cred | null>(null);
  const [registerResult, setRegisterResult] = useState<
    { ok: boolean; callbackUrl: string; status: number; response: string | null; error: string | null } | null
  >(null);

  function openRegister(c: Cred) {
    setRegistering(c);
    setRegisterResult(null);
  }

  async function handleRegister() {
    if (!registering) return;
    const r = await registerApi.execute(
      `/api/providers/${providerId}/credentials/${registering.id}/register-callback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't register the STOP callback");
      return;
    }
    setRegisterResult(r.data);
    if (r.data.ok) toast.success("Callback registered — now text STOP to capture the payload");
    else toast.error("TextHub didn't accept the registration");
  }

  // Check connection (SimpleTexting only): non-sending healthcheck that calls
  // SimpleTexting's GET /api/phones with the stored token to confirm it
  // authenticates and to list usable sender numbers. No SMS, no spend.
  const healthApi = useApiCall<{
    ok: boolean;
    status: number;
    numbers: string[];
    error: string | null;
  }>();
  const [checking, setChecking] = useState<Cred | null>(null);
  const [healthResult, setHealthResult] = useState<
    { ok: boolean; status: number; numbers: string[]; error: string | null } | null
  >(null);

  function openCheck(c: Cred) {
    setChecking(c);
    setHealthResult(null);
  }

  async function handleCheck() {
    if (!checking) return;
    const r = await healthApi.execute(
      `/api/providers/${providerId}/credentials/${checking.id}/healthcheck`,
    );
    if (!r.ok) {
      toastApiError(r, "Connection check failed");
      return;
    }
    setHealthResult(r.data);
    if (r.data.ok) toast.success("Connected — SimpleTexting accepted the token");
    else toast.error("SimpleTexting rejected the token");
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Accounts</h2>
          <p className="text-sm text-muted-foreground">
            Per-account API keys — key + sending numbers travel together.
          </p>
        </div>
        {canManage ? (
          <Button onClick={openAdd}>
            <Plus className="size-4" aria-hidden /> Add account
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          {creds === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : creds.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No accounts yet.{canManage ? " Add the first one." : ""}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Numbers</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                  {canManage ? <th className="px-4 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{c.label}</div>
                      {c.brand_name ? (
                        <div className="text-xs text-muted-foreground">{c.brand_name}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 font-mono">
                      <span className="inline-flex items-center gap-1.5">
                        <KeyRound className="size-3.5 opacity-50" aria-hidden />
                        {c.masked}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {numberWord(c.linked_numbers)}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(c.updated_at).toLocaleDateString()}
                    </td>
                    {canManage ? (
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-1">
                          {/* Send test is TextHub-only: the route hardcodes
                              TextHub's sendSms and would fire a real SMS via the
                              wrong provider for any other key. */}
                          {isTextHub ? (
                            <Button variant="ghost" size="sm" onClick={() => openTest(c)}>
                              <SendHorizonal className="size-4" aria-hidden /> Send test
                            </Button>
                          ) : null}
                          {isSimpleTexting ? (
                            <Button variant="ghost" size="sm" onClick={() => openCheck(c)}>
                              <PlugZap className="size-4" aria-hidden /> Check connection
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="sm" onClick={() => openRegister(c)}>
                            <Ban className="size-4" aria-hidden /> STOP callback
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                            <Pencil className="size-4" aria-hidden /> Edit
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openRotate(c)}>
                            <RotateCw className="size-4" aria-hidden /> Rotate
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove account"
                            onClick={() => setDeleting(c)}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Add account dialog */}
      <FormDialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) closeAdd();
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            The key is write-only — it&apos;s stored securely and never shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="add-cred-label">
              Label
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <Input
              id="add-cred-label"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="e.g. Main account"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="add-cred-key">
              API key
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <Input
              id="add-cred-key"
              type="password"
              autoComplete="off"
              value={addApiKey}
              onChange={(e) => setAddApiKey(e.target.value)}
              placeholder="Paste the TextHub api_key"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="add-cred-brand">
              Brand
            </label>
            <select
              id="add-cred-brand"
              value={addBrandId}
              onChange={(e) => setAddBrandId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value={NONE_BRAND}>None</option>
              {brands.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Numbers</label>
            <MultiSelectPicker
              options={phoneOptions(null)}
              value={addPhoneIds}
              onChange={(next) => setAddPhoneIds(next.map(Number))}
              isLoading={phonesApi.isLoading}
              disabled={!phonesLoaded}
              placeholder={phonesLoaded ? "No numbers linked" : "Loading numbers…"}
              selectedLabel={numberWord}
              emptyMessage="No numbers on this provider yet."
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={closeAdd}
              disabled={saveApi.isLoading || updateApi.isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleAdd()}
              disabled={
                saveApi.isLoading ||
                updateApi.isLoading ||
                !addLabel.trim() ||
                !addApiKey.trim()
              }
            >
              Add account
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* Rotate key dialog */}
      <FormDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) closeRotate();
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Rotate API key</DialogTitle>
          <DialogDescription>
            {rotating
              ? `Replace the key for ${rotating.label}. The old key is overwritten; never shown again.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="rotate-cred-key">
              New API key
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <Input
              id="rotate-cred-key"
              type="password"
              autoComplete="off"
              value={rotateApiKey}
              onChange={(e) => setRotateApiKey(e.target.value)}
              placeholder="Paste the new TextHub api_key"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeRotate} disabled={updateApi.isLoading}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRotate()}
              disabled={updateApi.isLoading || !rotateApiKey.trim()}
            >
              Rotate key
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* Edit account dialog */}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>{editing?.label ?? ""}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="edit-cred-label">
              Label
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </label>
            <Input
              id="edit-cred-label"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="edit-cred-brand">
              Brand
            </label>
            <select
              id="edit-cred-brand"
              value={editBrandId}
              onChange={(e) => setEditBrandId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value={NONE_BRAND}>None</option>
              {brands.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Numbers</label>
            <MultiSelectPicker
              options={editing ? phoneOptions(editing.id) : []}
              value={editPhoneIdsValue}
              onChange={(next) => {
                setEditPhoneIds(next.map(Number));
                setEditPhoneIdsTouched(true);
              }}
              isLoading={phonesApi.isLoading}
              disabled={!phonesLoaded}
              placeholder={phonesLoaded ? "No numbers linked" : "Loading numbers…"}
              selectedLabel={numberWord}
              emptyMessage="No numbers on this provider yet."
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeEdit} disabled={updateApi.isLoading}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleEditSave()}
              disabled={updateApi.isLoading || !editLabel.trim()}
            >
              Save changes
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
            Sends one real SMS using the &quot;{testing?.label ?? ""}&quot; account&apos;s key.
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

      {/* Register STOP callback dialog */}
      <FormDialog
        open={registering !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRegistering(null);
            setRegisterResult(null);
          }
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Register STOP callback</DialogTitle>
          <DialogDescription>
            Tells TextHub to deliver inbound STOP messages for the &quot;
            {registering?.label ?? ""}&quot; account&apos;s key to this app. One-time setup
            per key. After it succeeds, text STOP from your own phone to confirm what
            TextHub delivers.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {registerResult ? (
            <div
              className={
                "rounded-md border p-3 text-sm " +
                (registerResult.ok
                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
                  : "border-destructive/40 bg-destructive/5")
              }
            >
              <p className="font-medium">
                {registerResult.ok
                  ? "TextHub accepted the registration."
                  : `TextHub rejected it (HTTP ${registerResult.status}).`}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">Callback URL:</p>
              <p className="break-all font-mono text-xs">{registerResult.callbackUrl}</p>
              {registerResult.response ? (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">TextHub response:</p>
                  <p className="break-all font-mono text-xs">{registerResult.response}</p>
                </>
              ) : null}
              {registerResult.error ? (
                <p className="mt-2 break-all font-mono text-xs">{registerResult.error}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This calls TextHub once to register the callback. No SMS is sent.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRegistering(null);
                setRegisterResult(null);
              }}
              disabled={registerApi.isLoading}
            >
              Close
            </Button>
            <Button
              onClick={() => void handleRegister()}
              disabled={registerApi.isLoading}
            >
              {registerApi.isLoading
                ? "Registering…"
                : registerResult
                  ? "Re-register"
                  : "Register callback"}
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* Check connection dialog (SimpleTexting) */}
      <FormDialog
        open={checking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setChecking(null);
            setHealthResult(null);
          }
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Check connection</DialogTitle>
          <DialogDescription>
            Verifies the &quot;{checking?.label ?? ""}&quot; account&apos;s API token with
            SimpleTexting and lists its usable sending numbers. No SMS is sent.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {healthResult ? (
            <div
              className={
                "rounded-md border p-3 text-sm " +
                (healthResult.ok
                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
                  : "border-destructive/40 bg-destructive/5")
              }
            >
              {healthResult.ok ? (
                <>
                  <p className="font-medium">Connected — token accepted.</p>
                  {healthResult.numbers.length > 0 ? (
                    <>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Usable sending numbers:
                      </p>
                      <ul className="mt-1 font-mono text-xs">
                        {healthResult.numbers.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No sending numbers returned.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  SimpleTexting rejected it{healthResult.status ? ` (HTTP ${healthResult.status})` : ""}
                  : {healthResult.error ?? "unknown error"}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This calls SimpleTexting once to confirm the token works. No SMS is sent.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setChecking(null);
                setHealthResult(null);
              }}
              disabled={healthApi.isLoading}
            >
              Close
            </Button>
            <Button onClick={() => void handleCheck()} disabled={healthApi.isLoading}>
              {healthApi.isLoading
                ? "Checking…"
                : healthResult
                  ? "Check again"
                  : "Check connection"}
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
            <AlertDialogTitle>Remove this account?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? (() => {
                    const numbersClause =
                      deleting.linked_numbers > 0
                        ? ` and its ${numberWord(deleting.linked_numbers)} will be unlinked`
                        : "";
                    // Numberless/unlinked resolution only ever falls back
                    // when EXACTLY one account remains — mirrors
                    // resolveKeyForStage's fallback rule.
                    const remaining = (creds?.length ?? 1) - 1;
                    const fallbackClause =
                      remaining === 1
                        ? " With one account left on this provider, its unlinked or numberless sends will automatically use that account's key."
                        : " With no single surviving account, its unlinked or numberless sends will be refused until a number is re-linked.";
                    return `The "${deleting.label}" account will be removed${numbersClause}.${fallbackClause}`;
                  })()
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
