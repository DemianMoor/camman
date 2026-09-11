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

// Origin for an OAuth ROUND TRIP, selected by the host the browser is already
// on. Returns null only when the primary is unset.
//
// ⚠️ THIS IS THE ONE DELIBERATE EXCEPTION to "outbound URLs come from env" —
// and it is barely an exception: the request host never SUPPLIES an origin, it
// only SELECTS one of the origins env already declares. An unrecognised host
// (a spoofed `Host`, a preview URL) matches nothing and falls back to the
// primary, so no caller can introduce a redirect target of its own.
//
// WHY IT CANNOT JUST BE appOrigin(). An OAuth sign-in must return to the SAME
// ORIGIN it left: the PKCE code verifier lives in a cookie on that origin.
// CamMan answers on two hostnames, and pinning the callback to the primary
// meant anyone starting on the partner host came back to an origin with no
// verifier cookie. `exchangeCodeForSession()` then failed LOCALLY — it never
// issued a request — so Supabase's log showed a clean `/callback` and NO
// `/token`, and the user just landed back on /login with no explanation.
// (2026-09-11: this is what blocked the first invited user from signing in.)
//
// The rule still applies in full to everything else: a URL a PROVIDER PERSISTS
// must come from appOrigin() and nothing else, because it outlives the request.
// This one is consumed inside the same browser flow and is never stored, which
// is precisely why it is allowed to follow the tab.
export function authCallbackOrigin(
  requestHost: string | null | undefined,
): string | null {
  // `x-forwarded-host` can carry a comma-separated chain; the first entry is
  // the host the browser actually asked for.
  const host = (requestHost ?? "").split(",")[0]?.trim().toLowerCase();
  if (host) {
    for (const candidate of [appOrigin(), partnerOrigin()]) {
      if (!candidate) continue;
      try {
        if (new URL(candidate).host.toLowerCase() === host) return candidate;
      } catch {
        // A malformed env value can never match a real host; fall through.
      }
    }
  }
  return appOrigin();
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
