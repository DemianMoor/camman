// Failure classification for a single send attempt (Workstream 3, Guarantee 3).
//
// Responsibility boundary: everything up to and including TextHub's response
// envelope is OURS to get right; everything after is theirs. This classifier
// reads the normalized send result and buckets each attempt so failures read as
// "mine to fix" vs "theirs to explain" vs "genuinely unknown."
//
// Structural rule (brief): an outcome we can't confidently call a success is
// NEVER counted as sent — it lands in `indeterminate` for a human to reconcile.
// (Pre-flight config errors — no_credential, no_short_domain, … — never produce
// an attempt at all; they're refused at kickoff/drain before any HTTP call, so
// they are not a send_attempts classification.)

export type AttemptClassification =
  | "accepted" // TextHub returned a success envelope with a message id — theirs, OK
  | "mine_transport" // request never connected (DNS/refused) — ours
  | "theirs_rejected" // TextHub returned a rejection envelope (HTTP response) — theirs
  | "indeterminate"; // unknown if it landed (timeout after send, no id, unparseable) — reconcile

export type ClassificationOwner = "none" | "us" | "texthub" | "manual";

// Who has to act on this bucket. `accepted` ⇒ nobody (it worked).
export function classificationOwner(c: AttemptClassification): ClassificationOwner {
  switch (c) {
    case "accepted":
      return "none";
    case "mine_transport":
      return "us";
    case "theirs_rejected":
      return "texthub";
    case "indeterminate":
      return "manual";
  }
}

// Input mirrors the normalized SendSmsResult shape (status 0 = no HTTP response;
// timedOut distinguishes an abort — which may have landed — from a connection
// failure that never reached them).
export interface AttemptClassifyInput {
  ok: boolean;
  status: number;
  messageId: string | null;
  timedOut?: boolean;
}

export function classifyAttempt(r: AttemptClassifyInput): AttemptClassification {
  if (r.ok) {
    // 2xx WITH a message id is the only confident success. A 2xx with no id is
    // ambiguous — we can't prove it landed, so it is NOT counted as sent.
    return r.messageId ? "accepted" : "indeterminate";
  }
  if (r.status === 0) {
    // No HTTP envelope came back. A timeout might have landed (request sent,
    // response lost) ⇒ indeterminate. A connection failure never reached them
    // ⇒ ours (transport).
    return r.timedOut ? "indeterminate" : "mine_transport";
  }
  // We received an HTTP response with a non-2xx status: TextHub (or their edge)
  // returned a rejection envelope. Past the boundary ⇒ theirs to explain.
  return "theirs_rejected";
}
