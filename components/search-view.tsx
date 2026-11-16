"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowUpWideNarrow, ClipboardCheck, Filter, Info, Loader2, Search, Settings2, X } from "lucide-react";
import type { CorpusStat, Fusion, Hit, Mode, Patient, SearchResponse, Source } from "@/lib/types";
import { useApp } from "./app-shell";
import { useCorpus } from "@/lib/use-corpus";
import { HitExplainer, RunOverview } from "./explain";
import { warmUp } from "@/lib/use-warmup";
import { DIVERSIFIABLE, GROUPS, groupHits, parseDiversify, type GroupKey } from "@/lib/grouping";
import { facetDef, refineCount, refineFromParam, refineToParam, valueLabel, type FacetKey, type Refine,
  type SourceFacets } from "@/lib/facets";
import { BOOSTS, DEFAULT_MIDPOINT, DEFAULT_SPAN, isActive, rankingFromParam, rankingToParam, STRENGTH_LABEL,
  STRENGTH_WEIGHT, type Ranking, type Strength } from "@/lib/ranking";
import { cx, highlight, Segmented, SourceTag, Tip } from "./ui";

const EXAMPLES = ["trastuzumab cardiotoxicity monitoring", "EGFR exon 19 resistance after osimertinib",
  "pulsed field ablation for atrial fibrillation", "NCT03418961"];
const LITERATURE: Source[] = ["pubmed", "trials"];
const LIT_LABEL: Record<Source, string> = { notes: "Patient notes", pubmed: "Abstracts", trials: "Trials" };
const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "hybrid", label: "Hybrid", hint: "Runs a meaning search and a keyword search in one request and merges the two ranked lists (reciprocal rank fusion). The best default." },
  { value: "vector", label: "Vector", hint: "Matches meaning: turbopuffer embeds your words and finds the closest documents, so it catches paraphrases and synonyms." },
  { value: "bm25", label: "BM25", hint: "Matches exact words, weighting rare ones more. Best for drug names, genes and trial ids." },
];

const FUSIONS: { value: Fusion; label: string; hint: string }[] = [
  { value: "server", label: "turbopuffer", hint: "turbopuffer fuses the two lists itself (rerank_by [\"RRF\"]) and returns one ranked list. The app also recomputes RRF from the unfused lists to check they agree and to explain each result." },
  { value: "app", label: "In app", hint: "turbopuffer returns the vector and BM25 lists separately and this app fuses them with the same RRF formula (k = 60)." },
  { value: "rerank", label: "Model rerank", hint: "turbopuffer pools both lists' candidates and a relevance model reads each one against your query (rerank_by). Slower and paid per token, better at nuance like 'after osimertinib'. Each result shows where RRF would have put it." },
];
const CANDIDATES = [20, 30, 40];
const VECTOR_METHODS: { value: "ann" | "exact"; label: string; hint: string }[] = [
  { value: "ann", label: "Approximate", hint: "ANN: turbopuffer searches its vector index and skips most documents. Fast; can occasionally miss a true nearest neighbor (turbopuffer targets 90–95% recall@10)." },
  { value: "exact", label: "Exact", hint: "kNN: compares the query with every document that passes the filters. Always finds the true nearest neighbors; slower on large sources. Use it on small or tightly filtered sets, or to check ANN." },
];

type Area = "notes" | "literature";

