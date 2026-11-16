"use client";
// The right-hand panel: how the search ran, or why one result ranked where it did.
import { useEffect, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type { Accuracy, FusionCheck, Hit, NamespaceRun, SearchResponse, Verification } from "@/lib/types";
import { cx, SourceTag } from "./ui";

// ---------------------------------------------------------------- deferred RRF verification (FUSION_VERIFY=lazy)

// One request per (search, namespace), shared by the overview badge and every result's Explain panel.
const verifications = new Map<string, Promise<Verification>>();

function verificationFor(data: SearchResponse, run: NamespaceRun): Promise<Verification> {
  const key = `${data.query}|${run.namespace}|${JSON.stringify(run.request)}`;
  let p = verifications.get(key);
  if (!p) {
    const hits = data.hits.filter((h) => h.namespace === run.namespace).sort((a, b) => a.nsRank - b.nsRank)
      .map((h) => ({ id: h.id, score: h.fused }));
    p = fetch("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: run.namespace, request: run.request, hits }) })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j as Verification; });
    p.catch(() => verifications.delete(key)); // let a failed check be retried
    verifications.set(key, p);
  }
  return p;
}

/** The check for one namespace: inline when the search already ran it, otherwise fetched on demand. */
function useVerification(data: SearchResponse, run: NamespaceRun | undefined, auto: boolean) {
  const [state, setState] = useState<{ v: Verification | null; loading: boolean; error: boolean }>({ v: null, loading: false, error: false });
  const lazy = !!run?.verifyLater && !run.check;
  const load = () => {
    if (!run || !lazy) return;
    setState((s) => ({ ...s, loading: true, error: false }));
    verificationFor(data, run).then((v) => setState({ v, loading: false, error: false }), () => setState({ v: null, loading: false, error: true }));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setState({ v: null, loading: false, error: false }); if (auto && lazy) load(); }, [data, run?.namespace, auto]);
  return { ...state, lazy, load };
}

/** Where one search's time went, from your browser down to turbopuffer. */
function TimeBreakdown({ data, browserMs }: { data: SearchResponse; browserMs: number | null }) {
  const tpuf = Math.max(0, ...data.runs.map((r) => r.serverMs ?? 0));
  const route = data.server?.routeMs ?? null;
  const rows: [string, string | null, string][] = [
    ["In your browser", browserMs != null ? `${Math.round(browserMs)} ms` : null, "from pressing Search to the results on screen"],
    ["App server", route != null ? `${route} ms` : null, data.server?.cold ? "a cold start: this instance's first request" : `warm instance, up ${data.server?.ageS ?? "?"} s`],
    ["Search, all sources", `${Math.round(data.wallMs)} ms`, "turbopuffer requests in parallel, plus merging"],
    ["turbopuffer server", `${tpuf} ms`, "slowest source, as turbopuffer reports it"],
  ];
  const outside = browserMs != null && route != null ? Math.max(0, Math.round(browserMs - route)) : null;
  return (
    <div className="mt-4 rounded-xl border border-line p-3">
      <p className="text-[12.5px] font-semibold text-ink">Where the time went</p>
      <table className="mt-1 w-full text-[12.5px]">
        <tbody>
          {rows.map(([label, value, note]) => (
            <tr key={label}>
              <td className="py-0.5 pr-2 text-ink-2">{label}</td>
              <td className="py-0.5 pr-2 text-right font-semibold tabular-nums">{value ?? "–"}</td>
              <td className="py-0.5 text-slate">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {outside != null && (
        <p className="mt-1 text-[12px] leading-relaxed text-slate">
          {outside} ms happened outside the app server: the network between you and Vercel, Vercel&apos;s routing and sign-in
          check, sending the results, and drawing them.
        </p>
      )}
    </div>
  );
}

export function RunOverview({ data, browserMs = null }: { data: SearchResponse; browserMs?: number | null }) {
  const n = data.runs.length;
  const how = {
    hybrid: data.fusion === "rerank"
      ? "Each request runs a vector search and a BM25 keyword search in one multi_query, and turbopuffer has a relevance model read every candidate against your query and reorder them (rerank_by). The two lists also come back unfused, so each result shows where RRF would have put it."
      : data.fusion === "server"
      ? "Each request runs a vector search and a BM25 keyword search in one multi_query, and turbopuffer fuses the two lists itself with reciprocal rank fusion (rerank_by [\"RRF\"]). The app recomputes the fusion from the unfused lists to check it."
      : "Each request runs a vector search and a BM25 keyword search together in one multi_query, then the app fuses the two lists.",
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
      <TimeBreakdown data={data} browserMs={browserMs} />
      <div className="mt-4 divide-y divide-line">
        {data.runs.map((r) => <RunRow key={r.namespace} run={r} mode={data.mode} query={data.query} data={data} />)}
      </div>
      <p className="mt-4 text-[12.5px] text-slate">Select a result to see why it ranked where it did.</p>
    </div>
  );
}

function RunRow({ run, mode, query, data }: { run: NamespaceRun; mode: SearchResponse["mode"]; query: string; data: SearchResponse }) {
  const ver = useVerification(data, run, false);
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
      {run.fusion === "server" && (ver.lazy && !ver.v
        ? (
          <button type="button" onClick={ver.load} disabled={ver.loading}
            className="mt-1.5 block text-[12.5px] text-slate underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-60">
            {ver.loading ? "Checking against the app's RRF…" : ver.error ? "Couldn't check. Try again" : "Check turbopuffer's RRF against the app's"}
          </button>
        )
        : <FusionBadge check={ver.v?.check ?? run.check ?? null} />)}
      {run.ranking && <RankingNote ranking={run.ranking} />}
      {run.vectorSearch && (
        <p className={cx("mt-1.5 text-[12.5px]", run.vectorSearch.error ? "text-amber-800" : "text-slate")}>
          {run.vectorSearch.error ?? (run.vectorSearch.method === "knn"
            ? "Vector side ran exact (kNN): every document that passed the filters was compared."
            : "Vector side ran approximate (ANN) on turbopuffer's index.")}
        </p>
      )}
      {run.rerank && <RerankNote rerank={run.rerank} serverMs={run.serverMs} />}
      {run.diversify && (
        <p className="mt-1.5 text-[12.5px] text-slate">
          Diversified: at most {run.diversify.per} per <span className="font-mono">{run.diversify.attribute}</span> in each list (limit.per).
        </p>
      )}
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
      {run.request != null && <PlanAndConsistency run={run} mode={mode} />}
      {run.request != null && mode !== "bm25" && <AnnAccuracy run={run} query={query} />}
    </div>
  );
}

/**
 * On request: how accurate ANN was for this query. turbopuffer's recall endpoint runs ANN and an exhaustive search
 * itself (for this query, and for 20 sampled vectors), and the app times the same vector query both ways.
 */
function AnnAccuracy({ run, query }: { run: NamespaceRun; query: string }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [out, setOut] = useState<Accuracy | null>(null);
  const go = async () => {
    setState("loading");
    try {
      const r = await fetch("/api/accuracy", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: run.namespace, query, request: run.request }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setOut(j); setState("idle");
    } catch {
      setState("error");
    }
  };
  if (!out) {
    return (
      <button type="button" onClick={go} disabled={state === "loading"}
        className="mt-1.5 block text-[12.5px] text-slate underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-60">
        {state === "loading" ? "Comparing ANN with exact search…" : state === "error" ? "Couldn't check. Try again" : "Check ANN accuracy (vs exact)"}
      </button>
    );
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const failed = (x: object): x is { error: string } => "error" in x;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-line p-3 text-[12.5px] leading-relaxed">
      <p className="font-semibold text-ink">ANN accuracy, top {out.topK}</p>
      {"skipped" in out.timing ? (
        <p className="text-ink-2">This query: <span className="text-slate">{out.timing.skipped}</span></p>
      ) : failed(out.timing) ? (
        <p className="text-ink-2">This query: <span className="text-slate">exact comparison unavailable ({out.timing.error})</span></p>
      ) : (
        <>
          <p className="text-ink-2">
            This query: <b className="tabular-nums">{pct(out.timing.overlap)}</b> of the exact top {out.topK} also found by ANN
            {out.timing.onlyExact.length
              ? <span className="text-slate"> (missed {out.timing.onlyExact.slice(0, 5).join(", ")}{out.timing.onlyExact.length > 5 ? "…" : ""})</span>
              : null}
          </p>
          <table className="mt-1 w-full">
            <thead><tr className="text-slate"><th className="text-left font-normal" /><th className="text-right font-normal">server</th><th className="text-right font-normal">round trip</th></tr></thead>
            <tbody>
              <tr><td className="text-ink-2">Approximate (ANN)</td><td className="text-right tabular-nums">{out.timing.annServerMs ?? "–"} ms</td><td className="text-right tabular-nums text-slate">{Math.round(out.timing.annRoundMs)} ms</td></tr>
              <tr><td className="text-ink-2">Exact (kNN)</td><td className="text-right tabular-nums">{out.timing.knnServerMs ?? "–"} ms</td><td className="text-right tabular-nums text-slate">{Math.round(out.timing.knnRoundMs)} ms</td></tr>
            </tbody>
          </table>
        </>
      )}
      <p className="text-ink-2">
        Namespace sample: {failed(out.sampled) ? <span className="text-slate">unavailable ({out.sampled.error})</span>
          : <><b className="tabular-nums">{pct(out.sampled.recall)}</b> average recall over {out.sampled.searches} random searches (turbopuffer recall endpoint)</>}
      </p>
    </div>
  );
}

/** How much the reranker changed the order, and what it cost compared with the same retrieval without it. */
function RerankNote({ rerank, serverMs }: { rerank: NonNullable<NamespaceRun["rerank"]>; serverMs: number | null }) {
  if (rerank.error) return <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12.5px] text-amber-900">{rerank.error}</p>;
  const extra = serverMs != null && rerank.retrievalServerMs != null ? Math.max(0, serverMs - rerank.retrievalServerMs) : null;
  return (
    <div className="mt-1.5 rounded-lg bg-accent-soft/60 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-2">
      Reranked by <span className="font-mono">{rerank.model}</span> over up to {rerank.candidates} candidates per list. Changed{" "}
      {rerank.changedTop} of the shown positions versus RRF (average move {rerank.avgShift.toFixed(1)} places)
      {extra != null ? <>; about {Math.round(extra)} ms of server time on top of retrieval ({rerank.retrievalServerMs} ms).</> : "."}
    </div>
  );
}

/** Which boosts this source's keyword subquery ran with, which didn't apply, and any step-down after a rejection. */
function RankingNote({ ranking }: { ranking: NonNullable<NamespaceRun["ranking"]> }) {
  return (
    <div className="mt-1.5 rounded-lg bg-accent-soft/60 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-2">
      {ranking.applied.length
        ? <>Keyword ranking boosted: {ranking.applied.join(", ")} (relevance = Saturate(BM25, midpoint {ranking.bm25Midpoint}), 0–1).</>
        : <>No boosts applied here.</>}
      {ranking.skipped.length > 0 && <span className="text-slate"> Skipped: {ranking.skipped.join("; ")}.</span>}
      {ranking.error && <span className="block text-amber-800">{ranking.error}. {ranking.applied.length ? "Ran without the per-result breakdown." : "Ran as plain BM25."}</span>}
    </div>
  );
}

/** Did turbopuffer's RRF agree with the app's? Shown under each namespace when fusion ran on turbopuffer. */
function FusionBadge({ check }: { check: FusionCheck | null }) {
  if (!check) {
    return <p className="mt-1.5 text-[12.5px] text-slate">Fused on turbopuffer. Verification is off (FUSION_VERIFY=off), so per-list ranks aren&apos;t shown.</p>;
  }
  const diff = check.maxScoreDiff < 1e-9 ? "0" : check.maxScoreDiff.toExponential(1);
  return (
    <div className={cx("mt-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] leading-relaxed",
      check.matches ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900")}>
      {check.matches
        ? <>✓ turbopuffer&apos;s RRF matches the app&apos;s: {check.sameIds}/{check.compared} positions identical
          {check.tieSwaps ? `, ${check.tieSwaps} swapped within an exact score tie` : ""}, max score difference {diff}.</>
        : <>⚠ turbopuffer&apos;s RRF differs from the app&apos;s
          {check.firstMismatch ? ` at #${check.firstMismatch.position} (turbopuffer ${check.firstMismatch.server}, app ${check.firstMismatch.app})` : ""}
          ; {check.sameIds}/{check.compared} positions identical, max score difference {diff}.</>}
      <span className="text-slate"> Check request: {Math.round(check.verifyMs)} ms.</span>
    </div>
  );
}

type Explained = { plans: string[]; strong: { roundMs: number; serverMs: number | null }; eventual: { roundMs: number; serverMs: number | null } };

/**
 * On request: turbopuffer's own query plan for this search, and the same search timed with strong and eventual
 * consistency. Strong (the default) checks object storage for the latest writes first; eventual skips that check.
 */
function PlanAndConsistency({ run, mode }: { run: NamespaceRun; mode: SearchResponse["mode"] }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [out, setOut] = useState<Explained | null>(null);
  const go = async () => {
    setState("loading");
    try {
      const r = await fetch("/api/explain", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: run.namespace, request: run.request }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setOut(j); setState("idle");
    } catch {
      setState("error");
    }
  };
  const labels = mode === "hybrid" ? ["Vector subquery", "BM25 subquery"] : [mode === "vector" ? "Vector query" : "BM25 query"];
  if (!out) {
    return (
      <button type="button" onClick={go} disabled={state === "loading"}
        className="mt-1.5 block text-[12.5px] text-slate underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-60">
        {state === "loading" ? "Asking turbopuffer…" : state === "error" ? "Couldn't load. Try again" : "Query plan and consistency"}
      </button>
    );
  }
  const row = (label: string, t: Explained["strong"]) => (
    <tr><td className="py-0.5 pr-3 text-ink-2">{label}</td><td className="py-0.5 pr-3 text-right tabular-nums">{t.serverMs ?? "–"} ms</td>
      <td className="py-0.5 text-right tabular-nums text-slate">{t.roundMs} ms</td></tr>
  );
  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-line p-3">
      <div>
        <p className="text-[12.5px] font-semibold text-ink">Consistency</p>
        <table className="mt-1 w-full text-[12.5px]">
          <thead><tr className="text-slate"><th className="pr-3 text-left font-normal" /><th className="pr-3 text-right font-normal">server</th><th className="text-right font-normal">round trip</th></tr></thead>
          <tbody>{row("Strong (default)", out.strong)}{row("Eventual", out.eventual)}</tbody>
        </table>
        <p className="mt-1 text-[12px] leading-relaxed text-slate">
          Strong checks object storage for the newest writes first, so a just-saved note always shows up. Eventual skips that
          check and can be faster, but may miss writes from the last moment. Run once each, just now, so expect some noise.
        </p>
      </div>
      {out.plans.map((plan, i) => (
        <details key={i} className="group" open={i === 0}>
          <summary className="cursor-pointer text-[12.5px] font-semibold text-ink">Query plan: {labels[i] ?? `Subquery ${i + 1}`}</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-paper p-3 font-mono text-[11px] leading-snug text-ink-2">{plan}</pre>
        </details>
      ))}
    </div>
  );
}

/** Three columns of rank ticks: meaning, keywords and the fused result, with this document's path drawn through them. */
function RankLadder({ hit, topK, mode }: { hit: Hit; topK: number; mode: SearchResponse["mode"] }) {
  // Meaning on the left, keywords on the right, both flowing into the fused rank in the middle.
  // Cap the ladder so it stays compact (deeper ranks sit at the bottom).
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

export function HitExplainer({ hit: shown, data, onClose, closeLabel = "Back to search overview" }:
  { hit: Hit; data: SearchResponse; onClose: () => void; closeLabel?: string }) {
  const k = data.rrfK;
  const run = data.runs.find((r) => r.namespace === shown.namespace)!;
  // With deferred verification, the per-list ranks arrive when this panel opens; merge them into the hit.
  const ver = useVerification(data, run, true);
  const sig = ver.v?.signals[shown.id];
  const hit: Hit = sig ? { ...shown, vector: sig.vector, bm25: sig.bm25, appFused: sig.appFused } : shown;
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

      {hit.boost && (
        <>
          <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">Keyword score with boosts</h4>
          <div className="rounded-xl bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-7 text-ink-2">
            <div>relevance (BM25 → 0–1)&nbsp;&nbsp;{hit.boost.relevance.toFixed(3)}</div>
            {hit.boost.parts.map((p) => (
              <div key={p.key} className={p.value ? "" : "text-slate"}>
                + {p.label.toLowerCase()}&nbsp;&nbsp;{p.raw.toFixed(2)} × {p.weight} = {p.value.toFixed(3)}
              </div>
            ))}
            <div className="mt-1 border-t border-line pt-1 font-semibold text-ink">
              keyword score = {hit.boost.total.toFixed(3)}{hit.bm25 ? ` → #${hit.bm25.rank} in the keyword list` : ""}
            </div>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate">
            Each part was computed by turbopuffer (compute_attributes) with the same expressions used to rank. Boosts add to the
            keyword score only; {data.mode === "hybrid" ? "the vector rank is unchanged, and RRF fuses the boosted keyword rank with it below." : "this is the score the results are sorted by."}
          </p>
        </>
      )}

      {hit.rerankScore != null && (
        <>
          <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">Model rerank</h4>
          <div className="rounded-xl bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-7 text-ink-2">
            <div>model score&nbsp;&nbsp;{hit.rerankScore.toFixed(4)}</div>
            <div>RRF would rank&nbsp;&nbsp;{hit.rrfRank != null ? `#${hit.rrfRank}` : "outside the candidates"}{hit.appFused != null ? ` (RRF ${hit.appFused.toFixed(4)})` : ""}</div>
            <div className="mt-1 border-t border-line pt-1 font-semibold text-ink">
              reranked → #{hit.nsRank} in {run.short}
              {hit.rrfRank != null && hit.rrfRank !== hit.nsRank ? (hit.rrfRank > hit.nsRank ? ` (▲${hit.rrfRank - hit.nsRank})` : ` (▼${hit.nsRank - hit.rrfRank})`) : " (same as RRF)"}
            </div>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate">
            The model read this document&apos;s text together with your query and scored the match directly; the vector and keyword
            ranks below only decided whether it made the candidate list. The RRF lines show what plain fusion would have done.
          </p>
        </>
      )}

      {data.mode === "hybrid" && (
        <>
          <h4 className="mt-5 mb-2 text-[13px] font-semibold text-ink">{data.fusion === "rerank" ? "What RRF would have done" : "How the two rankings were combined"}</h4>
          {ver.loading && <p className="mb-2 text-[12.5px] text-slate">Fetching this result&apos;s vector and keyword ranks…</p>}
          {ver.error && <p className="mb-2 text-[12.5px] text-amber-800">Couldn&apos;t fetch the per-list ranks for this result.</p>}
          <div className="rounded-xl bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-7 text-ink-2">
            {hit.vector && <div>vector&nbsp;&nbsp;1/({k}+{hit.vector.rank}) = {(1 / (k + hit.vector.rank)).toFixed(4)}</div>}
            {hit.bm25 && <div>bm25&nbsp;&nbsp;&nbsp;&nbsp;1/({k}+{hit.bm25.rank}) = {(1 / (k + hit.bm25.rank)).toFixed(4)}</div>}
            {data.fusion === "server" ? (
              <>
                {hit.appFused != null && <div className="mt-1 border-t border-line pt-1">app&apos;s RRF&nbsp;&nbsp;= {hit.appFused.toFixed(4)}</div>}
                <div className={cx("font-semibold text-ink", hit.appFused == null && "mt-1 border-t border-line pt-1")}>
                  turbopuffer = {hit.fused.toFixed(4)} → #{hit.nsRank} in {run.short}
                  {hit.appFused != null && (Math.abs(hit.appFused - hit.fused) < 1e-6 ? " ✓" : " ≠")}
                </div>
              </>
            ) : data.fusion === "rerank" ? (
              <div className="mt-1 border-t border-line pt-1 font-semibold text-ink">
                RRF = {hit.appFused != null ? hit.appFused.toFixed(4) : "–"} → would be #{hit.rrfRank ?? "–"} (reranked to #{hit.nsRank})
              </div>
            ) : (
              <div className="mt-1 border-t border-line pt-1 font-semibold text-ink">fused = {hit.fused.toFixed(4)} → #{hit.nsRank} in {run.short}</div>
            )}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate">
            Reciprocal rank fusion adds 1/({k} + rank) from each list, so showing up in both lists beats a high rank in one.
            {data.fusion === "server"
              ? (hit.appFused != null
                ? " turbopuffer computed this result's score and position (rerank_by [\"RRF\"], returned in $dist); the lines above are the app's own arithmetic over the unfused lists, as a check."
                : " turbopuffer computed this result's score and position; with verification off there are no per-list ranks to show.")
              : data.fusion === "rerank" ? " Shown for comparison only: the reranker's score set the order."
              : " The app did this arithmetic itself, from the two lists turbopuffer returned."}
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
