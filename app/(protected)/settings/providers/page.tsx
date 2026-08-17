import type { Metadata } from "next";

import { ProviderConnections } from "@/components/settings/provider-connections";

export const metadata: Metadata = { title: "Provider Settings" };

export default function ProviderSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Per-provider sending posture and connection details. Switching a provider off
          stops it originating new sends immediately — it never affects inbound STOP
          intake, which keeps running regardless.
        </p>
      </header>

      <ProviderConnections />
    </div>
  );
}
