// Types shared by the server routes and the browser.

export type Kind = "notes" | "pubmed" | "trials";
export type Mode = "hybrid" | "vector" | "bm25";
export type Scope = "patient" | "literature" | "trials" | "all";

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
  fused: number;
  rrf: number;
  vector: Signal | null;
  bm25: Signal | null;
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
}

export interface SearchFilters {
  status?: string[];
  phases?: string[];
  country?: string;
  matchPatient?: boolean;
  yearFrom?: number;
  topic?: "oncology" | "cardiology" | "";
}

export interface SearchResponse {
  query: string;
  mode: Mode;
  topK: number;
  rrfK: number;
  wallMs: number;
  embedModel: string;
  runs: NamespaceRun[];
  hits: Hit[];
}

export const KIND_LABEL: Record<Kind, string> = {
  notes: "Patient note",
  pubmed: "PubMed",
  trials: "Clinical trial",
};

// ---------------------------------------------------------------- copilot explainability

/** One claim from a copilot answer, checked against the sources it cites. */
export interface GroundingItem {
  claim: string;
  tags: string[];
  verdict: "supported" | "partial" | "unsupported" | "uncited";
  note: string;
}

/** Tokens and approximate cost for one copilot answer or its grounding check. */
export interface Usage {
  calls: number;
  inTokens: number;
  outTokens: number;
  /** US dollars at AI Gateway list prices; null when the price isn't known (e.g. calling Anthropic directly). */
  cost: number | null;
}
