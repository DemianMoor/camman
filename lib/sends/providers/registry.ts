import type { SmsProviderAdapter } from "./types";
import { texthubAdapter } from "./texthub";
import { ahoiAdapter } from "./ahoi";
import { simpletextingAdapter } from "./simpletexting";

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
  // SimpleTexting (Phase 1 skeleton). Registered so the drain's provider seam
  // and getAdapter() recognize the key; send() is a not-implemented stub and
  // the smpl provider row keeps supports_api_send=false until Phase 2 go-live.
  smpl: simpletextingAdapter,
};

export function getAdapter(key: string): SmsProviderAdapter {
  const a = ADAPTERS[key];
  if (!a) throw new UnknownProviderError(key);
  return a;
}
