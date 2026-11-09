import { NextResponse } from "next/server";
import { getPatient } from "@/lib/patients";
import { requireUserId } from "@/lib/session";
import { patientCache } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

/** Cache state of a patient's namespace; with `warm`, also asks turbopuffer to load it into cache if it's cold. */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { patientId?: string; warm?: boolean };
  const patient = await getPatient(body.patientId);
  if (!patient) return NextResponse.json({ error: "Unknown patient." }, { status: 404 });
  try {
    return NextResponse.json(await patientCache(patient.id, !!body.warm));
  } catch (e) {
    if ((e as { status?: number }).status === 404) return NextResponse.json({ state: "cold", temperature: null, ms: 0 });
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
