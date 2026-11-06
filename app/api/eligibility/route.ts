import { config, copilotEnabled } from "@/lib/config";
import { copilotClient } from "@/lib/copilot";
import { getTrial, NCT_RE } from "@/lib/ctgov";
import { checkEligibility } from "@/lib/eligibility";
import { getPatient } from "@/lib/patients";
import { costOf } from "@/lib/pricing";
import { requireUserId } from "@/lib/session";
import { listNotes } from "@/lib/tpuf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (!copilotEnabled) return Response.json({ error: "The AI checks are off on this deployment." }, { status: 503 });

  const { nct, patientId } = (await req.json()) as { nct?: string; patientId?: string };
  if (!nct || !NCT_RE.test(nct)) return Response.json({ error: "Unknown trial id." }, { status: 400 });
  const patient = await getPatient(patientId);
  if (!patient) return Response.json({ error: "Select a patient first." }, { status: 400 });

  const t0 = performance.now();
  try {
    const [trial, notes] = await Promise.all([getTrial(nct), listNotes(patient.id)]);
    if (!trial) return Response.json({ error: "ClinicalTrials.gov has no study with that id." }, { status: 404 });
    if (!trial.criteria) return Response.json({ error: "This trial lists no eligibility criteria." }, { status: 422 });
    const result = await checkEligibility(await copilotClient(), config.copilotModel, trial, patient, notes.slice(0, 20));
    const cost = await costOf(config.copilotModel, result.inTokens, result.outTokens);
    const ms = performance.now() - t0;
    console.log(JSON.stringify({
      eligibility: "done", nct, model: config.copilotModel, ms: Math.round(ms), criteria: result.criteria.length,
      downgraded: result.downgraded, inTokens: result.inTokens, outTokens: result.outTokens, cost,
    }));
    return Response.json({ ...result, ms, cost, model: config.copilotModel });
  } catch (e) {
    console.log(JSON.stringify({ eligibility: "error", nct, message: (e as Error).message.slice(0, 300) }));
    return Response.json({ error: "The eligibility check couldn't run. Try again in a moment." }, { status: 502 });
  }
}
