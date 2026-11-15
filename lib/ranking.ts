// Optional ranking boosts and recency, layered onto the BM25 (keyword) side of a search. Off unless asked for: with no
// boosts the request is exactly the plain `["text", "BM25", query]` it always was. Shared by the browser (controls and
// URL params), the search API and the copilot, so it has no server-only imports.
//
// How a boosted keyword subquery is built (turbopuffer rank_by expressions):
//   Sum[ Saturate(BM25, midpoint)               relevance mapped into 0..1, so boosts are on a known scale
//        Product(w, <filter clause>)             a matching filter scores 1, otherwise 0, times the weight
//        Product(w, Sum(0.25 × [year ≥ t_i]))      recency: four year thresholds, 0.5 at the midpoint, 0.75 a span later
//   ]
// plus a ContainsAnyToken filter on `text`, because turbopuffer drops zero-score rows: without it, a boost alone
// would pull in documents that don't contain a single query word.
// The vector subquery never changes (an ANN search can't take boosts); RRF then fuses the two lists as usual.
import type { Kind, Patient } from "./types";

export type Strength = 0 | 1 | 2 | 3; // off, low, medium, high
export const STRENGTH_WEIGHT: Record<Strength, number> = { 0: 0, 1: 0.15, 2: 0.3, 3: 0.6 };
export const STRENGTH_LABEL: Record<Strength, string> = { 0: "Off", 1: "Low", 2: "Medium", 3: "High" };

export interface Ranking {
  recruiting?: Strength; // trials: Recruiting (full) and Not yet recruiting (half)
  recent?: Strength; // trials by start_year, PubMed by year
  recentMidpoint?: number; // the year that scores 0.5
  recentSpan?: number; // years after the midpoint that score 0.75 (smaller = sharper)
  evidence?: Strength; // PubMed: meta-analyses, systematic reviews and guidelines > RCTs > other clinical trials
  latePhase?: Strength; // trials: Phase 3/4 (full), Phase 2 (0.4)
  patientMatch?: Strength; // trials: the selected patient's age and sex fit the eligibility range
}

export const DEFAULT_MIDPOINT = 2020;
export const DEFAULT_SPAN = 4;
// BM25 score that maps to 0.5 relevance. TrialScope's documents are abstracts and trial summaries, where a solid
// multi-term match lands in the high single digits; override with BOOST_BM25_MIDPOINT if your corpus differs.
export const DEFAULT_BM25_MIDPOINT = 6;

export type BoostKey = "recruiting" | "recent" | "evidence" | "latePhase" | "patientMatch";
export const BOOSTS: { key: BoostKey; label: string; kinds: Kind[]; hint: string }[] = [
  { key: "recruiting", label: "Favor recruiting", kinds: ["trials"],
    hint: "Recruiting trials get the full boost, not-yet-recruiting trials half. Closed trials still appear, lower." },
  { key: "recent", label: "Favor recent", kinds: ["trials", "pubmed"],
    hint: "Newer trials (start year) and papers (publication year) rank higher, in four steps centred on the midpoint year." },
  { key: "evidence", label: "Evidence level", kinds: ["pubmed"],
    hint: "Meta-analyses, systematic reviews and guidelines first, then randomized controlled trials, then other clinical trials." },
  { key: "latePhase", label: "Favor late phase", kinds: ["trials"],
    hint: "Phase 3 and 4 trials get the full boost, Phase 2 a smaller one." },
  { key: "patientMatch", label: "Fits the patient", kinds: ["trials"],
    hint: "Trials whose age range and sex include the selected patient rank higher, without hiding the rest." },
];

export const isActive = (r: Ranking | null | undefined) =>
  !!r && BOOSTS.some((b) => (r[b.key] ?? 0) > 0);

/** Clamp anything from a request body or the copilot into a valid Ranking. */
export function parseRanking(input: unknown): Ranking {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown): Strength => {
    if (v === true) return 2;
    const n = Math.round(Number(v));
    return (n >= 0 && n <= 3 ? n : 0) as Strength;
  };
  const year = Math.round(Number(o.recentMidpoint));
  const span = Math.round(Number(o.recentSpan));
  return {
    recruiting: s(o.recruiting), recent: s(o.recent), evidence: s(o.evidence), latePhase: s(o.latePhase),
    patientMatch: s(o.patientMatch),
    recentMidpoint: year >= 1990 && year <= 2035 ? year : DEFAULT_MIDPOINT,
    recentSpan: span >= 1 && span <= 20 ? span : DEFAULT_SPAN,
  };
}

// ---------------------------------------------------------------- URL (?rk=recruiting2.recent2-2020-4.evidence1)

export function rankingToParam(r: Ranking): string {
  return BOOSTS.flatMap((b) => {
    const v = r[b.key] ?? 0;
    if (!v) return [];
    if (b.key === "recent") return [`recent${v}-${r.recentMidpoint ?? DEFAULT_MIDPOINT}-${r.recentSpan ?? DEFAULT_SPAN}`];
    return [`${b.key}${v}`];
  }).join(".");
}

export function rankingFromParam(p: string | null): Ranking {
  const out: Record<string, number> = {};
  for (const part of (p ?? "").split(".")) {
    const m = part.match(/^([a-zA-Z]+)(\d)(?:-(\d{4})-(\d{1,2}))?$/);
    if (!m) continue;
    out[m[1]] = Number(m[2]);
    if (m[1] === "recent" && m[3]) {
      out.recentMidpoint = Number(m[3]);
      out.recentSpan = Number(m[4]);
    }
  }
  return parseRanking(out);
}

// ---------------------------------------------------------------- turbopuffer expressions

