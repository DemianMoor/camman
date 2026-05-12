import { Send } from "lucide-react";

// Placeholder page for Step 7.2a. The campaigns API is live but the list +
// detail UI ship in Step 7.2b. We render a stub here so clicking the
// sidebar nav item doesn't 404.
export default function CampaignsPlaceholderPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-24 text-center">
      <Send className="size-12 text-muted-foreground/40" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">Campaigns UI coming in 7.2b</p>
        <p className="text-sm text-muted-foreground">
          The schema and API are live. The list page, builder, and stage
          dashboard are next.
        </p>
      </div>
    </div>
  );
}
