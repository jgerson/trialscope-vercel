"use client";
// Corpus sizes, fetched once per page session and shared by every component that shows them.
import { useEffect, useState } from "react";
import type { CorpusStat } from "./types";

type Stats = Record<string, CorpusStat>;
let pending: Promise<Stats> | null = null;

export function useCorpus(): Stats {
  const [stats, setStats] = useState<Stats>({});
  useEffect(() => {
    let live = true;
    pending ??= fetch("/api/corpus").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    pending.then((s) => { if (live) setStats(s); });
    return () => { live = false; };
  }, []);
  return stats;
}
