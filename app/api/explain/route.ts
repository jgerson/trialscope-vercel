import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { NS } from "@/lib/config";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { requireUserId } from "@/lib/session";
import { explainRun } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

// Only the parts of a search request the app itself sends; anything else is dropped.
const KEYS = ["rank_by", "top_k", "filters"];
const clean = (q: unknown) =>
  Object.fromEntries(Object.entries((q ?? {}) as Record<string, unknown>).filter(([k]) => KEYS.includes(k)));

/** Query plan and a strong-vs-eventual timing for one namespace's search, as the Explain panel shows it. */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { namespace?: string; request?: Record<string, unknown> };
  const namespace = String(body.namespace ?? "");
  if (!namespace.startsWith(NS.prefix)) return NextResponse.json({ error: "Unknown namespace." }, { status: 400 });
  const raw = body.request ?? {};
  const request = Array.isArray(raw.queries) ? { queries: (raw.queries as unknown[]).slice(0, 2).map(clean) } : clean(raw);
  if (!Object.keys(request).length) return NextResponse.json({ error: "Nothing to explain." }, { status: 400 });

  after(flushLangfuse);
  try {
    const out = await newTrace({ userId: user, tags: ["explain"], metadata: { namespace } }, () =>
      startActiveObservation("explain-search", async (obs) => {
        obs.update({ input: { namespace, request } });
        const r = await explainRun(namespace, request);
        obs.update({ output: { strong: r.strong, eventual: r.eventual, plans: r.plans.length } });
        return r;
      }, { asType: "chain" }));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
