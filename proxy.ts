// Runs before every request: sends visitors to /login until they enter APP_PASSWORD.
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, cookieValid } from "@/lib/auth";

export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD ?? "";
  if (!password) return NextResponse.next();
  if (cookieValid(request.cookies.get(AUTH_COOKIE)?.value, password)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const url = new URL("/login", request.url);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the sign-in page, Next.js assets and static files.
  matcher: ["/((?!login|_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
