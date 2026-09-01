import { getSendState } from "@/lib/sends/send-state";
import { loadAliasTable, redactForRole } from "@/lib/authz/redact";
import type { Role } from "@/lib/permissions";
import { SendStateStrip } from "@/components/sends/send-state-strip";

// Server component: computes the send-state snapshot for the already-resolved
// org and hands it to the (client) strip as `initial`, so the strip renders
// with real data on first paint and never fires its own /api/sends/state fetch
// (which would re-run a full auth round-trip). Wrapped in <Suspense> by the
// protected layout, so these queries stream in and never block the page shell.
// ⚠️ THIS IS A SERVER COMPONENT, SO IT BYPASSES THE API RESPONSE BOUNDARY.
//
// redactForRole() normally runs in lib/authz/redact.ts on the way out of an API
// route. Nothing here goes through an API route: the protected layout renders
// this directly, on EVERY page, and `paused_providers` carries
// sms_providers.name. Without the explicit redaction below, an operator would
// have seen real provider names in the header of every screen in the app —
// while every API response was dutifully aliased.
//
// The lesson generalises: "one layer at the response boundary" only covers what
// actually crosses that boundary. Server components have to opt in by hand, and
// scripts/verify-operator-access.ts checks rendered PAGES for provider names for
// exactly this reason, not just JSON bodies.
export async function SendStateStripLoader({
  orgId,
  role,
}: {
  orgId: string;
  role: Role;
}) {
  const s = await getSendState(orgId);
  const pausedProviders = s.paused_providers.map((p) => ({
    id: p.id,
    name: p.name,
    reason: p.reason,
  }));
  const redacted =
    role === "operator"
      ? redactForRole(role, pausedProviders, await loadAliasTable(orgId))
      : pausedProviders;

  return (
    <SendStateStrip
      initial={{
        sends_enabled: s.sends_enabled,
        env_enabled: s.env_enabled,
        effective_on: s.effective_on,
        paused_providers: redacted,
        stuck_count: s.stuck_count,
      }}
    />
  );
}
