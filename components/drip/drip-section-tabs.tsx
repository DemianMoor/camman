"use client";

import { useEffect, useState } from "react";

import { DripConfigPanel } from "@/components/campaigns/drip-config-panel";
import { DripDailyResults } from "@/components/drip/daily-results";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiCall } from "@/lib/hooks/use-api-call";

// The drip campaign's settings section. With org_settings.drip_daily_results_enabled
// off (migration 0208) it renders the settings panel exactly as before; on, it
// adds a "Daily results" tab beside it.
export function DripSectionTabs({ campaignId, canEdit }: { campaignId: number; canEdit: boolean }) {
  const probe = useApiCall<{ enabled: boolean }>();
  const execute = probe.execute;
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    execute(`/api/campaigns/${campaignId}/daily-results?probe=1`).then((r) => {
      if (!cancelled && r.ok) setEnabled(r.data.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId, execute]);

  if (!enabled) return <DripConfigPanel campaignId={campaignId} canEdit={canEdit} />;
  return (
    <Tabs defaultValue="settings">
      <TabsList>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="daily">Daily results</TabsTrigger>
      </TabsList>
      <TabsContent value="settings" className="pt-2">
        <DripConfigPanel campaignId={campaignId} canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="daily" className="pt-2">
        <DripDailyResults campaignId={campaignId} />
      </TabsContent>
    </Tabs>
  );
}
