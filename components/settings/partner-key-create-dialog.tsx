"use client";

import { useState } from "react";

import { SecretOnceDialog } from "@/components/settings/partner-key-card";
import { Button } from "@/components/ui/button";
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
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import type { PartnerJson } from "@/lib/partners/queries";

// "New key" for ONE partner (0200). There is no slug field: the key's slug is
// copied from the partner server-side, so two keys of one partner share it.
// The secret is shown exactly once, right after creation (SecretOnceDialog).
export function PartnerKeyCreateDialog({
  partner,
  onOpenChange,
  onCreated,
}: {
  /** The partner the key is created under; null = dialog closed. */
  partner: PartnerJson | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const api = useApiCall<{ id: number; token: string; secret: string }>();
  const [name, setName] = useState("");
  const [tagMode, setTagMode] = useState<"force" | "default">("default");
  const [tag, setTag] = useState("");
  const [created, setCreated] = useState<{ token: string; secret: string } | null>(null);

  const reset = () => {
    setName("");
    setTag("");
    setTagMode("default");
  };

  const create = async () => {
    if (!partner) return;
    const r = await api.execute("/api/partner-keys", {
      method: "POST",
      body: JSON.stringify({
        partner_id: partner.id,
        name: name.trim(),
        interest_tag_mode: tagMode,
        interest_tag: tag.trim() || null,
      }),
    });
    if (!r.ok) return toastApiError(r);
    onOpenChange(false);
    reset();
    setCreated({ token: r.data.token, secret: r.data.secret });
    onCreated();
  };

  return (
    <>
      <FormDialog
        open={partner !== null}
        onOpenChange={(o) => {
          if (!o) reset();
          onOpenChange(o);
        }}
      >
        <DialogHeader>
          <DialogTitle>New key for {partner?.name}</DialogTitle>
          <DialogDescription>
            Slug <code>{partner?.slug}</code> (from the partner). The secret is shown once,
            immediately after creation. New keys start in sandbox.
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
              placeholder="Main feed"
            />
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
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                // Same path as dismissing the dialog: the next partner's dialog
                // must not inherit this one's typed values.
                reset();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!name.trim() || (tagMode === "force" && !tag.trim()) || api.isLoading}
              onClick={() => void create()}
            >
              Create key
            </Button>
          </div>
        </div>
      </FormDialog>

      <SecretOnceDialog shown={created} onClose={() => setCreated(null)} />
    </>
  );
}
