import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { NS } from "@/lib/config";
import { getPatient } from "@/lib/patients";
import { buildFilters, search } from "@/lib/tpuf";
import { describeRanking, isActive, parseRanking } from "@/lib/ranking";
import { parseDiversify } from "@/lib/grouping";
import { cleanRefine } from "@/lib/facets";
import type { Fusion, Mode, SearchFilters, Source } from "@/lib/types";
import { requireUserId } from "@/lib/session";
import { instanceInfo } from "@/lib/instance";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const t0 = performance.now();
  const instance = instanceInfo();
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as {
    q: string; sources?: Source[]; scope?: string; mode: Mode; fusion?: Fusion; filters: SearchFilters; topK?: number;
    patientId?: string; ranking?: unknown; diversify?: unknown; candidates?: number; exact?: boolean;
  };
  const q = (body.q ?? "").trim().slice(0, 500);
  if (!q) return NextResponse.json({ error: "Type something to search for." }, { status: 400 });
  const mode: Mode = ["hybrid", "vector", "bm25"].includes(body.mode) ? body.mode : "hybrid";
  // Hybrid fusion: on turbopuffer (rerank_by ["RRF"], the default) or in the app.
  const fusion: Fusion = body.fusion === "app" ? "app" : body.fusion === "rerank" ? "rerank" : "server";
  // Optional turbopuffer-side diversification (at most N results per sponsor/journal/status/year) and rerank depth.
  const diversify = parseDiversify(body.diversify);
  const candidates = [20, 30, 40].includes(Number(body.candidates)) ? Number(body.candidates) : undefined;
  // Optional boosts and recency on the keyword side; all off unless the request turns them on.
  const ranking = parseRanking(body.ranking);
  const boosts = describeRanking(ranking);
  const topK = Math.min(30, Math.max(5, Number(body.topK ?? 10)));
  const patient = await getPatient(body.patientId);
  // Faceted refinements are validated against lib/facets.ts before they reach a filter.
  const f: SearchFilters = { ...(body.filters ?? {}), refine: cleanRefine(body.filters?.refine) };

  const sources = parseSources(body.sources, body.scope);

  // One source per search: the selected patient's notes, abstracts or trials. Every rank is then turbopuffer's own, with
  // no cross-source merge in the app.
  const targets: { namespace: string; filter: unknown[] | null }[] = [];
  if (sources.includes("notes") && patient) targets.push({ namespace: NS.patient(patient.id), filter: buildFilters("notes", f) });
  if (sources.includes("pubmed")) targets.push({ namespace: NS.pubmed, filter: buildFilters("pubmed", f) });
  if (sources.includes("trials")) targets.push({ namespace: NS.trials, filter: buildFilters("trials", f, patient) });
  if (!targets.length) return NextResponse.json({ error: "Pick a patient on the left to search their notes." }, { status: 400 });

  // One Langfuse trace per search (tagged "search"), with each namespace's turbopuffer call nested under it.
  after(flushLangfuse);
  try {
    const res = await newTrace({ userId: user, tags: ["search"], metadata: { sources, mode, fusion, topK, boosts, diversify, exact: body.exact === true } }, () =>
      startActiveObservation("search-page", async (obs) => {
        obs.update({ input: { q, sources, mode, fusion, boosts, topK, filters: f, patientId: patient?.id ?? null } });
        const out = await search(targets, q, mode, topK, { fusion, ranking: isActive(ranking) ? ranking : null, patient,
          diversify, candidates, exact: body.exact === true });
        obs.update({ output: { wallMs: Math.round(out.wallMs), hits: out.hits.length,
          rerank: out.runs.filter((r) => r.rerank).map((r) => ({ ns: r.short, ...r.rerank })),
          fusionChecks: out.runs.filter((r) => r.check).map((r) => ({ ns: r.short, matches: r.check!.matches, sameIds: r.check!.sameIds,
            tieSwaps: r.check!.tieSwaps, maxScoreDiff: r.check!.maxScoreDiff })),
          top: out.hits.slice(0, 10).map((h) => ({ rank: h.overall, kind: h.kind, id: h.id, title: h.title })) } });
        return out;
      }, { asType: "chain" }));
    console.log(JSON.stringify({ search: "done", sources, mode, fusion, boosts, topK, namespaces: targets.length,
      hits: res.hits.length, wallMs: Math.round(res.wallMs), cold: instance.cold, routeMs: Math.round(performance.now() - t0) }));
    const routeMs = Math.round(performance.now() - t0);
    return NextResponse.json({ ...res, server: { cold: instance.cold, ageS: instance.ageS, routeMs } });
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}

const ALL: Source[] = ["notes", "pubmed", "trials"];

/**
 * The source to search (one per search, so every rank is turbopuffer's own). Older links send `scope` instead: "patient", "literature", "trials" or "all"
 * (and "fulltext", from when full-text articles were searchable, which now means abstracts).
 */
function parseSources(sources: unknown, scope?: string): Source[] {
  if (Array.isArray(sources)) {
    const picked = ALL.filter((s) => sources.includes(s));
    return [picked.includes("notes") ? "notes" : picked[0] ?? "pubmed"];
  }
  return ({ patient: ["notes"], literature: ["pubmed"], fulltext: ["pubmed"], trials: ["trials"] } as Record<string, Source[]>)[scope ?? ""]
    ?? ["pubmed"];
}
