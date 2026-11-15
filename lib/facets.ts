// Faceted search: the refinements a user ticks after searching ("Recruiting", "Phase 3", "2024 or later") and the
// counts shown next to each value. Shared by the browser (panel, chips, URL) and the server (filters, count queries),
// so both build the exact same turbopuffer filter for a selection. No server-only imports.
//
// Semantics, as in most online stores ("disjunctive faceting"):
//   - values inside one facet combine with OR  (Phase 2 OR Phase 3)
//   - different facets combine with AND        (… AND Recruiting)
//   - each facet's counts apply every selection EXCEPT its own, so you can still see the other values' counts
//   - counts are scoped to the query by a ContainsAnyToken filter on `text` (keyword matches), since a pure vector
//     search has no fixed "match set" to count
import type { Kind, Patient } from "./types";

export type FacetKey =
  | "status" | "phase" | "sponsor" | "country" | "startYear" | "patientFit"
  | "pubType" | "journal" | "year" | "topic"
  | "noteType" | "author" | "visitYear";

type Clause = unknown[];

interface Bucket { value: string; label: string; from?: number; to?: number }

export interface FacetDef {
  key: FacetKey;
  kind: Kind;
  label: string;
  /** string: In; array ([]string): ContainsAny; buckets: year ranges; visitYear: YYYY from a date string; patient: special */
  type: "string" | "array" | "buckets" | "visitYear" | "patient";
  attr: string;
  buckets?: Bucket[];
  /** Values returned by the count query that aren't worth showing as refinements. */
  hide?: string[];
  hint: string;
}

const yearBuckets = (edges: [string, string, number | undefined, number | undefined][]): Bucket[] =>
  edges.map(([value, label, from, to]) => ({ value, label, from, to }));

export const FACETS: FacetDef[] = [
  // Trials
  { key: "status", kind: "trials", label: "Status", type: "string", attr: "status", hint: "Recruitment status on ClinicalTrials.gov." },
  { key: "phase", kind: "trials", label: "Phase", type: "array", attr: "phases", hide: ["N/A"], hint: "A trial can list two phases (e.g. Phase 2/3); it counts under both." },
  { key: "patientFit", kind: "trials", label: "Fits the patient", type: "patient", attr: "min_age",
    hint: "Trials whose age range and sex include the selected patient." },
  { key: "sponsor", kind: "trials", label: "Sponsor", type: "string", attr: "sponsor", hint: "Lead sponsor." },
  { key: "country", kind: "trials", label: "Country", type: "array", attr: "countries", hint: "Countries with at least one site." },
  { key: "startYear", kind: "trials", label: "Start year", type: "buckets", attr: "start_year",
    buckets: yearBuckets([["2024+", "2024 or later", 2024, undefined], ["2020-2023", "2020–2023", 2020, 2023],
      ["2015-2019", "2015–2019", 2015, 2019], ["pre-2015", "Before 2015", 1, 2014]]),
    hint: "Study start year. Trials with no recorded start year aren't counted." },
  // PubMed
  { key: "pubType", kind: "pubmed", label: "Publication type", type: "array", attr: "pub_types",
    hide: ["Journal Article", "English Abstract", "Research Support, Non-U.S. Gov't", "Research Support, N.I.H., Extramural",
      "Research Support, U.S. Gov't, P.H.S.", "Research Support, U.S. Gov't, Non-P.H.S."],
    hint: "From PubMed's publication types. An article can have several." },
  { key: "topic", kind: "pubmed", label: "Topic", type: "string", attr: "topic", hint: "Oncology or cardiology." },
  { key: "year", kind: "pubmed", label: "Year", type: "buckets", attr: "year",
    buckets: yearBuckets([["2024+", "2024 or later", 2024, undefined], ["2022-2023", "2022–2023", 2022, 2023],
      ["2019-2021", "2019–2021", 2019, 2021], ["pre-2019", "Before 2019", 1, 2018]]),
    hint: "Publication year." },
  { key: "journal", kind: "pubmed", label: "Journal", type: "string", attr: "journal", hint: "Journal of publication." },
  // Patient notes
  { key: "noteType", kind: "notes", label: "Note type", type: "string", attr: "note_type", hint: "Kind of chart note." },
  { key: "visitYear", kind: "notes", label: "Visit year", type: "visitYear", attr: "visit_date", hint: "Year of the visit." },
  { key: "author", kind: "notes", label: "Author", type: "string", attr: "author", hint: "The clinician who wrote the note." },
];

