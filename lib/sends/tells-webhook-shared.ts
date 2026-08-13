// Shared helpers for the Tells.co webhook routes (Phase 3). Mirrors
// lib/sends/textrequest-webhook-shared.ts, with three Tells-specific additions
// that are load-bearing rather than stylistic: the `Key` redaction (§4.6), the
// dedup-key builders (§4.2), and the anti-spam shape discriminator (§4.3).
//
// The verified payload contract is spec §5.1 — NOT §2, which is the pre-probe
// claim and is wrong in eight places.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import type { DbOrTx } from "@/lib/sends/textrequest-dlr";
import { provider_credentials, sms_providers } from "@/db/schema";

export interface TellsWebhookCredential {
  id: number;
  org_id: string;
  provider_id: number;
}

// Resolve a webhook path token to (org, provider, credential), scoped to the
// Tells provider ONLY. `inbound_webhook_token` is a shared column across
// providers, so a token belonging to a different provider must NOT
// authenticate here — it is treated exactly like an unknown token (null ⇒ the
// caller returns 401). Same rule as resolveTextrequestCredential.
export async function resolveTellsCredential(
  dbc: DbOrTx,
  token: string,
): Promise<TellsWebhookCredential | null> {
  const rows = await dbc
    .select({
      id: provider_credentials.id,
      org_id: provider_credentials.org_id,
      provider_id: provider_credentials.provider_id,
    })
    .from(provider_credentials)
    .innerJoin(
      sms_providers,
      and(
        eq(sms_providers.id, provider_credentials.provider_id),
        eq(sms_providers.org_id, provider_credentials.org_id),
      ),
    )
    .where(
      and(
        eq(provider_credentials.inbound_webhook_token, token),
        eq(sms_providers.sms_provider_id, "tls"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function headersToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function queryToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// ===========================================================================
// §4.6 — the `Key` redaction carve-out. HARD REQUIREMENT, not polish.
// ===========================================================================
// The INBOUND webhook body carries the FULL LIVE TELLS API KEY in its `Key`
// field — not a webhook secret, the actual sending credential (§5.1). Capturing
// it verbatim would replicate a live credential into every database backup and
// any future export, which breaches CLAUDE.md §11 outright.
//
// The rule: capture stays byte-for-byte verbatim EXCEPT this one field, whose
// value is replaced with a fixed marker before the row is persisted.
export const TELLS_KEY_REDACTION_MARKER = "[REDACTED]";

// Surgical: rewrites ONLY the `Key` value, leaving every other field, and the
// key's own position in the object, untouched. Operates on the parsed object
// and re-serializes, because a regex over raw JSON cannot safely handle escapes.
//
// If the body does not parse, we CANNOT prove the key isn't in there — so the
// unparseable case returns null and the caller stores null rather than risking
// a plaintext credential. Losing an unparseable body's bytes is strictly better
// than persisting a live key; the extracted columns and the alert still carry
// the event.
export function redactTellsKeyFromBody(rawBody: string | null): string | null {
  if (rawBody === null || rawBody === "") return rawBody;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null; // fail closed — see above
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Not an object ⇒ no `Key` field to leak, safe to keep verbatim.
    return rawBody;
  }
  const obj = parsed as Record<string, unknown>;
  // Case-insensitive sweep: the contract says `Key`, but a casing change on
  // their side must not silently reintroduce the credential.
  let touched = false;
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === "key") {
      obj[k] = TELLS_KEY_REDACTION_MARKER;
      touched = true;
    }
  }
  return touched ? JSON.stringify(obj) : rawBody;
}

// Read the `Key` value out of a parsed inbound body (pre-redaction), for the
// F1 auth check on the inbound route. Case-insensitive for the same reason.
export function readTellsKeyField(parsedBody: unknown): string | null {
  if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return null;
  const obj = parsedBody as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === "key") {
      const v = obj[k];
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

// Constant-time-ish comparison so the inbound Key check can't be probed by
// timing. Lengths differing short-circuits, which is fine — the length of an
// API key is not the secret.
export function safeEqual(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ===========================================================================
// §4.2 — dedup keys
// ===========================================================================
// DLR: (Id, Status). ⚠️ `Date` is DELIBERATELY EXCLUDED — it is the delivery-
// ATTEMPT timestamp and advances on every retry (verified across 4 redeliveries
// in Phase 0), so including it would book each retry as a separate event.
export function tellsDlrDedupKey(id: string | null, status: string | null): string | null {
  if (!id || !status) return null;
  return `dlr:${id}:${status.toLowerCase()}`;
}

// Inbound: there is no `Id` on an inbound payload, so the key must be composite.
// `Date` IS included here (per spec §4.2) because without it two genuinely
// separate STOPs from the same number with the same text would collapse into
// one. See the note in lib/sends/tells-optout.ts: because we cannot prove
// Tells's inbound `Date` is retry-stable, the opt-out path carries its OWN
// window guard rather than trusting this index alone.
export function tellsInboundDedupKey(
  from: string | null,
  to: string | null,
  body: string | null,
  date: string | null,
): string | null {
  if (!from || !to) return null;
  const bodyHash = createHash("sha256").update(body ?? "").digest("hex");
  return `in:${from}:${to}:${bodyHash}:${date ?? ""}`;
}

// ===========================================================================
// §4.4 — guarded extraction
// ===========================================================================
// Roughly eight strings, inside a try/catch that yields NULLs on any failure.
// This is ADDRESSING, not processing: dedup_key needs it and the sweeper's
// index needs it. `raw_body` remains the source of truth, so a JSON.parse that
// degrades to NULL cannot lose an event.
//
// ⚠️ Id/To/From arrive as JSON NUMBERS on the webhooks but as STRINGS on the
// send response (§5.1) — everything is coerced to text here so correlation
// against stage_sends.texthub_message_id can actually match.
export interface TellsExtracted {
  providerMessageId: string | null;
  status: string | null;
  errorMessage: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  body: string | null;
  metadataRaw: string | null;
  providerDate: string | null;
  providerTimezone: string | null;
}

const EMPTY_EXTRACT: TellsExtracted = {
  providerMessageId: null, status: null, errorMessage: null,
  fromNumber: null, toNumber: null, body: null, metadataRaw: null,
  providerDate: null, providerTimezone: null,
};

function asText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function extractTellsFields(parsedBody: unknown): TellsExtracted {
  try {
    if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return EMPTY_EXTRACT;
    }
    const o = parsedBody as Record<string, unknown>;
    return {
      providerMessageId: asText(o.Id),
      status: asText(o.Status),
      errorMessage: asText(o.ErrorMessage),
      fromNumber: asText(o.From),
      toNumber: asText(o.To),
      body: asText(o.Body),
      // ⚠️ LOWERCASE `metadata` — the only lowercase field on an otherwise
      // PascalCase DLR, and it carries stage_send_id. Reading `Metadata` would
      // return undefined on EVERY callback and silently break all correlation.
      // The `?? o.Metadata` fallback is defensive only, in case they ever fix
      // the casing; the lowercase form is what the probe observed.
      metadataRaw: asText(o.metadata) ?? asText(o.Metadata),
      providerDate: asText(o.Date),
      providerTimezone: asText(o.Timezone),
    };
  } catch {
    return EMPTY_EXTRACT;
  }
}

// `metadata` always comes back as a STRING even when an object was sent, so the
// stage_send_id must be JSON.parsed out of it — inside a try/catch, because a
// malformed value must degrade to "no correlation handle", never throw.
export function readStageSendIdFromMetadata(metadataRaw: string | null): string | null {
  if (!metadataRaw) return null;
  try {
    const parsed = JSON.parse(metadataRaw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const v = (parsed as Record<string, unknown>).stage_send_id;
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// §4.3 — anti-spam shape discriminator
// ===========================================================================
// The loud alert on a failed token resolution fires ONLY when the body parses
// as JSON AND carries a Tells-shaped field set. A scanner does not send
// well-formed Tells DLR JSON. Anything else gets a silent 401 + console.warn.
export function looksLikeTellsPayload(parsedBody: unknown, kind: "dlr" | "inbound"): boolean {
  if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return false;
  const o = parsedBody as Record<string, unknown>;
  if (kind === "dlr") return o.Id !== undefined && o.Status !== undefined;
  return o.From !== undefined && o.Body !== undefined;
}

// ===========================================================================
// Capture — the single committed INSERT (§4.1 step 3)
// ===========================================================================
export interface CaptureTellsEventOpts {
  orgId: string;
  credentialId: number | null;
  providerId: number | null;
  kind: "dlr" | "inbound";
  method: string;
  query: Record<string, string> | null;
  headers: Record<string, string> | null;
  // MUST already be Key-redacted by the caller for inbound (§4.6).
  rawBody: string | null;
  extracted: TellsExtracted;
  dedupKey: string | null;
  receivedAt?: Date;
}

export type CaptureTellsResult =
  | { kind: "inserted"; id: string }
  | { kind: "duplicate" };

// ON CONFLICT DO UPDATE bumps ONLY duplicate_count/last_duplicate_at — never
// processed_at, result, or any matched_* column, so a redelivery can never
// reset processing state. DO UPDATE (not DO NOTHING) because we need to know a
// duplicate happened; DO NOTHING would return no row and be indistinguishable
// from a failure. "An INSERT that can fail is an event that can be lost."
export async function captureTellsWebhookEvent(
  dbc: DbOrTx,
  o: CaptureTellsEventOpts,
): Promise<CaptureTellsResult> {
  const receivedIso = (o.receivedAt ?? new Date()).toISOString();
  const rows = (await dbc.execute(sql`
    INSERT INTO tells_webhook_events
      (org_id, credential_id, provider_id, kind, received_at, method, query, headers, raw_body,
       provider_message_id, status, error_message, from_number, to_number, body, metadata_raw,
       provider_date, provider_timezone, dedup_key)
    VALUES (
      ${o.orgId}, ${o.credentialId}, ${o.providerId}, ${o.kind}, ${receivedIso}::timestamptz,
      ${o.method}, ${o.query ? JSON.stringify(o.query) : null}::jsonb,
      ${o.headers ? JSON.stringify(o.headers) : null}::jsonb, ${o.rawBody},
      ${o.extracted.providerMessageId}, ${o.extracted.status}, ${o.extracted.errorMessage},
      ${o.extracted.fromNumber}, ${o.extracted.toNumber}, ${o.extracted.body},
      ${o.extracted.metadataRaw}, ${o.extracted.providerDate}, ${o.extracted.providerTimezone},
      ${o.dedupKey}
    )
    ON CONFLICT (provider_id, dedup_key) WHERE dedup_key IS NOT NULL
    DO UPDATE SET duplicate_count = tells_webhook_events.duplicate_count + 1,
                  last_duplicate_at = now()
    RETURNING id, (xmax = 0) AS inserted
  `)) as unknown as { id: string; inserted: boolean }[];

  const row = rows[0];
  if (!row) {
    // Should be unreachable — DO UPDATE always returns a row. Treat as a hard
    // failure so the caller 500s and alerts rather than acking a lost event.
    throw new Error("tells capture: INSERT returned no row");
  }
  return row.inserted ? { kind: "inserted", id: row.id } : { kind: "duplicate" };
}
