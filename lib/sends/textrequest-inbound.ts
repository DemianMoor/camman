// Pure parsers for Text Request's ACCOUNT webhook payloads (Phase 4).
//
// Three events matter to CamMan, and they are shaped inconsistently by Text
// Request itself — which is why each gets its own parser instead of one generic
// reader (confirmed against their OpenAPI spec, recon 2026-07-25):
//
//   msg_received       nested + camelCase:
//                      { messageUniqueIdentifier, account:{…},
//                        yourPhoneNumber:{ id, phoneNumber, … },
//                        conversation:{ consumerPhoneNumber, message,
//                                       messageDirection, date, numSegments, … } }
//   contact_updated    flat + snake_case:
//                      { phone_number, is_suppressed, is_blocked,
//                        suppressed_reason, opted_out_utc, … }
//   msg_status_updated { message_id, status, errorCode } — the SAME shape as the
//                      per-message status_callback, so Phase 3a's
//                      parseTxrStatusCallback handles it as-is.
//
// None of the payloads carries the event NAME, so the receiving route resolves
// the event from the `?e=` hint it registered the hook with, falling back to
// shape detection (see classifyTxrWebhookPayload).

export type TxrWebhookKind = "msg" | "contact" | "status" | "unknown";

export interface TxrMsgReceivedPayload {
  messageUuid: string | null;
  contactPhone: string | null;
  dashboardPhone: string | null;
  message: string | null;
  // 'R' = from the contact (inbound), 'S' = from the dashboard (outbound).
  direction: string | null;
  timestamp: string | null;
  segments: number | null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

export function parseTxrMsgReceived(body: unknown): TxrMsgReceivedPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const conv = (b.conversation ?? null) as Record<string, unknown> | null;
  const dash = (b.yourPhoneNumber ?? null) as Record<string, unknown> | null;
  const messageUuid = str(b.messageUniqueIdentifier);
  if (!messageUuid && !conv) return null;
  return {
    messageUuid,
    contactPhone: conv ? str(conv.consumerPhoneNumber) : null,
    dashboardPhone: dash ? str(dash.phoneNumber) : null,
    message: conv ? str(conv.message) : null,
    direction: conv ? str(conv.messageDirection) : null,
    timestamp: conv ? str(conv.date) : null,
    segments: conv && typeof conv.numSegments === "number" ? conv.numSegments : null,
  };
}

export interface TxrContactUpdatedPayload {
  contactPhone: string | null;
  optedOutUtc: string | null;
  isSuppressed: boolean | null;
  isBlocked: boolean | null;
  suppressedReason: string | null;
}

export function parseTxrContactUpdated(body: unknown): TxrContactUpdatedPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!("phone_number" in b)) return null;
  return {
    contactPhone: str(b.phone_number),
    optedOutUtc: str(b.opted_out_utc),
    isSuppressed: typeof b.is_suppressed === "boolean" ? b.is_suppressed : null,
    isBlocked: typeof b.is_blocked === "boolean" ? b.is_blocked : null,
    suppressedReason: str(b.suppressed_reason),
  };
}

// Does a contact_updated payload assert that we must stop texting this number?
//
// `opted_out_utc` is the recipient's own STOP (carrier-level opt-out) and
// `is_suppressed` is a manual "do not text" set in the Text Request portal.
// BOTH must suppress: the operator's intent is as binding as the carrier's.
// `is_blocked` deliberately does NOT count — blocking is Text Request's
// spam/abuse control over inbound traffic, not a messaging-consent signal.
export function contactUpdateIsOptOut(p: TxrContactUpdatedPayload): boolean {
  return !!p.optedOutUtc || p.isSuppressed === true;
}

// Resolve which event a payload represents. Prefers the `?e=` hint (we register
// each hook with its own URL, so the hint is normally present and exact) and
// falls back to shape detection, because a hook created by hand in the Text
// Request portal won't carry the hint.
export function classifyTxrWebhookPayload(hint: string | null, body: unknown): TxrWebhookKind {
  const h = (hint ?? "").trim().toLowerCase();
  if (h === "msg_received" || h === "msg_sent") return "msg";
  if (h === "contact_updated" || h === "contact_created") return "contact";
  if (h === "msg_status_updated") return "status";

  if (!body || typeof body !== "object") return "unknown";
  const b = body as Record<string, unknown>;
  if ("messageUniqueIdentifier" in b || "conversation" in b) return "msg";
  if ("phone_number" in b) return "contact";
  if ("message_id" in b && "status" in b) return "status";
  return "unknown";
}
