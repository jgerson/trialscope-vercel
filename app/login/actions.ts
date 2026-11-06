"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, authToken, passwordMatches } from "@/lib/auth";

export async function signIn(_: { error: string } | null, form: FormData): Promise<{ error: string }> {
  const password = process.env.APP_PASSWORD ?? "";
  const input = String(form.get("password") ?? "");
  if (!password || !passwordMatches(input, password)) return { error: "That password didn't match. Try again." };
  const isProduction = process.env.NODE_ENV === "production";
  // The v0 preview embeds the dev server in a cross-site iframe, where Lax cookies are never sent.
  (await cookies()).set(AUTH_COOKIE, authToken(password), {
    httpOnly: true,
    secure: true,
    sameSite: isProduction ? "lax" : "none",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}
