import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { NS } from "@/lib/config";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { requireUserId } from "@/lib/session";
import { accuracy } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

/**
 * ANN accuracy for one namespace's search, as the Explain panel's "Check ANN accuracy" shows it. The browser sends the
 * vector subquery it already ran (from run.request); only its filters and top_k are used, and the query text.
 */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { namespace?: string; query?: string; request?: Record<string, unknown> };
  const namespace = String(body.namespace ?? "");
  const query = String(body.query ?? "").trim().slice(0, 500);
  if (!namespace.startsWith(NS.prefix) || !query) return NextResponse.json({ error: "namespace and query are required." }, { status: 400 });
  const raw = body.request ?? {};
  // The vector subquery is the first of a multi-query, or the request itself for vector-only search.
  const vec = (Array.isArray(raw.queries) ? raw.queries[0] : raw) as Record<string, unknown>;
  const filters = Array.isArray(vec?.filters) ? (vec.filters as unknown[]) : null;
  const lim = vec?.limit as { total?: number } | number | undefined;
  const topK = Math.min(30, Math.max(5, Number(vec?.top_k ?? (typeof lim === "number" ? lim : lim?.total) ?? 10)));

  after(flushLangfuse);
  try {
    const out = await newTrace({ userId: user, tags: ["accuracy"], metadata: { namespace } }, () =>
      startActiveObservation("ann-accuracy", async (obs) => {
        obs.update({ input: { namespace, query, topK, filters } });
        const r = await accuracy(namespace, query, filters, topK);
        obs.update({ output: r });
        return r;
      }, { asType: "chain" }));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
