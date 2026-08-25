import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials, provider_phones, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { appOrigin } from "@/lib/app-origin";
import { can } from "@/lib/permissions";
import { resolveCredentialKeyById } from "@/lib/sends/provider-credential";
import {
  listTxrHooks,
  registerTxrHook,
  TXR_REQUIRED_EVENTS,
  type TxrHookEvent,
} from "@/lib/sends/textrequest-hooks";

// POST — register this Text Request credential's ACCOUNT webhooks (Phase 4).
//
// Text Request has no "register everything" call: hooks are per dashboard, per
// event (POST /dashboards/{id}/hooks). This route registers the three events
// CamMan consumes (TXR_REQUIRED_EVENTS) on every ACTIVE txr sending number bound
// to this credential that has a dashboard_id, pointing each at
// /api/webhooks/textrequest/events/<token>?e=<event>.
//
// Deliberately OPERATOR-TRIGGERED, never automatic: it writes to the customer's
// Text Request account (creating subscriptions that push data at our
// production URL), so it belongs to the gated go-live step, not to a cron.
// Idempotent in practice — Text Request rejects a second hook with the same
// url+event, and we skip anything already registered before calling.
//
// Admin+ (provider_credentials.manage): it resolves and transmits the plaintext
// api key, same bar as the TextHub register-callback route it mirrors.
export const dynamic = "force-dynamic";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// The hook origin comes from NEXT_PUBLIC_SITE_URL and NOTHING ELSE.
//
// ⚠️ This deliberately does NOT read the request host. It used to prefer it, on
// the reasoning that an admin clicking Register is on a reachable origin — but
// the URL registered here is persisted by the PROVIDER and long outlives the
// request. Registering from a preview deployment pinned inbound delivery to a
// URL that later disappears, and now that CamMan answers on a partner-facing
// hostname too, it would silently move inbound traffic off the primary host.
// Both failures are invisible until messages stop arriving. Fail loudly instead.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; credentialId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_credentials.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId: pParam, credentialId: cParam } = await params;
  const providerId = parseId(pParam);
  const credentialId = parseId(cParam);
  if (providerId === null || credentialId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Provider must actually be Text Request — this route speaks TR's hooks API.
  const provider = await db
    .select({ id: sms_providers.id, key: sms_providers.sms_provider_id })
    .from(sms_providers)
    .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)))
    .limit(1);
  if (!provider[0]) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "sms_provider" });
  }
  if (provider[0].key !== "txr") {
    return apiError(400, "This endpoint only registers Text Request webhooks", API_ERROR_CODES.VALIDATION, {
      reason: "wrong_provider",
    });
  }

  const cred = await db
    .select({ id: provider_credentials.id, inbound_webhook_token: provider_credentials.inbound_webhook_token })
    .from(provider_credentials)
    .where(
      and(
        eq(provider_credentials.id, credentialId),
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
      ),
    )
    .limit(1);
  if (!cred[0]) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider_credential" });
  }

  const apiKey = await resolveCredentialKeyById(db, { orgId, credentialId });
  if (apiKey === null) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider_credential" });
  }

  const origin = appOrigin();
  if (!origin) {
    return apiError(
      500,
      "Server misconfiguration: NEXT_PUBLIC_SITE_URL is not set, so the inbound hook URL cannot be built. Set it to the primary production origin and redeploy — registration will not fall back to the request host.",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Which dashboards to register. Only ACTIVE numbers bound to THIS credential
  // and carrying a dashboard_id — the same resolution the polls use, so webhook
  // coverage and poll coverage can never disagree.
  const phones = await db
    .select({ phone_number: provider_phones.phone_number, dashboard_id: provider_phones.dashboard_id })
    .from(provider_phones)
    .where(
      and(
        eq(provider_phones.org_id, orgId),
        eq(provider_phones.provider_id, providerId),
        eq(provider_phones.credential_id, credentialId),
        eq(provider_phones.status, "active"),
      ),
    );
  const dashboards = [...new Set(phones.filter((p) => p.dashboard_id).map((p) => p.dashboard_id!))];
  if (dashboards.length === 0) {
    return apiError(
      400,
      "No active sending number on this credential has a Text Request dashboard id yet — set dashboard_id on the number first (Check connection lists the account's dashboards).",
      API_ERROR_CODES.VALIDATION,
      { reason: "no_dashboard_id" },
    );
  }

  // Mint the shared per-credential token on first use and reuse it thereafter,
  // so the webhook URLs (and anything already registered at Text Request) stay
  // put. The SAME token authenticates the status callback the drain threads at
  // send time — that path is a no-op until this token exists, which is why
  // registering is part of go-live rather than optional.
  let token = cred[0].inbound_webhook_token;
  const mintedToken = !token;
  if (!token) {
    token = randomBytes(32).toString("hex");
    await db
      .update(provider_credentials)
      .set({ inbound_webhook_token: token, updated_at: new Date() })
      .where(eq(provider_credentials.id, cred[0].id));
  }

  const results: {
    dashboard_id: string;
    event: TxrHookEvent;
    outcome: "registered" | "already_present" | "failed";
    hook_id?: number;
    error?: string;
  }[] = [];

  for (const dashboardId of dashboards) {
    // Read first so a re-run reports "already_present" instead of collecting
    // duplicate-url rejections from Text Request.
    const existing = await listTxrHooks(apiKey, dashboardId);
    for (const event of TXR_REQUIRED_EVENTS) {
      const targetUrl = `${origin}/api/webhooks/textrequest/events/${token}?e=${event}`;
      const already = existing.hooks.find((h) => h.event === event && h.target_url === targetUrl);
      if (already) {
        results.push({ dashboard_id: dashboardId, event, outcome: "already_present", hook_id: already.id });
        continue;
      }
      const reg = await registerTxrHook(apiKey, dashboardId, { targetUrl, event });
      results.push(
        reg.ok
          ? { dashboard_id: dashboardId, event, outcome: "registered", hook_id: reg.hook?.id }
          : { dashboard_id: dashboardId, event, outcome: "failed", error: reg.error ?? `HTTP ${reg.status}` },
      );
    }
  }

  const failed = results.filter((r) => r.outcome === "failed").length;
  return NextResponse.json({
    ok: failed === 0,
    minted_token: mintedToken,
    // The token itself is a credential-grade secret in a URL — report only that
    // one exists, never the value (the operator never needs to see it).
    dashboards,
    events: TXR_REQUIRED_EVENTS,
    results,
    registered: results.filter((r) => r.outcome === "registered").length,
    already_present: results.filter((r) => r.outcome === "already_present").length,
    failed,
  });
}
