"use client";

import { useState, type KeyboardEvent } from "react";
import { Copy, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { exampleLead } from "@/lib/intake/api-contract";
import { PASSTHROUGH_LIMITS, passthroughNamesError } from "@/lib/intake/passthrough";

// The "Passthrough fields" section of a partner key card: the whitelist of extra
// per-lead field names the key keeps verbatim (partner_keys.passthrough_fields),
// plus a read-only block to paste into the partner's integration instructions.
// Saves through the key PATCH route; the parent reloads the list afterwards.

/** The partner-facing text: field names, limits in words, and an example lead. */
function partnerInstructions(names: string[]): string {
  const example: Record<string, string> = { ...exampleLead() };
  for (const n of names) example[n] = "example";
  const { maxValueLength, maxTotalBytes } = PASSTHROUGH_LIMITS;
  return [
    "Extra fields to send with each lead:",
    ...names.map((n) => `  - ${n}`),
    "",
    `Each value is a string, number or boolean of at most ${maxValueLength} characters; all extra fields together must stay under ${maxTotalBytes} bytes.`,
    "Field names are matched case-insensitively. A value that is too long, or too many bytes, is dropped and the lead is still accepted (the response lists a warning).",
    "Any other field you send is ignored.",
    "",
    "Example lead:",
    JSON.stringify(example, null, 2),
  ].join("\n");
}

export function PartnerKeyPassthrough({
  keyId,
  saved,
  canManage,
  onChanged,
}: {
  keyId: number;
  saved: string[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const api = useApiCall<unknown>();
  const [names, setNames] = useState<string[]>(saved);
  const [draft, setDraft] = useState("");

  const error = passthroughNamesError(names);
  const dirty = names.join("\n") !== saved.join("\n");

  const add = () => {
    const parts = draft
      .split(/[,\s]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    setNames((cur) => [...cur, ...parts.filter((p, i) => parts.indexOf(p) === i && !cur.includes(p))]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && draft === "" && names.length > 0) {
      setNames((cur) => cur.slice(0, -1));
    }
  };

  const save = async () => {
    const r = await api.execute(`/api/partner-keys/${keyId}`, {
      method: "PATCH",
      body: JSON.stringify({ passthrough_fields: names }),
    });
    if (!r.ok) return toastApiError(r);
    toast.success("Passthrough fields saved");
    onChanged();
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={`passthrough-${keyId}`} className="text-xs font-medium">
          Passthrough fields
        </Label>
        <span className="text-muted-foreground text-xs">
          {names.length} / {PASSTHROUGH_LIMITS.maxFields}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {names.map((n) => (
          <span
            key={n}
            className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs"
          >
            {n}
            {canManage && (
              <button
                type="button"
                aria-label={`Remove ${n}`}
                className="hover:text-destructive"
                onClick={() => setNames((cur) => cur.filter((x) => x !== n))}
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {names.length === 0 && !canManage && (
          <span className="text-muted-foreground text-xs">None</span>
        )}
        {canManage && (
          <Input
            id={`passthrough-${keyId}`}
            className="h-8 w-48"
            placeholder="Add a field name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={add}
            disabled={api.isLoading}
          />
        )}
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      {canManage && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={api.isLoading || !dirty || error !== null}
            onClick={() => void save()}
          >
            Save fields
          </Button>
          {dirty && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setNames(saved)}>
              Reset
            </Button>
          )}
        </div>
      )}

      {saved.length > 0 && !dirty && (
        <div className="space-y-1">
          <Label className="text-xs font-medium">Copy partner instructions</Label>
          <pre className="bg-muted max-h-64 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {partnerInstructions(saved)}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(partnerInstructions(saved))
                .then(() => toast.success("Partner instructions copied"));
            }}
          >
            <Copy className="mr-1 size-4" /> Copy
          </Button>
        </div>
      )}
    </div>
  );
}
