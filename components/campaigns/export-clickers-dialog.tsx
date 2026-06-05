"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type StageOption = {
  id: number;
  stage_number: number;
  label: string | null;
  status: string;
};

const ALL_STAGES = "all";

// "Export clickers" control for tracked campaigns: the contacts who actually
// clicked a tracked campaign's links (clicks → links → contacts), distinct
// from the manual clicker CSV import. Defaults to verified-humans-only (the
// endpoint's `clean` mode); "all clicks" is a deliberate opt-in. Optionally
// scopes to a single non-archived stage.
export function ExportClickersDialog({
  campaignId,
  stages,
}: {
  campaignId: number;
  stages: StageOption[];
}) {
  const [open, setOpen] = useState(false);
  // Default ON ⇒ clean: the easy path is verified-humans-only.
  const [humansOnly, setHumansOnly] = useState(true);
  const [stageId, setStageId] = useState<string>(ALL_STAGES);

  const stageOptions = stages
    .filter((s) => s.status !== "archived")
    .sort((a, b) => a.stage_number - b.stage_number);

  function download() {
    const params = new URLSearchParams();
    params.set("include", humansOnly ? "clean" : "all");
    if (stageId !== ALL_STAGES) params.set("stage_id", stageId);
    window.open(
      `/api/campaigns/${campaignId}/export-clickers?${params.toString()}`,
      "_blank",
      "noopener",
    );
    setOpen(false);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Export the contacts who clicked this tracked campaign's links"
      >
        <Download className="size-4" aria-hidden /> Export clickers
      </Button>

      <FormDialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>Export clickers</DialogTitle>
          <DialogDescription>
            Contacts who clicked this campaign&apos;s tracked links, as a CSV.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="clickers-humans-only">Verified humans only</Label>
              <p className="text-xs text-muted-foreground">
                {humansOnly
                  ? "Excludes bot, prefetch, suspect, and unscored clicks."
                  : "Includes every click, regardless of classification."}
              </p>
            </div>
            <Switch
              id="clickers-humans-only"
              checked={humansOnly}
              onCheckedChange={setHumansOnly}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="clickers-stage">Stage</Label>
            <Select value={stageId} onValueChange={setStageId}>
              <SelectTrigger id="clickers-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STAGES}>All stages</SelectItem>
                {stageOptions.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    Stage {s.stage_number}
                    {s.label ? ` — ${s.label}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={download}>
            <Download className="size-4" aria-hidden /> Download CSV
          </Button>
        </DialogFooter>
      </FormDialog>
    </>
  );
}
