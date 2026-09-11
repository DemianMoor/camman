import { getSendState } from "@/lib/sends/send-state";
import { SendStateStrip } from "@/components/sends/send-state-strip";

// Server component: computes the send-state snapshot for the already-resolved
// org and hands it to the (client) strip as `initial`, so the strip renders
// with real data on first paint and never fires its own /api/sends/state fetch
// (which would re-run a full auth round-trip). Wrapped in <Suspense> by the
// protected layout, so these queries stream in and never block the page shell.
// Provider names are shown to every role (owner decision, 2026-09-11): the
// registry name IS the display name, so there is nothing to alias. This
// component used to redact by hand because it is a SERVER component and so
// never crosses the API response boundary — that hand-rolled step is gone with
// the redactor itself.
export async function SendStateStripLoader({ orgId }: { orgId: string }) {
  const s = await getSendState(orgId);
  const pausedProviders = s.paused_providers.map((p) => ({
    id: p.id,
    name: p.name,
    reason: p.reason,
  }));

  return (
    <SendStateStrip
      initial={{
        sends_enabled: s.sends_enabled,
        env_enabled: s.env_enabled,
        effective_on: s.effective_on,
        paused_providers: pausedProviders,
        stuck_count: s.stuck_count,
      }}
    />
  );
}
