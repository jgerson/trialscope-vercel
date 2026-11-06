// Password gate. When APP_PASSWORD is set, a signed cookie proves the visitor entered it.
import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "ts_auth";

export function authToken(password: string): string {
  return createHmac("sha256", password).update("trialscope-session-v1").digest("hex");
}

export function passwordMatches(input: string, password: string): boolean {
  const a = Buffer.from(authToken(input));
  const b = Buffer.from(authToken(password));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieValid(value: string | undefined, password: string): boolean {
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(authToken(password));
  return a.length === b.length && timingSafeEqual(a, b);
}
