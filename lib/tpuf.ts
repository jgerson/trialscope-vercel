// turbopuffer access: search modes, multi-namespace merge, notes and patients.
// Same data and logic as the Streamlit version (tp_client.py).
import "server-only";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { config, NS, RRF_K } from "./config";
import type { Hit, Kind, Mode, NamespaceRun, Note, Patient, SearchFilters, SearchResponse } from "./types";

let _client: Turbopuffer | null = null;
export function tp(): Turbopuffer {
  if (!config.tpufKey) throw new Error("TURBOPUFFER_API_KEY is not set");
  _client ??= new Turbopuffer({ apiKey: config.tpufKey, region: config.tpufRegion, maxRetries: 3 });
  return _client;
}

type Row = Record<string, unknown> & { id: string | number; $dist?: number };
type Filter = unknown[];

export function kindOf(namespace: string): Kind {
  if (namespace === NS.trials) return "trials";
  if (namespace === NS.pubmed) return "pubmed";
  return "notes";
}

const DISPLAY: Record<Kind, string[]> = {
  trials: ["title", "summary", "nct_id", "status", "phases", "conditions", "countries", "sponsor", "start_year"],
  pubmed: ["title", "abstract", "pmid", "journal", "year", "pub_types", "topic"],
  notes: ["title", "body", "note_type", "visit_date", "author"],
};

const NOTE_SCHEMA = {
  text: { type: "string", full_text_search: true, embed: config.embedModel },
  title: { type: "string", filterable: false },
  body: { type: "string", filterable: false },
  note_type: { type: "string" },
  visit_date: { type: "string" },
  author: { type: "string" },
};

// ------------------------------------------------------------------ filters

export function buildFilters(kind: Kind, f: SearchFilters, patient?: Patient | null): Filter | null {
  const parts: Filter[] = [];
  if (kind === "trials") {
    if (f.status?.length) parts.push(["status", "In", f.status]);
    if (f.phases?.length) parts.push(["phases", "ContainsAny", f.phases]);
    if (f.country?.trim()) parts.push(["countries", "Contains", f.country.trim()]);
    if (f.matchPatient && patient) {
      parts.push(["min_age", "Lte", patient.age], ["max_age", "Gte", patient.age], ["sex", "In", [patient.sex, "All"]]);
    }
  } else if (kind === "pubmed") {
    if (f.yearFrom && f.yearFrom > 2015) parts.push(["year", "Gte", f.yearFrom]);
    if (f.topic) parts.push(["topic", "Eq", f.topic]);
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : ["And", parts];
}

export function describeFilter(f: Filter | null): string[] {
  if (!f) return [];
  if (f[0] === "And") return (f[1] as Filter[]).flatMap(describeFilter);
  const [attr, op, val] = f as [string, string, unknown];
  const words: Record<string, string> = { In: "is", Eq: "is", ContainsAny: "includes", Contains: "includes", Gte: "≥", Lte: "≤" };
  return [`${attr} ${words[op] ?? op} ${Array.isArray(val) ? val.join(", ") : String(val)}`];
}

// ------------------------------------------------------------------ search

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "are", "was", "what", "how", "does", "into",
  "about", "after", "before", "have", "has", "not", "can", "who", "which", "patients", "patient", "their", "when"]);

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9-]{3,}/g) ?? [])].filter((t) => !STOP.has(t));
}

