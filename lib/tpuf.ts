// turbopuffer access: search modes, multi-namespace merge, notes and patients.
// Same data and logic as the Streamlit version (tp_client.py).
import "server-only";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { config, NS, RRF_K } from "./config";
import { tpCall } from "./tpuf-log";
import { tracedFetch } from "./traced-fetch";
import { COMPUTED, isActive, keywordPlan, type Ranking } from "./ranking";
import { diversifyAttr, type Diversify } from "./grouping";
import { facetClause, facetsFor, PATIENT_FIT, refineClauses, valueLabel, type FacetCounts, type FacetKey, type FacetValue,
  type SourceFacets } from "./facets";
import type { Accuracy, CorpusStat, Facet, Fusion, FusionCheck, Hit, HitBoost, Kind, Mode, NamespaceRun, Note, Patient, SearchFilters, SearchResponse, Source, WriteReport } from "./types";

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
  // Faceted refinements (OR within a facet, AND across facets).
  parts.push(...(refineClauses(kind, f.refine, patient ?? null) as Filter[]));
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

type Lists = Partial<Record<"vector" | "bm25", Row[]>>;
type Signals = { row: Row; vector: Hit["vector"]; bm25: Hit["bm25"]; fused: number };

/** The app's own reciprocal rank fusion: Σ 1/(k + rank) over the lists a document appears in, ranks from 1. */
function fuseInApp(lists: Lists): Map<string, Signals> {
  const docs = new Map<string, Signals>();
  for (const [name, rows] of Object.entries(lists) as ["vector" | "bm25", Row[]][]) {
    rows.forEach((row, i) => {
      const id = String(row.id);
      const d = docs.get(id) ?? { row, vector: null, bm25: null, fused: 0 };
      d[name] = { rank: i + 1, score: Number(row.$dist ?? 0), of: rows.length };
      docs.set(id, d);
    });
  }
  for (const d of docs.values()) d.fused = [d.vector, d.bm25].reduce((sum, sig) => sum + (sig ? 1 / (RRF_K + sig.rank) : 0), 0);
  return docs;
}

const byFused = (docs: Map<string, Signals>) => [...docs.entries()].sort((a, b) => b[1].fused - a[1].fused);

/**
 * Compare turbopuffer's fused order with the app's. A position only counts as a mismatch when the documents differ AND
 * their scores differ: equal RRF scores (e.g. #3 in vector only vs #3 in BM25 only) may come back in either order,
 * since turbopuffer doesn't document its tie-break.
 */
function compareFusion(server: Row[], app: [string, Signals][], verifyMs: number): FusionCheck {
  const EPS = 1e-9;
  const appScore = new Map(app.map(([id, d]) => [id, d.fused]));
  const n = Math.min(server.length, app.length);
  let sameIds = 0, tieSwaps = 0, maxScoreDiff = 0;
  let firstMismatch: FusionCheck["firstMismatch"] = null;
  for (let i = 0; i < n; i++) {
    const sid = String(server[i].id), aid = app[i][0];
    const sScore = Number(server[i].$dist ?? 0);
    const mine = appScore.get(sid);
    if (mine !== undefined) maxScoreDiff = Math.max(maxScoreDiff, Math.abs(mine - sScore));
    if (sid === aid) sameIds++;
    else if (Math.abs(sScore - app[i][1].fused) < EPS) tieSwaps++;
    else firstMismatch ??= { position: i + 1, server: sid, app: aid };
  }
  return { compared: n, sameIds, tieSwaps, maxScoreDiff, firstMismatch, verifyMs, matches: !firstMismatch && maxScoreDiff < 1e-6 };
}

