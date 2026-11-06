"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Info, Loader2, Search, SlidersHorizontal } from "lucide-react";
import type { Hit, Mode, Scope, SearchFilters, SearchResponse } from "@/lib/types";
import { useApp } from "./app-shell";
import { HitExplainer, RunOverview } from "./explain";
import { cx, highlight, Segmented, SourceTag } from "./ui";

const EXAMPLES = ["trastuzumab cardiotoxicity monitoring", "EGFR exon 19 resistance after osimertinib",
  "pulsed field ablation for atrial fibrillation", "NCT03418961"];
const STATUSES = ["Recruiting", "Not yet recruiting", "Active not recruiting", "Completed", "Enrolling by invitation", "Terminated"];
const PHASES = ["Early phase 1", "Phase 1", "Phase 2", "Phase 3", "Phase 4"];
const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "All" }, { value: "patient", label: "This patient" },
  { value: "literature", label: "Literature" }, { value: "trials", label: "Trials" },
];
const MODES: { value: Mode; label: string }[] = [{ value: "hybrid", label: "Hybrid" }, { value: "vector", label: "Vector" }, { value: "bm25", label: "BM25" }];

export function SearchView({ counts }: { counts: Record<string, number> }) {
  const params = useSearchParams();
  const router = useRouter();
  const { patient } = useApp();
  const [input, setInput] = useState(params.get("q") ?? "");
  const [scope, setScope] = useState<Scope>((params.get("scope") as Scope) || "all");
  const [mode, setMode] = useState<Mode>((params.get("mode") as Mode) || "hybrid");
  const [filters, setFilters] = useState<SearchFilters>({});
  const [topK, setTopK] = useState(10);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const q = params.get("q") ?? "";

  const run = useCallback(async (query: string) => {
    if (!query.trim()) { setData(null); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, scope, mode, filters, topK, patientId: patient?.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed.");
      setData(json); setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope, mode, filters, topK, patient?.id]);

  // Re-run whenever the query in the URL or any control changes.
  useEffect(() => { setInput(q); run(q); }, [q, run]);

  const submit = (text: string) => {
    const sp = new URLSearchParams({ q: text.trim() });
    if (scope !== "all") sp.set("scope", scope);
    if (mode !== "hybrid") sp.set("mode", mode);
    router.replace(`/?${sp.toString()}`, { scroll: false });
  };

  const hit = data?.hits.find((h) => h.key === selected) ?? null;
  const activeFilters = [filters.status?.length, filters.phases?.length, filters.country, filters.matchPatient,
    (filters.yearFrom ?? 2015) > 2015, filters.topic].filter(Boolean).length;

  return (
    <div className="mx-auto max-w-[1360px] px-5 pb-20 sm:px-8 lg:px-10">
      <div className={cx("transition-[padding] duration-300", q ? "pt-8" : "pt-[12vh]")}>
        {!q && (
          <div className="mb-8 max-w-[760px]">
            <h1 className="font-display text-[clamp(44px,6.5vw,84px)] leading-[0.95] tracking-tight text-ink text-balance">
              Search the chart and <em className="italic text-slate">the literature</em> at once.
            </h1>
            <p className="mt-4 max-w-[62ch] text-[16px] leading-relaxed text-slate">
              {patient ? `${patient.name}'s notes, ` : "Patient notes, "}
              {counts.pubmed ? `${counts.pubmed.toLocaleString()} PubMed abstracts and ${counts.trials.toLocaleString()} clinical trials` : "PubMed and clinical trials"},
              {" "}ranked together by turbopuffer. Exact terms match on keywords, questions match on meaning.
            </p>
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); submit(input); }} className="group relative max-w-[980px]">
          <Search className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-slate" size={20} />
          <input value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search"
            placeholder="A drug, a gene, a trial ID or a clinical question"
            className="h-[60px] w-full rounded-2xl border border-line bg-surface pr-28 pl-14 text-[17px] text-ink transition placeholder:text-slate/70 focus:border-ink focus:ring-4 focus:ring-ink/5 focus:outline-none" />
          <button type="submit" className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-ink-2">
            {loading ? <Loader2 size={17} className="animate-spin" /> : "Search"}
          </button>
        </form>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Segmented label="Search in" value={scope} options={SCOPES} onChange={setScope} />
          <Segmented label="Retrieval" value={mode} options={MODES} onChange={setMode} />
          <FiltersButton filters={filters} setFilters={setFilters} topK={topK} setTopK={setTopK} active={activeFilters} hasPatient={!!patient} />
        </div>

        {!q && (
          <div className="mt-10">
            <h2 className="text-[13px] font-semibold text-ink">Try one of these</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
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
              {data?.hits.length === 0 && <p className="py-10 text-slate">No matches. Try fewer filters or a different scope.</p>}
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

function FiltersButton({ filters, setFilters, topK, setTopK, active, hasPatient }: {
  filters: SearchFilters; setFilters: (f: SearchFilters) => void; topK: number; setTopK: (n: number) => void;
  active: number; hasPatient: boolean;
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
  const toggle = (key: "status" | "phases", v: string) => {
    const cur = draft[key] ?? [];
    setDraft({ ...draft, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const chip = (on: boolean) => cx("rounded-full border px-3 py-1 text-[12.5px]",
    on ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-line-2");

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setDraft(filters); setOpen(!open); }} aria-expanded={open}
        className={cx("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium",
          active ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink-2 hover:border-line-2")}>
        <SlidersHorizontal size={15} />Filters{active ? ` (${active})` : ""}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[min(92vw,420px)] animate-fade-in rounded-2xl border border-line bg-surface p-5 shadow-pop">
          <h3 className="text-[13px] font-semibold text-ink">Clinical trials</h3>
          <p className="mt-3 mb-1.5 text-[12.5px] text-slate">Status</p>
          <div className="flex flex-wrap gap-1.5">{STATUSES.map((s) => <button key={s} className={chip(!!draft.status?.includes(s))} onClick={() => toggle("status", s)}>{s}</button>)}</div>
          <p className="mt-3 mb-1.5 text-[12.5px] text-slate">Phase</p>
          <div className="flex flex-wrap gap-1.5">{PHASES.map((s) => <button key={s} className={chip(!!draft.phases?.includes(s))} onClick={() => toggle("phases", s)}>{s}</button>)}</div>
          <label className="mt-3 block text-[12.5px] text-slate">Country
            <input value={draft.country ?? ""} onChange={(e) => setDraft({ ...draft, country: e.target.value })} placeholder="United States"
              className="mt-1.5 block w-full rounded-lg border border-line px-3 py-1.5 text-[13.5px] text-ink focus:border-accent focus:outline-none" />
          </label>
          <label className={cx("mt-3 flex items-center gap-2 text-[13px] text-ink-2", !hasPatient && "opacity-50")}>
            <input type="checkbox" disabled={!hasPatient} checked={!!draft.matchPatient} onChange={(e) => setDraft({ ...draft, matchPatient: e.target.checked })}
              className="size-4 accent-[var(--color-accent)]" />
            Match the selected patient&apos;s age and sex
          </label>
          <h3 className="mt-5 text-[13px] font-semibold text-ink">PubMed</h3>
          <label className="mt-2 block text-[12.5px] text-slate">Published from <b className="text-ink tabular-nums">{draft.yearFrom ?? 2015}</b>
            <input type="range" min={2015} max={2026} value={draft.yearFrom ?? 2015} onChange={(e) => setDraft({ ...draft, yearFrom: Number(e.target.value) })}
              className="mt-1 block w-full accent-[var(--color-accent)]" />
          </label>
          <div className="mt-2 flex gap-1.5">
            {(["", "oncology", "cardiology"] as const).map((t) => (
              <button key={t || "any"} className={chip((draft.topic ?? "") === t)} onClick={() => setDraft({ ...draft, topic: t })}>{t ? t[0].toUpperCase() + t.slice(1) : "Any topic"}</button>
            ))}
          </div>
          <label className="mt-5 block text-[12.5px] text-slate">Results per source <b className="text-ink tabular-nums">{topK}</b>
            <input type="range" min={5} max={30} value={topK} onChange={(e) => setTopK(Number(e.target.value))} className="mt-1 block w-full accent-[var(--color-accent)]" />
          </label>
          <div className="mt-5 flex justify-between">
            <button onClick={() => { setDraft({}); setFilters({}); setOpen(false); }} className="text-[13px] font-medium text-slate hover:text-ink">Clear all</button>
            <button onClick={() => { setFilters(draft); setOpen(false); }} className="rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:bg-ink-2">Apply filters</button>
          </div>
        </div>
      )}
    </div>
  );
}
