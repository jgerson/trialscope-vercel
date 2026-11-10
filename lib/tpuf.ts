// turbopuffer access: search modes, multi-namespace merge, notes and patients.
// Same data and logic as the Streamlit version (tp_client.py).
import "server-only";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { config, NS, RRF_K } from "./config";
import { tpCall } from "./tpuf-log";
import { tracedFetch } from "./traced-fetch";
import type { CorpusStat, Facet, Hit, Kind, Mode, NamespaceRun, Note, Patient, SearchFilters, SearchResponse, Source, WriteReport } from "./types";

let _client: Turbopuffer | null = null;
export function tp(): Turbopuffer {
  if (!config.tpufKey) throw new Error("TURBOPUFFER_API_KEY is not set");
  // tracedFetch adds an http span per request inside traced actions (see lib/traced-fetch.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _client ??= new Turbopuffer({ apiKey: config.tpufKey, region: config.tpufRegion, maxRetries: 3, fetch: tracedFetch as any });
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
  } else if (kind === "notes") {
    if (f.noteTypes?.length) parts.push(["note_type", "In", f.noteTypes]);
    // Visit dates are stored as YYYY-MM-DD strings, which sort the same way as the dates.
    if (f.visitFrom) parts.push(["visit_date", "Gte", f.visitFrom]);
    if (f.visitTo) parts.push(["visit_date", "Lte", f.visitTo]);
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
      const req = { queries: [vec, txt] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await tpCall("multi_query", namespace, req, () => ns.multiQuery(req as any), { label: "search" });
      lists = { vector: res.results?.[0]?.rows ?? [], bm25: res.results?.[1]?.rows ?? [] };
      perf = res.performance ?? {};
    } else {
      const req = mode === "vector" ? vec : txt;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await tpCall("query", namespace, req, () => ns.query(req as any), { label: "search" });
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
  const req = { rank_by: ["name", "asc"], top_k: 1000, include_attributes: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("query", NS.patients, req, () => tp().namespace(NS.patients).query(req as any), { label: "list-patients" });
  return ((res.rows ?? []) as Patient[]).sort((a, b) => a.id.localeCompare(b.id));
}

export async function listNotes(patientId: string): Promise<Note[]> {
  try {
    const namespace = NS.patient(patientId);
    const req = { rank_by: ["visit_date", "desc"], top_k: 200, include_attributes: DISPLAY.notes };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall("query", namespace, req, () => tp().namespace(namespace).query(req as any), { label: "list-notes" });
    return (res.rows ?? []).map((r: Row) => ({ ...r, id: String(r.id) })) as Note[];
  } catch (e: unknown) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
}

// How each note attribute is stored, in words, for the save panel. Mirrors NOTE_SCHEMA; the other fields use defaults.
const NOTE_STORAGE: WriteReport["schema"] = [
  { field: "text", stored: `title + body: keyword-indexed (BM25) and embedded by turbopuffer with ${config.embedModel}` },
  { field: "title", stored: "stored for display, not filterable" },
  { field: "body", stored: "stored for display, not filterable" },
  { field: "note_type", stored: "filterable" },
  { field: "visit_date", stored: "filterable" },
  { field: "author", stored: "filterable" },
];

/** Upsert one note and report what happened: insert or update, the turbopuffer write report, and when it became visible. */
export async function saveNote(patientId: string, note: Note): Promise<WriteReport & { id: string }> {
  const namespace = NS.patient(patientId);
  const ns = tp().namespace(namespace);

  // The current version, if any: an upsert replaces by id, so this decides insert vs update and feeds the diff.
  const tr = performance.now();
  let previous: Note | null = null;
  try {
    const req = { filters: ["id", "Eq", note.id], top_k: 1, include_attributes: ["title", "body", "note_type", "visit_date", "author"] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prev: any = await tpCall("query", namespace, req, () => ns.query(req as any), { label: "read-previous-note" });
    const r = prev.rows?.[0];
    if (r) previous = { id: String(r.id), title: r.title ?? "", body: r.body ?? "", note_type: r.note_type ?? "", visit_date: r.visit_date ?? "", author: r.author ?? "" };
  } catch {
    previous = null; // a namespace with no notes yet has nothing to compare against
  }
  const readMs = performance.now() - tr;

  const row = { ...note, text: `${note.title}\n${note.body}` };
  const t0 = performance.now();
  const writeReq = { upsert_rows: [row], schema: NOTE_SCHEMA, distance_metric: "cosine_distance" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("write", namespace, writeReq, () => ns.write(writeReq as any), { label: "write-note" });
  const writeMs = performance.now() - t0;

  // Queries are strongly consistent by default, so a fresh write should be visible straight away.
  // Logged as one record with the number of attempts, not one line per poll.
  const t1 = performance.now();
  const visReq = { filters: ["id", "Eq", note.id], top_k: 1, include_attributes: ["title"] };
  await tpCall("query", namespace, visReq, async () => {
    let attempts = 0;
    let found = false;
    for (; attempts < 20 && !found; attempts++) {
      if (attempts) await new Promise((r) => setTimeout(r, 50));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = await ns.query(visReq as any);
      found = Boolean(q.rows?.length);
    }
    return { attempts, found };
  }, { label: "wait-until-visible", extra: (r) => r });
  const visibleMs = performance.now() - t1;

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const short = (t: string) => (t.length > 600 ? `${t.slice(0, 600)}… (${t.length.toLocaleString()} characters)` : t);
  return {
    id: note.id, namespace, kind: previous ? "update" : "insert", previous,
    row: { id: note.id, title: note.title, body: short(note.body), note_type: note.note_type, visit_date: note.visit_date,
      author: note.author, text: short(row.text) },
    bodyChars: note.body.length, schema: NOTE_STORAGE, readMs, writeMs, visibleMs,
    serverMs: num(res?.performance?.server_total_ms), embeddingMs: num(res?.performance?.embedding_ms),
    embeddingTokens: num(res?.performance?.embedding_tokens), rowsAffected: num(res?.rows_affected),
    rowsUpserted: num(res?.rows_upserted), billableBytes: num(res?.billing?.billable_logical_bytes_written),
  };
}


// ------------------------------------------------------------------ corpus, facets, cache, explain

let _stats: { at: number; value: Promise<Record<string, CorpusStat>> } | null = null;

/**
 * Size of each shared corpus, two ways: an exact row count from an aggregate query, and stored bytes from the
 * namespace's metadata (a separate API call that searches nothing). Cached for 10 minutes per server instance, and
 * callers that arrive while it's being worked out share the same requests.
 */
export function corpusStats(): Promise<Record<string, CorpusStat>> {
  if (_stats && Date.now() - _stats.at < 10 * 60_000) return _stats.value;
  const value = loadCorpusStats();
  _stats = { at: Date.now(), value };
  value.catch(() => { if (_stats?.value === value) _stats = null; }); // don't cache a failure
  return value;
}

async function loadCorpusStats(): Promise<Record<string, CorpusStat>> {
  const one = async (namespace: string): Promise<CorpusStat> => {
    const ns = tp().namespace(namespace);
    const req = { aggregate_by: { c: ["Count"] } };
    const t0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [count, meta]: any[] = await Promise.all([
      tpCall("query", namespace, req, () => ns.query(req as any), { label: "count-rows" }).then((r) => ({ r, ms: performance.now() - t0 })),
      tpCall("metadata", namespace, {}, () => ns.metadata(), { label: "namespace-metadata" }).then((r) => ({ r, ms: performance.now() - t0 })),
    ]);
    const bytes = Number(meta.r?.approx_logical_bytes);
    return { namespace, rows: Number(count.r.aggregations?.c ?? 0), bytes: Number.isFinite(bytes) ? bytes : null,
      countMs: Math.round(count.ms), metadataMs: Math.round(meta.ms) };
  };
  const [trials, pubmed] = await Promise.all([one(NS.trials), one(NS.pubmed)]);
  return { trials, pubmed };
}

const FACET_FIELD: Record<Source, Facet["field"]> = { trials: "status", pubmed: "topic", notes: "note_type" };

/**
 * Counts per value of one field for each source, one aggregate query with group_by per namespace. Each source's other
 * active filters apply, so the counts match what a search would see; the faceted field's own filter is left out so
 * every value stays visible.
 */
export async function facets(sources: Source[], f: SearchFilters, patient: Patient | null): Promise<Facet[]> {
  const without: Record<Facet["field"], Partial<SearchFilters>> = {
    status: { status: [] }, topic: { topic: "" }, note_type: { noteTypes: [] },
  };
  const jobs = sources.flatMap((source) => {
    const namespace = source === "notes" ? (patient ? NS.patient(patient.id) : null)
      : source === "trials" ? NS.trials : NS.pubmed;
    if (!namespace) return [];
    const field = FACET_FIELD[source];
    const filter = buildFilters(source, { ...f, ...without[field] }, patient);
    return [{ source, namespace, field, filter }];
  });
  return Promise.all(jobs.map(async ({ source, namespace, field, filter }) => {
    const req: Record<string, unknown> = { aggregate_by: { n: ["Count"] }, group_by: [field], top_k: 50 };
    if (filter) req.filters = filter;
    const t0 = performance.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await tpCall("query", namespace, req, () => tp().namespace(namespace).query(req as any), { label: "facet-counts" });
      const groups = ((res.aggregation_groups ?? []) as Record<string, unknown>[])
        .map((g) => ({ value: String(g[field] ?? ""), count: Number(g.n ?? 0) }))
        .filter((g) => g.value && g.count)
        .sort((a, b) => b.count - a.count);
      return { source, namespace, field, groups, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if ((e as { status?: number }).status === 404) return { source, namespace, field, groups: [], ms: 0 };
      throw e;
    }
  }));
}

/**
 * Cache state of a patient's namespace, read from a tiny count query (eventual consistency, so it doesn't wait on object
 * storage). If it isn't warm and `warm` is set, ask turbopuffer to start loading it into cache.
 */
export async function patientCache(patientId: string, warm: boolean): Promise<{ state: "warm" | "warming" | "cold"; temperature: string | null; ms: number }> {
  const namespace = NS.patient(patientId);
  const ns = tp().namespace(namespace);
  const req = { aggregate_by: { c: ["Count"] }, consistency: { level: "eventual" } };
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("query", namespace, req, () => ns.query(req as any), { label: "cache-check" });
  const temperature = typeof res.performance?.cache_temperature === "string" ? res.performance.cache_temperature : null;
  const ms = Math.round(performance.now() - t0);
  if (temperature === "hot" || temperature === "warm") return { state: "warm", temperature, ms };
  if (!warm) return { state: "cold", temperature, ms };
  await tpCall("warm", namespace, {}, () => ns.hintCacheWarm(), { label: "hint-cache-warm" });
  return { state: "warming", temperature, ms };
}

/**
 * For one search request as the Explain panel shows it: turbopuffer's query plan for each subquery, and the same
 * request timed with strong and with eventual consistency.
 */
export async function explainRun(namespace: string, request: Record<string, unknown>) {
  const ns = tp().namespace(namespace);
  const subqueries = Array.isArray(request.queries) ? (request.queries as Record<string, unknown>[]) : [request];
  const plans = await Promise.all(subqueries.map((q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tpCall("explain", namespace, q, () => ns.explainQuery(q as any), { label: "explain-query" })
      .then((r) => String((r as { plan_text?: string }).plan_text ?? ""))));
  const timed = async (level: "strong" | "eventual") => {
    const req = { ...request, consistency: { level } };
    const multi = Array.isArray(request.queries);
    const t0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall(multi ? "multi_query" : "query", namespace, req,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): Promise<unknown> => (multi ? ns.multiQuery(req as any) : ns.query(req as any)), { label: `consistency-${level}` });
    return { level, roundMs: Math.round(performance.now() - t0), serverMs: res.performance?.server_total_ms ?? null };
  };
  // One after the other, so the two timings don't compete for the same connection.
  const strong = await timed("strong");
  const eventual = await timed("eventual");
  return { plans, strong, eventual };
}