async function searchNamespace(namespace: string, query: string, mode: Mode, filter: Filter | null, topK: number,
  terms: string[], fusion: Fusion, verify: boolean, ranking: Ranking | null, patient: Patient | null,
  extra: { diversify: Diversify | null; candidates: number; exact: boolean }): Promise<NsResult> {
  const kind = kindOf(namespace);
  const reranking = mode === "hybrid" && fusion === "rerank";
  // With model reranking each subquery returns `candidates` rows (not topK), with `text` included for the model to read.
  const perList = reranking ? Math.max(extra.candidates, topK) : topK;
  const divAttr = diversifyAttr(extra.diversify, kind);
  const size: Record<string, unknown> = divAttr
    ? { limit: { total: perList, per: { attributes: [divAttr], limit: extra.diversify!.per } } }
    : { top_k: perList };
  const base: Record<string, unknown> = { ...size, include_attributes: reranking ? [...DISPLAY[kind], "text"] : DISPLAY[kind] };
  if (filter) base.filters = filter;
  // Vector subquery: approximate (the ANN index) by default; exact kNN compares the query with every document that
  // passes the filters. If turbopuffer rejects kNN here (400), the search falls back to ANN and says so.
  let vecMethod: "ann" | "knn" = extra.exact && mode !== "bm25" ? "knn" : "ann";
  let vecError: string | null = null;
  const vecFor = (m: "ann" | "knn") => ({ ...base, rank_by: ["text", m === "knn" ? "kNN" : "ANN", ["Embed", query]] });
  let vec = vecFor(vecMethod);
  // The keyword subquery: plain BM25, or BM25 plus the requested boosts (see lib/ranking.ts). The reranker rescores
  // everything, so boosts are skipped (and listed as skipped) in that mode.
  const plan = keywordPlan(kind, query, mode === "vector" || reranking ? null : ranking, patient, config.bm25Midpoint);
  if (reranking && isActive(ranking)) plan.skipped.push({ key: "recruiting", label: "Ranking boosts", why: "the model reranker rescores every candidate" });
  const boosted = plan.parts.length > 0;
  /**
   * Level 0: boosts with a per-result breakdown (compute_attributes). Level 1: boosts only. Level 2: plain BM25.
   * The boost expressions can't be tested against every turbopuffer version from here, so a 400 on a boosted request
   * steps down a level instead of failing the search, and the run says what happened.
   */
  const keyword = (level: 0 | 1 | 2) => {
    if (!boosted || level === 2) return { ...base, rank_by: ["text", "BM25", query] };
    const f = plan.gate ? (filter ? ["And", [filter, plan.gate]] : plan.gate) : filter;
    return {
      ...base, ...(f ? { filters: f } : {}), rank_by: plan.rankBy,
      ...(level === 0 && plan.compute ? { compute_attributes: plan.compute } : {}),
    };
  };
  const strip = (q: Record<string, unknown>) => Object.fromEntries(Object.entries(q).filter(([k]) => k !== "include_attributes"));
  const serverFusion = mode === "hybrid" && fusion === "server";

  const t0 = performance.now();
  let lists = {} as Lists;
  let serverRows = null as Row[] | null; // assigned inside execute(); the cast stops TS narrowing it to null
  let perf: Record<string, unknown> = {};
  let verifyMs = 0;
  let request: unknown = null;
  let level: 0 | 1 | 2 = boosted ? 0 : 2;
  let rankingError: string | null = null;
  let rerankError: string | null = null;
  let effective: Fusion = fusion; // what actually ran (rerank falls back to "server" if the model call fails)
  let compareServerMs: number | null = null;
  const ns = tp().namespace(namespace);

  const execute = async (txt: Record<string, unknown>) => {
    // Server fusion: turbopuffer merges the two subqueries itself and returns one list of up to topK, scored in $dist.
    const fusedReq = { queries: [vec, txt], rerank_by: ["RRF"], limit: topK };
    request = mode === "vector" ? strip(vec) : mode === "bm25" ? strip(txt)
      : serverFusion || reranking ? { ...fusedReq, queries: [strip(vec), strip(txt)] } : { queries: [strip(vec), strip(txt)] };
    if (mode === "hybrid") {
      const unfusedReq = { queries: [vec, txt] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unfused = (label: string): Promise<any> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tpCall("multi_query", namespace, unfusedReq, () => ns.multiQuery(unfusedReq as any), { label });
      if (reranking && !rerankError) {
        // Model rerank: turbopuffer pools both subqueries' candidates and has the model score each one's `text` against
        // the query. The unfused lists come back in parallel, so the app knows where RRF would have put each result.
        const rrReq = { queries: [vec, txt], rerank_by: { model: config.rerankModel, attribute: "text", query }, limit: topK };
        request = { ...rrReq, queries: [strip(vec), strip(txt)] };
        try {
          const tv = performance.now();
          const [res, raw] = await Promise.all([
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tpCall("multi_query", namespace, rrReq, () => ns.multiQuery(rrReq as any), { label: "search-rerank" }) as Promise<any>,
            unfused("search-compare").then((r) => { verifyMs = performance.now() - tv; return r; }),
          ]);
          serverRows = res.results?.[0]?.rows ?? [];
          perf = res.performance ?? {};
          lists = { vector: raw.results?.[0]?.rows ?? [], bm25: raw.results?.[1]?.rows ?? [] };
          compareServerMs = typeof raw.performance?.server_total_ms === "number" ? raw.performance.server_total_ms : null;
          effective = "rerank";
          return;
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status === 404) throw e;
          // Model not enabled in this region, unknown model name, quota… fall back to turbopuffer RRF and say so.
          rerankError = `Model rerank failed${status ? ` (${status})` : ""}: ${String((e as Error).message).slice(0, 200)}. Showing turbopuffer RRF instead.`;
          effective = "server";
        }
      }
      if (serverFusion || reranking) {
        // The fused request gives the results. With verification, the two unfused lists come back in parallel, so the
        // app can recompute RRF, check it against turbopuffer's, and show each result's rank in both lists.
        const tv = performance.now();
        const [fusedRes, raw] = await Promise.all([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tpCall("multi_query", namespace, fusedReq, () => ns.multiQuery(fusedReq as any), { label: "search" }) as Promise<any>,
          verify ? unfused("search-verify").then((r) => { verifyMs = performance.now() - tv; return r; }) : Promise.resolve(null),
        ]);
        serverRows = fusedRes.results?.[0]?.rows ?? [];
        perf = fusedRes.performance ?? {};
        lists = raw ? { vector: raw.results?.[0]?.rows ?? [], bm25: raw.results?.[1]?.rows ?? [] } : {};
      } else {
        // App fusion: one request, two ranked lists back, fused below.
        const res = await unfused("search");
        lists = { vector: res.results?.[0]?.rows ?? [], bm25: res.results?.[1]?.rows ?? [] };
        perf = res.performance ?? {};
      }
    } else {
      const req = mode === "vector" ? vec : txt;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await tpCall("query", namespace, req, () => ns.query(req as any), { label: "search" });
      lists = { [mode]: res.rows ?? [] };
      perf = res.performance ?? {};
    }
  };

  try {
    for (;;) {
      try {
        await execute(keyword(level));
        break;
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        if (status === 400 && vecMethod === "knn") {
          vecError = `Exact (kNN) search was rejected: ${String((e as Error).message).slice(0, 200)}. Ran approximate (ANN) instead.`;
          vecMethod = "ann";
          vec = vecFor("ann");
          continue;
        }
        if (status === 400 && level < 2) {
          rankingError = `turbopuffer rejected the ${level === 0 ? "per-result breakdown" : "boost expression"}: ${String((e as Error).message).slice(0, 240)}`;
          level = (level + 1) as 1 | 2;
          continue;
        }
        throw e;
      }
    }
  } catch (e: unknown) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const roundMs = performance.now() - t0;

  const app = fuseInApp(lists);
  const appOrder = byFused(app);
  const check = serverRows && verify && effective === "server" ? compareFusion(serverRows, appOrder.slice(0, topK), verifyMs) : null;
  const rrfRankOf = new Map(appOrder.map(([id], i) => [id, i + 1]));

  // The ranked list to show: turbopuffer's order with server fusion, otherwise the app's.
  const ordered: { id: string; row: Row; fused: number; appFused: number | null; vector: Hit["vector"]; bm25: Hit["bm25"] }[] =
    serverRows
      ? serverRows.map((row) => {
        const id = String(row.id);
        const mine = app.get(id);
        return { id, row, fused: Number(row.$dist ?? 0), appFused: mine?.fused ?? null, vector: mine?.vector ?? null, bm25: mine?.bm25 ?? null };
      })
      : appOrder.map(([id, d]) => ({ id, row: d.row, fused: d.fused, appFused: null, vector: d.vector, bm25: d.bm25 }));

  // Per-result boost breakdown from the computed attributes (on the keyword list's row, or the fused row).
  const bm25Rows = new Map((lists.bm25 ?? []).map((r) => [String(r.id), r]));
  const boostOf = (id: string, row: Row): HitBoost | null => {
    if (level !== 0) return null;
    const src = bm25Rows.get(id) ?? row;
    const rel = src[COMPUTED.relevance];
    if (typeof rel !== "number") return null;
    const parts = plan.parts.map((p) => {
      const raw = Number(src[COMPUTED.part(p.key)] ?? 0);
      return { key: p.key, label: p.label, weight: p.weight, raw, value: raw * p.weight };
    });
    return { relevance: rel, parts, total: rel + parts.reduce((a, b) => a + b.value, 0) };
  };

  const hits = ordered.slice(0, topK).map((d, i) => {
    const p = present(kind, d.row);
    const visible = `${p.title} ${p.body}`.toLowerCase();
    return {
      key: `${namespace}:${d.id}`, id: d.id, kind, namespace, title: p.title, url: p.url,
      meta: p.meta.filter(Boolean), code: p.code,
      snippet: p.body.length > 420 ? p.body.slice(0, 420) + "…" : p.body,
      nsRank: i + 1, fused: d.fused, appFused: d.appFused, vector: d.vector, bm25: d.bm25, boost: boostOf(d.id, d.row),
      ...(effective === "rerank" ? { rerankScore: d.fused, rrfRank: rrfRankOf.get(d.id) ?? null } : {}),
      terms: terms.filter((t) => new RegExp(`\\b${t.replace(/[-]/g, "\\-")}`).test(visible)),
      // `text` (title + body, only fetched for the reranker) duplicates what's shown; keep it out of the response.
      raw: Object.fromEntries(Object.entries(d.row).filter(([k]) => k !== "text")) as Record<string, unknown>,
    };
  });
  const shifts = effective === "rerank" ? hits.map((h, i) => Math.abs((rrfRankOf.get(h.id) ?? topK + 1) - (i + 1))) : [];

  const num = (k: string) => (typeof perf[k] === "number" ? (perf[k] as number) : null);
  return {
    hits,
    run: {
      namespace, short: namespace.replace(NS.prefix, ""), kind, hits: hits.length, roundMs,
      serverMs: num("server_total_ms"), embeddingMs: num("embedding_ms"),
      cache: typeof perf.cache_temperature === "string" ? perf.cache_temperature : null,
      docs: num("approx_namespace_size"), filters: describeFilter(filter), request,
      ...(mode === "hybrid" ? { fusion: effective, check } : {}),
      rerank: reranking ? {
        model: config.rerankModel, candidates: perList,
        changedTop: shifts.filter((x) => x > 0).length,
        avgShift: shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : 0,
        retrievalServerMs: compareServerMs, error: rerankError,
      } : null,
      diversify: divAttr ? { attribute: divAttr, per: extra.diversify!.per } : null,
      vectorSearch: mode === "bm25" ? null : { method: vecMethod, error: vecError },
      ranking: plan.parts.length || plan.skipped.length || rankingError ? {
        applied: level === 2 ? [] : plan.parts.map((p) => `${p.label} +${p.weight}`),
        skipped: plan.skipped.map((x) => `${x.label}: ${x.why}`),
        breakdown: level === 0,
        bm25Midpoint: plan.bm25Midpoint,
        error: rankingError,
      } : null,
    },
  };
}