function cleanNote(body: string): string {
  return body
    .replace(/(^|\n)\s*#+\s*([^\n]+)\n+/g, "$1$2: ")
    .replace(/(^|\n|:\s)\s*-\s*/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function present(kind: Kind, r: Row) {
  const s = (k: string) => (r[k] == null ? "" : String(r[k]));
  if (kind === "notes") {
    return { title: s("title"), meta: [s("visit_date"), s("note_type"), s("author")], code: null, body: cleanNote(s("body")), url: null };
  }
  if (kind === "pubmed") {
    return {
      title: s("title"), meta: [s("journal"), s("year")], code: `PMID ${s("pmid")}`, body: s("abstract"),
      url: `https://pubmed.ncbi.nlm.nih.gov/${s("pmid")}/`,
    };
  }
  const conds = ((r.conditions as string[]) ?? []).slice(0, 4).join(", ");
  return {
    title: s("title"), meta: [s("status"), ((r.phases as string[]) ?? []).join(", ")], code: s("nct_id"),
    body: (conds ? `Conditions: ${conds}. ` : "") + s("summary"), url: `https://clinicaltrials.gov/study/${s("nct_id")}`,
  };
}

interface NsResult { run: NamespaceRun; hits: Omit<Hit, "overall" | "rrf">[] }

async function searchNamespace(namespace: string, query: string, mode: Mode, filter: Filter | null, topK: number,
  terms: string[]): Promise<NsResult> {
  const kind = kindOf(namespace);
  const base: Record<string, unknown> = { top_k: topK, include_attributes: DISPLAY[kind] };
  if (filter) base.filters = filter;
  const vec = { ...base, rank_by: ["text", "ANN", ["Embed", query]] };
  const txt = { ...base, rank_by: ["text", "BM25", query] };
  const strip = (q: Record<string, unknown>) => Object.fromEntries(Object.entries(q).filter(([k]) => k !== "include_attributes"));
  const request = mode === "vector" ? strip(vec) : mode === "bm25" ? strip(txt) : { queries: [strip(vec), strip(txt)] };

  const t0 = performance.now();
  let lists: Partial<Record<"vector" | "bm25", Row[]>> = {};
  let perf: Record<string, unknown> = {};
  try {
    const ns = tp().namespace(namespace);
    if (mode === "hybrid") {
      // One request, two ranked lists back. Fused below with the same RRF formula turbopuffer's
      // rerank_by ["RRF"] uses (k=60), so each result keeps its rank in both lists for the explainer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await ns.multiQuery({ queries: [vec, txt] } as any);
      lists = { vector: res.results?.[0]?.rows ?? [], bm25: res.results?.[1]?.rows ?? [] };
      perf = res.performance ?? {};
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await ns.query((mode === "vector" ? vec : txt) as any);
      lists = { [mode]: res.rows ?? [] };
      perf = res.performance ?? {};
    }
  } catch (e: unknown) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const roundMs = performance.now() - t0;

  const docs = new Map<string, { row: Row; vector: Hit["vector"]; bm25: Hit["bm25"] }>();
  for (const [name, rows] of Object.entries(lists) as ["vector" | "bm25", Row[]][]) {
    rows.forEach((row, i) => {
      const id = String(row.id);
      const d = docs.get(id) ?? { row, vector: null, bm25: null };
      d[name] = { rank: i + 1, score: Number(row.$dist ?? 0), of: rows.length };
      docs.set(id, d);
    });
  }
  const scored = [...docs.entries()].map(([id, d]) => {
    const fused = [d.vector, d.bm25].reduce((sum, sig) => sum + (sig ? 1 / (RRF_K + sig.rank) : 0), 0);
    return { id, ...d, fused };
  });
  scored.sort((a, b) => b.fused - a.fused);

  const hits = scored.slice(0, topK).map((d, i) => {
    const p = present(kind, d.row);
    const visible = `${p.title} ${p.body}`.toLowerCase();
    return {
      key: `${namespace}:${d.id}`, id: d.id, kind, namespace, title: p.title, url: p.url,
      meta: p.meta.filter(Boolean), code: p.code,
      snippet: p.body.length > 420 ? p.body.slice(0, 420) + "…" : p.body,
      nsRank: i + 1, fused: d.fused, vector: d.vector, bm25: d.bm25,
      terms: terms.filter((t) => new RegExp(`\\b${t.replace(/[-]/g, "\\-")}`).test(visible)),
      raw: d.row as Record<string, unknown>,
    };
  });

  const num = (k: string) => (typeof perf[k] === "number" ? (perf[k] as number) : null);
  return {
    hits,
    run: {
      namespace, short: namespace.replace(NS.prefix, ""), kind, hits: hits.length, roundMs,
      serverMs: num("server_total_ms"), embeddingMs: num("embedding_ms"),
      cache: typeof perf.cache_temperature === "string" ? perf.cache_temperature : null,
      docs: num("approx_namespace_size"), filters: describeFilter(filter), request,
    },
  };
}

export async function search(targets: { namespace: string; filter: Filter | null }[], query: string, mode: Mode,
  topK: number): Promise<SearchResponse> {
  const terms = queryTerms(query);
  const t0 = performance.now();
  const parts = await Promise.all(targets.map((t) => searchNamespace(t.namespace, query, mode, t.filter, topK, terms)));
  const wallMs = performance.now() - t0;

  // Merge across namespaces by rank: each namespace's #1 ties, then #2, and so on (stable by target order).
  const merged = parts.flatMap((p) => p.hits.map((h) => ({ ...h, rrf: 1 / (RRF_K + h.nsRank) })));
  merged.sort((a, b) => b.rrf - a.rrf);
  const hits: Hit[] = merged.map((h, i) => ({ ...h, overall: i + 1 }));

  return { query, mode, topK, rrfK: RRF_K, wallMs, embedModel: config.embedModel, runs: parts.map((p) => p.run), hits };
}

// ------------------------------------------------------------------ patients and notes

export async function listPatients(): Promise<Patient[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tp().namespace(NS.patients).query({ rank_by: ["name", "asc"], top_k: 1000, include_attributes: true } as any);
  return ((res.rows ?? []) as Patient[]).sort((a, b) => a.id.localeCompare(b.id));
}

export async function listNotes(patientId: string): Promise<Note[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tp().namespace(NS.patient(patientId)).query({
      rank_by: ["visit_date", "desc"], top_k: 200, include_attributes: DISPLAY.notes,
    } as any);
    return (res.rows ?? []).map((r: Row) => ({ ...r, id: String(r.id) })) as Note[];
  } catch (e: unknown) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
}

export async function saveNote(patientId: string, note: Note): Promise<{ id: string; writeMs: number; visibleMs: number }> {
  const namespace = NS.patient(patientId);
  const row = { ...note, text: `${note.title}\n${note.body}` };
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await tp().namespace(namespace).write({ upsert_rows: [row], schema: NOTE_SCHEMA, distance_metric: "cosine_distance" } as any);
  const writeMs = performance.now() - t0;

  // Queries are strongly consistent by default, so a fresh write should be visible straight away.
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tp().namespace(namespace).query({ filters: ["id", "Eq", note.id], top_k: 1, include_attributes: ["title"] } as any);
    if (res.rows?.length) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { id: note.id, writeMs, visibleMs: performance.now() - t1 };
}

let _counts: { at: number; value: Record<string, number> } | null = null;

export async function corpusCounts(): Promise<Record<string, number>> {
  if (_counts && Date.now() - _counts.at < 10 * 60_000) return _counts.value;
  const count = async (ns: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tp().namespace(ns).query({ aggregate_by: { c: ["Count"] } } as any);
    return Number(res.aggregations?.c ?? 0);
  };
  const [trials, pubmed, patients] = await Promise.all([count(NS.trials), count(NS.pubmed), count(NS.patients)]);
  _counts = { at: Date.now(), value: { trials, pubmed, patients } };
  return _counts.value;
}
