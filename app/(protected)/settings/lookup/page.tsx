import type { Metadata } from "next";

import { LookupAdmin } from "@/components/settings/lookup-admin";

export const metadata: Metadata = { title: "Carrier Lookup" };

export default function LookupSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Carrier lookup
        </h1>
        <p className="text-sm text-muted-foreground">
          Backfill carrier + line-type data, tune the lookup worker, review
          batches, and resolve unmapped carriers.
        </p>
      </header>

      <LookupAdmin />
    </div>
  );
}
