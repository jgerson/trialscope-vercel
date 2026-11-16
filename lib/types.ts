// Types shared by the server routes and the browser.

export type Kind = "notes" | "pubmed" | "trials";
export type Mode = "hybrid" | "vector" | "bm25";
/** Where hybrid results are fused: on turbopuffer (rerank_by ["RRF"]) or in this app's code. */
export type Fusion = "server" | "app" | "rerank";
/** A searchable source. "notes" is the selected patient's own namespace; the others are shared corpora. */
export type Source = "notes" | "pubmed" | "trials";

export interface Patient {
  id: string;
  name: string;
  age: number;
  sex: string;
  city: string;
  state: string;
  specialty: "Oncology" | "Cardiology";
  primary_dx: string;
  stage: string;
  biomarkers: string;
  note_count: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  note_type: string;
  visit_date: string;
  author: string;
}

export interface Signal {
  rank: number;
  score: number;
  of: number;
}

export interface Hit {
  key: string; // namespace:id, unique across sources
  id: string;
  kind: Kind;
  namespace: string;
  title: string;
  url: string | null;
  meta: string[];
  code: string | null;
  snippet: string;
  nsRank: number;
  overall: number;
  /** RRF score that ordered this hit: turbopuffer's ($dist) with server fusion, the app's own otherwise. */
  fused: number;
  /** With server fusion and verification on: the app's recomputed RRF score for the same document. */
  appFused: number | null;
  /** Model rerank only: the reranker's relevance score, and where RRF would have placed this result instead. */
  rerankScore?: number | null;
  rrfRank?: number | null;
  rrf: number;
  vector: Signal | null;
  bm25: Signal | null;
  /** With ranking boosts: this result's keyword score split into relevance and each boost (from compute_attributes). */
  boost?: HitBoost | null;
  terms: string[];
  raw: Record<string, unknown>;
}

export interface NamespaceRun {
  namespace: string;
  short: string;
  kind: Kind;
  hits: number;
  roundMs: number;
  serverMs: number | null;
  embeddingMs: number | null;
  cache: string | null;
  docs: number | null;
  filters: string[];
  request: unknown;
  /** Hybrid only: who fused, and (server fusion with verification) whether the app's RRF agreed. */
  fusion?: Fusion;
  check?: FusionCheck | null;
  /** Server fusion without the check run inline: the Explain panel fetches it on demand from /api/verify. */
  verifyLater?: boolean;
  ranking?: RunRanking | null;
  rerank?: RunRerank | null;
  /** How the vector subquery ran: approximate (ANN index) or exact (kNN, every document compared). */
  vectorSearch?: { method: "ann" | "knn"; error: string | null } | null;
  /** turbopuffer-side diversification: at most `per` results per value of `attribute`, per subquery. */
  diversify?: { attribute: string; per: number } | null;
}

/** ANN accuracy for one namespace, from turbopuffer's recall endpoint plus a timed ANN vs exact comparison. */
export interface Accuracy {
  namespace: string;
  topK: number;
  thisQuery: { recall: number; annCount: number; exhaustiveCount: number } | { error: string };
  sampled: { recall: number; searches: number } | { error: string };
  timing: { annServerMs: number | null; knnServerMs: number | null; annRoundMs: number; knnRoundMs: number; overlap: number;
    onlyExact: string[]; onlyAnn: string[] } | { error: string };
}

/** What model reranking did on one namespace. */
export interface RunRerank {
  model: string;
  candidates: number; // per subquery, sent to the model
  changedTop: number; // positions in the shown results where the reranker's pick differs from RRF's
  avgShift: number; // mean |RRF rank − reranked rank| over the shown results
  retrievalServerMs: number | null; // server time of the same subqueries without the model
  error: string | null; // set when reranking failed and the search fell back to turbopuffer RRF
}

export interface HitBoost {
  relevance: number; // Saturate(BM25), 0..1
  parts: { key: string; label: string; weight: number; raw: number; value: number }[]; // value = raw × weight
  total: number; // relevance + Σ value: the keyword subquery's score
}

