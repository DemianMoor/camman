import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = ["/dashboard", "/brands", "/settings"];
const AUTH_PAGE_PREFIXES = ["/login", "/signup"];

function pathStartsWith(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export async function proxy(request: NextRequest) {
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