export async function search(targets: { namespace: string; filter: Filter | null }[], query: string, mode: Mode,
  topK: number, opts: { fusion?: Fusion; verify?: boolean; ranking?: Ranking | null; patient?: Patient | null;
    diversify?: Diversify | null; candidates?: number; exact?: boolean } = {}): Promise<SearchResponse> {
  const fusion: Fusion = opts.fusion ?? "server";
  const ranking = isActive(opts.ranking) ? opts.ranking! : null;
  const verify = opts.verify ?? config.fusionVerify;
  const terms = queryTerms(query);
  const t0 = performance.now();
  const parts = await Promise.all(targets.map((t) => searchNamespace(t.namespace, query, mode, t.filter, topK, terms, fusion, verify, ranking,
    opts.patient ?? null, { diversify: opts.diversify ?? null, candidates: opts.candidates ?? config.rerankCandidates, exact: !!opts.exact })));
  const wallMs = performance.now() - t0;

  // Merge across namespaces by rank: each namespace's #1 ties, then #2, and so on (stable by target order). This step
  // always runs in the app: a multi_query, and so turbopuffer's RRF, covers one namespace.
  const merged = parts.flatMap((p) => p.hits.map((h) => ({ ...h, rrf: 1 / (RRF_K + h.nsRank) })));
  merged.sort((a, b) => b.rrf - a.rrf);
  const hits: Hit[] = merged.map((h, i) => ({ ...h, overall: i + 1 }));

  return { query, mode, fusion, ranking, diversify: opts.diversify ?? null, vectorExact: !!opts.exact, topK, rrfK: RRF_K, wallMs, embedModel: config.embedModel, runs: parts.map((p) => p.run), hits };
}

