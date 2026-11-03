"use client";

import { useEffect, useState } from "react";
import { Copy, Download, FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { EventTypeOption } from "@/components/networks/conversion-mapping";
import { Button } from "@/components/ui/button";
import { CopyableId } from "@/components/ui/copyable-id";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  simulateConversion,
  type PostbackUrl,
  type SimulationResult,
  type SimulationRule,
} from "@/lib/conversions/postback-urls";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

// Per-network "Postback URLs" panel: one copyable Keitaro postback URL per
// event of the standard model, a SIMULATED test per event (the network's live
// rules run through resolveMapping in the browser — no Keitaro call, no ledger
// write), and the advertiser spec as text. Manager+ only; read-only.

type UrlsResponse =
  | { configured: true; urls: PostbackUrl[]; spec: string }
  | { configured: false; reason: string; urls: []; spec: null };

export function PostbackUrlsDialog({
  network,
  onOpenChange,
  eventTypes,
}: {
  network: { id: number; name: string; network_id: string } | null;
  onOpenChange: (open: boolean) => void;
  eventTypes: EventTypeOption[] | null;
}) {
  return (
    <Dialog open={network !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Postback URLs</DialogTitle>
          <DialogDescription>
            {network ? `${network.name} — ` : ""}give the advertiser one URL per
            event. They replace the {"{…}"} placeholders with their own macros.
          </DialogDescription>
        </DialogHeader>
        {network ? (
          <PostbackUrlsBody key={network.id} network={network} eventTypes={eventTypes ?? []} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PostbackUrlsBody({
  network,
  eventTypes,
}: {
  network: { id: number; name: string; network_id: string };
  eventTypes: EventTypeOption[];
}) {
  const { execute: fetchUrls } = useApiCall<UrlsResponse>();
  const { execute: fetchRules } = useApiCall<{ data: SimulationRule[] }>();
  const [data, setData] = useState<UrlsResponse | null>(null);
  const [rules, setRules] = useState<SimulationRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, SimulationResult>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [u, r] = await Promise.all([
        fetchUrls(`/api/networks/${network.id}/postback-urls`),
        fetchRules(`/api/networks/${network.id}/mappings`),
      ]);
      if (cancelled) return;
      if (!u.ok) return setError(u.error);
      if (!r.ok) return setError(r.error);
      setData(u.data);
      setRules(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchUrls, fetchRules, network.id]);

  if (error) {
    return <p className="text-sm text-destructive">Couldn&apos;t load postback URLs: {error}</p>;
  }
  if (!data || !rules) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (!data.configured) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Postback URLs are not configured: {data.reason}.
      </p>
    );
  }

  const spec = data.spec;
  async function copySpec() {
    try {
      await navigator.clipboard.writeText(spec);
      toast.success("Advertiser spec copied");
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }
  function downloadSpec() {
    const href = URL.createObjectURL(new Blob([spec], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = `postback-spec-${network.network_id}.txt`;
    a.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
      <ul className="space-y-4">
        {data.urls.map((u) => {
          const result = tested[u.keitaroType];
          return (
            <li key={u.keitaroType} className="space-y-1.5">
              <div className="flex items-end gap-2">
                <CopyableId
                  className="min-w-0 flex-1"
                  label={u.label}
                  value={u.url}
                  inputClassName="font-mono text-xs"
                  helperText={`Standard: ${u.countsAs}.`}
                  copiedMessage={`${u.label} URL copied`}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="mb-6 shrink-0"
                  onClick={() =>
                    setTested((t) => ({
                      ...t,
                      [u.keitaroType]: simulateConversion(network.id, u.keitaroType, rules, eventTypes),
                    }))
                  }
                >
                  <FlaskConical className="size-4" aria-hidden /> Test
                </Button>
              </div>
              {result ? (
                <p
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs",
                    result.kind === "unmapped"
                      ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      : "bg-muted/40",
                  )}
                >
                  <span className="font-medium">Simulated</span> (no conversion
                  sent): <span className="font-mono">{u.keitaroType}</span> →{" "}
                  {result.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Advertiser spec</p>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => void copySpec()}>
              <Copy className="size-4" aria-hidden /> Copy
            </Button>
            <Button variant="outline" size="sm" onClick={downloadSpec}>
              <Download className="size-4" aria-hidden /> Download .txt
            </Button>
          </div>
        </div>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
          {spec}
        </pre>
      </div>
    </div>
  );
}
