import { Suspense } from "react";
import { SearchView } from "@/components/search-view";
import { corpusStats } from "@/lib/tpuf";
import type { CorpusStat } from "@/lib/types";

export default async function SearchPage() {
  const stats = await corpusStats().catch(() => ({} as Record<string, CorpusStat>));
  return (
    <Suspense>
      <SearchView stats={stats} />
    </Suspense>
  );
}
