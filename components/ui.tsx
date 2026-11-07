"use client";
// Small shared building blocks.
import type { Kind } from "@/lib/types";
import { KIND_LABEL } from "@/lib/types";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-accent">
      <circle cx="15" cy="15" r="10" />
      <path d="M29 29l-6.8-6.8" />
      <path d="M15 10.5v9M10.5 15h9" />
    </svg>
  );
}

const SRC: Record<Kind, string> = { notes: "text-notes", pubmed: "text-pubmed", fulltext: "text-fulltext", trials: "text-trials" };
const SRC_SOFT: Record<Kind, string> = {
  notes: "bg-notes-soft text-notes", pubmed: "bg-pubmed-soft text-pubmed", fulltext: "bg-fulltext-soft text-fulltext",
  trials: "bg-trials-soft text-trials",
};

export function SourceTag({ kind, label }: { kind: Kind; label?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[12.5px] font-semibold", SRC[kind])}>
      <span className="size-2 rounded-[2px] bg-current" aria-hidden="true" />
      {label ?? KIND_LABEL[kind]}
    </span>
  );
}

export function SourcePill({ kind, children }: { kind: Kind; children: React.ReactNode }) {
  return <span className={cx("inline-flex items-baseline gap-1.5 rounded-md px-2 py-0.5 text-xs", SRC_SOFT[kind])}>{children}</span>;
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-surface p-0.5 [scrollbar-width:none]">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx("shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
            value === o.value ? "bg-ink text-white" : "text-slate hover:text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface px-1.5 py-px font-mono text-[11px] text-slate shadow-[0_1px_0_var(--color-line)]">
      {children}
    </kbd>
  );
}

export function highlight(text: string, terms: string[]): React.ReactNode {
  const words = terms.filter((t) => t.length >= 4).sort((a, b) => b.length - a.length);
  if (!words.length) return text;
  const re = new RegExp(`\\b(${words.map((w) => w.replace(/[-]/g, "\\-")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}
