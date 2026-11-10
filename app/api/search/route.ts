import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { NS } from "@/lib/config";
import { getPatient } from "@/lib/patients";
import { buildFilters, search } from "@/lib/tpuf";
import type { Mode, SearchFilters, Source } from "@/lib/types";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as {
    q: string; sources?: Source[]; scope?: string; mode: Mode; filters: SearchFilters; topK?: number; patientId?: string;
  };
  const q = (body.q ?? "").trim().slice(0, 500);
  if (!q) return NextResponse.json({ error: "Type something to search for." }, { status: 400 });
  const mode: Mode = ["hybrid", "vector", "bm25"].includes(body.mode) ? body.mode : "hybrid";
  const topK = Math.min(30, Math.max(5, Number(body.topK ?? 10)));
  const patient = await getPatient(body.patientId);
  const f = body.filters ?? {};

  const sources = parseSources(body.sources, body.scope);

  // Either the selected patient's notes, or any mix of the shared corpora; the search page never mixes the two.
  const targets: { namespace: string; filter: unknown[] | null }[] = [];
  if (sources.includes("notes") && patient) targets.push({ namespace: NS.patient(patient.id), filter: buildFilters("notes", f) });
  if (sources.includes("pubmed")) targets.push({ namespace: NS.pubmed, filter: buildFilters("pubmed", f) });
  if (sources.includes("trials")) targets.push({ namespace: NS.trials, filter: buildFilters("trials", f, patient) });
  if (!targets.length) return NextResponse.json({ error: "Pick a patient on the left to search their notes." }, { status: 400 });

  // One Langfuse trace per search (tagged "search"), with each namespace's turbopuffer call nested under it.
  after(flushLangfuse);
  try {
    const res = await newTrace({ userId: user, tags: ["search"], metadata: { sources, mode, topK } }, () =>
      startActiveObservation("search-page", async (obs) => {
        obs.update({ input: { q, sources, mode, topK, filters: f, patientId: patient?.id ?? null } });
        const out = await search(targets, q, mode, topK);
        obs.update({ output: { wallMs: Math.round(out.wallMs), hits: out.hits.length,
          top: out.hits.slice(0, 10).map((h) => ({ rank: h.overall, kind: h.kind, id: h.id, title: h.title })) } });
        return out;
      }, { asType: "chain" }));
    console.log(JSON.stringify({ search: "done", sources, mode, topK, namespaces: targets.length,
      hits: res.hits.length, wallMs: Math.round(res.wallMs) }));
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}

const ALL: Source[] = ["notes", "pubmed", "trials"];

/**
 * The sources to search. Older links send `scope` instead: "patient", "literature", "trials" or "all"
 * (and "fulltext", from when full-text articles were searchable, which now means abstracts).
 */
function parseSources(sources: unknown, scope?: string): Source[] {
  if (Array.isArray(sources)) {
    const picked = ALL.filter((s) => sources.includes(s));
    return picked.includes("notes") ? ["notes"] : picked;
  }
  return ({ patient: ["notes"], literature: ["pubmed"], fulltext: ["pubmed"], trials: ["trials"] } as Record<string, Source[]>)[scope ?? ""]
    ?? ["pubmed", "trials"];
}
