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
  // Keyed by CONNECTION TYPE (sms_providers.adapter_code), not by provider-row
  // identity. The `txh2` alias entry that used to live here is gone: that row is
  // a second TextHub account whose adapter_code is 'txh', so it resolves through
  // the normal entry now. Adding a provider row no longer means editing this map.
  txh: texthubAdapter,
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
//   getDescriptor(code)   "what serves THIS provider row?" — takes adapter_code.
//   listConnectionTypes() "what can I create?"             — one entry per type.
//
// Both are keyed on the CONNECTION TYPE now. Callers pass a row's
// `adapter_code`, never its `sms_provider_id`: several rows can share a type
// (`txh` and `txh2` are both adapter_code 'txh'), and identity was only ever
// usable as a key by accident.
//
// The split between the two functions survives the alias removal because they
// still answer different questions: several provider ROWS may share one type, so
// "what serves this row" is many-to-one while "what can I create" must list each
// type exactly once.

export type ConnectionType = {
  // The canonical registry key for this connection type (the picker's value).
  key: string;
  descriptor: NonNullable<SmsProviderAdapter["descriptor"]>;
  // False ⇒ this type cannot be verified without sending (no validateCredentials).
  // The UI must say so rather than offering a check that can never fail.
  canValidate: boolean;
};

// Registry keys that are aliases of another key rather than connection types of
// their own — excluded from listConnectionTypes(), still resolvable via
// getDescriptor().
//
// EMPTY as of migration 0134's cutover, and expected to stay that way. Aliases
// existed only because sms_provider_id doubled as both row identity and adapter
// key: a second TextHub account could not reuse `txh` (the column is UNIQUE), so
// it became `txh2` and this set taught the registry to map it back. adapter_code
// carries the type now, so a new account of an existing type is just another row
// with the same adapter_code — nothing to alias.
//
// Kept rather than deleted because listConnectionTypes() still needs the concept
// if a future provider ever ships two registry keys for one adapter. If you find
// yourself adding to it, check first whether adapter_code should carry the
// distinction instead.
const ALIAS_KEYS = new Set<string>();

// Descriptor for a provider row's key, or null when the key is unknown or the
// adapter declares none. Does NOT throw — callers are usually rendering.
export function getDescriptor(key: string) {
  return ADAPTERS[key]?.descriptor ?? null;
}

// registryKeysForType() lived here. It enumerated every registry key resolving
// to the same adapter, so "does a provider of this type already exist?" could
// catch the `txh2` alias next to `txh`. With the alias gone it would return only
// the canonical key and silently under-report — so both callers now query
// sms_providers.adapter_code instead, which is the column that actually means
// "connection type" and matches rows created after the code was written.
// Removed rather than left as a one-element identity function.

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
