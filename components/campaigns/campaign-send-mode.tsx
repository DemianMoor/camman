"use client";

import Link from "next/link";
import { Link2, MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

// Per-campaign send method (campaigns.link_mode). "Manual Send" = the send path
// reads the operator-pasted Short URL on each stage. "API Send" = tracked; the
// send path mints a unique link per recipient at kickoff. Writes via PATCH
// /api/campaigns/[id] (which also guards tracked server-side). API Send is only
// selectable when the brand has an active short domain.
export function CampaignSendMode({
  campaignId,
  linkMode,
  brandName,
  brandShortDomain,
  canEdit,
  onChanged,
}: {
  campaignId: number;
  linkMode: "manual" | "tracked";
  brandName: string | null;
  brandShortDomain: string | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const api = useApiCall<{ link_mode?: string }>();
  const apiSendBlocked = !brandShortDomain;

  async function setMode(mode: "manual" | "tracked") {
    if (mode === linkMode || !canEdit) return;
    const r = await api.execute(`/api/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link_mode: mode }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't change send method");
      return;
    }
    toast.success(
      mode === "tracked" ? "Switched to API Send (tracked links)" : "Switched to Manual Send",
    );
    onChanged();
  }

  return (
    <section className="space-y-1.5">
      <div className="text-xs uppercase text-muted-foreground">Send method</div>
      <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Send method">
        <ModeButton
          active={linkMode === "manual"}
          disabled={!canEdit || api.isLoading}
          onClick={() => void setMode("manual")}
          icon={<MessageSquare className="size-4" aria-hidden />}
          label="Manual Send"
        />
        <ModeButton
          active={linkMode === "tracked"}
          disabled={!canEdit || api.isLoading || apiSendBlocked}
          onClick={() => void setMode("tracked")}
          icon={<Link2 className="size-4" aria-hidden />}
          label="API Send"
          title={
            apiSendBlocked
              ? `Add a short domain for ${brandName ?? "this brand"} first`
              : undefined
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {linkMode === "tracked"
          ? "Mints a unique tracked link per recipient at send time."
          : "Uses the operator-pasted Short URL on each stage."}
        {apiSendBlocked ? (
          <>
            {" "}
            API Send needs an active short domain —{" "}
            <Link href="/brands" className="underline">
              set one for {brandName ?? "this brand"}
            </Link>
            .
          </>
        ) : null}
      </p>
    </section>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled && !active}
      title={title}
      aria-pressed={active}
      className={cn(
        "gap-1.5",
        active ? "bg-foreground text-background hover:bg-foreground/90 hover:text-background" : "",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}
