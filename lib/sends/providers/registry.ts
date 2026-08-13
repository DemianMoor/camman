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
