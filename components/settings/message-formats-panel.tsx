"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pencil, Plus, Star } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { NEW_ROW, assembleMessage, validateTemplate } from "@/lib/messages/format";

type FormatRow = {
  id: number;
  name: string;
  template: string;
  is_enabled: boolean;
  is_default: boolean;
  live_stage_count: number;
};

const BLOCKS = ["{brand}", "{creative_text}", "{url}", "{stop_text}", NEW_ROW] as const;

// A fixed sample so every format previews against the same message.
const SAMPLE = {
  brand: "Guide Kin",
  creative_text: "Your 2026 plan options are ready.",
  url: "https://gdkn.org/r/Ab3dE9x",
  stop_text: "Stop to END",
};

/** How a template reads on screen: <new_row> shown as a line break marker. */
function TemplateText({ template }: { template: string }) {
  return (
    <code className="whitespace-pre-wrap break-all text-xs">
      {template.split(NEW_ROW).join("⏎\n")}
    </code>
  );
}

// Message formats (0216): how brand, creative text, link and opt-out footer are
// assembled. Each stage picks one enabled format; exactly one is the default
// for new stages. Disabling a format live stages use is refused with a count.
export function MessageFormatsPanel() {
  const { can } = useAuth();
  const canManage = can("message_formats.manage");
  const listApi = useApiCall<{ data: FormatRow[] }>();
  const mutateApi = useApiCall<FormatRow>();
  const { execute: listExec } = listApi;

  const [rows, setRows] = useState<FormatRow[] | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<{ id: number | null; name: string; template: string } | null>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await listExec("/api/message-formats/list");
      if (active && r.ok) setRows(r.data.data);
    })();
    return () => {
      active = false;
    };
  }, [tick, listExec]);

  const refresh = () => setTick((t) => t + 1);

  const toggle = async (row: FormatRow, enabled: boolean) => {
    const r = await mutateApi.execute(`/api/message-formats/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_enabled: enabled }),
    });
    if (!r.ok) {
      toastApiError(r, `Couldn't ${enabled ? "enable" : "disable"} ${row.name}`);
      return;
    }
    toast.success(`${row.name} ${enabled ? "enabled" : "disabled"}`);
    refresh();
  };

  const makeDefault = async (row: FormatRow) => {
    const r = await mutateApi.execute(`/api/message-formats/${row.id}/make-default`, { method: "POST" });
    if (!r.ok) {
      toastApiError(r, `Couldn't make ${row.name} the default`);
      return;
    }
    toast.success(`${row.name} is now the default for new stages`);
    refresh();
  };

  const save = async () => {
    if (!editing) return;
    const body = JSON.stringify({ name: editing.name, template: editing.template });
    const r = editing.id == null
      ? await mutateApi.execute("/api/message-formats", { method: "POST", headers: { "Content-Type": "application/json" }, body })
      : await mutateApi.execute(`/api/message-formats/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
    if (!r.ok) {
      toastApiError(r, "Couldn't save the format");
      return;
    }
    toast.success(editing.id == null ? "Format created" : "Format saved — applies to messages rendered from now on");
    setEditing(null);
    refresh();
  };

  const insertBlock = (block: string) => {
    const el = templateRef.current;
    if (!el || !editing) return;
    el.setRangeText(block, el.selectionStart, el.selectionEnd, "end");
    setEditing({ ...editing, template: el.value });
    el.focus();
  };

  const error = editing ? validateTemplate(editing.template) : null;
  const preview = editing && !error ? assembleMessage(editing.template, SAMPLE) : "";

  if (rows === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading formats…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <Button size="sm" onClick={() => setEditing({ id: null, name: "", template: "" })}>
          <Plus className="mr-1 h-4 w-4" /> New format
        </Button>
      )}

      <div className="space-y-3">
        {rows.map((row) => (
          <Card key={row.id}>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  {row.is_default && <Badge>Default</Badge>}
                  {!row.is_enabled && <Badge variant="secondary">Disabled</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {row.live_stage_count} live stage{row.live_stage_count === 1 ? "" : "s"}
                  </span>
                </div>
                <TemplateText template={row.template} />
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-3">
                  {!row.is_default && row.is_enabled && (
                    <Button variant="outline" size="sm" onClick={() => makeDefault(row)}>
                      <Star className="mr-1 h-4 w-4" /> Make default
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing({ id: row.id, name: row.name, template: row.template })}
                  >
                    <Pencil className="mr-1 h-4 w-4" /> Edit
                  </Button>
                  <Switch
                    checked={row.is_enabled}
                    disabled={row.is_default}
                    onCheckedChange={(v) => toggle(row, v)}
                    aria-label={`${row.name} enabled`}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <FormDialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogHeader>
          <DialogTitle>{editing?.id == null ? "New format" : "Edit format"}</DialogTitle>
          <DialogDescription>
            Blocks: {"{brand}"}, {"{creative_text}"}, {"{url}"}, {"{stop_text}"}; {NEW_ROW} starts a new line.
            Everything else is sent as written. {"{creative_text}"}, {"{url}"} and {"{stop_text}"} are required.
            Edits apply to messages rendered from now on.
          </DialogDescription>
        </DialogHeader>
        {editing && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="mf-name">
                Name<span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <Input id="mf-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="mf-template">
                Template<span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <div className="mb-2 flex flex-wrap gap-1">
                {BLOCKS.map((b) => (
                  <Button key={b} type="button" variant="outline" size="sm" onClick={() => insertBlock(b)}>
                    {b}
                  </Button>
                ))}
              </div>
              <Textarea
                id="mf-template"
                ref={templateRef}
                rows={3}
                className="font-mono text-xs"
                value={editing.template}
                onChange={(e) => setEditing({ ...editing, template: e.target.value })}
              />
              {editing.template && error && (
                <p className="mt-1 text-xs text-destructive">
                  {error.code === "unknown_token" ? `${error.detail} is not a block.` : `Add ${error.detail}.`}
                </p>
              )}
            </div>
            {preview && (
              <div>
                <Label>Preview (sample message)</Label>
                <pre className="mt-1 whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs">{preview}</pre>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!editing?.name.trim() || !editing?.template || !!error || mutateApi.isLoading}>
            Save
          </Button>
        </DialogFooter>
      </FormDialog>
    </div>
  );
}
