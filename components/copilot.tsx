"use client";
// Copilot panel: streams Claude's answer, shows each turbopuffer call it makes, and turns [T1]-style tags into source cards.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ArrowUpRight, BookOpen, Check, ChevronRight, FileText, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import type { GroundingItem, Hit, Patient, SearchResponse, Usage } from "@/lib/types";
import { HitExplainer } from "./explain";
import { useApp } from "./app-shell";
import { cx, SourceTag } from "./ui";

interface Step {
  tool: string; input: Record<string, unknown>; results: number; ms: number;
  returned?: { tag: string; title: string; key: string }[]; reasoning?: string;
  filters?: { source: string; filters: string[] }[]; search?: SearchResponse;
}
interface Grounding { items: GroundingItem[]; ms: number; usage: Usage }
interface Turn {
  q: string; answer: string; steps: Step[]; cites: Record<string, Hit>; seconds?: number; error?: string; pending: boolean;
  usage?: Usage; checking?: boolean; grounding?: Grounding; groundingError?: string;
}

const TAG_RE = /\[([NPT]\d+)\]/g;
/** Tags the finished answer cites, or undefined while it is still being written. */
const citedIn = (t: Turn) => (t.seconds == null ? undefined : new Set([...t.answer.matchAll(TAG_RE)].map((m) => m[1])));

const SUGGESTIONS = (p: Patient) => [
  `Is there a recruiting trial ${p.name.split(" ")[0]} might qualify for?`,
  "What does recent literature say about the main risks of the current treatment?",
  "Summarize this patient's course so far.",
];

export function Copilot({ patient }: { patient: Patient }) {
  const { copilotEnabled } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const busy = turns.some((t) => t.pending);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { setTurns([]); }, [patient.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [turns]);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setInput("");
    const history = turns.filter((t) => !t.error && t.answer).flatMap((t) => [
      { role: "user", content: t.q }, { role: "assistant", content: t.answer },
    ]);
    const idx = turns.length;
    setTurns((ts) => [...ts, { q, answer: "", steps: [], cites: {}, pending: true }]);
    const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, i) => (i === idx ? fn(t) : t)));

    try {
      const res = await fetch("/api/copilot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: q }], patientId: patient.id }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "The copilot didn't respond.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "text") update((t) => ({ ...t, answer: t.answer + ev.delta }));
          else if (ev.type === "step") update((t) => ({ ...t, answer: "", steps: [...t.steps, ev] }));
          else if (ev.type === "citations") update((t) => ({ ...t, cites: ev.items }));
          else if (ev.type === "error") update((t) => ({ ...t, error: ev.message }));
          else if (ev.type === "usage") update((t) => ({ ...t, usage: ev.usage }));
          else if (ev.type === "done") update((t) => ({ ...t, seconds: ev.seconds }));
          else if (ev.type === "checking") update((t) => ({ ...t, checking: true }));
          else if (ev.type === "grounding") update((t) => ({ ...t, checking: false, grounding: { items: ev.items, ms: ev.ms, usage: ev.usage } }));
          else if (ev.type === "grounding_error") update((t) => ({ ...t, checking: false, groundingError: ev.message }));
        }
      }
    } catch (e) {
      update((t) => ({ ...t, error: (e as Error).message }));
    } finally {
      update((t) => ({ ...t, pending: false, checking: false }));
    }
  }

  return (
    <section aria-label="Copilot" className="flex min-h-[560px] flex-col rounded-2xl border border-line bg-surface xl:sticky xl:top-6 xl:max-h-[calc(100dvh-48px)]">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
        <Sparkles size={17} className="text-accent" />
        <h2 className="font-display text-[24px] leading-none">Copilot</h2>
        <span className="ml-auto text-[12px] text-slate">Searches notes, PubMed and trials</span>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {!turns.length && (
          <div>
            <p className="text-[14px] leading-relaxed text-ink-2">
              {copilotEnabled
                ? `Ask about ${patient.name.split(" ")[0]}, the literature or open trials. Every answer cites the notes, abstracts and trials it used.`
                : "The copilot is off on this deployment. Deploy on Vercel with AI Gateway enabled, or set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY, to turn it on. Search and notes work without it."}
            </p>
            <div className="mt-4 space-y-2">
              {SUGGESTIONS(patient).map((s) => (
                <button key={s} disabled={!copilotEnabled} onClick={() => ask(s)}
                  className="block w-full rounded-xl border border-line px-3.5 py-2.5 text-left text-[13.5px] text-ink-2 hover:border-line-2 hover:text-ink disabled:opacity-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => { const cited = citedIn(t); return (
          <div key={i}>
            <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-[14px] text-white">{t.q}</div>
            {t.steps.length > 0 && (
              <ol className="mt-3 space-y-1.5">
                {t.steps.map((s, j) => <StepRow key={j} step={s} cited={cited} />)}
              </ol>
            )}
            {t.pending && !t.answer && (
              <p className="mt-3 inline-flex items-center gap-2 text-[13px] text-slate"><Loader2 size={14} className="animate-spin" />
                {t.steps.length ? "Reading results" : "Planning the search"}</p>
            )}
            {t.answer && <Answer text={t.answer} cites={t.cites} />}
            {t.error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-800">{t.error}</p>}
            {(t.checking || t.grounding || t.groundingError) && <SourceCheck turn={t} />}
            {t.seconds != null && <AnswerFooter turn={t} cited={cited} />}
          </div>
        ); })}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-paper px-3 py-2 focus-within:border-accent">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} disabled={!copilotEnabled}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
            placeholder={copilotEnabled ? "Ask the copilot" : "Copilot is off"} aria-label="Ask the copilot"
            className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] outline-none placeholder:text-slate/70" />
          <button type="submit" aria-label="Send" disabled={!copilotEnabled || busy || !input.trim()}
            className="grid size-8 place-items-center rounded-lg bg-ink text-white disabled:bg-line-2"><ArrowUp size={16} /></button>
        </div>
      </form>
    </section>
  );
}

