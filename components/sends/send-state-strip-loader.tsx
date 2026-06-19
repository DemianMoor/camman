import { getSendState } from "@/lib/sends/send-state";
import { SendStateStrip } from "@/components/sends/send-state-strip";

// Server component: computes the send-state snapshot for the already-resolved
// org and hands it to the (client) strip as `initial`, so the strip renders
// with real data on first paint and never fires its own /api/sends/state fetch
// (which would re-run a full auth round-trip). Wrapped in <Suspense> by the
// protected layout, so these queries stream in and never block the page shell.
export async function SendStateStripLoader({ orgId }: { orgId: string }) {
  const s = await getSendState(orgId);
  return (
    <SendStateStrip
      initial={{
        sends_enabled: s.sends_enabled,
        env_enabled: s.env_enabled,
        effective_on: s.effective_on,
        paused_providers: s.paused_providers.map((p) => ({
          id: p.id,
          name: p.name,
          reason: p.reason,
        })),
        stuck_count: s.stuck_count,
      }}
    />
  );
}