export const facetsFor = (kind: Kind) => FACETS.filter((f) => f.kind === kind);
export const facetDef = (key: string) => FACETS.find((f) => f.key === key);

/** Selected values per facet. Facet keys are unique across sources, so one map covers every source. */
export type Refine = Partial<Record<FacetKey, string[]>>;

export const PATIENT_FIT = "fits";

/** The turbopuffer filter for one facet's selected values (OR within the facet), or null when nothing applies. */
export function facetClause(def: FacetDef, values: string[], patient: Patient | null): Clause | null {
  if (!values.length) return null;
  const or = (cs: Clause[]): Clause | null => (cs.length === 0 ? null : cs.length === 1 ? cs[0] : ["Or", cs]);
  switch (def.type) {
    case "string":
      return [def.attr, "In", values];
    case "array":
      return [def.attr, "ContainsAny", values];
    case "buckets":
      return or(values.flatMap((v) => {
        const b = def.buckets?.find((x) => x.value === v);
        if (!b) return [];
        const parts: Clause[] = [];
        if (b.from != null) parts.push([def.attr, "Gte", b.from]);
        if (b.to != null) parts.push([def.attr, "Lte", b.to]);
        return [parts.length === 1 ? parts[0] : ["And", parts]];
      }));
    case "visitYear":
      // Visit dates are YYYY-MM-DD strings, which sort the same way as the dates.
      return or(values.filter((v) => /^\d{4}$/.test(v)).map((y) => ["And", [[def.attr, "Gte", `${y}-01-01`], [def.attr, "Lte", `${y}-12-31`]]]));
    case "patient":
      if (!patient || !values.includes(PATIENT_FIT)) return null;
      return ["And", [["min_age", "Lte", patient.age], ["max_age", "Gte", patient.age], ["sex", "In", [patient.sex, "All"]]]];
  }
}

/** All refinement clauses for one source (AND across facets), optionally leaving one facet out (for its own counts). */
export function refineClauses(kind: Kind, refine: Refine | undefined, patient: Patient | null, except?: FacetKey): Clause[] {
  if (!refine) return [];
  return facetsFor(kind).flatMap((def) => {
    if (def.key === except) return [];
    const c = facetClause(def, refine[def.key] ?? [], patient);
    return c ? [c] : [];
  });
}

/** Human label for a selected value (bucket labels, "Fits Maria"), for chips. */
export function valueLabel(def: FacetDef, value: string, patient: Patient | null): string {
  if (def.type === "buckets") return def.buckets?.find((b) => b.value === value)?.label ?? value;
  if (def.type === "patient") return patient ? `Fits ${patient.name.split(" ")[0]} (${patient.age}, ${patient.sex.toLowerCase()})` : "Fits the patient";
  return value;
}

/** Only selections that are valid for their facet, with duplicates removed. */
export function cleanRefine(input: unknown): Refine {
  const out: Refine = {};
  for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    const def = facetDef(k);
    if (!def || !Array.isArray(v)) continue;
    const vals = [...new Set(v.map(String).map((s) => s.slice(0, 200)).filter(Boolean))].slice(0, 20);
    if (vals.length) out[def.key] = vals;
  }
  return out;
}

export const refineCount = (r: Refine, kinds?: Kind[]) =>
  Object.entries(r).reduce((n, [k, v]) => n + ((!kinds || kinds.includes(facetDef(k)!.kind)) ? (v?.length ?? 0) : 0), 0);

// ---------------------------------------------------------------- URL: ?f=status~Recruiting|Completed,phase~Phase 3

export function refineToParam(r: Refine): string {
  return Object.entries(r)
    .filter(([, v]) => v?.length)
    .map(([k, v]) => `${k}~${v!.map((x) => x.replace(/[|,~]/g, " ")).join("|")}`)
    .join(",");
}

export function refineFromParam(p: string | null): Refine {
  const out: Record<string, string[]> = {};
  for (const part of (p ?? "").split(",")) {
    const i = part.indexOf("~");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1).split("|");
  }
  return cleanRefine(out);
}

// ---------------------------------------------------------------- counts

export interface FacetValue { value: string; label: string; count: number; selected: boolean }
export interface FacetCounts {
  key: FacetKey;
  label: string;
  hint: string;
  values: FacetValue[];
  ms: number;
  error?: string;
}
export interface SourceFacets {
  source: Kind;
  namespace: string;
  /** Documents matching the query (keyword scope) and every refinement. */
  total: number | null;
  scoped: boolean; // counts are scoped to the query's keyword matches
  facets: FacetCounts[];
  ms: number;
}
