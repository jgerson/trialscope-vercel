"use client";
// "What the save did": one note upsert explained. Insert or update and what changed, the row and schema sent to
// turbopuffer, where the time went (from turbopuffer's own write report), and a live search proving the note is findable.
import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import type { Hit, Note, Patient, SearchResponse, WriteReport } from "@/lib/types";
import { ExplainDialog } from "./explain";
import { cx, highlight } from "./ui";

const ms = (n: number) => (n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n).toLocaleString()} ms`);

const stripMd = (l: string) => l.replace(/^[#>*\-\d.\s]+/, "").replace(/[*_`]/g, "").trim();

/** Body lines that weren't in the previous version, as plain text. */
function addedLines(note: Note, previous: Note | null): string[] {
  const old = new Set((previous?.body ?? "").split("\n").map((l) => l.trim()));
  return note.body.split("\n").map((l) => l.trim()).filter((l) => l && !old.has(l) && /[a-z]{3}/i.test(l)).map(stripMd);
}

const FILLER = new Set(["a", "an", "the", "in", "of", "to", "and", "or", "on", "for", "at", "with", "by", "from", "is", "was"]);

// A phrase from what changed, so the search proves the edit itself is findable: the first new line of the body,
// else the title. At most 8 words, without trailing filler words.
function phraseFor(note: Note, previous: Note | null): string {
  const words = (addedLines(note, previous)[0] ?? stripMd(note.title)).replace(/[.,;:]+$/, "").split(/\s+/).slice(0, 8);
  while (words.length > 2 && FILLER.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(" ");
}

export function SaveDetails({ report, note, patient, savedAt }: { report: WriteReport; note: Note; patient: Patient; savedAt: number }) {
  const prev = report.previous;
  const changes = prev
    ? ([["title", "Title"], ["note_type", "Type"], ["visit_date", "Visit date"]] as const)
        .filter(([k]) => prev[k] !== note[k]).map(([k, label]) => ({ label, from: prev[k], to: note[k] }))
    : [];
  const bodyChanged = prev && prev.body !== note.body;

  return (
    <div className="mt-3 space-y-5 rounded-2xl border border-line bg-surface p-5 text-[13px]">
      <div>
        <p className="text-[15px] font-semibold text-ink">
          {report.kind === "update" ? "Updated an existing note" : "Inserted a new note"}{" "}
          <span className="font-normal text-slate">in</span>{" "}
          <span className="rounded-md bg-notes-soft px-1.5 py-px font-mono text-[12px] text-notes">{report.namespace}</span>
        </p>
        <p className="mt-1 text-slate">
          One <code className="font-mono text-[12px]">upsert_rows</code> write: turbopuffer inserts a row with a new id and
          replaces the row with an existing one.
          {report.rowsUpserted != null && ` ${report.rowsUpserted} row upserted.`}
          {report.billableBytes != null && ` ${report.billableBytes.toLocaleString()} billable bytes written.`}
        </p>
      </div>

      {report.kind === "update" && (
        <Section title="What changed">
          {!changes.length && !bodyChanged ? (
            <p className="text-slate">Nothing differed from the stored version; the row was rewritten as is.</p>
          ) : (
            <ul className="space-y-1.5">
              {changes.map((c) => (
                <li key={c.label}>
                  <span className="font-medium text-ink-2">{c.label}:</span>{" "}
                  <span className="text-slate line-through">{c.from || "empty"}</span> → <span className="text-ink">{c.to}</span>
                </li>
              ))}
              {bodyChanged && (
                <li>
                  <span className="font-medium text-ink-2">Body:</span>{" "}
                  {prev!.body.length.toLocaleString()} → {note.body.length.toLocaleString()} characters
                  {addedLines(note, prev).slice(0, 3).map((l, i) => (
                    <span key={i} className="mt-1 block rounded-md bg-trials-soft px-2 py-1 text-[12.5px] text-ink-2">+ {l}</span>
                  ))}
                </li>
              )}
            </ul>
          )}
        </Section>
      )}

      <Section title="Where the time went">
        <Timing report={report} />
      </Section>

      <Section title="What was sent">
        <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-paper p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {JSON.stringify({ upsert_rows: [report.row], distance_metric: "cosine_distance" }, null, 2)}
        </pre>
        <table className="mt-3 w-full text-left text-[12.5px]">
          <thead><tr className="text-slate"><th className="pb-1 pr-4 font-medium">Field</th><th className="pb-1 font-medium">How turbopuffer stores it</th></tr></thead>
          <tbody>
            {report.schema.map((f) => (
              <tr key={f.field} className="border-t border-line">
                <td className="py-1.5 pr-4 font-mono text-[12px] text-ink">{f.field}</td>
                <td className="py-1.5 text-ink-2">{f.stored}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[12px] text-slate">
          The app sends plain text; turbopuffer computes the embedding itself
          {report.embeddingTokens != null ? ` (${report.embeddingTokens.toLocaleString()} tokens this time)` : ""}.
        </p>
      </Section>

      <Section title="Prove it's searchable">
        <FindIt note={note} patient={patient} savedAt={savedAt} initial={phraseFor(note, prev)} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate">{title}</h3>
      {children}
    </div>
  );
}

// The write split by turbopuffer's own numbers: network (app server ↔ turbopuffer), server work, embedding, then the
// wait until a query returns the note.
function Timing({ report: r }: { report: WriteReport }) {
  const embed = r.embeddingMs ?? 0;
  const server = r.serverMs != null ? Math.max(0, r.serverMs - embed) : null;
  const network = r.serverMs != null ? Math.max(0, r.writeMs - r.serverMs) : null;
  const parts = [
    network != null && { label: "Network", ms: network, color: "bg-line-2" },
    server != null && { label: "turbopuffer write", ms: server, color: "bg-ink" },
    embed > 0 && { label: "Embedding", ms: embed, color: "bg-pubmed" },
    r.serverMs == null && { label: "Write", ms: r.writeMs, color: "bg-ink" },
    { label: "Until searchable", ms: r.visibleMs, color: "bg-trials" },
  ].filter(Boolean) as { label: string; ms: number; color: string }[];
  const total = parts.reduce((a, p) => a + p.ms, 0) || 1;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-paper" role="img"
        aria-label={parts.map((p) => `${p.label} ${ms(p.ms)}`).join(", ")}>
        {parts.map((p) => <div key={p.label} className={p.color} style={{ width: `${Math.max(1.5, (p.ms / total) * 100)}%` }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
        {parts.map((p) => (
          <li key={p.label} className="inline-flex items-center gap-1.5">
            <span className={cx("size-2 rounded-full", p.color)} aria-hidden />
            <span className="text-slate">{p.label}</span> <span className="font-semibold tabular-nums text-ink">{ms(p.ms)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] leading-relaxed text-slate">
        The write was acknowledged after {ms(r.writeMs)}, and a query returned the note {ms(r.visibleMs)} later: turbopuffer
        queries are strongly consistent by default, so a write is readable as soon as it&apos;s acknowledged. Looking up the
        previous version first took {ms(r.readMs)}.
      </p>
    </div>
  );
}

function FindIt({ note, patient, savedAt, initial }: { note: Note; patient: Patient; savedAt: number; initial: string }) {
  const [q, setQ] = useState(initial);
  const [state, setState] = useState<{ loading?: boolean; error?: string; data?: SearchResponse; hit?: Hit | null; after?: number }>({});
  const [explain, setExplain] = useState<Hit | null>(null);

  async function run() {
    if (!q.trim()) return;
    setState({ loading: true });
    try {
      const res = await fetch("/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, sources: ["notes"], mode: "hybrid", filters: {}, topK: 10, patientId: patient.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Search failed (${res.status})`);
      const d = data as SearchResponse;
      setState({ data: d, hit: d.hits.find((h) => h.id === note.id) ?? null, after: Date.now() - savedAt });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  }

  const { data, hit } = state;
  return (
    <div>
      <p className="mb-2 text-slate">Search this patient&apos;s notes for words from your edit and see where the note ranks.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search phrase"
          className="min-w-0 flex-1 rounded-lg border border-line-2 bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-ink-2" />
        <button type="submit" disabled={state.loading || !q.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-ink-2 disabled:bg-line-2">
          {state.loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}Search
        </button>
      </form>
      {state.error && <p className="mt-2 text-red-800">{state.error}</p>}
      {data && (
        hit ? (
          <p className="mt-2.5 leading-relaxed text-ink-2">
            Found at <b className="text-ink">#{hit.overall}</b> of {data.hits.length}
            {hit.vector && <> · <span className="text-slate">by meaning</span> #{hit.vector.rank}</>}
            {hit.bm25 ? <> · <span className="text-slate">by keywords</span> #{hit.bm25.rank}</> : <> · <span className="text-slate">no keyword match</span></>}
            {state.after != null && <span className="text-slate"> · searched {(state.after / 1000).toFixed(1)} s after saving</span>}
            {" "}
            <button type="button" onClick={() => setExplain(hit)} className="font-semibold text-accent underline underline-offset-2">Why this rank?</button>
          </p>
        ) : (
          <p className="mt-2.5 text-slate">Not in the top {data.hits.length} for this phrase. Try words that appear in the note.</p>
        )
      )}
      {data && !!data.hits.length && (
        <ol className="mt-3 divide-y divide-line rounded-xl border border-line">
          {data.hits.map((h) => {
            const mine = h.id === note.id;
            return (
              <li key={h.key} className={cx("flex gap-3 px-3.5 py-2.5", mine && "bg-trials-soft/60")}>
                <span className="w-6 shrink-0 pt-px text-right font-semibold tabular-nums text-ink">#{h.overall}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-ink">
                    <span className="font-medium">{highlight(h.title, h.terms)}</span>
                    {mine && <span className="rounded-md bg-trials px-1.5 py-px text-[11px] font-semibold text-white">Your edit</span>}
                  </p>
                  <p className="text-[12px] text-slate">
                    {h.meta.filter(Boolean).join(" · ")}
                    {" · "}meaning #{h.vector?.rank ?? "–"}{" · "}{h.bm25 ? `keywords #${h.bm25.rank}` : "no keyword match"}
                  </p>
                  {h.snippet && <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{highlight(h.snippet, h.terms)}</p>}
                </div>
                <button type="button" onClick={() => setExplain(h)}
                  className="shrink-0 self-start pt-px text-[12px] font-semibold text-ink-2 underline underline-offset-2 hover:text-accent">Why?</button>
              </li>
            );
          })}
        </ol>
      )}
      {explain && data && <ExplainDialog hit={explain} search={data} context="Search after saving:" onClose={() => setExplain(null)} />}
    </div>
  );
}
