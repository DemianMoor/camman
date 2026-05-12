"use client";

import { ArrowLeft, Send } from "lucide-react";
import Link from "next/link";

// Placeholder for the campaign detail page. The list page navigates here on
// row-click, and the full detail UI (stages, audience pool inspection,
// status transitions inline) ships in 7.2c. The stub keeps the navigation
// flow intact in the meantime.
export default function CampaignDetailPlaceholder() {
  return (
    <div className="space-y-4">
      <Link
        href="/campaigns"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" aria-hidden /> All campaigns
      </Link>
      <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-24 text-center">
        <Send className="size-12 text-muted-foreground/40" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-medium">Campaign detail coming in 7.2c</p>
          <p className="text-sm text-muted-foreground">
            Stage management, audience inspection, and inline status changes
            land in the next sub-step.
          </p>
        </div>
      </div>
    </div>
  );
}