type Clause = unknown[];
const product = (w: number, c: Clause): Clause => (w === 1 ? c : ["Product", w, c]);
const max = (cs: Clause[]): Clause => (cs.length === 1 ? cs[0] : ["Max", cs]);

/** One named boost: its unweighted 0..1 clause (also used as a computed attribute) and its weight. */
export interface BoostPart {
  key: BoostKey;
  label: string;
  weight: number;
  clause: Clause;
}

export interface KeywordPlan {
  /** The rank_by for the BM25 subquery. */
  rankBy: Clause;
  /** Extra filter to AND with the source's filters (null when no boost is active). */
  gate: Clause | null;
  /** compute_attributes for the per-result breakdown in the Explain panel. */
  compute: Record<string, Clause> | null;
  /** The boosts that apply to this source, and the ones that were asked for but don't. */
  parts: BoostPart[];
  skipped: { key: BoostKey; label: string; why: string }[];
  bm25Midpoint: number;
}

export const COMPUTED = { relevance: "ts_relevance", part: (k: BoostKey) => `ts_boost_${k}` };

/**
 * Recency as four year thresholds worth 0.25 each: mid − 1.5·span, mid − 0.5·span, mid + 0.5·span, mid + 1.5·span.
 * A document from the midpoint year scores 0.5, one `span` years newer 0.75, and anything older than the first
 * threshold (or with no year, stored as 0) scores 0. Built from plain comparison filters ("rank by filter"), because a
 * smooth Saturate curve on raw years needs an exponent in the hundreds and overflows floating point.
 */
export function recencyThresholds(mid: number, span: number): number[] {
  return [-1.5, -0.5, 0.5, 1.5].map((k) => Math.round(mid + k * span));
}

export function keywordPlan(kind: Kind, query: string, ranking: Ranking | null | undefined, patient: Patient | null,
  bm25Midpoint = DEFAULT_BM25_MIDPOINT): KeywordPlan {
  const bm25: Clause = ["text", "BM25", query];
  const plain: KeywordPlan = { rankBy: bm25, gate: null, compute: null, parts: [], skipped: [], bm25Midpoint };
  if (!isActive(ranking)) return plain;
  const r = ranking!;
  const parts: BoostPart[] = [];
  const skipped: KeywordPlan["skipped"] = [];

  for (const b of BOOSTS) {
    const strength = (r[b.key] ?? 0) as Strength;
    if (!strength) continue;
    if (!b.kinds.includes(kind)) {
      skipped.push({ key: b.key, label: b.label, why: kind === "notes" ? "notes have no fields it can use" : `applies to ${b.kinds.join(" and ")}` });
      continue;
    }
    const weight = STRENGTH_WEIGHT[strength];
    let clause: Clause | null = null;
    if (b.key === "recruiting") {
      clause = max([["status", "Eq", "Recruiting"], ["Product", 0.5, ["status", "Eq", "Not yet recruiting"]]]);
    } else if (b.key === "latePhase") {
      clause = max([["phases", "Contains", "Phase 3"], ["phases", "Contains", "Phase 4"], ["Product", 0.4, ["phases", "Contains", "Phase 2"]]]);
    } else if (b.key === "evidence") {
      clause = max([
        ["pub_types", "Contains", "Meta-Analysis"], ["pub_types", "Contains", "Systematic Review"],
        ["pub_types", "Contains", "Practice Guideline"], ["pub_types", "Contains", "Guideline"],
        ["Product", 0.75, ["pub_types", "Contains", "Randomized Controlled Trial"]],
        ["Product", 0.4, ["pub_types", "Contains", "Clinical Trial"]],
      ]);
    } else if (b.key === "recent") {
      const mid = r.recentMidpoint ?? DEFAULT_MIDPOINT;
      const span = r.recentSpan ?? DEFAULT_SPAN;
      const attr = kind === "trials" ? "start_year" : "year";
      clause = ["Sum", recencyThresholds(mid, span).map((t) => ["Product", 0.25, [attr, "Gte", t]])];
    } else if (b.key === "patientMatch") {
      if (!patient) {
        skipped.push({ key: b.key, label: b.label, why: "no patient selected" });
        continue;
      }
      clause = ["And", [["min_age", "Lte", patient.age], ["max_age", "Gte", patient.age], ["Or", [["sex", "Eq", patient.sex], ["sex", "Eq", "All"]]]]];
    }
    if (clause) parts.push({ key: b.key, label: b.label, weight, clause });
  }
  if (!parts.length) return { ...plain, skipped };

  const relevance: Clause = ["Saturate", bm25, { midpoint: bm25Midpoint }];
  const compute: Record<string, Clause> = { [COMPUTED.relevance]: relevance };
  for (const p of parts) compute[COMPUTED.part(p.key)] = p.clause;
  return {
    rankBy: ["Sum", [relevance, ...parts.map((p) => product(p.weight, p.clause))]],
    gate: ["text", "ContainsAnyToken", query],
    compute,
    parts,
    skipped,
    bm25Midpoint,
  };
}

/** Plain-English summary of the active boosts, for logs, Langfuse and the copilot's tool step. */
export function describeRanking(r: Ranking | null | undefined): string[] {
  if (!isActive(r)) return [];
  return BOOSTS.flatMap((b) => {
    const v = (r![b.key] ?? 0) as Strength;
    if (!v) return [];
    const extra = b.key === "recent" ? ` (½ at ${r!.recentMidpoint ?? DEFAULT_MIDPOINT}, ¾ by +${r!.recentSpan ?? DEFAULT_SPAN}y)` : "";
    return [`${b.label}: ${STRENGTH_LABEL[v].toLowerCase()} +${STRENGTH_WEIGHT[v]}${extra}`];
  });
}
