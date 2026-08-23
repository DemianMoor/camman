"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime, utcToCampaignLocalInput, campaignLocalInputToUtcIso }
  from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Drip campaign config + routed journeys (Drip Phase 4).
//
// ⚠️ THE THREE CAPS ARE LABELLED APART, and the labels are load-bearing. They
// are different windows over different things, and an operator who reads one as
// another will chase the wrong control:
//   Campaign cap   — LIFETIME journeys, enforced now at routing
//   Routing/day    — journeys admitted per ET day, enforced now at routing
//   Daily send cap — SENDS per ET day, NOT enforced yet (Phase 5)
// The UI says which are live and which is not, because a cap that silently does
// nothing is worse than no cap: it looks like protection.

type Config = {
  campaign_id: number;
  type: string;
  interest_tag: string | null;
  partner_key_id: number | null;
  start_at: string | null;
  end_at: string | null;
  daily_cap: number | null;
  campaign_cap: number | null;
  routing_daily_admission_cap: number | null;
  priority: number | null;
  journeys_total: number;
};

type Journey = {
  id: string;
  state: string;
  routed_at: string;
  campaign_id: number | null;
  phone_number: string | null;
  reason: Record<string, unknown>;
};

export function DripConfigPanel({ campaignId, canEdit }: { campaignId: number; canEdit: boolean }) {
  const cfgApi = useApiCall<Config>();
  const saveApi = useApiCall<unknown>();
  const journeysApi = useApiCall<{ data: Journey[] }>();

  const [cfg, setCfg] = useState<Config | null>(null);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [tick, setTick] = useState(0);

  const [tag, setTag] = useState("");
  const [priority, setPriority] = useState("100");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [campaignCap, setCampaignCap] = useState("");
  const [admissionCap, setAdmissionCap] = useState("");
  const [dailyCap, setDailyCap] = useState("");

  const loadCfg = cfgApi.execute;
  const loadJ = journeysApi.execute;

  useEffect(() => {
    (async () => {
      const r = await loadCfg(`/api/campaigns/${campaignId}/drip-config`);
      if (r.ok) {
        setCfg(r.data);
        setTag(r.data.interest_tag ?? "");
        setPriority(String(r.data.priority ?? 100));
        setStartAt(r.data.start_at ? utcToCampaignLocalInput(r.data.start_at) : "");
        setEndAt(r.data.end_at ? utcToCampaignLocalInput(r.data.end_at) : "");
        setCampaignCap(r.data.campaign_cap == null ? "" : String(r.data.campaign_cap));
        setAdmissionCap(
          r.data.routing_daily_admission_cap == null ? "" : String(r.data.routing_daily_admission_cap),
        );
        setDailyCap(r.data.daily_cap == null ? "" : String(r.data.daily_cap));
      }
    })();
  }, [loadCfg, campaignId, tick]);

  useEffect(() => {
    (async () => {
      const r = await loadJ(`/api/campaigns/${campaignId}/drip-journeys`);
      if (r.ok) setJourneys(r.data.data);
    })();
  }, [loadJ, campaignId, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  const save = async () => {
    const r = await saveApi.execute(`/api/campaigns/${campaignId}/drip-config`, {
      method: "PUT",
      body: JSON.stringify({
        interest_tag: tag.trim(),
        priority: Number(priority) || 100,
        start_at: startAt ? campaignLocalInputToUtcIso(startAt) : null,
        end_at: endAt ? campaignLocalInputToUtcIso(endAt) : null,
        campaign_cap: num(campaignCap),
        routing_daily_admission_cap: num(admissionCap),
        daily_cap: num(dailyCap),
      }),
    });
    if (!r.ok) return toastApiError(r);
    toast.success("Drip settings saved");
    reload();
  };

  if (cfgApi.isLoading && !cfg) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  }
  if (cfg && cfg.type !== "drip") {
    return <p className="text-muted-foreground text-sm">This is a regular campaign.</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="drip-tag">
                Interest tag<span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="drip-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="ACA"
                disabled={!canEdit}
              />
              <p className="text-muted-foreground mt-1 text-xs">
                Leads are routed to this campaign only when their tag matches exactly.
              </p>
            </div>
            <div>
              <Label htmlFor="drip-priority">Priority</Label>
              <Input
                id="drip-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                disabled={!canEdit}
              />
              <p className="text-muted-foreground mt-1 text-xs">
                Lower wins. Ties go to the most recently created campaign.
              </p>
            </div>
            <div>
              <Label htmlFor="drip-start">Start</Label>
              <Input
                id="drip-start"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                disabled={!canEdit}
              />
            </div>
            <div>
              <Label htmlFor="drip-end">End</Label>
              <Input
                id="drip-end"
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                disabled={!canEdit}
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Caps</p>
            <p className="text-muted-foreground text-xs">
              Three different limits over three different things. They are not interchangeable.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="cap-lifetime" className="text-xs">
                  Campaign cap <Badge variant="secondary">live</Badge>
                </Label>
                <Input
                  id="cap-lifetime"
                  value={campaignCap}
                  onChange={(e) => setCampaignCap(e.target.value)}
                  placeholder="unlimited"
                  disabled={!canEdit}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Total leads ever routed here.
                </p>
              </div>
              <div>
                <Label htmlFor="cap-admission" className="text-xs">
                  Routing per day <Badge variant="secondary">live</Badge>
                </Label>
                <Input
                  id="cap-admission"
                  value={admissionCap}
                  onChange={(e) => setAdmissionCap(e.target.value)}
                  placeholder="unlimited"
                  disabled={!canEdit}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Leads admitted per ET day.
                </p>
              </div>
              <div>
                <Label htmlFor="cap-daily" className="text-xs">
                  Daily send cap <Badge variant="outline">not yet enforced</Badge>
                </Label>
                <Input
                  id="cap-daily"
                  value={dailyCap}
                  onChange={(e) => setDailyCap(e.target.value)}
                  placeholder="unlimited"
                  disabled={!canEdit}
                />
                {/* ⚠️ Saying this plainly matters: a cap that silently does
                    nothing looks like protection. */}
                <p className="text-muted-foreground mt-1 text-xs">
                  Saved, but sends do not exist yet — enforced in the next phase.
                </p>
              </div>
            </div>
          </div>

          {canEdit && (
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={!tag.trim() || saveApi.isLoading}
            >
              <Save className="mr-1 size-4" /> Save drip settings
            </Button>
          )}
        </CardContent>
      </Card>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium">Routed leads</h3>
          <Badge variant="secondary">{cfg?.journeys_total ?? 0}</Badge>
        </div>
        {journeys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing routed yet. Leads are matched by the 1-minute routing worker once drip is
            switched on for the organization.
          </p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {journeys.map((j) => (
              <li key={j.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{j.phone_number ?? "—"}</span>
                  <Badge variant={j.state === "unroutable" ? "outline" : "secondary"}>{j.state}</Badge>
                  <span className="text-muted-foreground text-xs">
                    {formatCampaignDateTime(j.routed_at)}
                  </span>
                </div>
                {/* The stored reason, verbatim. It is the record of what was true
                    at routing time, which is often different from now. */}
                <pre className="text-muted-foreground overflow-x-auto rounded bg-muted p-2 text-[11px]">
                  {JSON.stringify(j.reason, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
