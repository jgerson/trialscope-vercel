"use client";
// Warm-up before a search (see app/api/warm/route.ts). Fired when the search box gets focus, while you type, and once on
// page load when no search is about to run anyway; at most every 20 seconds per tab, never two at a time. Typing keeps
// it fresh: a Vercel instance can stop being reused after about a minute idle, so a warm-up only on focus could warm
// an instance that's gone by the time you press Search. Failures are ignored: it's an
// optimisation, the search works without it.
let last = 0;
let inflight = false;

export function warmUp(): void {
  const now = Date.now();
  if (inflight || now - last < 20_000) return;
  last = now;
  inflight = true;
  fetch("/api/warm", { method: "POST" }).catch(() => undefined).finally(() => { inflight = false; });
}