/** What the ranking boosts did on one namespace. */
export interface RunRanking {
  applied: string[];
  skipped: string[];
  breakdown: boolean; // per-result breakdown available
  bm25Midpoint: number;
  error: string | null; // set when turbopuffer rejected part of the boost request and the search stepped down
}

/** On-demand check for one namespace: per-result vector/BM25 ranks and the app's RRF, plus the comparison. */
export interface Verification {
  check: FusionCheck;
  signals: Record<string, { vector: Signal | null; bm25: Signal | null; appFused: number }>;
}

/** Server-side RRF compared with the app's own RRF over the same two unfused lists. */
export interface FusionCheck {
  compared: number; // positions compared (the shorter of the two lists)
  sameIds: number; // positions where both put the same document
  tieSwaps: number; // positions that differ only because two documents have equal scores
  maxScoreDiff: number; // largest |server − app| score for documents in both
  firstMismatch: { position: number; server: string; app: string } | null; // first difference not explained by a tie
  verifyMs: number; // round trip of the extra unfused request
  matches: boolean;
}

export interface SearchFilters {
  status?: string[];
  phases?: string[];
  country?: string;
  matchPatient?: boolean;
  yearFrom?: number;
  topic?: "oncology" | "cardiology" | "";
  noteTypes?: string[];
  visitFrom?: string; // YYYY-MM-DD
  visitTo?: string;
  /** Faceted refinements ticked after searching (see lib/facets.ts). */
  refine?: import("./facets").Refine;
}

/** One corpus: exact rows from an aggregate Count query, stored size from namespace metadata. */
export interface CorpusStat {
  namespace: string;
  rows: number;
  bytes: number | null;
  countMs: number;
  metadataMs: number;
}

/** Counts grouped by one field, from one aggregate query with group_by. */
export interface Facet {
  source: Source;
  namespace: string;
  field: "status" | "topic" | "note_type";
  groups: { value: string; count: number }[];
  ms: number;
}

export interface SearchResponse {
  query: string;
  mode: Mode;
  fusion: Fusion;
  ranking: import("./ranking").Ranking | null;
  diversify: import("./grouping").Diversify | null;
  vectorExact: boolean;
  topK: number;
  rrfK: number;
  wallMs: number;
  embedModel: string;
  runs: NamespaceRun[];
  hits: Hit[];
  /** How the app server handled this request: whether it was a cold start, and the route's own time. */
  server?: { cold: boolean; ageS: number; routeMs: number };
}

/** Browser-side timing for one search, measured from pressing Search to the results being on screen. */
export interface ClientTiming {
  browserMs: number;
}

export const KIND_LABEL: Record<Kind, string> = {
  notes: "Patient note",
  pubmed: "PubMed",
  trials: "Clinical trial",
};

// ---------------------------------------------------------------- copilot explainability

/** What one note save did in turbopuffer, for the "What the save did" panel. Numbers come from the write response. */
export interface WriteReport {
  namespace: string;
  kind: "insert" | "update";
  previous: Note | null; // the stored version before this upsert, for the diff
  row: Record<string, string>; // the row as sent, with a long body shortened for display
  bodyChars: number;
  schema: { field: string; stored: string }[];
  readMs: number; // looking up the previous version
  writeMs: number; // the upsert, measured from the app server (network included)
  visibleMs: number; // from write acknowledged to the note being returned by a query
  serverMs: number | null; // turbopuffer's own processing time for the write
  embeddingMs: number | null;
  embeddingTokens: number | null;
  rowsAffected: number | null;
  rowsUpserted: number | null;
  billableBytes: number | null;
}

/** Tokens and approximate cost for one copilot answer. */
export interface Usage {
  calls: number;
  /** All input tokens, cached or not. */
  inTokens: number;
  outTokens: number;
  /** Input tokens read from the prompt cache, and written to it (included in inTokens). */
  cacheRead?: number;
  cacheWrite?: number;
  /** US dollars at AI Gateway list prices; null when the price isn't known (e.g. calling Anthropic directly). */
  cost: number | null;
}
