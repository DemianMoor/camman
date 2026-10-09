import type { Metadata } from "next";
import Link from "next/link";
import { Handshake } from "lucide-react";

import { Partners } from "@/components/settings/partners";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Partners" };

export default function PartnersSettingsPage() {
  return (
    <div className="space-y-6">
      {/* Partners are managed here, so this is where an operator looks for the
          report built from them. Same outline-Button-to-its-report pattern the
          Segments list uses for /segments/charts. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Partners</h1>
          <p className="text-muted-foreground text-sm">
            Partners that send us leads. Each partner owns its intake keys, its signed report
            link and whether that report shows revenue. Leads land in the inbox raw — nothing is
            looked up, contacted, or sent at intake. New keys start in{" "}
            <span className="font-medium">sandbox</span>: their leads are stored and flagged, and
            are excluded from sending and reporting until you switch the key live.
          </p>
        </div>
        <Link href="/reports/partners">
          <Button variant="outline">
            <Handshake className="size-4" aria-hidden /> Partner report
          </Button>
        </Link>
      </header>

      <Partners />
    </div>
  );
}
