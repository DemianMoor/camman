import type { Metadata } from "next";

import { LifecycleSettings } from "@/components/settings/lifecycle-settings";

export const metadata: Metadata = { title: "Lifecycle Settings" };

export default function LifecycleSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Lifecycle</h1>
        <p className="text-sm text-muted-foreground">
          The thresholds that decide each contact&apos;s status. A change takes effect on the
          next status run, never instantly — preview it first.
        </p>
      </header>
      <LifecycleSettings />
    </div>
  );
}
