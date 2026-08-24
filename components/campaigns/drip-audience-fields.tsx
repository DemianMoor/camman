"use client";

import { useEffect, useState } from "react";

import { MultiSelectPicker } from "@/components/multi-select-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { AGE_BANDS, bandLabel, GENDERS, INCOME_BANDS } from "@/lib/drip/demographics";

// The drip campaign's audience, as ONE field block (Drip UI review).
//
// ⚠️ WHY THIS IS SHARED. It renders in the campaign editor (where a drip
// campaign is created) and in the campaign page's drip panel (where it is
// edited). Two copies of the same form drift, and the one an operator hits
// second silently disagrees with the routing rules. There is one definition.
//
// ⚠️ A DRIP CAMPAIGN HAS NO CONTACT GROUPS AND NO SEGMENTS. Its audience is not
// a set chosen up front; it is leads arriving and being routed. The caller hides
// the regular audience controls entirely rather than disabling them — a greyed
// "Contact groups (required)" on a campaign type that can never have one reads
// as a blocked form, which is exactly the report that produced this change.

const NONE = "__none__";

export interface DripAudienceValue {
  interest_tag: string;
  partner_key_id: number | null;
  start_at: string;
  end_at: string;
  daily_cap: string;
  campaign_cap: string;
  routing_daily_admission_cap: string;
  priority: string;
  filters: Record<string, unknown>;
}

export const EMPTY_DRIP_AUDIENCE: DripAudienceValue = {
  interest_tag: "",
  partner_key_id: null,
  start_at: "",
  end_at: "",
  daily_cap: "",
  campaign_cap: "",
  routing_daily_admission_cap: "",
  priority: "100",
  filters: {},
};

type PartnerKey = { id: number; partner_slug: string; name: string; status: string };

