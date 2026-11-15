// Group-by for search results, in two forms that share these keys:
//
// - Display grouping (browser only): the ranked results are arranged into sections by sponsor, journal, year and so
//   on. Ranks don't change, so it works the same after RRF, in-app fusion or model reranking.
// - Diversification (turbopuffer): `limit: { total, per: { attributes: [attr], limit: n } }` on each subquery caps how
//   many results can share one value, so one sponsor or journal can't fill the top 10. turbopuffer applies it per
//   subquery, before RRF or the reranker see the candidates. Only single-valued attributes are offered.
import type { Hit, Kind } from "./types";

export type GroupKey = "source" | "org" | "category" | "year" | "design" | "condition";

const str = (v: unknown) => (v == null || v === "" ? "" : String(v));
const first = (v: unknown, skip: string[] = []) =>
  (Array.isArray(v) ? (v as unknown[]).map(String).find((x) => !skip.includes(x)) : undefined) ?? "";

export const GROUPS: {
  key: GroupKey;
  label: string;
  perKind: Record<Kind, string>; // what the key means for each source, for labels
  diversify: Partial<Record<Kind, string>>; // turbopuffer attribute for limit.per (scalar attributes only)
  value: (h: Hit) => string;
}[] = [
  { key: "source", label: "Source", perKind: { trials: "source", pubmed: "source", notes: "source" }, diversify: {},
    value: (h) => ({ trials: "Clinical trials", pubmed: "PubMed", notes: "Patient notes" })[h.kind] },
  { key: "org", label: "Sponsor / journal", perKind: { trials: "sponsor", pubmed: "journal", notes: "author" },
    diversify: { trials: "sponsor", pubmed: "journal", notes: "author" },
    value: (h) => str(h.raw[{ trials: "sponsor", pubmed: "journal", notes: "author" }[h.kind]]) },
  { key: "category", label: "Status / topic", perKind: { trials: "status", pubmed: "topic", notes: "note type" },
    diversify: { trials: "status", pubmed: "topic", notes: "note_type" },
    value: (h) => str(h.raw[{ trials: "status", pubmed: "topic", notes: "note_type" }[h.kind]]) },
  { key: "year", label: "Year", perKind: { trials: "start year", pubmed: "year", notes: "visit year" },
    diversify: { trials: "start_year", pubmed: "year" },
    value: (h) => (h.kind === "notes" ? str(h.raw.visit_date).slice(0, 4) : str(h.raw[h.kind === "trials" ? "start_year" : "year"])).replace(/^0$/, "") },
  { key: "design", label: "Phase / study type", perKind: { trials: "phase", pubmed: "publication type", notes: "note type" }, diversify: {},
    value: (h) => h.kind === "trials" ? ((h.raw.phases as string[] | undefined) ?? []).join(", ")
      : h.kind === "pubmed" ? first(h.raw.pub_types, ["Journal Article", "English Abstract"]) || "Journal article" : str(h.raw.note_type) },
  { key: "condition", label: "Condition", perKind: { trials: "first condition", pubmed: "topic", notes: "note type" }, diversify: {},
    value: (h) => h.kind === "trials" ? first(h.raw.conditions) : h.kind === "pubmed" ? str(h.raw.topic) : str(h.raw.note_type) },
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

/** Arrange ranked hits into groups, ordered by each group's best rank; ranks inside a group keep their order. */
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
