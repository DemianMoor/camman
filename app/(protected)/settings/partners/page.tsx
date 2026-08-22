import type { Metadata } from "next";

import { PartnerKeys } from "@/components/settings/partner-keys";

export const metadata: Metadata = { title: "Partner Intake Keys" };

export default function PartnerKeysSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Partner intake keys</h1>
        <p className="text-muted-foreground text-sm">
          Credentials partners use to post leads into CamMan. Leads land in the inbox raw —
          nothing is looked up, contacted, or sent at intake. New keys start in{" "}
          <span className="font-medium">sandbox</span>: their leads are stored and flagged, and
          are excluded from sending and reporting until you switch the key live.
        </p>
      </header>

      <PartnerKeys />
    </div>
  );
}
