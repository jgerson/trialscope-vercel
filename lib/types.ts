// Types shared by the server routes and the browser.

export type Kind = "notes" | "pubmed" | "fulltext" | "trials";
export type Mode = "hybrid" | "vector" | "bm25";
export type Scope = "patient" | "literature" | "fulltext" | "trials" | "all";

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
  /** Full-text results only: the section the best passage came from, and how many passages matched. */
  section?: string | null;
  passages?: number;
  chunk?: number;
  /** Full-text results only: the next-best passages from the same article (up to two). */
  more?: { section: string; snippet: string; chunk: number; text: string }[];
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
  fulltext: "Full text",
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
  inTokens: number;
  outTokens: number;
  /** US dollars at AI Gateway list prices; null when the price isn't known (e.g. calling Anthropic directly). */
  cost: number | null;
}
