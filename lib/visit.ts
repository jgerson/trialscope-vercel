// A visit: one browser's run of activity, ending after 30 minutes without a request. proxy.ts gives each browser a
// random visit id in a cookie and slides its expiry on every request; newTrace (lib/langfuse.ts) sends it to Langfuse
// as the trace's sessionId, so a warm-up, the search after it and the Explain on a result show up together in
// Langfuse's Sessions view. The id is random and carries nothing about the user (Clerk's userId is sent separately).
// Kept free of server-only imports so proxy.ts can use it.
import type { NextResponse } from "next/server";

export const VISIT_COOKIE = "ts_visit";
const IDLE_SECONDS = 30 * 60;
const VALID = /^[A-Za-z0-9-]{16,64}$/;

/** The visit id from a cookie value, or null if it's missing or malformed. */
export const parseVisit = (value: string | undefined): string | null => (value && VALID.test(value) ? value : null);

/** Keep (or start) the visit on this response: same id if the request had one, a new one otherwise. */
export function touchVisit(res: NextResponse, current: string | undefined): NextResponse {
  res.cookies.set(VISIT_COOKIE, parseVisit(current) ?? crypto.randomUUID(), {
    maxAge: IDLE_SECONDS, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
  });
  return res;
}
