// Session refresh for the Next.js middleware (web/middleware.ts). Refreshes
// the auth cookies on every request and redirects signed-out visitors from
// app routes to /login. API routes answer 401 themselves.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasPublicEnv, publicEnv } from "@/lib/env";
import type { Database } from "@/lib/types/db";

// `/demo` is the clickable prototype (app/demo): it signs nobody in, touches
// no table and needs no keys, so it must be reachable on a configured
// deployment as well as an unconfigured one.
const PUBLIC_PREFIXES = ["/login", "/auth/", "/demo"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  if (!hasPublicEnv()) {
    // Unconfigured deployment: let the page render its own "set up .env.local" state.
    return response;
  }
  const { url, anonKey } = publicEnv();

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Do not put logic between createServerClient and getUser: the refresh
  // happens here and the cookies it writes must reach the response.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (!user && !isApi && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    if (pathname !== "/") redirectUrl.searchParams.set("next", `${pathname}${search}`);
    return withCookies(NextResponse.redirect(redirectUrl), response);
  }

  if (user && pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.search = "";
    return withCookies(NextResponse.redirect(redirectUrl), response);
  }

  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function withCookies(target: NextResponse, source: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  return target;
}
