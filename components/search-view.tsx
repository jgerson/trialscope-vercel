"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ClipboardCheck, Info, Loader2, Search, SlidersHorizontal } from "lucide-react";
import type { CorpusStat, Facet, Hit, Mode, Patient, SearchFilters, SearchResponse, Source } from "@/lib/types";
import { useApp } from "./app-shell";
import { useCorpus } from "@/lib/use-corpus";
import { HitExplainer, RunOverview } from "./explain";
import { cx, highlight, Segmented, SourceTag, Tip } from "./ui";

const EXAMPLES = ["trastuzumab cardiotoxicity monitoring", "EGFR exon 19 resistance after osimertinib",
  "pulsed field ablation for atrial fibrillation", "NCT03418961"];
const STATUSES = ["Recruiting", "Not yet recruiting", "Active not recruiting", "Completed", "Enrolling by invitation", "Terminated"];
const PHASES = ["Early phase 1", "Phase 1", "Phase 2", "Phase 3", "Phase 4"];
const NOTE_TYPES = ["Visit note", "Result", "Phone call", "Treatment plan", "Other"];
const LITERATURE: Source[] = ["pubmed", "trials"];
const LIT_LABEL: Record<Source, string> = { notes: "Patient notes", pubmed: "Abstracts", trials: "Trials" };
const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "hybrid", label: "Hybrid", hint: "Runs a meaning search and a keyword search in one request and merges the two ranked lists (reciprocal rank fusion). The best default." },
  { value: "vector", label: "Vector", hint: "Matches meaning: turbopuffer embeds your words and finds the closest documents, so it catches paraphrases and synonyms." },
  { value: "bm25", label: "BM25", hint: "Matches exact words, weighting rare ones more. Best for drug names, genes and trial ids." },
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
  const [filters, setFilters] = useState<SearchFilters>({});
  const [topK, setTopK] = useState(10);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [facetList, setFacetList] = useState<Facet[]>([]);
  const q = params.get("q") ?? "";
  const sources: Source[] = area === "notes" ? ["notes"] : lit;
  const sourcesKey = sources.join(",");

  const run = useCallback(async (query: string) => {
    if (!query.trim()) { setData(null); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, sources: sourcesKey.split(","), mode, filters, topK, patientId: patient?.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed.");
      setData(json); setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sourcesKey, mode, filters, topK, patient?.id]);

  // Re-run whenever the query in the URL or any control changes.
  useEffect(() => { setInput(q); run(q); }, [q, run]);

  // Facet counts for the sources being searched, with the other active filters applied.
  useEffect(() => {
    if (area === "notes" && !patient) { setFacetList([]); return; }
    const ctl = new AbortController();
    fetch("/api/facets", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ sources: sourcesKey.split(","), filters, patientId: patient?.id }),
    }).then((r) => r.json()).then((j) => setFacetList(j.facets ?? [])).catch(() => {});
    return () => ctl.abort();
  }, [area, sourcesKey, filters, patient?.id]);

  const submit = (text: string) => {
    const sp = new URLSearchParams({ q: text.trim() });
    if (area === "notes") sp.set("in", "notes");
    else if (lit.length < LITERATURE.length) sp.set("in", lit.join(","));
    if (mode !== "hybrid") sp.set("mode", mode);
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
  const groups = filterGroups(filters);
  const activeFilters = sources.reduce((n, s) => n + (groups[s] ?? 0), 0);
  const idle = Object.entries(groups).filter(([s, n]) => n && !sources.includes(s as Source)).map(([s]) => LIT_LABEL[s as Source]);
  const idleNames = idle.map((n) => n.toLowerCase());

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
          <input value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search"
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
          <FiltersButton filters={filters} setFilters={setFilters} topK={topK} setTopK={setTopK} active={activeFilters}
            sources={sources} patient={patient} />
        </div>

        {idleNames.length > 0 && (
          <p className="mt-2 text-[12.5px] text-slate">
            Filters for {idleNames.join(" and ")} are set but don’t apply, because {idleNames.length > 1 ? "those sources are" : "that source is"} off.
          </p>
        )}

        <FacetRow facets={facetList} />

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
        <div className="mt-8 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <section aria-label="Results" aria-busy={loading}>
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-[32px] leading-none tracking-tight">{data ? `${data.hits.length} results` : "Searching"}</h2>
              {data && <span className="text-[13.5px] text-slate">
                {MODES.find((m) => m.value === data.mode)?.label} search across {data.runs.length} source{data.runs.length > 1 ? "s" : ""}, {Math.round(data.wallMs)} ms
              </span>}
            </div>
            <div className={cx("mt-4 space-y-2.5 transition-opacity", loading && data && "opacity-50")}>
              {!data && loading && Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)}
              {data?.hits.length === 0 && <p className="py-10 text-slate">No matches. Try fewer filters or different sources.</p>}
              {data?.hits.map((h) => (
                <ResultCard key={h.key} hit={h} terms={data.hits.length ? queryWords(data.query) : []}
                  selected={h.key === selected} onSelect={() => setSelected(h.key === selected ? null : h.key)} />
              ))}
            </div>
          </section>

          {data && (
            <aside aria-live="polite"
              className={cx("rounded-2xl border border-line bg-surface xl:sticky xl:top-6 xl:max-h-[calc(100dvh-48px)] xl:overflow-y-auto",
                "max-xl:fixed max-xl:inset-x-3 max-xl:bottom-3 max-xl:z-40 max-xl:max-h-[72dvh] max-xl:overflow-y-auto max-xl:shadow-pop",
                !hit && "max-xl:hidden")}>
              {hit ? <HitExplainer hit={hit} data={data} onClose={() => setSelected(null)} /> : <RunOverview data={data} />}
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

/** How many filters are set per source. */
function filterGroups(f: SearchFilters): Record<Source, number> {
  const lit = [(f.yearFrom ?? 2015) > 2015, f.topic].filter(Boolean).length;
  return {
    trials: [f.status?.length, f.phases?.length, f.country, f.matchPatient].filter(Boolean).length,
    pubmed: lit,
    notes: [f.noteTypes?.length, f.visitFrom, f.visitTo].filter(Boolean).length,
  };
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

const FACET_LABEL: Record<Facet["source"], string> = { trials: "Trials by status", pubmed: "Abstracts by topic", notes: "Notes by type" };

/** Counts per value from one grouped aggregate query per source, for information. Filtering happens in the Filters panel. */
function FacetRow({ facets }: { facets: Facet[] }) {
  const shown = facets.filter((f) => f.groups.length);
  if (!shown.length) return null;
  return (
    <div className="mt-3 flex flex-col gap-1 text-[12.5px] text-slate">
      {shown.map((f) => (
        <p key={f.source}>
          <Tip align="left" text={`One aggregate Count query with group_by ["${f.field}"] on ${f.namespace}, ${f.ms} ms. Your other active filters apply.`}>
            <span className="mr-1.5 font-medium text-ink-2 underline decoration-dotted underline-offset-2">{FACET_LABEL[f.source]}</span>
          </Tip>
          {f.groups.slice(0, 8).map((g, i) => (
            <span key={g.value}>{i ? " · " : ""}{g.value[0].toUpperCase() + g.value.slice(1)} <span className="tabular-nums">{g.count.toLocaleString()}</span></span>
          ))}
        </p>
      ))}
    </div>
  );
}

function queryWords(q: string) {
  return [...new Set(q.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? [])].filter((w) =>
    !["after", "before", "with", "from", "that", "this", "what", "does", "about", "patient", "patients"].includes(w));
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
        <span className="ml-auto tabular-nums">#{hit.overall}</span>
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

function FiltersButton({ filters, setFilters, topK, setTopK, active, sources, patient }: {
  filters: SearchFilters; setFilters: (f: SearchFilters) => void; topK: number; setTopK: (n: number) => void;
  active: number; sources: Source[]; patient: Patient | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const toggle = (key: "status" | "phases" | "noteTypes", v: string) => {
    const cur = draft[key] ?? [];
    setDraft({ ...draft, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const chip = (on: boolean) => cx("rounded-full border px-3 py-1 text-[12.5px]",
    on ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-line-2");
  const notes = sources.includes("notes");
  const trials = sources.includes("trials");
  const lit = sources.includes("pubmed");
  const litName = "Abstracts";
  // Only the filters for the sources being searched are cleared; the rest are kept for when those sources come back.
  const cleared: SearchFilters = {
    ...draft,
    ...(notes ? { noteTypes: [], visitFrom: "", visitTo: "" } : {}),
    ...(trials ? { status: [], phases: [], country: "", matchPatient: false } : {}),
    ...(lit ? { yearFrom: 2015, topic: "" } : {}),
  };
  const date = "mt-1.5 block w-full rounded-lg border border-line px-3 py-1.5 text-[13.5px] text-ink focus:border-accent focus:outline-none";

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setDraft(filters); setOpen(!open); }} aria-expanded={open}
        className={cx("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium",
          active ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink-2 hover:border-line-2")}>
        <SlidersHorizontal size={15} />Filters{active ? ` (${active})` : ""}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[min(92vw,420px)] animate-fade-in rounded-2xl border border-line bg-surface p-5 shadow-pop">
          {notes && (<>
            <h3 className="text-[13px] font-semibold text-ink">{patient ? `${patient.name}'s notes` : "Patient notes"}</h3>
            <p className="mt-3 mb-1.5 text-[12.5px] text-slate">Note type</p>
            <div className="flex flex-wrap gap-1.5">{NOTE_TYPES.map((s) => <button key={s} className={chip(!!draft.noteTypes?.includes(s))} onClick={() => toggle("noteTypes", s)}>{s}</button>)}</div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-[12.5px] text-slate">Visit from
                <input type="date" value={draft.visitFrom ?? ""} onChange={(e) => setDraft({ ...draft, visitFrom: e.target.value })} className={date} />
              </label>
              <label className="block text-[12.5px] text-slate">Visit to
                <input type="date" value={draft.visitTo ?? ""} onChange={(e) => setDraft({ ...draft, visitTo: e.target.value })} className={date} />
              </label>
            </div>
          </>)}
          {trials && (<>
            <h3 className="text-[13px] font-semibold text-ink">Clinical trials</h3>
            <p className="mt-3 mb-1.5 text-[12.5px] text-slate">Status</p>
            <div className="flex flex-wrap gap-1.5">{STATUSES.map((s) => <button key={s} className={chip(!!draft.status?.includes(s))} onClick={() => toggle("status", s)}>{s}</button>)}</div>
            <p className="mt-3 mb-1.5 text-[12.5px] text-slate">Phase</p>
            <div className="flex flex-wrap gap-1.5">{PHASES.map((s) => <button key={s} className={chip(!!draft.phases?.includes(s))} onClick={() => toggle("phases", s)}>{s}</button>)}</div>
            <label className="mt-3 block text-[12.5px] text-slate">Country
              <input value={draft.country ?? ""} onChange={(e) => setDraft({ ...draft, country: e.target.value })} placeholder="United States" className={date} />
            </label>
            <label className={cx("mt-3 flex items-center gap-2 text-[13px] text-ink-2", !patient && "opacity-50")}>
              <input type="checkbox" disabled={!patient} checked={!!draft.matchPatient} onChange={(e) => setDraft({ ...draft, matchPatient: e.target.checked })}
                className="size-4 accent-[var(--color-accent)]" />
              {patient ? `Match ${patient.name.split(" ")[0]}'s age and sex (${patient.age}, ${patient.sex.toLowerCase()})` : "Match the selected patient's age and sex"}
            </label>
          </>)}
          {lit && (<>
            <h3 className={cx("text-[13px] font-semibold text-ink", trials && "mt-5")}>{litName}</h3>
            <label className="mt-2 block text-[12.5px] text-slate">Published from <b className="text-ink tabular-nums">{draft.yearFrom ?? 2015}</b>
              <input type="range" min={2015} max={2026} value={draft.yearFrom ?? 2015} onChange={(e) => setDraft({ ...draft, yearFrom: Number(e.target.value) })}
                className="mt-1 block w-full accent-[var(--color-accent)]" />
            </label>
            <div className="mt-2 flex gap-1.5">
              {(["", "oncology", "cardiology"] as const).map((t) => (
                <button key={t || "any"} className={chip((draft.topic ?? "") === t)} onClick={() => setDraft({ ...draft, topic: t })}>{t ? t[0].toUpperCase() + t.slice(1) : "Any topic"}</button>
              ))}
            </div>
          </>)}
          <label className="mt-5 block text-[12.5px] text-slate">Results per source <b className="text-ink tabular-nums">{topK}</b>
            <input type="range" min={5} max={30} value={topK} onChange={(e) => setTopK(Number(e.target.value))} className="mt-1 block w-full accent-[var(--color-accent)]" />
          </label>
          <div className="mt-5 flex justify-between">
            <button onClick={() => { setDraft(cleared); setFilters(cleared); setOpen(false); }} className="text-[13px] font-medium text-slate hover:text-ink">Clear these filters</button>
            <button onClick={() => { setFilters(draft); setOpen(false); }} className="rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:bg-ink-2">Apply filters</button>
          </div>
        </div>
      )}
    </div>
  );
}