function StepRow({ step, cited }: { step: Step; cited?: Set<string> }) {
  const [explain, setExplain] = useState<Hit | null>(null);
  const isNotes = step.tool === "read_patient_notes";
  const usedCount = cited && step.returned ? step.returned.filter((r) => cited.has(r.tag)).length : null;
  const sources = (step.input.sources as string[] | undefined)?.join(", ");
  const filters = ["trial_status", "trial_phases", "country"].map((k) => step.input[k]).filter(Boolean).flat().join(", ");
  return (
    <li className="text-[12.5px] leading-relaxed text-slate">
      <details className="group">
        <summary className="flex cursor-pointer list-none gap-2.5 rounded-md hover:text-ink-2 [&::-webkit-details-marker]:hidden">
          <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
            {isNotes ? <FileText size={12} /> : <BookOpen size={12} />}
          </span>
          <span className="flex-1">
            {isNotes ? "Read the patient's notes" : <>Searched {sources} for <b className="font-medium text-ink-2">“{String(step.input.query)}”</b>{filters ? ` (${filters})` : ""}</>}
            <span className="tabular-nums">, {step.results} results in {Math.round(step.ms)} ms{usedCount != null ? `, ${usedCount} cited` : ""}</span>
          </span>
          <ChevronRight size={14} aria-hidden className="mt-1 shrink-0 transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-1.5 ml-7 space-y-2 rounded-lg border border-line bg-paper p-2.5">
          {step.reasoning && <Reasoning text={step.reasoning} />}
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate">Tool call: {step.tool}</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink-2">{JSON.stringify(step.input, null, 2)}</pre>
          </div>
          {step.filters && <AppliedFilters filters={step.filters} />}
          {!!step.returned?.length && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate">
                Returned to the model{cited ? " · cited in the answer or not" : ""}
              </p>
              <ul className="space-y-1">
                {step.returned.map((r) => {
                  const hit = step.search?.hits.find((h) => h.key === r.key);
                  const used = cited?.has(r.tag);
                  return (
                    <li key={r.tag} className={cx("flex gap-2", cited && !used && "opacity-55")}>
                      <span className="w-8 shrink-0 font-mono text-[11.5px] text-accent">{r.tag}</span>
                      <span className="min-w-0 flex-1 text-ink-2">
                        {r.title}
                        {hit && (
                          <button type="button" onClick={() => setExplain(hit)}
                            className="ml-1.5 whitespace-nowrap text-[11.5px] font-semibold text-accent underline underline-offset-2">
                            Why this result?
                          </button>
                        )}
                      </span>
                      {cited && (
                        used
                          ? <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-trials"><Check size={11} />cited</span>
                          : <span className="shrink-0 text-[11px] text-slate">not used</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </details>
      {explain && step.search && <ExplainDialog hit={explain} search={step.search} onClose={() => setExplain(null)} />}
    </li>
  );
}

// What each source actually filtered on, in words: "status is Recruiting", "min_age ≤ 58", "sex is female, All".
// The tool call above shows what the model asked for; this shows what turbopuffer was sent after translation.
function AppliedFilters({ filters }: { filters: { source: string; filters: string[] }[] }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate">Filters applied</p>
      <ul className="space-y-1">
        {filters.map((f) => (
          <li key={f.source} className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-[11.5px] font-semibold text-ink-2">{f.source}</span>
            {(f.filters.length ? f.filters : ["no filters"]).map((x) => (
              <span key={x} className="rounded-md border border-line bg-surface px-1.5 py-px text-[11.5px] text-ink-2">{x}</span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The search page's Explain panel, opened over the copilot for one result of one copilot search.
function ExplainDialog({ hit, search, onClose }: { hit: Hit; search: SearchResponse; onClose: () => void }) {
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
          Copilot search for <b className="font-medium text-ink-2">“{search.query}”</b>
        </p>
        <HitExplainer hit={hit} data={search} onClose={onClose} closeLabel="Close" />
      </div>
    </div>
  );
}

const REASONING_PREVIEW = 360;

function Reasoning({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > REASONING_PREVIEW;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate">Model&rsquo;s reasoning</p>
      <p className="whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-ink-2">
        {long && !all ? `${text.slice(0, REASONING_PREVIEW).trimEnd()}…` : text}
      </p>
      {long && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 text-[11.5px] font-semibold text-accent">
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

const VERDICT: Record<GroundingItem["verdict"], { label: string; dot: string; text: string }> = {
  supported: { label: "Supported", dot: "bg-trials", text: "text-trials" },
  partial: { label: "Partly supported", dot: "bg-notes", text: "text-notes" },
  unsupported: { label: "Not supported", dot: "bg-red-700", text: "text-red-800" },
  uncited: { label: "No source", dot: "bg-slate", text: "text-slate" },
};

// Each claim in the answer, checked by a second model call against the exact source text the copilot was given.
function SourceCheck({ turn }: { turn: Turn }) {
  if (turn.checking) {
    return (
      <p className="mt-3 inline-flex items-center gap-2 text-[12.5px] text-slate">
        <Loader2 size={13} className="animate-spin" />Checking each claim against its sources
      </p>
    );
  }
  if (turn.groundingError) return <p className="mt-3 text-[12px] text-slate">{turn.groundingError}</p>;
  const items = turn.grounding?.items ?? [];
  const counts = (Object.keys(VERDICT) as GroundingItem["verdict"][])
    .map((v) => [v, items.filter((i) => i.verdict === v).length] as const).filter(([, n]) => n);
  const flagged = items.some((i) => i.verdict !== "supported");
  return (
    <details className="group mt-3 rounded-xl border border-line" open={flagged}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12.5px] [&::-webkit-details-marker]:hidden">
        <ShieldCheck size={14} className={flagged ? "text-notes" : "text-trials"} />
        <span className="font-semibold text-ink">Source check</span>
        <span className="flex-1 text-slate">
          {items.length ? counts.map(([v, n]) => `${n} ${VERDICT[v].label.toLowerCase()}`).join(", ") : "no factual claims to check"}
        </span>
        <ChevronRight size={14} aria-hidden className="shrink-0 text-slate transition-transform group-open:rotate-90" />
      </summary>
      {!!items.length && (
        <ul className="space-y-2 border-t border-line px-3 py-2.5">
          {items.map((it, i) => (
            <li key={i} className="text-[12.5px] leading-relaxed">
              <div className="flex items-start gap-2">
                <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", VERDICT[it.verdict].dot)} aria-hidden />
                <div className="min-w-0">
                  <span className={cx("mr-1.5 font-semibold", VERDICT[it.verdict].text)}>{VERDICT[it.verdict].label}</span>
                  {!!it.tags.length && <span className="mr-1.5 font-mono text-[11px] text-slate">{it.tags.join(" ")}</span>}
                  <span className="text-ink-2">{it.claim}</span>
                  {it.note && it.verdict !== "supported" && <p className="mt-0.5 text-[12px] text-slate">{it.note}</p>}
                </div>
              </div>
            </li>
          ))}
          <li className="pt-1 text-[11.5px] text-slate">
            Checked by a second model call against the cited text only. It can be wrong too, so treat flags as prompts to look.
          </li>
        </ul>
      )}
    </details>
  );
}

const money = (d: number | null | undefined) =>
  d == null ? null : d < 0.01 ? `${(d * 100).toFixed(d < 0.001 ? 3 : 2)}¢` : `$${d.toFixed(2)}`;

function AnswerFooter({ turn, cited }: { turn: Turn; cited?: Set<string> }) {
  const u = turn.usage;
  const retrieved = Object.keys(turn.cites).length;
  const used = cited ? [...cited].filter((tag) => turn.cites[tag]).length : 0;
  const g = turn.grounding;
  const parts = [
    `${turn.seconds!.toFixed(1)} s`,
    `${used} of ${retrieved} sources cited`,
    u && `${u.calls} model call${u.calls === 1 ? "" : "s"}`,
    u && `${(u.inTokens + u.outTokens).toLocaleString()} tokens`,
    u && money(u.cost) && `≈ ${money(u.cost)}`,
    g && `check ${(g.ms / 1000).toFixed(1)} s${money(g.usage.cost) ? `, ≈ ${money(g.usage.cost)}` : ""}`,
  ].filter(Boolean);
  return (
    <p className="mt-2 text-[12px] text-slate" title={u ? `${u.inTokens.toLocaleString()} input and ${u.outTokens.toLocaleString()} output tokens at AI Gateway list prices` : undefined}>
      {parts.join(" · ")}
    </p>
  );
}

function Answer({ text, cites }: { text: string; cites: Record<string, Hit> }) {
  const linked = text.replace(/\[([NPT]\d+)\]/g, (m, tag) => (cites[tag] || !Object.keys(cites).length ? `[${tag}](#cite-${tag})` : m));
  return (
    <div className="prose-ts mt-3">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        // Tables scroll sideways inside the narrow panel instead of squeezing every column.
        table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
        a: ({ href, children }) => {
          const tag = href?.startsWith("#cite-") ? href.slice(6) : null;
          if (tag) return <Cite tag={tag} hit={cites[tag]} />;
          return <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">{children}</a>;
        },
      }}>{linked}</ReactMarkdown>
    </div>
  );
}

const CARD_W = 288;
const GAP = 8;

// The card is position: fixed, placed from the tag's on-screen box and kept inside the copilot panel, so the
// panel's scroll area can't clip it. It opens above the tag when there is room, otherwise below.
function Cite({ tag, hit }: { tag: string; hit?: Hit }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const color = tag[0] === "N" ? "bg-notes-soft text-notes" : tag[0] === "P" ? "bg-pubmed-soft text-pubmed" : "bg-trials-soft text-trials";

  useLayoutEffect(() => {
    if (!open || !btn.current || !card.current) { setPos(null); return; }
    const b = btn.current.getBoundingClientRect();
    const panel = btn.current.closest("section")?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth, top: 0 };
    const h = card.current.offsetHeight;
    const minLeft = Math.max(panel.left, 0) + GAP;
    const maxLeft = Math.min(panel.right, window.innerWidth) - CARD_W - GAP;
    const left = Math.max(minLeft, Math.min(b.left + b.width / 2 - CARD_W / 2, maxLeft));
    const above = b.top - h >= Math.max(panel.top, 0) + GAP;
    setPos({ left, top: above ? b.top - h : b.bottom });
  }, [open]);

  // A fixed card would drift away from its tag on scroll or resize, so close it instead.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open]);

  return (
    <span className="inline-block align-baseline" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={cx("mx-0.5 rounded-md px-1.5 py-px font-mono text-[11.5px] font-semibold", color)}>{tag}</button>
      {open && hit && (
        // The padding bridges the gap to the tag, so moving the mouse onto the card doesn't close it.
        <span ref={card} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: CARD_W, visibility: pos ? "visible" : "hidden" }}
          className="fixed z-50 block py-2">
          <span className="block animate-fade-in rounded-xl border border-line bg-surface p-3 text-left shadow-pop">
            <SourceTag kind={hit.kind} />
            <span className="mt-1 block text-[13px] font-semibold leading-snug text-ink">{hit.title}</span>
            <span className="mt-1 block text-[12px] text-slate">{[hit.code, ...hit.meta].filter(Boolean).join(", ")}</span>
            {hit.url && (
              <a href={hit.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent">
                Open the full record<ArrowUpRight size={13} />
              </a>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
