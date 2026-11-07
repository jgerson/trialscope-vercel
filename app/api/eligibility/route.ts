import { startActiveObservation } from "@langfuse/tracing";
import { after } from "next/server";
import { config, copilotEnabled } from "@/lib/config";
import { copilotClient } from "@/lib/copilot";
import { getTrial, NCT_RE } from "@/lib/ctgov";
import { checkEligibility } from "@/lib/eligibility";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
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

  after(flushLangfuse);
  // One Langfuse trace per check: the trial and notes lookups, then the model's criterion-by-criterion assessment.
  return newTrace({ userId: user, tags: ["eligibility"], metadata: { patientId: patient.id, nct } }, () =>
    startActiveObservation("check-trial-eligibility", async (span) => {
      span.update({ input: { nct, patientId: patient.id }, metadata: { model: config.copilotModel } });
      const t0 = performance.now();
      try {
        const [trial, notes] = await Promise.all([
          startActiveObservation("fetch-trial", async (r) => {
            r.update({ input: { nct }, metadata: { source: "ClinicalTrials.gov" } });
            const t = await getTrial(nct);
            r.update({ output: t ? { title: t.title, minAge: t.minAge, maxAge: t.maxAge, sex: t.sex, criteria: t.criteria } : null });
            return t;
          }, { asType: "retriever" }),
          startActiveObservation("read-patient-notes", async (r) => {
            r.update({ input: { patientId: patient.id } });
            const n = await listNotes(patient.id);
            r.update({ output: n.slice(0, 20).map((x) => ({ id: x.id, date: x.visit_date, type: x.note_type, title: x.title })), metadata: { notes: n.length, used: Math.min(n.length, 20) } });
            return n;
          }, { asType: "retriever" }),
        ]);
        if (!trial) {
          span.update({ level: "WARNING", statusMessage: "Trial not found." });
          return Response.json({ error: "ClinicalTrials.gov has no study with that id." }, { status: 404 });
        }
        if (!trial.criteria) {
          span.update({ level: "WARNING", statusMessage: "Trial lists no criteria." });
          return Response.json({ error: "This trial lists no eligibility criteria." }, { status: 422 });
        }
        const result = await checkEligibility(await copilotClient(), config.copilotModel, trial, patient, notes.slice(0, 20));
        const cost = await costOf(config.copilotModel, result.inTokens, result.outTokens);
        const ms = performance.now() - t0;
        console.log(JSON.stringify({
          eligibility: "done", nct, model: config.copilotModel, ms: Math.round(ms), criteria: result.criteria.length,
          downgraded: result.downgraded, inTokens: result.inTokens, outTokens: result.outTokens, cost,
        }));
        const count = (s: string) => result.criteria.filter((c) => c.status === s).length;
        span.update({
          output: result.criteria,
          metadata: { criteria: result.criteria.length, meets: count("meets"), fails: count("fails"), unknown: count("unknown"), downgraded: result.downgraded, cost },
        });
        return Response.json({ ...result, ms, cost, model: config.copilotModel });
      } catch (e) {
        console.log(JSON.stringify({ eligibility: "error", nct, message: (e as Error).message.slice(0, 300) }));
        span.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) });
        return Response.json({ error: "The eligibility check couldn't run. Try again in a moment." }, { status: 502 });
      }
    }),
  );
}
