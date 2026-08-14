import { NextResponse, type NextRequest } from "next/server";

// Env-gated HTTP Basic Auth for non-production deployments (the external demo
// project on Vercel). A free stand-in for Vercel Deployment Protection.
//
// ACTIVE ONLY when DEMO_BASIC_AUTH is set, as "user:password". Production does
// not set it, so this middleware short-circuits to next() on the very first line
// and prod behaviour is byte-for-byte unchanged.
//
// ── Why the Bearer passthrough is load-bearing ──────────────────────────────
// Vercel Cron authenticates with `Authorization: Bearer <CRON_SECRET>` — the
// SAME header Basic Auth uses. A naive gate 401s all 17 cron entries. We cannot
// exempt by path either: cron paths are spread across /api/cron, /api/keitaro,
// /api/clicks, /api/opt-outs and /api/reports, so a prefix list would rot the
// next time one is added. Instead we branch on the auth SCHEME and let any
// Bearer through — every cron route re-checks CRON_SECRET itself and 401s on a
// mismatch, so passing through here weakens nothing.
//
// Exemptions below are paths that must answer to callers who cannot possibly
// hold demo credentials.

const PUBLIC_PREFIXES = [
  // The link shortener. Recipients (and demo reviewers clicking a seeded
  // message link) hit this with no session and no credentials — a login box
  // here would break the one flow the demo is meant to show off.
  "/r/",
  // Provider callbacks are authenticated by their own per-credential path
  // token. Nothing calls these in the demo (no provider credentials exist),
  // but keeping them open preserves parity with prod behaviour.
  "/api/webhooks/",
];

export function middleware(req: NextRequest) {
  const expected = process.env.DEMO_BASIC_AUTH;
  if (!expected) return NextResponse.next(); // production: inert

  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const header = req.headers.get("authorization");

  // Scheme branch — see note above.
  if (header?.startsWith("Bearer ")) return NextResponse.next();

  if (header?.startsWith("Basic ")) {
    try {
      // Compare the whole decoded "user:password" so a colon inside the
      // password is handled without splitting.
      if (atob(header.slice("Basic ".length)) === expected) {
        return NextResponse.next();
      }
    } catch {
      // Malformed base64 — fall through to the challenge.
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="CamMan demo", charset="UTF-8"',
    },
  });
}

export const config = {
  // Everything except Next's own static output. Kept deliberately broad: the
  // point is that an unauthenticated visitor sees nothing of the app.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
