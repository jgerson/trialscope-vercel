import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { NS } from "@/lib/config";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { requireUserId } from "@/lib/session";
import { verifyFusion } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

// Only the parts of a subquery the app itself sends; anything else is dropped.
const KEYS = ["rank_by", "top_k", "limit", "filters"];
const clean = (q: unknown) =>
  Object.fromEntries(Object.entries((q ?? {}) as Record<string, unknown>).filter(([k]) => KEYS.includes(k)));

/**
 * The deferred half of server-side fusion: re-run one namespace's hybrid subqueries unfused and check turbopuffer's
 * RRF against the app's. Called by the Explain panel when it opens (FUSION_VERIFY=lazy).
 */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { namespace?: string; request?: { queries?: unknown[] }; hits?: { id: string; score: number }[] };
  const namespace = String(body.namespace ?? "");
  const queries = (Array.isArray(body.request?.queries) ? body.request!.queries : []).slice(0, 2).map(clean);
  const hits = (body.hits ?? []).slice(0, 30).map((h) => ({ id: String(h.id), score: Number(h.score) }));
  if (!namespace.startsWith(NS.prefix) || queries.length !== 2 || !hits.length) {
    return NextResponse.json({ error: "namespace, both subqueries and the fused hits are required." }, { status: 400 });
  }
  after(flushLangfuse);
  try {
    const out = await newTrace({ userId: user, tags: ["verify"], metadata: { namespace } }, () =>
      startActiveObservation("verify-fusion", async (obs) => {
        obs.update({ input: { namespace, hits: hits.length } });
        const r = await verifyFusion(namespace, queries, hits, hits.length);
        obs.update({ output: r.check });
        return r;
      }, { asType: "chain" }));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
