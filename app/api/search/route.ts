import { NextResponse } from "next/server";
import { NS } from "@/lib/config";
import { getPatient } from "@/lib/patients";
import { buildFilters, search } from "@/lib/tpuf";
import type { Mode, Scope, SearchFilters } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    q: string; scope: Scope; mode: Mode; filters: SearchFilters; topK?: number; patientId?: string;
  };
  const q = (body.q ?? "").trim().slice(0, 500);
  if (!q) return NextResponse.json({ error: "Type something to search for." }, { status: 400 });
  const mode: Mode = ["hybrid", "vector", "bm25"].includes(body.mode) ? body.mode : "hybrid";
  const topK = Math.min(30, Math.max(5, Number(body.topK ?? 10)));
  const patient = await getPatient(body.patientId);
  const f = body.filters ?? {};

  const targets: { namespace: string; filter: unknown[] | null }[] = [];
  if ((body.scope === "patient" || body.scope === "all") && patient) targets.push({ namespace: NS.patient(patient.id), filter: null });
  if (body.scope === "literature" || body.scope === "all") targets.push({ namespace: NS.pubmed, filter: buildFilters("pubmed", f) });
  if (body.scope === "trials" || body.scope === "all") targets.push({ namespace: NS.trials, filter: buildFilters("trials", f, patient) });
  if (!targets.length) return NextResponse.json({ error: "Pick a patient to search their notes." }, { status: 400 });

  try {
    return NextResponse.json(await search(targets, q, mode, topK));
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
