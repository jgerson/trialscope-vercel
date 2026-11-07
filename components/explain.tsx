"use client";
// The right-hand panel: how the search ran, or why one result ranked where it did.
import { useEffect } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type { Hit, NamespaceRun, SearchResponse } from "@/lib/types";
import { cx, SourceTag } from "./ui";

export function RunOverview({ data }: { data: SearchResponse }) {
  const n = data.runs.length;
  const how = {
    hybrid: "Each request runs a vector search and a BM25 keyword search together in one multi_query, then fuses the two lists.",
    vector: "Each request is a vector search: turbopuffer embeds the query and walks its nearest-neighbor index.",
    bm25: "Each request is a BM25 keyword search over the inverted index.",
  }[data.mode];
  return (
    <div className="animate-slide-in p-5">
      <h3 className="text-[15px] font-semibold text-ink">How turbopuffer ran this search</h3>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-[34px] font-bold tracking-[-0.02em] tabular-nums">{Math.round(data.wallMs)} ms</span>
        <span className="text-[13px] text-slate">{n} request{n > 1 ? "s" : ""} in parallel</span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-slate">{how}{n > 1 ? " Results from each source are then merged by rank." : ""}</p>
      <div className="mt-4 divide-y divide-line">
        {data.runs.map((r) => <RunRow key={r.namespace} run={r} />)}
      </div>
      <p className="mt-4 text-[12.5px] text-slate">Select a result to see why it ranked where it did.</p>
    </div>
  );
}

