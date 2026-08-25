// The origins this app advertises to the outside world.
//
// ⚠️ BOTH ARE READ FROM ENV, NEVER FROM THE REQUEST HOST. CamMan is served on
// more than one hostname (a primary name and a partner-facing one), so an
// outbound URL built from `Host` silently becomes whichever name the operator
// happened to be browsing — a preview deployment URL that later 404s, or the
// partner name on a webhook that was meant to stay on the primary. That is the
// exact bug this module exists to prevent; see docs/07-conventions.md.

// Trim, default a missing scheme to https, drop trailing slashes. Returns null
// for an unset or blank value so callers can decide what "unset" means.
function normalizeOrigin(raw: string | undefined): string | null {
  let v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v.replace(/\/+$/, "");
}

// PRIMARY host. Auth emails, internal alert deep-links, and every provider
// webhook/callback URL we register with a provider. All machine traffic lives
// here and must keep living here — a registered callback outlives the browser
// tab that registered it.
export function appOrigin(): string | null {
  return normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL);
}

// PARTNER-FACING host, when one is configured. Only for URLs handed to a
// partner: the lead intake endpoint and the public API docs. Null when unset,
// which is the normal single-hostname deployment — callers keep their own
// fallback rather than getting a broken URL.
export function partnerOrigin(): string | null {
  return normalizeOrigin(process.env.NEXT_PUBLIC_PARTNER_HOST);
}

// Base origin for a URL we hand to a partner, given the origin the operator's
// browser is currently on. The current origin is the SINGLE-HOSTNAME FALLBACK
// ONLY — whenever a partner host is configured it wins, which is the whole
// point: the copied URL must not change with the tab it was copied from.
//
// Takes the browser origin as an argument rather than reading `window` so the
// exact shipped expression is testable against an old-host and a preview-URL
// input; see scripts/test-partner-host.ts.
export function partnerBase(currentOrigin: string): string {
  return partnerOrigin() ?? currentOrigin;
}
