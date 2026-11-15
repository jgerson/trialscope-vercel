import { NextResponse } from "next/server";
import { getPatient } from "@/lib/patients";
import { requireUserId } from "@/lib/session";
import { facetCounts } from "@/lib/tpuf";
import { cleanRefine } from "@/lib/facets";
import type { SearchFilters, Source } from "@/lib/types";

export const dynamic = "force-dynamic";

const ALL: Source[] = ["notes", "pubmed", "trials"];

/** Faceted-search counts for the sources being searched, scoped to the query (see facetCounts in lib/tpuf.ts). */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { sources?: Source[]; filters?: SearchFilters; patientId?: string; q?: string };
  const sources = ALL.filter((s) => body.sources?.includes(s));
  const patient = await getPatient(body.patientId);
  try {
    const filters = { ...(body.filters ?? {}), refine: cleanRefine(body.filters?.refine) };
    const q = String(body.q ?? "").trim().slice(0, 500);
    return NextResponse.json({ facets: await facetCounts(sources, filters, patient ?? null, q) });
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
