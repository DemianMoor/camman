import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { reconcileTellsDlrEvent } from "@/lib/sends/tells-dlr";
import {
  captureTellsWebhookEvent,
  extractTellsFields,
  headersToObject,
  looksLikeTellsPayload,
  queryToObject,
  readStageSendIdFromMetadata,
  resolveTellsCredential,
  tellsDlrDedupKey,
} from "@/lib/sends/tells-webhook-shared";

// Public Tells.co delivery-status (DLR) receiver.
//
// AUTH PER F1: the path token ONLY. Tells sends NO `Key` on the status webhook
// (verified in Phase 0 — §5.1 corrects §2 on exactly this point), and an IP
// allowlist is not viable: DLRs arrive from three different AWS ranges and the
// User-Agent is inconsistent (`TellsWebhookProcessor/2.0 (+1844…)`, sometimes
// without the `+`). So the unguessable token in the URL is the auth gate, same
// posture as Ahoi and Text Request.
//
// PERSIST-FIRST (§4.1): resolve → guarded extraction → ONE committed INSERT →
// best-effort inline reconcile → 200. Nothing is allowed to precede the INSERT,
// and the inline step can never fail the request. A cron sweeper drains
// anything the inline attempt missed.
//
// force-dynamic: every callback must run and be recorded, never cached.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  // Read the body ONCE, as text, before anything else — it is the evidence.
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
    // §4.3: reject, and alert ONLY when the payload is Tells-shaped. A scanner
    // does not send well-formed Tells DLR JSON. Two copies (console + Telegram)
    // so a Telegram outage is not total loss — this alert is the event's last
    // copy, because there is no reconciliation API to recover it from.
    if (looksLikeTellsPayload(parsed, "dlr")) {
      console.error(
        `[tells-dlr] UNRESOLVED TOKEN with a Tells-shaped payload — event lost. ` +
          `token_prefix=${token.slice(0, 6)} body=${rawBody}`,
      );
      void notifyTelegram(
        `🚨 Tells DLR webhook: token did not resolve, event LOST.\n` +
          `Likely a credential rotation or a deleted credential.\n` +
          `token_prefix=<code>${token.slice(0, 6)}</code>\n` +
          `<pre>${(rawBody ?? "").slice(0, 800)}</pre>`,
      ).catch(() => {});
    } else {
      console.warn(`[tells-dlr] unresolved token, non-Tells-shaped body (likely a scanner)`);
    }
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const extracted = extractTellsFields(parsed);
  // ⚠️ Dedup on (Id, Status) — NEVER include `Date`. It is the delivery-ATTEMPT
  // timestamp and advances on every retry, so including it would book each of
  // Tells's 4 retries as a separate event.
  const dedupKey = tellsDlrDedupKey(extracted.providerMessageId, extracted.status);

  // ---- step 3: the single committed INSERT. Never ack what was not stored. ----
  let captured;
  try {
    captured = await captureTellsWebhookEvent(db, {
      orgId: cred.org_id,
      credentialId: cred.id,
      providerId: cred.provider_id,
      kind: "dlr",
      method: req.method,
      query: queryToObject(req),
      headers: headersToObject(req),
      // No redaction needed here: the DLR body carries no `Key` (§5.1). Only
      // the INBOUND payload does.
      rawBody,
      extracted,
      dedupKey,
    });
  } catch (err) {
    console.error(`[tells-dlr] CAPTURE FAILED — event lost. body=${rawBody}`, err);
    void notifyTelegram(
      `🚨 Tells DLR capture INSERT failed — event LOST.\n<pre>${(rawBody ?? "").slice(0, 800)}</pre>`,
    ).catch(() => {});
    return new NextResponse("Capture failed", { status: 500 });
  }

  if (captured.kind === "duplicate") {
    // Diagnostic only, never an alert (§4.2). duplicate_count was bumped; no
    // processing state was touched.
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ---- step 4: best-effort inline processing. Cannot fail the request. ----
  try {
    await reconcileTellsDlrEvent(db, {
      eventId: captured.id,
      orgId: cred.org_id,
      stageSendId: readStageSendIdFromMetadata(extracted.metadataRaw),
      providerMessageId: extracted.providerMessageId,
    });
  } catch (err) {
    // The row is already committed and processed_at stays NULL, so the sweeper
    // will retry it. Swallowing here is the design, not an oversight.
    console.error(`[tells-dlr] inline reconcile failed (sweeper will retry) event=${captured.id}`, err);
  }

  return NextResponse.json({ ok: true });
}
