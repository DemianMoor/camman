import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
import { countSentSince, resolve24hCap } from "@/lib/sends/circuit-breakers";

// The operating layer's "send state" snapshot, computed for one org. Shared by
// GET /api/sends/state (the endpoint other consumers — e.g. /sends/today — read)
// and the server-rendered <SendStateStrip> in the protected layout, so the strip
// hydrates from the server without a client round-trip + redundant auth.
//
// org-scoped by the orgId argument; the caller is responsible for authenticating
// and authorizing (campaigns.view) before calling. Never emits credentials.
export async function getSendState(orgId: string) {
  // Global master switch (org_settings.sends_enabled) + deploy backstop.
  const settingRows = (await db.execute(sql`
    SELECT sends_enabled FROM org_settings WHERE org_id = ${orgId} LIMIT 1
  `)) as unknown as { sends_enabled: boolean }[];
  const sendsEnabled = settingRows[0]?.sends_enabled === true;
  const envEnabled = process.env.SEND_ENABLED === "true";

  // Providers — capability + breaker state + caps + send window. API-capable,
  // non-archived only (those are the ones that can actually send).
  const providers = await db
    .select({
      id: sms_providers.id,
      name: sms_providers.name,
      color: sms_providers.color,
      supports_api_send: sms_providers.supports_api_send,
      send_paused: sms_providers.send_paused,
      send_paused_reason: sms_providers.send_paused_reason,
      send_paused_at: sms_providers.send_paused_at,
      max_sends_per_24h: sms_providers.max_sends_per_24h,
      max_sends_per_run: sms_providers.max_sends_per_run,
      send_window_weekday_start: sms_providers.send_window_weekday_start,
      send_window_weekday_end: sms_providers.send_window_weekday_end,
      send_window_weekend_start: sms_providers.send_window_weekend_start,
      send_window_weekend_end: sms_providers.send_window_weekend_end,
    })
    .from(sms_providers)
    .where(
      and(
        eq(sms_providers.org_id, orgId),
        eq(sms_providers.supports_api_send, true),
        ne(sms_providers.status, "archived"),
      ),
    );

  // Org-wide sent in the trailing 24h (matches breaker accounting) + the
  // aggregate effective 24h cap across API providers. Null cap ⇒ no API
  // provider configured, so there's nothing to meter against.
  const sent24h = await countSentSince(db, orgId, 86400);
  const cap24h =
    providers.length > 0
      ? providers.reduce((sum, p) => sum + resolve24hCap(p.max_sends_per_24h), 0)
      : null;

  // Stage_sends stranded in 'sending' (process died mid-send; never auto-retried).
  const stuckRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${orgId} AND status = 'sending'
  `)) as unknown as { n: number }[];
  const stuckCount = Number(stuckRows[0]?.n ?? 0);

  return {
    sends_enabled: sendsEnabled,
    env_enabled: envEnabled,
    effective_on: sendsEnabled && envEnabled,
    providers: providers.map((p) => ({
      ...p,
      max_sends_per_24h_effective: resolve24hCap(p.max_sends_per_24h),
    })),
    paused_providers: providers
      .filter((p) => p.send_paused)
      .map((p) => ({
        id: p.id,
        name: p.name,
        reason: p.send_paused_reason,
        at: p.send_paused_at,
      })),
    today: { sent_24h: sent24h, cap_24h: cap24h },
    stuck_count: stuckCount,
  };
}

export type SendStateSnapshot = Awaited<ReturnType<typeof getSendState>>;