function RunRow({ run }: { run: NamespaceRun }) {
  return (
    <div className="py-3">
      <div className="flex items-baseline gap-2">
        <SourceTag kind={run.kind} label={run.short} />
        {run.docs != null && <span className="text-xs text-slate tabular-nums">~{run.docs.toLocaleString()} docs</span>}
        <span className="ml-auto text-[13px] font-semibold tabular-nums">{run.serverMs ?? 0} ms</span>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-slate">
        {run.hits} hits. Server time includes {run.embeddingMs ?? 0} ms to embed the query; {run.cache ?? "unknown"} cache;{" "}
        {Math.round(run.roundMs)} ms round trip.
      </p>
      {run.filters.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {run.filters.map((f) => <span key={f} className="rounded-md bg-paper px-2 py-0.5 text-xs text-ink-2">{f}</span>)}
        </div>
      )}
      <details className="mt-1.5 group">
        <summary className="cursor-pointer text-[12.5px] text-slate hover:text-ink">Request sent</summary>
        <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-paper p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {JSON.stringify(run.request, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/** Three columns of rank ticks: meaning, keywords and the fused result, with this document's path drawn through them. */
function RankLadder({ hit, topK, mode }: { hit: Hit; topK: number; mode: SearchResponse["mode"] }) {
  // Meaning on the left, keywords on the right, both flowing into the fused rank in the middle.
  // Full text fetches up to 100 passages; cap the ladder so it stays compact (deeper ranks sit at the bottom).
  const rows = Math.min(30, Math.max(topK, hit.vector?.rank ?? 0, hit.bm25?.rank ?? 0, hit.nsRank));
  const W = 300, top = 40, gap = 12, H = top + (rows - 1) * gap + 14;
  const y = (rank: number) => top + (Math.min(rank, rows) - 1) * gap;
  const center = { x: 150, label: mode === "hybrid" ? "Fused" : "Result", sig: { rank: hit.nsRank } };
  const sides = [
    ...(mode !== "bm25" ? [{ x: mode === "vector" ? 60 : 50, label: "Meaning", sig: hit.vector, side: -1 }] : []),
    ...(mode !== "vector" ? [{ x: mode === "bm25" ? 240 : 250, label: "Keywords", sig: hit.bm25, side: 1 }] : []),
  ];
  const cols = [...sides, center];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
      aria-label={`Rank ${hit.vector ? hit.vector.rank : "none"} by meaning, ${hit.bm25 ? hit.bm25.rank : "none"} by keywords, ${hit.nsRank} after fusion`}>
      {cols.map((c) => (
        <g key={c.label}>
          <text x={c.x} y={11} textAnchor="middle" className="fill-slate text-[10.5px] font-medium">{c.label}</text>
          <text x={c.x} y={25} textAnchor="middle" className={c.sig ? "fill-ink text-[11.5px] font-bold" : "fill-slate text-[10.5px]"}>
            {c.sig ? `#${c.sig.rank}` : `not in top ${topK}`}
          </text>
          {Array.from({ length: rows }, (_, i) => (
            <line key={i} x1={c.x - 9} x2={c.x + 9} y1={y(i + 1)} y2={y(i + 1)} stroke="var(--color-line)" strokeWidth="2" strokeLinecap="round" />
          ))}
        </g>
      ))}
      {sides.map((c) => c.sig && (
        <path key={`p-${c.label}`}
          d={`M ${c.x - c.side * 11} ${y(c.sig.rank)} C ${(c.x + center.x) / 2} ${y(c.sig.rank)}, ${(c.x + center.x) / 2} ${y(center.sig.rank)}, ${center.x + c.side * 11} ${y(center.sig.rank)}`}
          fill="none" stroke="var(--color-accent)" strokeWidth="1.75" opacity="0.5" />
      ))}
      {cols.map((c) => c.sig && <circle key={`d-${c.label}`} cx={c.x} cy={y(c.sig.rank)} r={c === center ? 7 : 5.5} fill="var(--color-accent)" />)}
    </svg>
  );
}

function Signal({ title, sig, topK, children }: { title: string; sig: Hit["vector"]; topK: number; children: React.ReactNode }) {
  return (
    <div className={cx("rounded-xl border border-line p-3", !sig && "bg-paper")}>
      <div className="flex items-baseline justify-between text-[13.5px]">
        <span className={cx("font-semibold", sig ? "text-ink" : "text-slate")}>{title}</span>
        <span className="text-[12.5px] text-slate tabular-nums">{sig ? `#${sig.rank} of ${sig.of}` : `not in top ${topK}`}</span>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-slate">{children}</p>
    </div>
  );
}

export function HitExplainer({ hit, data, onClose, closeLabel = "Back to search overview" }:
  { hit: Hit; data: SearchResponse; onClose: () => void; closeLabel?: string }) {
  const k = data.rrfK;
  const run = data.runs.find((r) => r.namespace === hit.namespace)!;
  const multi = data.runs.length > 1;
  return (
    <div key={hit.key} className="animate-slide-in p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <SourceTag kind={hit.kind} />
          <h3 className="mt-1 text-[15px] font-semibold leading-snug text-ink">{hit.title}</h3>
        </div>
        <button onClick={onClose} aria-label={closeLabel} className="rounded-lg bg-paper p-1.5 text-slate hover:text-ink"><X size={16} /></button>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-[34px] font-bold tracking-[-0.02em] tabular-nums">#{hit.overall}</span>
        <span className="text-[13px] text-slate">overall{multi ? `, #${hit.nsRank} in ${run.short}` : ""}</span>
      </div>

      {hit.kind === "fulltext" && (
        <div className="mt-3 rounded-xl bg-fulltext-soft/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
          <b className="text-fulltext">Full-text passage.</b> Articles are stored as passages of about 450–600 words, split
          within sections. The best passage came from <b className="text-ink">{hit.section ?? "the body"}</b>
          {hit.chunk ? <> (passage {hit.chunk} of {String(hit.raw.chunks_total ?? "?")})</> : null}
          {(hit.passages ?? 1) > 1 ? <>; {hit.passages} passages from this article matched, and only the best one counts.</> : "."}
          {" "}Ranks below are among passages, not articles.
        </div>
      )}

      <div className="mt-3 rounded-xl border border-line px-2 pt-2 pb-1"><RankLadder hit={hit} topK={data.topK} mode={data.mode} /></div>

      <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">What matched</h4>
      <div className="space-y-2">
        {data.mode !== "bm25" && (
          <Signal title="Meaning (vector)" sig={hit.vector} topK={data.topK}>
            {hit.vector
              ? <>Cosine distance <b className="text-ink tabular-nums">{hit.vector.score.toFixed(3)}</b> between your query and this document, both embedded with {data.embedModel}. Lower is closer.</>
              : "Its meaning wasn't among the closest matches, so it arrived through keywords."}
          </Signal>
        )}
        {data.mode !== "vector" && (
          <Signal title="Keywords (BM25)" sig={hit.bm25} topK={data.topK}>
            {hit.bm25
              ? <>Score <b className="text-ink tabular-nums">{hit.bm25.score.toFixed(2)}</b>. {hit.terms.length
                ? <>Found {hit.terms.map((t, i) => <span key={t}>{i ? ", " : ""}<b className="text-ink">{t}</b></span>)}.</>
                : "Matching words are in text not shown on the card."} Rare words that appear often in a document score higher.</>
              : "No strong keyword match, so it was found by meaning alone."}
          </Signal>
        )}
      </div>

      {data.mode === "hybrid" && (
        <>
          <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">How the two rankings were combined</h4>
          <div className="rounded-xl bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-7 text-ink-2">
            {hit.vector && <div>vector&nbsp;&nbsp;1/({k}+{hit.vector.rank}) = {(1 / (k + hit.vector.rank)).toFixed(4)}</div>}
            {hit.bm25 && <div>bm25&nbsp;&nbsp;&nbsp;&nbsp;1/({k}+{hit.bm25.rank}) = {(1 / (k + hit.bm25.rank)).toFixed(4)}</div>}
            <div className="mt-1 border-t border-line pt-1 font-semibold text-ink">fused = {hit.fused.toFixed(4)} → #{hit.nsRank} in {run.short}</div>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate">
            Reciprocal rank fusion adds 1/({k} + rank) from each list, so showing up in both lists beats a high rank in one.
          </p>
        </>
      )}

      {multi && (
        <>
          <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">Merged with the other sources</h4>
          <div className="rounded-xl bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-7 text-ink-2">
            <div>1/({k}+{hit.nsRank}) = {hit.rrf.toFixed(4)}</div>
            <div className="mt-1 border-t border-line pt-1 font-semibold text-ink">#{hit.overall} of {data.hits.length} overall</div>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate">Every source&apos;s #1 scores the same, then #2, and so on. Ties keep the source order.</p>
        </>
      )}

      <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">Filters on {run.short}</h4>
      <div className="flex flex-wrap gap-1.5">
        {(run.filters.length ? run.filters : ["none"]).map((f) => <span key={f} className="rounded-md bg-paper px-2 py-0.5 text-xs text-ink-2">{f}</span>)}
      </div>

      {hit.url && (
        <a href={hit.url} target="_blank" rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-1 text-[13.5px] font-semibold text-accent hover:underline underline-offset-4">
          Open the full record <ArrowUpRight size={15} />
        </a>
      )}
    </div>
  );
}

/** The Explain panel for one result, opened as a side dialog over another view (the copilot, a note save). */
export function ExplainDialog({ hit, search, context, onClose }: { hit: Hit; search: SearchResponse; context: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Why this result: ${hit.title}`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/20" />
      <div className="relative h-full w-full max-w-[460px] overflow-y-auto border-l border-line bg-surface shadow-pop">
        <p className="border-b border-line px-5 py-3 text-[12.5px] text-slate">
          {context} <b className="font-medium text-ink-2">“{search.query}”</b>
        </p>
        <HitExplainer hit={hit} data={search} onClose={onClose} closeLabel="Close" />
      </div>
    </div>
  );
}
