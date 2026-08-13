import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { optOutBreakerAlertText } from "@/lib/sends/optout-rate-breaker";
import { resolveCredentialKeyById } from "@/lib/sends/provider-credential";
import { processTellsOptOut } from "@/lib/sends/tells-optout";
import {
  captureTellsWebhookEvent,
  extractTellsFields,
  headersToObject,
  looksLikeTellsPayload,
  queryToObject,
  readTellsKeyField,
  redactTellsKeyFromBody,
  resolveTellsCredential,
  safeEqual,
  tellsInboundDedupKey,
} from "@/lib/sends/tells-webhook-shared";

// Public Tells.co inbound-message (reply / STOP) receiver.
//
// AUTH PER F1: path token AND `Key` validation. Unlike the DLR webhook, the
// inbound payload DOES carry a `Key` field — and Phase 0 established that it is
// the FULL LIVE API KEY, not a separate webhook secret (§5.1). So it doubles as
// a second auth factor: it is compared against the stored credential before the
// event is processed.
//
// ⚠️ §4.6 — THE KEY REDACTION IS A HARD REQUIREMENT. That same field must NEVER
// be persisted. `redactTellsKeyFromBody` replaces its value with a fixed marker
// before the row is written, so a live sending credential is not replicated into
// every database backup and export (CLAUDE.md §11). Validate, then redact, then
// persist — in that order, and the raw value never leaves this function.
//
// force-dynamic: every callback must run and be recorded, never cached.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  let rawBody: string | null = null;
  try {
    rawBody = await req.text();
  } catch {
    rawBody = null;
  }
  let parsed: unknown = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }

  const cred = await resolveTellsCredential(db, token);
  if (!cred) {
    // §4.3 — alert only on a Tells-shaped payload; silent 401 otherwise.
    // NOTE: the alert body is REDACTED too. An unresolved token still means a
    // real inbound STOP may have been lost, but a Telegram message is not a
    // place to paste a live API key either.
    if (looksLikeTellsPayload(parsed, "inbound")) {
      const safeBody = redactTellsKeyFromBody(rawBody) ?? "[unparseable body withheld]";
      console.error(
        `[tells-inbound] UNRESOLVED TOKEN with a Tells-shaped payload — STOP may be LOST. ` +
          `token_prefix=${token.slice(0, 6)} body=${safeBody}`,
      );
      void notifyTelegram(
        `🚨 Tells INBOUND webhook: token did not resolve — a STOP may have been LOST.\n` +
          `This is the compliance-critical path.\n` +
          `token_prefix=<code>${token.slice(0, 6)}</code>\n` +
          `<pre>${safeBody.slice(0, 800)}</pre>`,
      ).catch(() => {});
    } else {
      console.warn(`[tells-inbound] unresolved token, non-Tells-shaped body (likely a scanner)`);
    }
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // ---- F1 second factor: validate `Key` against the stored credential ----
  // A mismatch is NOT treated as a capture failure — it is an auth failure, so
  // nothing is persisted and nothing is processed. Resolution failure of the
  // stored key itself (missing/undecryptable) is treated the same way: we
  // cannot authenticate, so we refuse rather than process an unverified STOP.
  const suppliedKey = readTellsKeyField(parsed);
  const storedKey = await resolveCredentialKeyById(db, {
    orgId: cred.org_id,
    credentialId: cred.id,
  });
  if (!storedKey || !safeEqual(suppliedKey, storedKey)) {
    console.error(
      `[tells-inbound] KEY VALIDATION FAILED — token resolved but the payload Key did not match ` +
        `the stored credential (org=${cred.org_id} credential=${cred.id}). Refusing.`,
    );
    void notifyTelegram(
      `🚨 Tells INBOUND webhook: path token resolved but the payload <code>Key</code> did NOT ` +
        `match the stored credential (credential ${cred.id}). Refused — a STOP may have been lost. ` +
        `Check whether the Tells API key was rotated without updating CamMan.`,
    ).catch(() => {});
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // ---- §4.6: redact BEFORE persist. Non-negotiable. ----
  const redactedBody = redactTellsKeyFromBody(rawBody);
  const extracted = extractTellsFields(parsed);
  const dedupKey = tellsInboundDedupKey(
    extracted.fromNumber,
    extracted.toNumber,
    extracted.body,
    extracted.providerDate,
  );

  // ---- step 3: the single committed INSERT ----
  let captured;
  try {
    captured = await captureTellsWebhookEvent(db, {
      orgId: cred.org_id,
      credentialId: cred.id,
      providerId: cred.provider_id,
      kind: "inbound",
      method: req.method,
      query: queryToObject(req),
      headers: headersToObject(req),
      rawBody: redactedBody, // ← never the raw one
      extracted,
      dedupKey,
    });
  } catch (err) {
    console.error(`[tells-inbound] CAPTURE FAILED — STOP may be LOST.`, err);
    void notifyTelegram(
      `🚨 Tells INBOUND capture INSERT failed — a STOP may have been LOST. ` +
        `from=${extracted.fromNumber ?? "?"} body=${JSON.stringify(extracted.body ?? "").slice(0, 200)}`,
    ).catch(() => {});
    return new NextResponse("Capture failed", { status: 500 });
  }

  if (captured.kind === "duplicate") {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ---- step 4: best-effort inline suppression. Cannot fail the request. ----
  try {
    const outcome = await processTellsOptOut(db, {
      eventId: captured.id,
      orgId: cred.org_id,
      fromNumber: extracted.fromNumber,
      body: extracted.body,
      receivedAt: new Date(),
    });
    if (outcome.kind === "suppressed" && outcome.breakerTrip) {
      // Post-commit, like every other intake path.
      void notifyTelegram(
        optOutBreakerAlertText(outcome.breakerTrip.campaignId, null, outcome.breakerTrip.result),
      ).catch(() => {});
    }
  } catch (err) {
    // Row is committed with processed_at NULL ⇒ the sweeper retries it. This is
    // the design: the STOP is already durably ours, so we never needed their ack.
    console.error(`[tells-inbound] inline suppression failed (sweeper will retry) event=${captured.id}`, err);
  }

  return NextResponse.json({ ok: true });
}