/** Sources from the URL: `in=notes` or `in=pubmed,trials`; older links use `scope`. */
function initialSources(params: URLSearchParams): { area: Area; lit: Source[] } {
  const inParam = params.get("in");
  if (inParam === "notes" || params.get("scope") === "patient") return { area: "notes", lit: LITERATURE };
  const picked = (inParam ?? "").split(",").filter((s): s is Source => LITERATURE.includes(s as Source));
  if (picked.length) return { area: "literature", lit: picked };
  // "fulltext" is from when full-text articles were searchable; it now opens abstracts.
  const legacy = ({ literature: ["pubmed"], fulltext: ["pubmed"], trials: ["trials"] } as Record<string, Source[]>)[params.get("scope") ?? ""];
  return { area: "literature", lit: legacy?.length ? legacy : LITERATURE };
}

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function SearchView() {
  const stats = useCorpus();
  const params = useSearchParams();
  const router = useRouter();
  const { patient } = useApp();
  const examples = EXAMPLES;
  const [input, setInput] = useState(params.get("q") ?? "");
  const [{ area, lit }, setSources] = useState(() => initialSources(params));
  const [mode, setMode] = useState<Mode>((params.get("mode") as Mode) || "hybrid");
  const [fusion, setFusion] = useState<Fusion>(
    params.get("fusion") === "app" ? "app" : params.get("fusion") === "rerank" ? "rerank" : "server");
  const [candidates, setCandidates] = useState<number>(CANDIDATES.includes(Number(params.get("cand"))) ? Number(params.get("cand")) : 20);
  // Display grouping (browser only) and turbopuffer-side diversification (?div=org-2: at most 2 per sponsor/journal).
  const [groupBy, setGroupBy] = useState<GroupKey | "">((GROUPS.find((g) => g.key === params.get("group"))?.key) ?? "");
  const [diversify, setDiversify] = useState(() => {
    const [by, per] = (params.get("div") ?? "").split("-");
    return parseDiversify({ by, per });
  });
  const divKey = diversify ? `${diversify.by}-${diversify.per}` : "";
  const [vectorMethod, setVectorMethod] = useState<"ann" | "exact">(params.get("vec") === "exact" ? "exact" : "ann");
  // Optional boosts and recency (all off by default), kept in the URL as ?rk=… so a link reproduces the ranking.
  const [ranking, setRanking] = useState<Ranking>(() => rankingFromParam(params.get("rk")));
  const rankingKey = rankingToParam(ranking);
  // Faceted refinements (?f=status~Recruiting,phase~Phase 2|Phase 3), applied as turbopuffer filters.
  const [refine, setRefine] = useState<Refine>(() => refineFromParam(params.get("f")));
  const refineKey = refineToParam(refine);
  const [topK, setTopK] = useState(() => Math.min(30, Math.max(5, Number(params.get("k")) || 10)));
  const [facetsOpen, setFacetsOpen] = useState(false); // below lg the panel opens from a Refine button
  const [data, setData] = useState<SearchResponse | null>(null);
  // Browser timing: from pressing Search to the results being painted (set after the next frame).
  const [browserMs, setBrowserMs] = useState<number | null>(null);
  const searchStart = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [facetData, setFacetData] = useState<SourceFacets[]>([]);
  const [facetsLoading, setFacetsLoading] = useState(false);
  const q = params.get("q") ?? "";
  const sources: Source[] = area === "notes" ? ["notes"] : lit;
  const sourcesKey = sources.join(",");

  const run = useCallback(async (query: string) => {
    if (!query.trim()) { setData(null); return; }
    setLoading(true); setError(null);
    searchStart.current = performance.now();
    try {
      const res = await fetch("/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, sources: sourcesKey.split(","), mode, fusion, ranking: rankingFromParam(rankingKey),
          diversify: divKey ? { by: divKey.split("-")[0], per: Number(divKey.split("-")[1]) } : null, candidates,
          exact: mode !== "bm25" && vectorMethod === "exact",
          filters: { refine: refineFromParam(refineKey) }, topK, patientId: patient?.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed.");
      setData(json); setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sourcesKey, mode, fusion, candidates, rankingKey, divKey, vectorMethod, refineKey, topK, patient?.id]);

  // Once new results are on screen, record how long the whole search took as you experienced it.
  useEffect(() => {
    if (!data || searchStart.current == null) return;
    const t0 = searchStart.current;
    searchStart.current = null;
    requestAnimationFrame(() => requestAnimationFrame(() => setBrowserMs(performance.now() - t0)));
  }, [data]);

  // Warm the server and turbopuffer on page load, unless a search is about to run anyway (see lib/use-warmup.ts).
  useEffect(() => { if (!params.get("q")) warmUp(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run whenever the query in the URL or any control changes.
  useEffect(() => { setInput(q); run(q); }, [q, run]);

  // Facet counts for the sources being searched, scoped to the query, with every other refinement applied.
  useEffect(() => {
    if (!q.trim() || (area === "notes" && !patient)) { setFacetData([]); return; }
    const ctl = new AbortController();
    setFacetsLoading(true);
    fetch("/api/facets", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ q, sources: sourcesKey.split(","), filters: { refine: refineFromParam(refineKey) }, patientId: patient?.id }),
    }).then((r) => r.json()).then((j) => { setFacetData(j.facets ?? []); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => ctl.abort();
  }, [q, area, sourcesKey, refineKey, patient?.id]);

  // Keep refinements in the URL so a refined search can be shared; replace() so each tick isn't a history entry.
  useEffect(() => {
    if (!q) return;
    const sp = new URLSearchParams(window.location.search);
    if (refineKey) sp.set("f", refineKey); else sp.delete("f");
    if (topK !== 10) sp.set("k", String(topK)); else sp.delete("k");
    const next = `/?${sp.toString()}`;
    if (next !== `${window.location.pathname}${window.location.search}`) router.replace(next, { scroll: false });
  }, [refineKey, topK, q, router]);

  const toggleRefine = (key: FacetKey, value: string) => setRefine((r) => {
    const cur = r[key] ?? [];
    return { ...r, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
  });

  const submit = (text: string) => {
    const sp = new URLSearchParams({ q: text.trim() });
    if (area === "notes") sp.set("in", "notes");
    else if (lit.length < LITERATURE.length) sp.set("in", lit.join(","));
    if (mode !== "hybrid") sp.set("mode", mode);
    else if (fusion === "app") sp.set("fusion", "app");
    if (rankingKey) sp.set("rk", rankingKey);
    if (mode === "hybrid" && fusion === "rerank") { sp.set("fusion", "rerank"); if (candidates !== 20) sp.set("cand", String(candidates)); }
    if (divKey) sp.set("div", divKey);
    if (mode !== "bm25" && vectorMethod === "exact") sp.set("vec", "exact");
    if (groupBy) sp.set("group", groupBy);
    if (refineKey) sp.set("f", refineKey);
    if (topK !== 10) sp.set("k", String(topK));
    router.replace(`/?${sp.toString()}`, { scroll: false });
    // The search re-runs when the query in the URL changes. Searching the same words again (say, after switching from
    // hybrid to vector) leaves the query unchanged, so run it directly.
    if (text.trim() === q.trim()) run(text);
  };

  const toggleLit = (s: Source) => setSources(({ lit: cur }) => {
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : LITERATURE.filter((x) => x === s || cur.includes(x));
    return { area: "literature", lit: next.length ? next : cur }; // at least one stays on
  });

  const hit = data?.hits.find((h) => h.key === selected) ?? null;
  const activeRefinements = refineCount(refine, sources);

  const notesLabel = patient ? `${patient.name.split(" ")[0]}'s notes` : "Patient notes";
  const corpusTotal = ["pubmed", "trials"].reduce((n, k) => n + (stats[k]?.bytes ?? 0), 0);

  return (
    <div className="mx-auto max-w-[1360px] px-5 pb-20 sm:px-8 lg:px-10">
      <div className={cx("transition-[padding] duration-300", q ? "pt-8" : "pt-[12vh]")}>
        {!q && (
          <div className="mb-8 max-w-[760px]">
            <h1 className="font-display text-[clamp(44px,6.5vw,84px)] leading-[0.95] tracking-tight text-ink text-balance">
              Search the chart or <em className="italic text-slate">the literature</em>.
            </h1>
            <p className="mt-4 max-w-[62ch] text-[16px] leading-relaxed text-slate">
              A patient’s own notes, or PubMed and clinical trials, ranked by turbopuffer. Exact terms
              match on keywords, questions match on meaning.
            </p>
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); submit(input); }} className="group relative max-w-[980px]">
          <Search className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-slate" size={20} />
          <input value={input} onChange={(e) => setInput(e.target.value)} onFocus={warmUp} aria-label="Search"
            placeholder={area === "notes" ? `Search ${patient ? `${patient.name}'s` : "a patient's"} notes` : "A drug, a gene, a trial ID or a clinical question"}
            className="h-[60px] w-full rounded-2xl border border-line bg-surface pr-28 pl-14 text-[17px] text-ink transition placeholder:text-slate/70 focus:border-ink focus:ring-4 focus:ring-ink/5 focus:outline-none" />
          <button type="submit" className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-ink-2">
            {loading ? <Loader2 size={17} className="animate-spin" /> : "Search"}
          </button>
        </form>

        <CorpusLine area={area} patient={patient} stats={stats} total={corpusTotal} />

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Segmented label="Search" value={area} onChange={(a) => setSources(({ lit: cur }) => ({ area: a, lit: cur }))} options={[
            { value: "notes", label: notesLabel, hint: patient
              ? `Only ${patient.name}'s chart notes, in their own turbopuffer namespace (ts-patient-${patient.id}). Synthetic, written by a script.`
              : "Pick a patient on the left to search their chart notes. Each patient has their own turbopuffer namespace." },
            { value: "literature", label: "Literature and trials", hint: "Public medical literature and trials. Pick abstracts, trials or both." },
          ]} />
          {area === "literature" && (
            <div role="group" aria-label="Sources" className="inline-flex flex-wrap gap-1.5">
              {LITERATURE.map((s) => (
                <Tip key={s} text={sourceHint(s, stats)}>
                  <button type="button" aria-pressed={lit.includes(s)} onClick={() => toggleLit(s)}
                    className={cx("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium",
                      lit.includes(s) ? "border-ink bg-ink text-white" : "border-line bg-surface text-slate hover:text-ink")}>
                    <span aria-hidden className={cx("size-1.5 rounded-full", { pubmed: "bg-pubmed", trials: "bg-trials", notes: "bg-notes" }[s],
                      lit.includes(s) && "ring-2 ring-white/70")} />
                    {LIT_LABEL[s]}
                  </button>
                </Tip>
              ))}
            </div>
          )}
          <Segmented label="Retrieval" value={mode} options={MODES} onChange={setMode} />
          <SettingsButton mode={mode} fusion={fusion} setFusion={setFusion} candidates={candidates} setCandidates={setCandidates}
            vectorMethod={vectorMethod} setVectorMethod={setVectorMethod} topK={topK} setTopK={setTopK} />
          <RankingButton ranking={ranking} setRanking={setRanking} mode={mode} sources={sources} patient={patient}
            rerank={mode === "hybrid" && fusion === "rerank"} />
        </div>

        {area === "notes" && !patient && (
          <p className="mt-4 rounded-xl border border-line bg-surface px-4 py-3 text-[13.5px] text-slate">Pick a patient on the left to search their notes.</p>
        )}

        {!q && (
          <div className="mt-10">
            <h2 className="text-[13px] font-semibold text-ink">Try one of these</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {examples.map((ex) => (
                <button key={ex} onClick={() => submit(ex)}
                  className="rounded-full border border-line bg-surface px-4 py-2 text-[13.5px] text-ink-2 hover:border-line-2 hover:text-ink">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <p className="mt-8 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

      {q && (
        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-x-10 xl:grid-cols-[240px_minmax(0,1fr)_400px]">
          <div className={cx("min-w-0", !facetsOpen && "max-lg:hidden")}>
            <FacetPanel data={facetData} loading={facetsLoading} refine={refine} toggle={toggleRefine} patient={patient}
              onClose={() => setFacetsOpen(false)} />
          </div>
          <section aria-label="Results" aria-busy={loading}>
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-[32px] leading-none tracking-tight">{data ? `${data.hits.length} results` : "Searching"}</h2>
              {data && <span className="text-[13.5px] text-slate">
                {MODES.find((m) => m.value === data.mode)?.label}{data.mode === "hybrid" ? ` (${data.fusion === "rerank" ? "model reranked" : `fused ${data.fusion === "server" ? "on turbopuffer" : "in app"}`})` : ""} search across {data.runs.length} source{data.runs.length > 1 ? "s" : ""}, {Math.round(data.wallMs)} ms
                {browserMs != null && ` · ${Math.round(browserMs)} ms in your browser`}
                {data.server?.cold && " · cold start"}
              </span>}
              <button type="button" onClick={() => setFacetsOpen(!facetsOpen)} aria-expanded={facetsOpen}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-2 lg:hidden">
                <Filter size={14} />Refine{activeRefinements ? ` (${activeRefinements})` : ""}
              </button>
            </div>
            <ActiveRefinements refine={refine} setRefine={setRefine} sources={sources} patient={patient}
              total={facetData.length === 1 ? facetData[0].total : null} />
            <div className={cx("mt-4 space-y-2.5 transition-opacity", loading && data && "opacity-50")}>
              {!data && loading && Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)}
              {data?.hits.length === 0 && <p className="py-10 text-slate">No matches. Try removing a refinement or picking different sources.</p>}
              {data && data.hits.length > 0 && (
                <GroupControls groupBy={groupBy} setGroupBy={setGroupBy} diversify={diversify} setDiversify={setDiversify}
                  sources={sources} />
              )}
              {data && (groupBy
                ? groupHits(data.hits, groupBy).map((g) => (
                  <section key={g.name} aria-label={g.name} className="pt-2">
                    <h3 className="mb-1.5 flex items-baseline gap-2 text-[13.5px] font-semibold text-ink">
                      {g.name}<span className="text-[12.5px] font-normal text-slate">{g.hits.length} result{g.hits.length > 1 ? "s" : ""} · best #{g.best}</span>
                    </h3>
                    <div className="space-y-2.5">
                      {g.hits.map((h) => (
                        <ResultCard key={h.key} hit={h} terms={queryWords(data.query)}
                          selected={h.key === selected} onSelect={() => setSelected(h.key === selected ? null : h.key)} />
                      ))}
                    </div>
                  </section>
                ))
                : data.hits.map((h) => (
                  <ResultCard key={h.key} hit={h} terms={data.hits.length ? queryWords(data.query) : []}
                    selected={h.key === selected} onSelect={() => setSelected(h.key === selected ? null : h.key)} />
                )))}
            </div>
          </section>

          {data && (
            <aside aria-live="polite"
              className={cx("rounded-2xl border border-line bg-surface xl:sticky xl:top-6 xl:max-h-[calc(100dvh-48px)] xl:overflow-y-auto",
                "max-xl:fixed max-xl:inset-x-3 max-xl:bottom-3 max-xl:z-40 max-xl:max-h-[72dvh] max-xl:overflow-y-auto max-xl:shadow-pop",
                !hit && "max-xl:hidden")}>
              {hit ? <HitExplainer hit={hit} data={data} onClose={() => setSelected(null)} /> : <RunOverview data={data} browserMs={browserMs} />}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function sourceHint(s: Source, stats: Record<string, CorpusStat>) {
  const n = (k: string) => (stats[k]?.rows ? stats[k].rows.toLocaleString() : null);
  return {
    pubmed: `${n("pubmed") ?? "About 71,000"} oncology and cardiology abstracts from PubMed (U.S. National Library of Medicine), 2015 onward.`,
    trials: `${n("trials") ?? "About 49,400"} interventional studies from ClinicalTrials.gov, most recently updated first.`,
    notes: "",
  }[s];
}


/** One quiet line: what's being searched and how big it is. Hover for how each number was fetched. */
function CorpusLine({ area, patient, stats, total }: {
  area: Area; patient: Patient | null; stats: Record<string, CorpusStat>; total: number;
}) {
  if (area === "notes") {
    return (
      <p className="mt-2.5 text-[12.5px] text-slate">
        {patient ? <>Searching only {patient.name}’s notes, in namespace <span className="font-mono">ts-patient-{patient.id}</span>.</> : "No patient selected."}
      </p>
    );
  }
  if (!stats.pubmed) return null;
  const rows = ([["pubmed", "abstracts"], ["trials", "trials"]] as [string, string][])
    .filter(([k]) => stats[k]);
  return (
    <div className="mt-2.5 text-[12.5px] text-slate">
      <Tip align="left" text={
        <span className="block space-y-1.5">
          {rows.map(([k, label]) => stats[k] && (
            <span key={k} className="block">
              <b className="font-semibold">{stats[k].namespace}</b>: {stats[k].rows.toLocaleString()} {label} from an aggregate Count
              query ({stats[k].countMs} ms){stats[k].bytes != null && <>; {gb(stats[k].bytes!)} stored, from namespace metadata ({stats[k].metadataMs} ms), about
              ${(stats[k].bytes! / 1e9 * 0.33).toFixed(2)} a month at $0.33 per GB</>}.
            </span>
          ))}
          <span className="block text-white/70">Refreshed every 10 minutes.</span>
        </span>
      }>
        <button type="button" className="inline-flex items-center gap-1.5 text-left hover:text-ink">
          <Info size={13} aria-hidden />
          {rows.map(([k, label]) => `${(stats[k]?.rows ?? 0).toLocaleString()} ${label}`).join(" · ")}
          {total > 0 && ` · ${gb(total)} stored`}
        </button>
      </Tip>
    </div>
  );
}


function queryWords(q: string) {
  return [...new Set(q.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? [])].filter((w) =>
    !["after", "before", "with", "from", "that", "this", "what", "does", "about", "patient", "patients"].includes(w));
}

/** Group the shown results (display only), and ask turbopuffer to cap results per sponsor/journal/status/year. */
function GroupControls({ groupBy, setGroupBy, diversify, setDiversify, sources }: {
  groupBy: GroupKey | ""; setGroupBy: (g: GroupKey | "") => void;
  diversify: ReturnType<typeof parseDiversify>; setDiversify: (d: ReturnType<typeof parseDiversify>) => void; sources: Source[];
}) {
  const kinds = sources.map((s) => s) as ("notes" | "pubmed" | "trials")[];
  const meaning = (g: (typeof GROUPS)[number]) => [...new Set(kinds.map((k) => g.perKind[k]))].join(" / ");
  const select = "rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-ink-2";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-1 text-[13px] text-slate">
      <label className="inline-flex items-center gap-2">
        Group by
        <select className={select} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupKey | "")}>
          <option value="">None</option>
          {GROUPS.map((g) => <option key={g.key} value={g.key}>{g.key === "source" ? "Source" : `${g.label} (${meaning(g)})`}</option>)}
        </select>
      </label>
      <Tip text="Asks turbopuffer to return at most this many results per value (limit.per on each subquery), so one sponsor or journal can't fill the page. Applied before fusion or reranking.">
        <label className="inline-flex items-center gap-2">
          At most
          <select className={select} value={diversify?.per ?? 0}
            onChange={(e) => { const per = Number(e.target.value); setDiversify(per ? { by: diversify?.by ?? "org", per } : null); }}>
            <option value={0}>any number</option>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          per
          <select className={select} value={diversify?.by ?? "org"} disabled={!diversify}
            onChange={(e) => setDiversify({ by: e.target.value as GroupKey, per: diversify?.per ?? 2 })}>
            {DIVERSIFIABLE.map((g) => <option key={g.key} value={g.key}>{meaning(g) || g.label}</option>)}
          </select>
        </label>
      </Tip>
    </div>
  );
}

function ResultCard({ hit, terms, selected, onSelect }: { hit: Hit; terms: string[]; selected: boolean; onSelect: () => void }) {
  return (
    <article tabIndex={0} onClick={onSelect}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onSelect(); } }}
      className={cx("cursor-pointer rounded-2xl border bg-surface px-5 pt-4 pb-3 transition",
        selected ? "border-accent ring-4 ring-accent/10" : "border-line hover:border-line-2")}>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-slate">
        <SourceTag kind={hit.kind} />
        {hit.code && <span className="font-mono text-[12px] text-ink-2">{hit.code}</span>}
        {hit.meta.map((m) => <span key={m}>{m}</span>)}
        {hit.rrfRank != null && hit.rrfRank !== hit.nsRank && (
          <Tip text={`The reranker moved this from #${hit.rrfRank} (RRF) to #${hit.nsRank}.`}>
            <span className={cx("ml-auto tabular-nums font-semibold", hit.rrfRank > hit.nsRank ? "text-trials" : "text-slate")}>
              {hit.rrfRank > hit.nsRank ? `▲${hit.rrfRank - hit.nsRank}` : `▼${hit.nsRank - hit.rrfRank}`}
            </span>
          </Tip>
        )}
        {hit.rrfRank === null && hit.rerankScore != null && (
          <Tip text="Not in RRF's top results: the reranker pulled it up from deeper in the candidates.">
            <span className="ml-auto font-semibold text-trials">new</span>
          </Tip>
        )}
        <span className={cx("tabular-nums", hit.rerankScore == null || hit.rrfRank === hit.nsRank ? "ml-auto" : "")}>#{hit.overall}</span>
      </div>
      <h3 className="mt-2 text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-ink">{highlight(hit.title, terms)}</h3>
      <p className="mt-1.5 max-w-[82ch] text-[14px] leading-relaxed text-ink-2">{highlight(hit.snippet, terms)}</p>
      <div className="mt-3 flex items-center gap-5 text-[13px]">
        <button onClick={(e) => { e.stopPropagation(); onSelect(); }} aria-expanded={selected}
          className={cx("inline-flex items-center gap-1.5 font-medium", selected ? "text-accent" : "text-slate hover:text-accent")}>
          <Info size={15} />Explain
        </button>
        {hit.url && (
          <a href={hit.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 font-medium text-slate hover:text-accent">
            Open on {hit.kind === "pubmed" ? "PubMed" : "ClinicalTrials.gov"}<ArrowUpRight size={14} />
          </a>
        )}
        {hit.kind === "trials" && hit.code && (
          <Link href={`/trials/${hit.code}`} onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 font-medium text-slate hover:text-accent">
            <ClipboardCheck size={15} />Eligibility &amp; sites
          </Link>
        )}
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-line bg-surface px-5 py-4">
      <div className="h-3 w-40 rounded bg-paper" />
      <div className="mt-3 h-4 w-3/4 rounded bg-paper" />
      <div className="mt-2.5 h-3 w-full rounded bg-paper" />
      <div className="mt-1.5 h-3 w-5/6 rounded bg-paper" />
    </div>
  );
}

/**
 * Soft ranking: boosts and recency added to the keyword (BM25) side. Unlike filters they never remove a result. Each
 * control is off by default; turning one on re-runs the search. Vector-only search has no keyword side to boost.
 */
function RankingButton({ ranking, setRanking, mode, sources, patient, rerank }: {
  ranking: Ranking; setRanking: (r: Ranking) => void; mode: Mode; sources: Source[]; patient: Patient | null; rerank: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const vectorOnly = mode === "vector" || rerank;
  const kinds = sources.map((s) => (s === "notes" ? "notes" : s)) as ("notes" | "pubmed" | "trials")[];
  const on = BOOSTS.filter((b) => (ranking[b.key] ?? 0) > 0);
  const relevant = on.filter((b) => b.kinds.some((k) => kinds.includes(k)));
  const set = (key: keyof Ranking, v: number) => setRanking({ ...ranking, [key]: v });
  const select = "rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink focus:border-accent focus:outline-none";

  return (
    <div ref={ref} className="relative">
      <Tip text={rerank ? "The model reranker rescores every candidate, so boosts are off while Model rerank is selected." : vectorOnly ? "Boosts apply to keyword ranking, so they're off in vector-only search." : "Boost recruiting, recent or higher-evidence results without filtering anything out."}>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} disabled={vectorOnly}
          className={cx("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium disabled:opacity-50",
            relevant.length && !vectorOnly ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink-2 hover:border-line-2")}>
          <ArrowUpWideNarrow size={15} />Ranking{relevant.length && !vectorOnly ? ` (${relevant.length})` : ""}
        </button>
      </Tip>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[min(92vw,440px)] animate-fade-in rounded-2xl border border-line bg-surface p-5 shadow-pop">
          <h3 className="text-[13px] font-semibold text-ink">Ranking boosts</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate">
            Added to the keyword score (relevance scaled 0–1), so they move results up without hiding any. The vector side is
            unchanged; in hybrid mode RRF fuses the two lists as usual. All off by default.
          </p>
          <div className="mt-3 divide-y divide-line">
            {BOOSTS.map((b) => {
              const v = (ranking[b.key] ?? 0) as Strength;
              const applies = b.kinds.some((k) => kinds.includes(k));
              const needsPatient = b.key === "patientMatch" && !patient;
              return (
                <div key={b.key} className={cx("py-2.5", (!applies || needsPatient) && "opacity-60")}>
                  <div className="flex items-center gap-3">
                    <Tip text={b.hint} align="left"><span className="text-[13px] font-medium text-ink">{b.label}</span></Tip>
                    <span className="text-[11.5px] text-slate">{b.kinds.join(", ")}</span>
                    <div role="radiogroup" aria-label={b.label} className="ml-auto inline-flex rounded-md border border-line p-0.5">
                      {([0, 1, 2, 3] as Strength[]).map((s) => (
                        <button key={s} type="button" role="radio" aria-checked={v === s} onClick={() => set(b.key, s)}
                          title={s ? `+${STRENGTH_WEIGHT[s]} at most` : "off"}
                          className={cx("rounded px-2 py-0.5 text-[12px]", v === s ? "bg-ink text-white" : "text-slate hover:text-ink")}>
                          {STRENGTH_LABEL[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {b.key === "recent" && v > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-slate">
                      Half weight at
                      <select className={select} value={ranking.recentMidpoint ?? DEFAULT_MIDPOINT}
                        onChange={(e) => set("recentMidpoint", Number(e.target.value))}>
                        {[2012, 2015, 2018, 2020, 2022, 2024].map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                      , ¾ by
                      <select className={select} value={ranking.recentSpan ?? DEFAULT_SPAN}
                        onChange={(e) => set("recentSpan", Number(e.target.value))}>
                        {[[2, "+2 years (sharp)"], [4, "+4 years"], [8, "+8 years (gentle)"]].map(([n, l]) => <option key={n} value={n}>{l}</option>)}
                      </select>
                    </div>
                  )}
                  {!applies && v > 0 && <p className="mt-1 text-[12px] text-slate">Not used for the sources you&apos;re searching.</p>}
                  {needsPatient && v > 0 && <p className="mt-1 text-[12px] text-slate">Pick a patient on the left for this to apply.</p>}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[12px] text-slate">{on.length ? `${on.length} on` : "Nothing boosted"}</span>
            <button type="button" disabled={!isActive(ranking)}
              onClick={() => setRanking({ recentMidpoint: ranking.recentMidpoint, recentSpan: ranking.recentSpan })}
              className="text-[12.5px] text-slate underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-40">
              Turn all off
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * Search settings: the technical knobs (how hybrid fuses, approximate vs exact vectors, results per source), kept out of
 * the main row so faceted refinement is the primary way to narrow a search.
 */
function SettingsButton({ mode, fusion, setFusion, candidates, setCandidates, vectorMethod, setVectorMethod, topK, setTopK }: {
  mode: Mode; fusion: Fusion; setFusion: (f: Fusion) => void; candidates: number; setCandidates: (n: number) => void;
  vectorMethod: "ann" | "exact"; setVectorMethod: (m: "ann" | "exact") => void; topK: number; setTopK: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const changed = (mode === "hybrid" && fusion !== "server") || (mode !== "bm25" && vectorMethod === "exact") || topK !== 10;
  const summary = [
    mode === "hybrid" ? { server: "turbopuffer RRF", app: "in-app RRF", rerank: "model rerank" }[fusion] : null,
    mode !== "bm25" && vectorMethod === "exact" ? "exact vectors" : null,
    topK !== 10 ? `${topK} per source` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={cx("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium",
          changed ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink-2 hover:border-line-2")}>
        <Settings2 size={15} />Search settings{changed && summary ? `: ${summary}` : ""}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[min(92vw,460px)] animate-fade-in space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-pop">
          <div className={cx(mode !== "hybrid" && "opacity-55")}>
            <p className="mb-1.5 text-[13px] font-semibold text-ink">Fused by {mode !== "hybrid" && <span className="font-normal text-slate">(hybrid only)</span>}</p>
            <Segmented label="Fusion" value={fusion} options={FUSIONS} onChange={setFusion} />
            {fusion === "rerank" && mode === "hybrid" && (
              <label className="mt-2 flex items-center gap-2 text-[12.5px] text-slate">
                Candidates per list sent to the model
                <select value={candidates} onChange={(e) => setCandidates(Number(e.target.value))}
                  className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink">
                  {CANDIDATES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className={cx(mode === "bm25" && "opacity-55")}>
            <p className="mb-1.5 text-[13px] font-semibold text-ink">Vector search {mode === "bm25" && <span className="font-normal text-slate">(not used by BM25)</span>}</p>
            <Segmented label="Vector search" value={vectorMethod} options={VECTOR_METHODS} onChange={setVectorMethod} />
          </div>
          <label className="block text-[13px] font-semibold text-ink">Results per source <b className="tabular-nums">{topK}</b>
            <input type="range" min={5} max={30} value={topK} onChange={(e) => setTopK(Number(e.target.value))}
              className="mt-1 block w-full accent-[var(--color-accent)]" />
          </label>
        </div>
      )}
    </div>
  );
}

const SOURCE_TITLE: Record<Source, string> = { trials: "Clinical trials", pubmed: "PubMed", notes: "Patient notes" };
const FACET_PREVIEW = 6;

/**
 * The faceted-search panel: per source, each facet's values with counts scoped to the query. Ticking a value re-runs the
 * search with that filter applied in turbopuffer, and every count refreshes (a facet's own counts ignore its own picks).
 */
function FacetPanel({ data, loading, refine, toggle, patient, onClose }: {
  data: SourceFacets[]; loading: boolean; refine: Refine; toggle: (k: FacetKey, v: string) => void; patient: Patient | null;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!data.length && loading) {
    return <div className="space-y-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-paper" />)}</div>;
  }
  if (!data.length) return null;
  return (
    <nav aria-label="Refine results" className={cx("min-w-0 space-y-5 transition-opacity", loading && "opacity-60")}>
      <div className="flex items-center justify-between lg:hidden">
        <span className="text-[14px] font-semibold text-ink">Refine</span>
        <button type="button" onClick={onClose} aria-label="Close refinements" className="rounded-lg bg-paper p-1.5 text-slate"><X size={16} /></button>
      </div>
      {data.map((src) => (
        <section key={src.namespace} aria-label={SOURCE_TITLE[src.source]}>
          <Tip align="left" text={`Counts from aggregate Count queries with group_by on ${src.namespace}, ${src.scoped
            ? "limited to documents containing your search words" : "over the whole source"}. ${src.ms} ms for all facets.`}>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate">
              {SOURCE_TITLE[src.source]}{src.total != null && <span className="ml-1.5 font-normal normal-case tracking-normal">{src.total.toLocaleString()} matches</span>}
            </h3>
          </Tip>
          <div className="mt-2 space-y-4">
            {src.facets.filter((f) => f.values.length || f.error).map((f) => {
              const open = expanded[f.key];
              const shown = open ? f.values : [...f.values.slice(0, FACET_PREVIEW), ...f.values.slice(FACET_PREVIEW).filter((v) => v.selected)];
              const more = f.values.length - shown.length;
              return (
                <fieldset key={f.key}>
                  <Tip align="left" text={f.hint}><legend className="mb-1 text-[13px] font-semibold text-ink">{f.label}</legend></Tip>
                  {f.error && <p className="text-[12px] text-amber-800">Couldn&apos;t count this facet.</p>}
                  <ul className="space-y-0.5">
                    {shown.map((v) => (
                      <li key={v.value}>
                        <label className={cx("flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-1 py-0.5 text-[13px] hover:bg-paper",
                          !v.count && !v.selected && "opacity-45")}>
                          <input type="checkbox" checked={v.selected} disabled={!v.count && !v.selected}
                            onChange={() => toggle(f.key, v.value)} className="shrink-0 translate-y-[1px] accent-[var(--color-accent)]" />
                          <span className={cx("min-w-0 flex-1 truncate", v.selected ? "font-medium text-ink" : "text-ink-2")} title={v.label}>
                            {f.key === "patientFit" ? valueLabel(facetDef(f.key)!, v.value, patient) : v.label}
                          </span>
                          <span className="shrink-0 pl-2 tabular-nums text-[12px] text-slate">{v.count.toLocaleString()}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {(more > 0 || open) && f.values.length > FACET_PREVIEW && (
                    <button type="button" onClick={() => setExpanded((e) => ({ ...e, [f.key]: !open }))}
                      className="mt-0.5 px-1 text-[12.5px] text-accent hover:underline">
                      {open ? "Show fewer" : `Show ${more} more`}
                    </button>
                  )}
                </fieldset>
              );
            })}
          </div>
        </section>
      ))}
      <p className="text-[11.5px] leading-relaxed text-slate">
        Counts cover documents containing your search words. Within a facet, picks combine with OR; across facets, with AND.
      </p>
    </nav>
  );
}

/** The active refinements as removable chips, above the results. */
function ActiveRefinements({ refine, setRefine, sources, patient, total }: {
  refine: Refine; setRefine: (r: Refine) => void; sources: Source[]; patient: Patient | null; total: number | null;
}) {
  const chips = Object.entries(refine).flatMap(([k, vals]) => {
    const def = facetDef(k);
    if (!def || !sources.includes(def.kind)) return [];
    return (vals ?? []).map((v) => ({ key: def.key, value: v, text: `${def.label}: ${valueLabel(def, v, patient)}` }));
  });
  if (!chips.length) return null;
  const remove = (key: FacetKey, value: string) => setRefine({ ...refine, [key]: (refine[key] ?? []).filter((x) => x !== value) });
  const clearAll = () => setRefine(Object.fromEntries(Object.entries(refine).filter(([k]) => !sources.includes(facetDef(k)!.kind))));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <button key={`${c.key}:${c.value}`} type="button" onClick={() => remove(c.key, c.value)}
          className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 text-[12.5px] text-ink-2 hover:border-accent">
          {c.text}<X size={12} aria-label="Remove" />
        </button>
      ))}
      <button type="button" onClick={clearAll} className="ml-1 text-[12.5px] text-slate underline decoration-dotted underline-offset-2 hover:text-ink">
        Clear all
      </button>
      {total != null && <span className="ml-auto text-[12.5px] text-slate">{total.toLocaleString()} matching documents</span>}
    </div>
  );
}