export function DripAudienceFields({
  value,
  onChange,
  disabled,
}: {
  value: DripAudienceValue;
  onChange: (v: DripAudienceValue) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof DripAudienceValue>(k: K, v: DripAudienceValue[K]) =>
    onChange({ ...value, [k]: v });
  const setFilter = (k: string, v: unknown) => {
    const next = { ...value.filters };
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) delete next[k];
    else next[k] = v;
    onChange({ ...value, filters: next });
  };

  // useApiCall returns only { isLoading, execute } — the result comes back from
  // the call, so the list is held here rather than read off the hook.
  const [partnerKeys, setPartnerKeys] = useState<PartnerKey[]>([]);
  const keysApi = useApiCall<{ data: PartnerKey[] }>();
  const loadKeys = keysApi.execute;
  useEffect(() => {
    (async () => {
      const r = await loadKeys("/api/partner-keys");
      if (r.ok) setPartnerKeys(r.data.data);
    })();
  }, [loadKeys]);

  const arr = (k: string) => (Array.isArray(value.filters[k]) ? (value.filters[k] as string[]) : []);

  return (
    <div className="grid gap-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <Label htmlFor="drip-tag">
            Interest tag<span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Input
            id="drip-tag"
            value={value.interest_tag}
            onChange={(e) => set("interest_tag", e.target.value)}
            placeholder="e.g. medicare"
            disabled={disabled}
          />
          <p className="text-muted-foreground mt-1 text-xs">
            A lead is routed here only when its tag matches exactly.
          </p>
        </div>

        <div className="min-w-0">
          <Label htmlFor="drip-partner">Partner</Label>
          <Select
            value={value.partner_key_id == null ? NONE : String(value.partner_key_id)}
            onValueChange={(v) => set("partner_key_id", v === NONE ? null : Number(v))}
            disabled={disabled}
          >
            <SelectTrigger id="drip-partner" className="w-full">
              <SelectValue placeholder="Any partner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Any partner</SelectItem>
              {partnerKeys
                .filter((k: PartnerKey) => k.status === "active")
                .map((k: PartnerKey) => (
                  <SelectItem key={k.id} value={String(k.id)}>
                    {k.name} · {k.partner_slug}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground mt-1 text-xs">
            Leave as Any to accept this tag from every partner.
          </p>
        </div>

        <div className="min-w-0">
          <Label htmlFor="drip-start">Start</Label>
          <Input
            id="drip-start"
            type="datetime-local"
            value={value.start_at}
            onChange={(e) => set("start_at", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="drip-end">End</Label>
          <Input
            id="drip-end"
            type="datetime-local"
            value={value.end_at}
            onChange={(e) => set("end_at", e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>

      {/* ⚠️ THREE CAPS, THREE WINDOWS, NAMED APART ON PURPOSE. A journey routed
          at 23:50 ET sends the next day, so today's journeys are not today's
          sends. An operator who cannot tell "not routed, admission full" from
          "not sent, send cap full" cannot debug either. */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <Label htmlFor="drip-cap-lifetime" className="text-xs">
            Campaign cap
          </Label>
          <Input
            id="drip-cap-lifetime"
            value={value.campaign_cap}
            onChange={(e) => set("campaign_cap", e.target.value)}
            placeholder="unlimited"
            disabled={disabled}
          />
          <p className="text-muted-foreground mt-1 text-xs">Lifetime journeys.</p>
        </div>
        <div className="min-w-0">
          <Label htmlFor="drip-cap-admission" className="text-xs">
            Daily admission
          </Label>
          <Input
            id="drip-cap-admission"
            value={value.routing_daily_admission_cap}
            onChange={(e) => set("routing_daily_admission_cap", e.target.value)}
            placeholder="unlimited"
            disabled={disabled}
          />
          <p className="text-muted-foreground mt-1 text-xs">Journeys admitted per ET day.</p>
        </div>
        <div className="min-w-0">
          <Label htmlFor="drip-cap-daily" className="text-xs">
            Daily sends
          </Label>
          <Input
            id="drip-cap-daily"
            value={value.daily_cap}
            onChange={(e) => set("daily_cap", e.target.value)}
            placeholder="unlimited"
            disabled={disabled}
          />
          <p className="text-muted-foreground mt-1 text-xs">Messages sent per ET day.</p>
        </div>
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <Label htmlFor="drip-priority">Priority</Label>
          <Input
            id="drip-priority"
            value={value.priority}
            onChange={(e) => set("priority", e.target.value)}
            placeholder="100"
            disabled={disabled}
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Lower wins. Ties go to the most recently created campaign.
          </p>
        </div>
      </div>

      {/* Demographic filters — every one is skip-if-missing: a lead with no
          value for a filter still matches. */}
      <div className="grid min-w-0 gap-3">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Demographic filters
        </Label>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <Label className="text-xs">Gender</Label>
            <MultiSelectPicker
              options={GENDERS.map((g) => ({ id: g, label: g }))}
              value={arr("gender")}
              onChange={(v) => setFilter("gender", v.map(String))}
              placeholder="Any"
              disabled={disabled}
            />
          </div>
          <div className="min-w-0">
            <Label className="text-xs">Age band</Label>
            <MultiSelectPicker
              options={AGE_BANDS.map((a) => ({ id: a, label: bandLabel(a) }))}
              value={arr("age_band")}
              onChange={(v) => setFilter("age_band", v.map(String))}
              placeholder="Any"
              disabled={disabled}
            />
          </div>
          <div className="min-w-0">
            <Label className="text-xs">Income band</Label>
            <MultiSelectPicker
              options={INCOME_BANDS.map((i) => ({ id: i, label: bandLabel(i) }))}
              value={arr("income_band")}
              onChange={(v) => setFilter("income_band", v.map(String))}
              placeholder="Any"
              disabled={disabled}
            />
          </div>
          <div className="min-w-0">
            <Label htmlFor="drip-f-state" className="text-xs">
              States
            </Label>
            <Input
              id="drip-f-state"
              value={arr("state").join(", ")}
              onChange={(e) =>
                setFilter(
                  "state",
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
              placeholder="Any — e.g. TX, FL"
              disabled={disabled}
            />
          </div>
          <div className="min-w-0">
            <Label htmlFor="drip-f-country" className="text-xs">
              Countries
            </Label>
            <Input
              id="drip-f-country"
              value={arr("country").join(", ")}
              onChange={(e) =>
                setFilter(
                  "country",
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
              placeholder="Any — e.g. US"
              disabled={disabled}
            />
          </div>
          <div className="grid min-w-0 content-start gap-2 pt-5">
            {(["kids", "married"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs">
                <Switch
                  checked={value.filters[k] === true}
                  disabled={disabled}
                  onCheckedChange={(on) => setFilter(k, on ? true : undefined)}
                />
                <span className="capitalize">{k}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
