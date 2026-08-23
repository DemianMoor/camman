import type { Metadata } from "next";

import { WhyNotRouted } from "@/components/drip/why-not-routed";

export const metadata: Metadata = { title: "Why not routed" };

export default function WhyNotRoutedPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Why wasn&apos;t this number routed?</h1>
        <p className="text-muted-foreground text-sm">
          Enter a phone number to see exactly what drip routing decides about it, rule by rule.
          This runs the same evaluator the routing worker runs, so it reports the real decision
          rather than a second opinion.
        </p>
      </header>
      <WhyNotRouted />
    </div>
  );
}
