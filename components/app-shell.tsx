"use client";
// App frame: sidebar with patient switcher, ⌘K command palette, and the selected-patient context.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { UserButton, useUser } from "@clerk/nextjs";
import { ArrowUpRight, FileText, Menu, Search, X } from "lucide-react";
import type { Patient } from "@/lib/types";
import { cx, Kbd, LogoMark } from "./ui";

interface Ctx {
  patients: Patient[];
  patient: Patient | null;
  selectPatient: (id: string, go?: boolean) => void;
  openPalette: () => void;
  copilotEnabled: boolean;
  readOnly: boolean;
}
const PatientCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(PatientCtx);
  if (!c) throw new Error("useApp outside AppShell");
  return c;
};

const stageText = (p: Patient) =>
  !p.stage ? "" : /^(NYHA|Post|Parox|Persis)/.test(p.stage) ? p.stage : `stage ${p.stage}`;

export function AppShell({ patients, initialPatientId, copilotEnabled, readOnly, counts, children }: {
  patients: Patient[]; initialPatientId: string | null; copilotEnabled: boolean; readOnly: boolean;
  counts: Record<string, number>; children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [patientId, setPatientId] = useState(initialPatientId ?? patients[0]?.id ?? null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const patient = patients.find((p) => p.id === patientId) ?? null;

  // The workspace URL is the source of truth when you're on a patient page.
  useEffect(() => {
    const m = pathname.match(/^\/patients\/([^/]+)/);
    if (m && m[1] !== patientId) setPatientId(m[1]);
  }, [pathname, patientId]);

  const selectPatient = useCallback((id: string, go = true) => {
    setPatientId(id);
    document.cookie = `ts_patient=${id}; path=/; max-age=31536000; samesite=lax`;
    setNavOpen(false);
    if (go) router.push(`/patients/${id}`);
  }, [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx = useMemo<Ctx>(() => ({
    patients, patient, selectPatient, openPalette: () => setPaletteOpen(true), copilotEnabled, readOnly,
  }), [patients, patient, selectPatient, copilotEnabled, readOnly]);

  return (
    <PatientCtx.Provider value={ctx}>
      <div className="flex min-h-dvh">
        {/* mobile top bar */}
        <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden">
          <button aria-label="Open menu" onClick={() => setNavOpen(true)} className="rounded-md p-1.5 text-slate hover:bg-paper"><Menu size={20} /></button>
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight"><LogoMark size={22} />TrialScope</Link>
        </div>
        {navOpen && <div className="fixed inset-0 z-40 bg-ink/30 lg:hidden" onClick={() => setNavOpen(false)} />}

        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} counts={counts} />

        <main className="min-w-0 flex-1 pt-14 lg:pt-0">{children}</main>
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </PatientCtx.Provider>
  );
}

function Sidebar({ open, onClose, counts }: { open: boolean; onClose: () => void; counts: Record<string, number> }) {
  const { patients, patient, selectPatient, openPalette } = useApp();
  const pathname = usePathname();
  const [panel, setPanel] = useState<"All" | "Oncology" | "Cardiology">("All");
  const [filter, setFilter] = useState("");
  const shown = patients.filter((p) =>
    (panel === "All" || p.specialty === panel) &&
    (!filter || `${p.name} ${p.primary_dx}`.toLowerCase().includes(filter.toLowerCase())));

  const nav = [
    { href: "/", label: "Search", icon: Search, active: pathname === "/" },
    { href: patient ? `/patients/${patient.id}` : "/", label: "Patient workspace", icon: FileText, active: pathname.startsWith("/patients") },
  ];

  return (
    <aside className={cx(
      "fixed inset-y-0 left-0 z-50 flex w-[284px] flex-col border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0",
      open ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex items-center justify-between px-5 pt-5 pb-4">
        <Link href="/" className="flex items-center gap-2.5 text-[19px] font-bold tracking-[-0.02em]"><LogoMark size={26} />TrialScope</Link>
        <button aria-label="Close menu" onClick={onClose} className="rounded-md p-1 text-slate lg:hidden"><X size={18} /></button>
      </div>

      <button onClick={openPalette}
        className="mx-4 mb-4 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-left text-[13px] text-slate hover:border-line-2">
        <Search size={15} /><span className="flex-1">Jump to a patient</span><Kbd>⌘K</Kbd>
      </button>

      <nav className="space-y-0.5 px-3">
        {nav.map(({ href, label, icon: Icon, active }) => (
          <Link key={label} href={href} onClick={onClose}
            className={cx("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium",
              active ? "bg-accent-soft text-accent-strong" : "text-ink-2 hover:bg-paper")}>
            <Icon size={17} strokeWidth={2} />{label}
          </Link>
        ))}
      </nav>

      <div className="mt-6 flex items-center justify-between px-5">
        <h2 className="text-[13px] font-semibold text-ink">Patients</h2>
        <span className="text-xs text-slate tabular-nums">{shown.length}</span>
      </div>
      <div className="mt-2 flex gap-1 px-4">
        {(["All", "Oncology", "Cardiology"] as const).map((s) => (
          <button key={s} onClick={() => setPanel(s)}
            className={cx("rounded-md px-2.5 py-1 text-[12.5px] font-medium",
              panel === s ? "bg-ink text-white" : "text-slate hover:bg-paper hover:text-ink")}>{s}</button>
        ))}
      </div>
      <div className="px-4 pt-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or diagnosis"
          aria-label="Filter patients"
          className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] placeholder:text-slate/70 focus:border-accent focus:outline-none" />
      </div>
      <ul className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
        {shown.map((p) => {
          const selected = patient?.id === p.id;
          const onWorkspace = pathname === `/patients/${p.id}`;
          return (
            <li key={p.id} className="relative">
              {/* On a patient's workspace a click opens that patient's workspace; anywhere else it only selects them
                  (for "This patient" search, trial matching and the copilot). */}
              <button onClick={() => selectPatient(p.id, pathname.startsWith("/patients"))} aria-pressed={selected}
                className={cx("w-full rounded-lg border-l-[3px] py-2 pr-3 pl-[9px] text-left transition-colors",
                  selected ? "border-notes bg-notes-soft" : "border-transparent hover:bg-paper")}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cx("truncate text-[13.5px] font-semibold", selected ? "text-notes" : "text-ink")}>{p.name}</span>
                  {selected
                    ? <span className="shrink-0 rounded bg-notes px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-white uppercase">Selected</span>
                    : <span className="text-xs text-slate tabular-nums">{p.age}</span>}
                </div>
                <div className={cx("truncate text-[12.5px] text-slate", selected && !onWorkspace && "pr-6")}>
                  {selected ? `${p.age}, ` : ""}{p.primary_dx}{stageText(p) ? `, ${stageText(p)}` : ""}
                </div>
              </button>
              {selected && !onWorkspace && (
                <Link href={`/patients/${p.id}`} onClick={onClose} aria-label={`Open ${p.name}'s workspace`} title="Open workspace"
                  className="absolute right-2 bottom-1.5 rounded-md p-1 text-notes hover:bg-surface">
                  <ArrowUpRight size={15} />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <Account />
      <div className="border-t border-line px-5 py-3 text-[11.5px] leading-relaxed text-slate">
        {counts.pubmed ? `${counts.pubmed.toLocaleString()} abstracts and ${counts.trials.toLocaleString()} trials on turbopuffer. ` : ""}
        Personal learning project. Synthetic patients, not for clinical use.
      </div>
    </aside>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const { patients, selectPatient } = useApp();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const items = [
    ...(q.trim() ? [{ key: "search", label: `Search everything for “${q.trim()}”`, sub: "Notes, PubMed and trials", run: () => router.push(`/?q=${encodeURIComponent(q.trim())}`) }] : []),
    ...patients
      .filter((p) => !q || `${p.name} ${p.primary_dx} ${p.city}`.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8)
      .map((p) => ({ key: p.id, label: p.name, sub: `${p.age}, ${p.primary_dx}`, run: () => selectPatient(p.id) })),
  ];
  const run = (n: number) => { items[n]?.run(); onClose(); };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/25 p-4 pt-[14vh] animate-fade-in" onMouseDown={onClose}>
      <div role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={18} className="text-slate" />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} aria-label="Search patients or the corpus"
            placeholder="Jump to a patient, or type a search" className="h-14 flex-1 bg-transparent text-[16px] outline-none focus-visible:outline-none placeholder:text-slate/70"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setI((v) => Math.min(v + 1, items.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((v) => Math.max(v - 1, 0)); }
              if (e.key === "Enter") run(i);
            }} />
          <Kbd>esc</Kbd>
        </div>
        <ul className="max-h-[360px] overflow-y-auto p-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate">No patients match. Press Enter to search the corpus instead.</li>}
          {items.map((it, n) => (
            <li key={it.key}>
              <button onMouseEnter={() => setI(n)} onClick={() => run(n)}
                className={cx("flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2.5 text-left", n === i && "bg-paper")}>
                <span className="text-[14px] font-medium text-ink">{it.label}</span>
                <span className="truncate text-[12.5px] text-slate">{it.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// The signed-in user, with Clerk's menu for profile and sign-out.
function Account() {
  const { user } = useUser();
  if (!user) return null;
  const name = user.fullName || user.username || user.primaryEmailAddress?.emailAddress;
  return (
    <div className="flex items-center gap-2.5 border-t border-line px-5 py-3">
      <UserButton />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-ink">{name}</div>
        {user.fullName && <div className="truncate text-[11.5px] text-slate">{user.primaryEmailAddress?.emailAddress}</div>}
      </div>
    </div>
  );
}
