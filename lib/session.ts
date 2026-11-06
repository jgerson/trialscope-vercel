// The signed-in Clerk user, for API routes. proxy.ts already blocks signed-out requests; this is the second check.
import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";

export async function requireUserId(): Promise<string | Response> {
  const { userId } = await auth();
  return userId ?? Response.json({ error: "Sign in first." }, { status: 401 });
}

// The name to record on a note: full name, else username, else email.
export async function displayName(): Promise<string> {
  const user = await currentUser();
  if (!user) return "Unknown user";
  return user.fullName || user.username || user.primaryEmailAddress?.emailAddress || "Unknown user";
}
