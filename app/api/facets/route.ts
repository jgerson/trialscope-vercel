import { NextResponse } from "next/server";
import { getPatient } from "@/lib/patients";
import { requireUserId } from "@/lib/session";
import { facets } from "@/lib/tpuf";
import type { SearchFilters, Source } from "@/lib/types";

export const dynamic = "force-dynamic";

const ALL: Source[] = ["notes", "pubmed", "trials"];

/** Counts per status, topic or note type for the sources being searched: one grouped aggregate query per namespace. */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { sources?: Source[]; filters?: SearchFilters; patientId?: string };
  const sources = ALL.filter((s) => body.sources?.includes(s));
  const patient = await getPatient(body.patientId);
  try {
    return NextResponse.json({ facets: await facets(sources, body.filters ?? {}, patient ?? null) });
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
