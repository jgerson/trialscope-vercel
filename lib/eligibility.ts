// Eligibility checklist: one model call reads a trial's full criteria (live from ClinicalTrials.gov) and the patient's
// record and notes, then reports each criterion as meets, doesn't meet, or unknown, with the evidence it relied on.
// The server enforces the rules that matter: a verdict other than "unknown" must cite evidence that exists.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { tracedCreate } from "./langfuse";
import type { Note, Patient } from "./types";

export type CriterionStatus = "meets" | "fails" | "unknown";

export interface CriterionResult {
  section: "inclusion" | "exclusion";
  criterion: string;
  status: CriterionStatus;
  evidence: string[]; // "Record" for the patient record, or note tags like "N2"
  explanation: string;
}

export interface EligibilityResult {
  criteria: CriterionResult[];
  notes: { tag: string; title: string; date: string; type: string }[];
  inTokens: number;
  outTokens: number;
  downgraded: number; // verdicts turned into "unknown" because they cited no valid evidence
}

const MAX_CRITERIA = 40;
const NOTE_CHARS = 3000;

const SYSTEM = `You screen one patient against one clinical trial's eligibility criteria, for a physician to review. \
All patients are synthetic demo records.

You receive the trial's criteria text, the patient record, and the patient's notes, each labelled with a tag like [N1].

List the criteria in order, inclusion first, then exclusion, at most ${MAX_CRITERIA}. Restate each in at most 25 words. \
Merge trivial administrative criteria (consent, willingness to comply) into one item per section. If the trial lists no criteria for a section, report nothing for it (no placeholder item).

For each criterion, decide what the patient's information shows:
- meets: the record or notes show the patient satisfies it. For an exclusion criterion, "meets" means the excluding \
condition is clearly absent.
- fails: the record or notes show the patient does not satisfy it. For an exclusion criterion, "fails" means the \
excluding condition is present.
- unknown: the information needed isn't in the record or notes, or the patient hasn't reached that point in care yet \
(for example, surgery not done). This is expected for many criteria; never guess.

Every meets or fails verdict must list its evidence: "Record" for the patient record and/or the tags of the notes it \
relies on. Judge only from the text given, not from typical patients or medical knowledge about what is likely. In the \
explanation, say in one sentence what the evidence shows or what is missing. Report through the tool.`;

const TOOL: Anthropic.Tool = {
  name: "report_criteria",
  description: "Report each eligibility criterion with the patient's status and evidence.",
  input_schema: {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        maxItems: MAX_CRITERIA,
        items: {
          type: "object",
          properties: {
            section: { type: "string", enum: ["inclusion", "exclusion"] },
            criterion: { type: "string" },
            status: { type: "string", enum: ["meets", "fails", "unknown"] },
            evidence: { type: "array", items: { type: "string" }, description: "\"Record\" and/or note tags like N2." },
            explanation: { type: "string" },
          },
          required: ["section", "criterion", "status", "evidence", "explanation"],
        },
      },
    },
    required: ["criteria"],
  },
};

const SECTIONS = new Set(["inclusion", "exclusion"]);
const STATUSES = new Set<CriterionStatus>(["meets", "fails", "unknown"]);

export async function checkEligibility(
  llm: Anthropic,
  model: string,
  trial: { nct: string; title: string; criteria: string; minAge: string; maxAge: string; sex: string },
  patient: Patient,
  notes: Note[],
): Promise<EligibilityResult> {
  const tagged = notes.map((n, i) => ({ tag: `N${i + 1}`, note: n }));
  const record = JSON.stringify({
    age: patient.age, sex: patient.sex, location: `${patient.city}, ${patient.state}`, diagnosis: patient.primary_dx,
    stage: patient.stage, biomarkers: patient.biomarkers, specialty: patient.specialty,
  });
  const noteText = tagged
    .map(({ tag, note: n }) => `[${tag}] ${n.visit_date} | ${n.note_type} | ${n.title}\n${n.body.slice(0, NOTE_CHARS)}`)
    .join("\n\n");
  const msg = await tracedCreate("assess-eligibility-criteria", llm, {
    model,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{
      role: "user",
      content:
        `<trial id="${trial.nct}">\n${trial.title}\nAges: ${trial.minAge} to ${trial.maxAge}. Sex: ${trial.sex}.\n\n` +
        `${trial.criteria}\n</trial>\n\n<patient_record>\n${record}\n</patient_record>\n\n<notes>\n${noteText || "(no notes)"}\n</notes>`,
    }],
  });

  // The model's output is untrusted: keep well-formed items, and only evidence that really exists.
  const known = new Set(["Record", ...tagged.map((t) => t.tag)]);
  const call = msg.content.find((b) => b.type === "tool_use");
  const raw = (call?.type === "tool_use" ? (call.input as { criteria?: unknown }).criteria : null) ?? [];
  if (!Array.isArray(raw)) throw new Error("The check returned no criteria.");
  let downgraded = 0;
  const criteria: CriterionResult[] = raw.slice(0, MAX_CRITERIA).flatMap((c) => {
    const r = c as Partial<CriterionResult>;
    if (!SECTIONS.has(String(r.section)) || !STATUSES.has(r.status as CriterionStatus)) return [];
    if (typeof r.criterion !== "string" || !r.criterion.trim()) return [];
    const evidence = Array.isArray(r.evidence)
      ? [...new Set(r.evidence.map(String).map((e) => e.replace(/[[\]]/g, "").trim()))].filter((e) => known.has(e))
      : [];
    let status = r.status as CriterionStatus;
    let explanation = String(r.explanation ?? "").slice(0, 400);
    // A verdict without evidence is a guess: show it as unknown rather than trust it.
    if (status !== "unknown" && !evidence.length) {
      status = "unknown";
      downgraded += 1;
      explanation = `No supporting record or note was cited. ${explanation}`.trim();
    }
    return [{ section: r.section as CriterionResult["section"], criterion: r.criterion.trim().slice(0, 300), status, evidence, explanation }];
  });
  return {
    criteria,
    notes: tagged.map(({ tag, note: n }) => ({ tag, title: n.title, date: n.visit_date, type: n.note_type })),
    inTokens: msg.usage.input_tokens,
    outTokens: msg.usage.output_tokens,
    downgraded,
  };
}
