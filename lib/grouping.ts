// Group-by for search results, done by turbopuffer. Picking "Group by sponsor" (say) sends
// `limit: { total, per: { attributes: ["sponsor"], limit: n } }` on each subquery: turbopuffer returns the best results
// with at most n per sponsor, before RRF or the reranker see them. The page then shows those rows under a heading per
// value, in turbopuffer's order. Only single-valued attributes can be used, so only those are offered.
import type { Hit, Kind } from "./types";

export type GroupKey = "org" | "category" | "year";

const str = (v: unknown) => (v == null || v === "" ? "" : String(v));

export const GROUPS: {
  key: GroupKey;
  label: string;
  perKind: Record<Kind, string>; // what the key means for each source, for labels
  diversify: Partial<Record<Kind, string>>; // turbopuffer attribute for limit.per (scalar attributes only)
  value: (h: Hit) => string;
}[] = [
  { key: "org", label: "Sponsor / journal", perKind: { trials: "sponsor", pubmed: "journal", notes: "author" },
    diversify: { trials: "sponsor", pubmed: "journal", notes: "author" },
    value: (h) => str(h.raw[{ trials: "sponsor", pubmed: "journal", notes: "author" }[h.kind]]) },
  { key: "category", label: "Status / topic", perKind: { trials: "status", pubmed: "topic", notes: "note type" },
    diversify: { trials: "status", pubmed: "topic", notes: "note_type" },
    value: (h) => str(h.raw[{ trials: "status", pubmed: "topic", notes: "note_type" }[h.kind]]) },
  { key: "year", label: "Year", perKind: { trials: "start year", pubmed: "year", notes: "visit year" },
    diversify: { trials: "start_year", pubmed: "year" },
    value: (h) => (h.kind === "notes" ? str(h.raw.visit_date).slice(0, 4) : str(h.raw[h.kind === "trials" ? "start_year" : "year"])).replace(/^0$/, "") },
];

export const DIVERSIFIABLE = GROUPS.filter((g) => Object.keys(g.diversify).length);

export interface Diversify {
  by: GroupKey;
  per: number; // 1..5
}

export function parseDiversify(input: unknown): Diversify | null {
  const o = (input ?? {}) as Record<string, unknown>;
  const per = Math.round(Number(o.per));
  const g = DIVERSIFIABLE.find((x) => x.key === o.by);
  return g && per >= 1 && per <= 5 ? { by: g.key, per } : null;
}

/** The turbopuffer attribute to diversify on for one source, or null when that source has no such attribute. */
export const diversifyAttr = (d: Diversify | null, kind: Kind) =>
  (d && GROUPS.find((g) => g.key === d.by)?.diversify[kind]) || null;

/** Group keys turbopuffer can group one source by (its attribute must be single-valued). */
export const groupsFor = (kind: Kind) => GROUPS.filter((g) => g.diversify[kind]);

/**
 * Lay out the rows turbopuffer returned (already capped per value by limit.per) under one heading per value, ordered
 * by each group's best rank; ranks inside a group keep turbopuffer's order. Nothing is re-ranked or dropped here.
 */
export function groupHits(hits: Hit[], key: GroupKey): { name: string; hits: Hit[]; best: number }[] {
  const g = GROUPS.find((x) => x.key === key)!;
  const map = new Map<string, Hit[]>();
  for (const h of hits) {
    const name = g.value(h) || "Not recorded";
    map.set(name, [...(map.get(name) ?? []), h]);
  }
  return [...map.entries()]
    .map(([name, hs]) => ({ name, hits: hs, best: Math.min(...hs.map((h) => h.overall)) }))
    .sort((a, b) => a.best - b.best);
}
