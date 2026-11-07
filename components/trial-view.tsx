"use client";
// One trial, live from ClinicalTrials.gov: the eligibility checklist for the selected patient and the sites near them.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, CircleHelp, ClipboardCheck, Loader2, MapPin, X } from "lucide-react";
import type { Site, Trial } from "@/lib/ctgov";
import type { CriterionResult, CriterionStatus } from "@/lib/eligibility";
import { milesBetween, placeCoords } from "@/lib/places";
import type { Patient } from "@/lib/types";
import { useApp } from "./app-shell";
import { cx, SourceTag } from "./ui";

const SitesMap = dynamic(() => import("./sites-map"), {
  ssr: false,
  loading: () => <div className="h-[320px] w-full animate-pulse rounded-xl border border-line bg-paper" />,
});

export function TrialView({ trial }: { trial: Trial }) {
  const { patient } = useApp();
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 lg:px-8">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-slate">
          <SourceTag kind="trials" />
          <span className="font-mono text-[12px] text-ink-2">{trial.nct}</span>
          <span>{trial.status}</span>
          {!!trial.phases.length && <span>{trial.phases.join(", ")}</span>}
          {trial.sponsor && <span>{trial.sponsor}</span>}
        </div>
        <h1 className="mt-2 max-w-[60ch] font-display text-[32px] leading-[1.1] tracking-tight text-ink">{trial.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <span className="text-slate">{ageRange(trial.minAge, trial.maxAge)} · {trial.sex === "All" ? "All sexes" : trial.sex}</span>
          <a href={`https://clinicaltrials.gov/study/${trial.nct}`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-accent">
            Open on ClinicalTrials.gov<ArrowUpRight size={14} />
          </a>
          <span className="text-[12px] text-slate">Read live from ClinicalTrials.gov, not from the search index.</span>
        </div>
      </header>

      {!patient ? (
        <p className="mt-8 rounded-2xl border border-line bg-surface px-5 py-4 text-[14px] text-slate">
          Select a patient in the sidebar to check their eligibility and see the sites nearest to them.
        </p>
      ) : (
        <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <Eligibility key={`${trial.nct}:${patient.id}`} trial={trial} patient={patient} />
          <Sites trial={trial} patient={patient} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ eligibility checklist

interface CheckResult {
  criteria: CriterionResult[];
  notes: { tag: string; title: string; date: string; type: string }[];
  ms: number; cost: number | null; inTokens: number; outTokens: number; downgraded: number;
}

const STATUS: Record<CriterionStatus, { label: string; icon: typeof Check; chip: string }> = {
  meets: { label: "Meets", icon: Check, chip: "bg-trials-soft text-trials" },
  fails: { label: "Doesn't meet", icon: X, chip: "bg-red-50 text-red-800" },
  unknown: { label: "Unknown", icon: CircleHelp, chip: "bg-paper text-slate" },
};

const money = (d: number | null) => (d == null ? null : d < 0.01 ? `${(d * 100).toFixed(2)}¢` : `$${d.toFixed(2)}`);

function Eligibility({ trial, patient }: { trial: Trial; patient: Patient }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; result?: CheckResult }>({ loading: false });
  const first = patient.name.split(" ")[0];

  async function run() {
    setState({ loading: true });
    try {
      const res = await fetch("/api/eligibility", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nct: trial.nct, patientId: patient.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setState({ loading: false, result: data as CheckResult });
    } catch (e) {
      setState({ loading: false, error: (e as Error).message });
    }
  }

  const r = state.result;
  const counts = r && (["meets", "fails", "unknown"] as CriterionStatus[]).map((s) => [s, r.criteria.filter((c) => c.status === s).length] as const);
  const noteTitle = (tag: string) => (tag === "Record" ? "Patient record" : r?.notes.find((n) => n.tag === tag)?.title ?? tag);

  return (
    <section aria-labelledby="elig-h" className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="elig-h" className="flex items-center gap-2 text-[16px] font-semibold text-ink"><ClipboardCheck size={17} />Eligibility checklist</h2>
          <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed text-slate">
            Each criterion checked against {first}&apos;s record and notes. A verdict needs cited evidence; anything the
            notes don&apos;t show stays unknown.
          </p>
        </div>
        {!state.loading && (
          <button type="button" onClick={run}
            className="rounded-xl bg-ink px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-ink-2">
            {r ? "Check again" : `Check ${first}'s eligibility`}
          </button>
        )}
      </div>

      {state.loading && (
        <p className="mt-5 inline-flex items-center gap-2 text-[13px] text-slate">
          <Loader2 size={14} className="animate-spin" />Reading the full criteria against {first}&apos;s notes. This takes about 10 seconds.
        </p>
      )}
      {state.error && <p className="mt-5 rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-800">{state.error}</p>}

      {r && counts && (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            {counts.map(([s, n]) => (
              <span key={s} className={cx("rounded-lg px-2.5 py-1 text-[12.5px] font-semibold tabular-nums", n ? STATUS[s].chip : STATUS.unknown.chip)}>
                {n} {STATUS[s].label.toLowerCase()}
              </span>
            ))}
          </div>
          {(["inclusion", "exclusion"] as const).map((section) => {
            const items = r.criteria.filter((c) => c.section === section);
            if (!items.length) return null;
            return (
              <div key={section} className="mt-5">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate">
                  {section === "inclusion" ? "Inclusion criteria" : "Exclusion criteria"}
                </h3>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {items.map((c, i) => {
                    const S = STATUS[c.status];
                    return (
                      <li key={i} className="flex gap-3 px-3.5 py-3">
                        <span className={cx("mt-0.5 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold", S.chip)}>
                          <S.icon size={12} />{S.label}
                        </span>
                        <div className="min-w-0 text-[13px] leading-relaxed">
                          <p className="text-ink">{c.criterion}</p>
                          {c.explanation && <p className="mt-0.5 text-[12.5px] text-slate">{c.explanation}</p>}
                          {!!c.evidence.length && (
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {c.evidence.map((e) => (
                                <span key={e} title={noteTitle(e)}
                                  className="rounded-md bg-notes-soft px-1.5 py-px font-mono text-[11px] font-semibold text-notes">
                                  {e === "Record" ? "Record" : `${e} · ${noteTitle(e)}`}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          <p className="mt-4 text-[12px] leading-relaxed text-slate">
            A screening aid, not a determination: eligibility needs physician review against the full protocol.
            {r.downgraded > 0 && ` ${r.downgraded} verdict${r.downgraded === 1 ? " was" : "s were"} shown as unknown because no evidence was cited.`}
          </p>
          <p className="mt-1 text-[12px] text-slate">
            {(r.ms / 1000).toFixed(1)} s · {r.notes.length} notes read · {(r.inTokens + r.outTokens).toLocaleString()} tokens
            {money(r.cost) ? ` · ≈ ${money(r.cost)}` : ""}
          </p>
        </>
      )}

      <details className="group mt-5">
        <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-accent">Full criteria from ClinicalTrials.gov</summary>
        <pre className="mt-2 max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-paper p-3.5 font-sans text-[12.5px] leading-relaxed text-ink-2">
          {trial.criteria || "This trial lists no eligibility criteria."}
        </pre>
      </details>
    </section>
  );
}

// ------------------------------------------------------------------ sites near the patient

const RECRUITING = new Set(["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"]);
const statusLabel = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function Sites({ trial, patient }: { trial: Trial; patient: Patient }) {
  const home = useMemo(() => placeCoords(patient.city, patient.state), [patient.city, patient.state]);
  const [recruitingOnly, setRecruitingOnly] = useState(true);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [recruitingOnly, patient.id]);

  const withDistance = useMemo(() => trial.sites.map((s) => ({
    ...s,
    recruiting: RECRUITING.has(s.status),
    miles: home && s.lat != null && s.lon != null ? milesBetween(home, [s.lat, s.lon]) : null,
  })), [trial.sites, home]);
  const listed = useMemo(() => withDistance
    .filter((s) => !recruitingOnly || s.recruiting)
    .sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity) || a.facility.localeCompare(b.facility)),
  [withDistance, recruitingOnly]);
  const recruitingCount = withDistance.filter((s) => s.recruiting).length;
  const nearest = listed.find((s) => s.miles != null);

  const mapSites = useMemo(() => withDistance
    .filter((s) => s.lat != null && s.lon != null && (!recruitingOnly || s.recruiting))
    .map((s) => ({ lat: s.lat!, lon: s.lon!, recruiting: s.recruiting, label: siteLabel(s) })), [withDistance, recruitingOnly]);
  const focus = useMemo(() => [
    ...(home ? [home] : []),
    ...listed.filter((s) => s.lat != null && s.lon != null).slice(0, 5).map((s) => [s.lat!, s.lon!] as [number, number]),
  ], [home, listed]);

  const shown = showAll ? listed : listed.slice(0, 8);
  return (
    <section aria-labelledby="sites-h" className="self-start rounded-2xl border border-line bg-surface p-5 xl:sticky xl:top-6">
      <h2 id="sites-h" className="flex items-center gap-2 text-[16px] font-semibold text-ink"><MapPin size={17} />Sites near {patient.name.split(" ")[0]}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-slate">
        {trial.sites.length.toLocaleString()} site{trial.sites.length === 1 ? "" : "s"}, {recruitingCount.toLocaleString()} recruiting.
        {nearest?.miles != null && ` The nearest${recruitingOnly ? " recruiting" : ""} site is ${fmtMiles(nearest.miles)} from ${patient.city}, ${patient.state}.`}
        {!home && ` Distances aren't available for ${patient.city}, ${patient.state}.`}
      </p>
      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
        <input type="checkbox" checked={recruitingOnly} onChange={(e) => setRecruitingOnly(e.target.checked)} className="size-4 accent-[var(--color-ink)]" />
        Recruiting sites only
      </label>

      {trial.sites.length > 0 && (
        <div className="mt-3">
          <SitesMap home={home} homeLabel={patient.city} sites={mapSites} focus={focus} />
        </div>
      )}

      {listed.length ? (
        <ol className="mt-4 divide-y divide-line">
          {shown.map((s, i) => (
            <li key={`${s.facility}-${s.city}-${i}`} className="flex items-start gap-3 py-2.5 text-[13px]">
              <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", s.recruiting ? "bg-trials" : "bg-line-2")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">{s.facility || "Unnamed site"}</p>
                <p className="text-[12.5px] text-slate">{[s.city, s.state, s.country].filter(Boolean).join(", ")} · {statusLabel(s.status)}</p>
              </div>
              {s.miles != null && <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-ink-2">{fmtMiles(s.miles)}</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-4 text-[13px] text-slate">{recruitingOnly ? "No sites are recruiting." : "This trial lists no sites."}</p>
      )}
      {listed.length > 8 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-[13px] font-semibold text-ink-2 hover:text-accent">
          {showAll ? "Show the nearest 8" : `Show all ${listed.length.toLocaleString()}`}
        </button>
      )}
    </section>
  );
}

function siteLabel(s: Site & { miles: number | null }) {
  return `${s.facility || "Site"}, ${[s.city, s.state].filter(Boolean).join(", ")}${s.miles != null ? ` (${fmtMiles(s.miles)})` : ""}`;
}

function ageRange(min: string, max: string) {
  if (min === "None" && max === "None") return "Any age";
  if (max === "None") return `Ages ${min} and older`;
  if (min === "None") return `Ages up to ${max}`;
  return `Ages ${min} to ${max}`;
}

function fmtMiles(m: number) {
  return m < 10 ? `${m.toFixed(1)} mi` : `${Math.round(m).toLocaleString()} mi`;
}
