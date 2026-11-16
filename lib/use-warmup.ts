"use client";
// Warm-up before a search (see app/api/warm/route.ts). Fired when the search box gets focus, and once on page load when
// no search is about to run anyway; at most once a minute per tab, never two at a time. Failures are ignored: it's an
// optimisation, the search works without it.
let last = 0;
let inflight = false;

export function warmUp(): void {
  const now = Date.now();
  if (inflight || now - last < 60_000) return;
  last = now;
  inflight = true;
  fetch("/api/warm", { method: "POST" }).catch(() => undefined).finally(() => { inflight = false; });
}
