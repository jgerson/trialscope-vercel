"use client";
// Patient workspace: notes list, note editor and the copilot side by side.
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useUser } from "@clerk/nextjs";
import { Check, Loader2, Plus } from "lucide-react";
import type { Note, Patient } from "@/lib/types";
import { useApp } from "./app-shell";
import { Copilot } from "./copilot";
import { cx } from "./ui";

const TYPES = ["Visit note", "Result", "Phone call", "Treatment plan", "Other"];
const TEMPLATE = "## Subjective\n\n\n## Assessment\n\n\n## Plan\n- ";
const stageText = (p: Patient) => (!p.stage ? "" : /^(NYHA|Post|Parox|Persis)/.test(p.stage) ? p.stage : `Stage ${p.stage}`);

// The server credits a new note to the signed-in user; the name here is only what the draft shows.
function blank(author: string): Note {
  return { id: "", title: "", body: TEMPLATE, note_type: "Visit note", visit_date: new Date().toISOString().slice(0, 10), author };
}

export function Workspace({ patient, initialNotes }: { patient: Patient; initialNotes: Note[] }) {
  const { readOnly } = useApp();
  const { user } = useUser();
  const me = user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || "You";
  const [notes, setNotes] = useState(initialNotes);
  const [selId, setSelId] = useState<string>(initialNotes[0]?.id ?? "");
  const [draft, setDraft] = useState<Note>(initialNotes[0] ?? blank(me));
  const [tab, setTab] = useState<"write" | "read">("read");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ writeMs: number; visibleMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const original = useMemo(() => notes.find((n) => n.id === selId), [notes, selId]);
  const dirty = !original || original.title !== draft.title || original.body !== draft.body ||
    original.note_type !== draft.note_type || original.visit_date !== draft.visit_date;

  useEffect(() => {
    setNotes(initialNotes); setSelId(initialNotes[0]?.id ?? ""); setDraft(initialNotes[0] ?? blank(me));
    setSaved(null); setTab("read");
  }, [patient.id, initialNotes]);

  const open = (n: Note | null) => { setSelId(n?.id ?? ""); setDraft(n ?? blank(me)); setSaved(null); setError(null); setTab(n ? "read" : "write"); };

  const save = async () => {
    if (readOnly || saving) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: patient.id, note: draft }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed.");
      const note = json.note as Note;
      setNotes((ns) => [note, ...ns.filter((n) => n.id !== note.id)].sort((a, b) => b.visit_date.localeCompare(a.visit_date)));
      setSelId(note.id); setDraft(note); setSaved({ writeMs: json.writeMs, visibleMs: json.visibleMs });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="mx-auto grid max-w-[1600px] gap-6 px-5 py-8 sm:px-8 lg:px-10 2xl:grid-cols-[250px_minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_400px]">
      {/* patient header spans the row */}
      <header className="2xl:col-span-3 xl:col-span-2">
        <p className="text-[13px] text-slate">{patient.age}-year-old {patient.sex.toLowerCase()}, {patient.city}, {patient.state}</p>
        <h1 className="mt-1 font-display text-[44px] leading-[1.05] tracking-tight">{patient.name}</h1>
        <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
          <span className="rounded-lg bg-accent-soft px-2.5 py-1 font-semibold text-accent-strong">{patient.primary_dx}</span>
          {stageText(patient) && <span className="rounded-lg bg-surface px-2.5 py-1 text-ink-2 ring-1 ring-line">{stageText(patient)}</span>}
          {patient.biomarkers && <span className="rounded-lg bg-surface px-2.5 py-1 text-ink-2 ring-1 ring-line">{patient.biomarkers}</span>}
          <span className="rounded-lg bg-notes-soft px-2.5 py-1 font-mono text-[12px] text-notes">ts-patient-{patient.id}</span>
        </div>
      </header>

      {/* notes list */}
      <nav aria-label="Notes" className="max-2xl:hidden">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">Notes <span className="font-normal text-slate tabular-nums">{notes.length}</span></h2>
          <button onClick={() => open(null)} disabled={readOnly}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-accent hover:bg-accent-soft disabled:opacity-40">
            <Plus size={15} />New
          </button>
        </div>
        <ul className="mt-2 space-y-0.5">
          {notes.map((n) => (
            <li key={n.id}>
              <button onClick={() => open(n)}
                className={cx("w-full rounded-lg px-3 py-2 text-left", n.id === selId ? "bg-surface ring-1 ring-line" : "hover:bg-surface/60")}>
                <div className="truncate text-[13.5px] font-medium text-ink">{n.title}</div>
                <div className="text-[12px] text-slate">{n.visit_date} · {n.note_type}</div>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* editor */}
      <section className="min-w-0">
        <div className="mb-3 flex gap-2 2xl:hidden">
          <select value={selId} onChange={(e) => open(notes.find((n) => n.id === e.target.value) ?? null)} aria-label="Choose a note"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-[14px]">
            {notes.map((n) => <option key={n.id} value={n.id}>{n.visit_date}  {n.title}</option>)}
            {!selId && <option value="">New note</option>}
          </select>
          <button onClick={() => open(null)} disabled={readOnly} className="rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-accent disabled:opacity-40">New</button>
        </div>

        <div className="rounded-2xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
            <div role="tablist" className="flex gap-1">
              {(["read", "write"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={cx("rounded-md px-2.5 py-1 text-[13px] font-medium", tab === t ? "bg-paper text-ink" : "text-slate hover:text-ink")}>
                  {t === "read" ? "Read" : "Edit"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {saved && !dirty && (
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-accent-strong">
                  <Check size={14} />Saved in {(saved.writeMs / 1000).toFixed(2)} s, searchable {Math.round(saved.visibleMs)} ms later
                </span>
              )}
              <button onClick={save} disabled={readOnly || saving || !dirty}
                title={readOnly ? "Editing is turned off on this deployment" : "Save (⌘S)"}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-ink-2 disabled:bg-line-2">
                {saving && <Loader2 size={14} className="animate-spin" />}Save note
              </button>
            </div>
          </div>

          {tab === "write" ? (
            <div className="px-6 pt-5 pb-6">
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Untitled note" aria-label="Title"
                className="w-full bg-transparent text-[24px] font-bold tracking-[-0.02em] outline-none placeholder:text-line-2" />
              <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
                <select value={draft.note_type} onChange={(e) => setDraft({ ...draft, note_type: e.target.value })} aria-label="Note type"
                  className="rounded-lg border border-line bg-paper px-2.5 py-1.5">{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
                <input type="date" value={draft.visit_date} onChange={(e) => setDraft({ ...draft, visit_date: e.target.value })} aria-label="Visit date"
                  className="rounded-lg border border-line bg-paper px-2.5 py-1.5" />
                <span className="self-center text-slate">{draft.author}</span>
              </div>
              <AutoTextarea value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} />
              <p className="mt-2 text-[12px] text-slate">Markdown: ## for headings, - for lists. ⌘S saves.</p>
            </div>
          ) : (
            <article className="px-6 pt-5 pb-7">
              <h2 className="text-[24px] font-bold tracking-[-0.02em]">{draft.title || "Untitled note"}</h2>
              <p className="mt-1 text-[13px] text-slate">{draft.visit_date}, {draft.note_type.toLowerCase()} by {draft.author}</p>
              <div className="prose-ts mt-5 max-w-[72ch]"><ReactMarkdown>{draft.body}</ReactMarkdown></div>
            </article>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </section>

      <Copilot patient={patient} />
    </div>
  );
}

function AutoTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.max(280, el.scrollHeight)}px`; }
  }, [value]);
  return (
    <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Note"
      className="mt-5 w-full resize-none bg-transparent text-[15px] leading-7 text-ink-2 outline-none" />
  );
}
