import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = ["/dashboard", "/brands", "/settings"];
const AUTH_PAGE_PREFIXES = ["/login", "/signup"];

function pathStartsWith(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

// ── Demo-only HTTP Basic Auth gate ──────────────────────────────────────────
// A free stand-in for Vercel Deployment Protection on the external demo project
// (see docs/09-demo-environment.md). ACTIVE ONLY when DEMO_BASIC_AUTH is set, as
// "user:password" — production leaves it unset, so this returns null on the
// first line and prod behaviour is unchanged.
//
// Runs BEFORE the Supabase session work below so an unauthenticated visitor
// doesn't cost a getUser() round-trip.
//
// SCOPE: the `config.matcher` at the bottom already excludes `/api/` and `/r/`,
// so this gate never sees them. That is what keeps the 19 Vercel Cron entries
// working — every cron path lives under `/api/`. It also leaves the public
// short-link redirect and the provider webhooks reachable, which they must be.
//
// The Bearer branch below is therefore currently unreachable, and is kept
// deliberately: Basic Auth and Vercel Cron share the `Authorization` header, so
// anyone who later widens the matcher to cover `/api/` would otherwise 401 every
// cron with no obvious cause. Each cron route re-checks CRON_SECRET itself, so
// letting a Bearer through weakens nothing.
function demoAuthGate(request: NextRequest): NextResponse | null {
  const expected = process.env.DEMO_BASIC_AUTH;
  if (!expected) return null; // production: inert

  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return null; // see note above

  if (header?.startsWith("Basic ")) {
    try {
      // Compare the whole decoded "user:password" so a colon inside the
      // password is handled without splitting.
      if (atob(header.slice("Basic ".length)) === expected) return null;
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

export async function proxy(request: NextRequest) {
  const gate = demoAuthGate(request);
  if (gate) return gate;

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  if (!user && pathStartsWith(pathname, PROTECTED_PREFIXES)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathStartsWith(pathname, AUTH_PAGE_PREFIXES)) {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    dashboardUrl.search = "";
    return NextResponse.redirect(dashboardUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // `r/` is excluded so the public short-link redirect (app/r/[code]) never
    // pays a Supabase auth round-trip — it's high-volume and unauthenticated.
    //
    // ALL of `api/` is excluded: every route under app/api/ independently
    // authenticates inside its own handler (via lib/api/helpers.ts
    // requireApiUser/requireApiMembership, a CRON_SECRET Bearer check, or a
    // per-credential webhook token — audited 2026-06-19, 172/172 routes
    // self-protected). Route handlers can also refresh their own auth cookies
    // (unlike Server Components), so they don't need the middleware session
    // refresh. Excluding them drops a redundant getUser() round-trip per API
    // call. The middleware's redirect logic only targets page prefixes
    // (PROTECTED_PREFIXES / AUTH_PAGE_PREFIXES), none of which live under /api.
    "/((?!_next/static|_next/image|_next/data|favicon.ico|r/|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf)$).*)",
  ],
};
