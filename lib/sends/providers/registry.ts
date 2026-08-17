import type { SmsProviderAdapter } from "./types";
import { texthubAdapter } from "./texthub";
import { ahoiAdapter } from "./ahoi";
import { textrequestAdapter } from "./textrequest";
import { tellsAdapter } from "./tells";

export class UnknownProviderError extends Error {
  constructor(public readonly key: string) {
    super(`Unknown SMS provider key: ${key}`);
    this.name = "UnknownProviderError";
  }
}

const ADAPTERS: Record<string, SmsProviderAdapter> = {
  txh: texthubAdapter,
  // `txh2` is a second TextHub account modeled as its own provider row
  // ("Texthub - 621637", id 499) rather than a second credential on `txh`.
  // It talks to the same TextHub API, so it reuses the TextHub adapter — only
  // the resolved per-credential api_key differs.
  txh2: texthubAdapter,
  ahi: ahoiAdapter,
  // Text Request (Phase 1 skeleton). Registered so the drain's provider seam
  // and getAdapter() recognize the key; send() is a not-implemented stub and
  // the txr provider row keeps supports_api_send=false until Phase 2 go-live.
  // The key MUST equal the sms_providers.sms_provider_id value seeded by the
  // migration ('txr') — getAdapter throws UnknownProviderError otherwise.
  txr: textrequestAdapter,
  // Tells.co (Phase 1 skeleton, same posture as txr above). Key matches the
  // `tls` sms_providers row (id 855), which was created through the UI during
  // Phase 0 rather than by a migration. supports_api_send stays false until
  // Phase 5. Registering the key early also removes a footgun: before this,
  // flipping that flag made every Tells stage refuse with `unknown_provider`
  // only at drain time — after the campaign had already been activated and
  // scheduled. It now refuses legibly instead.
  tls: tellsAdapter,
};

export function getAdapter(key: string): SmsProviderAdapter {
  const a = ADAPTERS[key];
  if (!a) throw new UnknownProviderError(key);
  return a;
}

// ── Connection-type descriptors (869egmakh P1) ───────────────────────────────
// Two different questions, deliberately two different functions:
//
//   getDescriptor(key)   "what is THIS provider row?"  — alias-tolerant.
//   listConnectionTypes() "what can I create?"          — canonical only.
//
// The split exists because `txh2` is an ALIAS, not a connection type: it is a
// second TextHub ACCOUNT that was modeled as its own provider row because
// sms_provider_id is UNIQUE (see card 869ej8qzk). A provider row keyed `txh2`
// must resolve to the TextHub descriptor, but "TextHub" must appear exactly
// ONCE in a create-provider picker.
//
// Lookup is by REGISTRY key, never `adapter.key` — the txh2 entry reuses
// texthubAdapter, whose `.key` reports "txh" and would misattribute the row.

export type ConnectionType = {
  // The canonical registry key for this connection type (the picker's value).
  key: string;
  descriptor: NonNullable<SmsProviderAdapter["descriptor"]>;
  // False ⇒ this type cannot be verified without sending (no validateCredentials).
  // The UI must say so rather than offering a check that can never fail.
  canValidate: boolean;
};

// Registry keys that are aliases of another key rather than connection types of
// their own. Excluded from listConnectionTypes(); still resolvable via
// getDescriptor(). Retire this once adapter_code lands (card 869ej8qzk Part A).
const ALIAS_KEYS = new Set(["txh2"]);

// Descriptor for a provider row's key, or null when the key is unknown or the
// adapter declares none. Does NOT throw — callers are usually rendering.
export function getDescriptor(key: string) {
  return ADAPTERS[key]?.descriptor ?? null;
}

// Every registry key that resolves to the SAME adapter as `key` — i.e. every
// provider-row code that is really this connection type. For "txh" that is
// ["txh", "txh2"], because txh2 is a second TextHub account wearing its own
// provider row.
//
// This is what makes "does a provider of this type already exist?" correct:
// matching only the canonical code would miss the txh2 row and cheerfully offer
// to create a THIRD TextHub row. Compares adapter identity, not `adapter.key`,
// which reports "txh" for both entries and so can't distinguish anything.
export function registryKeysForType(key: string): string[] {
  const target = ADAPTERS[key];
  if (!target) return [];
  return Object.entries(ADAPTERS)
    .filter(([, adapter]) => adapter === target)
    .map(([k]) => k);
}

// Every distinct connection type an operator can pick, aliases excluded.
// Sorted by display name so the picker order is stable.
export function listConnectionTypes(): ConnectionType[] {
  const out: ConnectionType[] = [];
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    if (ALIAS_KEYS.has(key)) continue;
    if (!adapter.descriptor) continue;
    out.push({
      key,
      descriptor: adapter.descriptor,
      canValidate: typeof adapter.descriptor.validateCredentials === "function",
    });
  }
  return out.sort((a, b) =>
    a.descriptor.displayName.localeCompare(b.descriptor.displayName),
  );
}