// ------------------------------------------------------------------ ANN accuracy

/**
 * How accurate was the approximate vector search for this query? Three independent checks, each allowed to fail alone:
 * - turbopuffer's recall endpoint for this exact rank_by + filters (num 1): it runs ANN and an exhaustive search itself;
 * - the recall endpoint on 20 searches with random vectors sampled from the namespace (a namespace-level figure);
 * - the same vector query run both ways here, timed, with the documents only one of them returned.
 */
export async function accuracy(namespace: string, query: string, filters: Filter | null, topK: number): Promise<Accuracy> {
  const ns = tp().namespace(namespace);
  const f = filters ? { filters } : {};
  const err = (e: unknown) => ({ error: String((e as Error)?.message ?? e).slice(0, 240) });
  const rank = (m: "ANN" | "kNN") => ["text", m, ["Embed", query]];
  const timed = async (m: "ANN" | "kNN") => {
    const req = { rank_by: rank(m), top_k: topK, ...f };
    const t0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall("query", namespace, req, () => ns.query(req as any), { label: `accuracy-${m.toLowerCase()}` });
    return { ids: ((res.rows ?? []) as Row[]).map((r) => String(r.id)), serverMs: num(res.performance?.server_total_ms), roundMs: performance.now() - t0 };
  };
  const [thisQuery, sampled, timing] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ns.recall({ rank_by: rank("ANN"), top_k: topK, num: 1, ...f } as any)
      .then((r) => ({ recall: r.avg_recall, annCount: r.avg_ann_count, exhaustiveCount: r.avg_exhaustive_count }), err),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ns.recall({ num: 20, top_k: topK, ...f } as any).then((r) => ({ recall: r.avg_recall, searches: 20 }), err),
    Promise.all([timed("ANN"), timed("kNN")]).then(([a, k]) => {
      const exact = new Set(k.ids);
      const approx = new Set(a.ids);
      return {
        annServerMs: a.serverMs, knnServerMs: k.serverMs, annRoundMs: a.roundMs, knnRoundMs: k.roundMs,
        overlap: k.ids.length ? a.ids.filter((id) => exact.has(id)).length / k.ids.length : 1,
        onlyExact: k.ids.filter((id) => !approx.has(id)), onlyAnn: a.ids.filter((id) => !exact.has(id)),
      };
    }, err),
  ]);
  return { namespace, topK, thisQuery, sampled, timing };
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

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


