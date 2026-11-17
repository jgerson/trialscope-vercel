import { startActiveObservation } from "@langfuse/tracing";
import { after, NextResponse } from "next/server";
import { NS } from "@/lib/config";
import { instanceInfo } from "@/lib/instance";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { ensureLangfuse } from "@/lib/langfuse-setup";
import { requireUserId } from "@/lib/session";
import { namespaceCache } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

/**
 * Warm-up before a search: the browser calls this when you focus the search box (at most once a minute). By the time
 * you press Search, the function instance is running, Langfuse's exporter has loaded, the connection to turbopuffer
 * is open, and both shared corpora have been sent turbopuffer's cache-warm hint (every time, as turbopuffer's docs
 * recommend; it's free when a namespace is already warm).
 */
export async function POST() {
  const t0 = performance.now();
  const instance = instanceInfo();
  const user = await requireUserId();
  if (user instanceof Response) return user;
  // Load Langfuse's exporter first, so the warm-up is traced even on a cold instance (it costs ~55-70 ms, only on a
  // cold start). One "warm-up" trace, with each namespace's cache-warm hint and Count query nested under it.
  await ensureLangfuse();
  after(flushLangfuse);
  const namespaces = [NS.trials, NS.pubmed];
  const caches = await newTrace(
    { userId: user, tags: ["warm-up"], traceName: "warm-up", metadata: { cold: instance.cold, ageS: instance.ageS } },
    () => startActiveObservation("warm-up", async (obs) => {
      obs.update({ input: { namespaces, cold: instance.cold } });
      const out = await Promise.all(namespaces.map((namespace) =>
        namespaceCache(namespace, true, "warm-check").then((c) => ({ namespace, ...c }),
          (e) => ({ namespace, state: "error", error: String((e as Error)?.message ?? e).slice(0, 160) }))));
      obs.update({ output: { caches: out } });
      return out;
    }, { asType: "span" }));
  const ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ warm: "done", cold: instance.cold, ageS: instance.ageS, ms, caches }));
  return NextResponse.json({ instance, ms, caches });
}
