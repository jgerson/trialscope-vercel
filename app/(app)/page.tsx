import { Suspense } from "react";
import { SearchView } from "@/components/search-view";
import { corpusCounts } from "@/lib/tpuf";

export default async function SearchPage() {
  const counts = await corpusCounts().catch(() => ({}));
  return (
    <Suspense>
      <SearchView counts={counts as Record<string, number>} />
    </Suspense>
  );
}