/**
 * Counts per value of one field for each source, one aggregate query with group_by per namespace. Each source's other
 * active filters apply, so the counts match what a search would see; the faceted field's own filter is left out so
 * every value stays visible.
 */
/**
 * Facet counts for the faceted-search panel, scoped to the query. Per source and per facet, one aggregate Count query
 * with group_by on the facet's attribute, filtered by every refinement except the facet's own (disjunctive faceting)
 * plus a ContainsAnyToken gate on `text`, so the counts describe documents containing the query's words. Plus one count
 * of all matches with every refinement. Queries run in parallel; a failing facet is reported, not fatal.
 */
export async function facetCounts(sources: Source[], f: SearchFilters, patient: Patient | null, query: string): Promise<SourceFacets[]> {
  const gate: Filter | null = query.trim() ? ["text", "ContainsAnyToken", query.trim()] : null;
  const and = (xs: (Filter | null)[]): Filter | null => {
    const ps = xs.filter(Boolean) as Filter[];
    return ps.length === 0 ? null : ps.length === 1 ? ps[0] : ["And", ps];
  };
  const targets = sources.flatMap((source) => {
    const namespace = source === "notes" ? (patient ? NS.patient(patient.id) : null) : source === "trials" ? NS.trials : NS.pubmed;
    return namespace ? [{ source, namespace }] : [];
  });

  return Promise.all(targets.map(async ({ source, namespace }) => {
    const kind = kindOf(namespace);
    const ns = tp().namespace(namespace);
    const t0 = performance.now();
    const selectedOf = (k: FacetKey) => f.refine?.[k] ?? [];
    const without = (k: FacetKey): SearchFilters => ({ ...f, refine: { ...(f.refine ?? {}), [k]: [] } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (req: Record<string, unknown>, label: string): Promise<any> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tpCall("query", namespace, req, () => ns.query({ ...req, consistency: { level: "eventual" } } as any), { label });

    const totalP = run({ aggregate_by: { n: ["Count"] }, ...withFilters(and([buildFilters(kind, f, patient), gate])) }, "facet-total")
      .then((r) => Number(r.aggregations?.n ?? 0)).catch((e) => ((e as { status?: number }).status === 404 ? 0 : null));

    const defs = facetsFor(kind).filter((d) => d.type !== "patient" || patient);
    const facetsP = defs.map(async (def): Promise<FacetCounts> => {
      const tf = performance.now();
      const base = and([buildFilters(kind, without(def.key), patient), gate]);
      const selected = selectedOf(def.key);
      try {
        let values: FacetValue[] = [];
        if (def.type === "patient") {
          const clause = facetClause(def, [PATIENT_FIT], patient) as Filter;
          const r = await run({ aggregate_by: { n: ["Count"] }, ...withFilters(and([base, clause])) }, `facet-${def.key}`);
          values = [{ value: PATIENT_FIT, label: valueLabel(def, PATIENT_FIT, patient), count: Number(r.aggregations?.n ?? 0), selected: selected.includes(PATIENT_FIT) }];
        } else {
          const r = await run({ aggregate_by: { n: ["Count"] }, group_by: [def.attr], top_k: 1000, ...withFilters(base) }, `facet-${def.key}`);
          const counts = new Map<string, number>();
          const add = (v: string, n: number) => { if (v && !def.hide?.includes(v)) counts.set(v, (counts.get(v) ?? 0) + n); };
          for (const g of (r.aggregation_groups ?? []) as Record<string, unknown>[]) {
            const raw = g[def.attr];
            const n = Number(g.n ?? 0);
            if (def.type === "buckets") {
              const y = Number(raw);
              const b = def.buckets!.find((x) => (x.from == null || y >= x.from) && (x.to == null || y <= x.to));
              if (b && y > 0) add(b.value, n);
            } else if (def.type === "visitYear") {
              add(String(raw ?? "").slice(0, 4), n);
            } else if (Array.isArray(raw)) {
              // A multi-valued attribute may group by the whole array; count the document under each of its values.
              for (const v of new Set(raw.map(String))) add(v, n);
            } else {
              add(String(raw ?? ""), n);
            }
          }
          values = [...counts.entries()].map(([value, count]) => ({ value, label: valueLabel(def, value, patient), count, selected: selected.includes(value) }));
          // Bucketed facets keep their natural order; the rest sort by count. Selected values always show.
          if (def.type === "buckets") values.sort((a, b) => def.buckets!.findIndex((x) => x.value === a.value) - def.buckets!.findIndex((x) => x.value === b.value));
          else if (def.type === "visitYear") values.sort((a, b) => b.value.localeCompare(a.value));
          else values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
          for (const v of selected) if (!counts.has(v)) values.push({ value: v, label: valueLabel(def, v, patient), count: 0, selected: true });
        }
        return { key: def.key, label: def.label, hint: def.hint, values, ms: Math.round(performance.now() - tf) };
      } catch (e) {
        if ((e as { status?: number }).status === 404) return { key: def.key, label: def.label, hint: def.hint, values: [], ms: 0 };
        return { key: def.key, label: def.label, hint: def.hint, values: [], ms: Math.round(performance.now() - tf),
          error: String((e as Error).message).slice(0, 200) };
      }
    });

    const [total, ...facets] = await Promise.all([totalP, ...facetsP]);
    return { source: kind, namespace, total, scoped: !!gate, facets, ms: Math.round(performance.now() - t0) };
  }));
}

const withFilters = (f: Filter | null) => (f ? { filters: f } : {});

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
