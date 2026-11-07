// Grounding check: after the copilot answers, a second model call splits the answer into factual claims and checks
// each one against the exact source text the copilot was given for the tags it cited. It catches claims the sources
// don't support, such as eligibility criteria the model filled in from general knowledge.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { tracedCreate } from "./langfuse";
import type { GroundingItem } from "./types";

const MAX_CLAIMS = 12;

const SYSTEM = `You verify a clinical-research assistant's answer against its sources. You receive the answer, the \
patient record the assistant was given (when a patient is selected), and the exact text of every source it cited, each \
labelled with its tag (like [T1] or [N2]).

Split the answer into its factual claims: statements about the patient, a trial, a study or a finding. Do not report \
greetings, headings, disclaimers (such as "eligibility needs physician review"), statements about what the assistant \
searched, or overall summaries like "there are two good options" that only restate other claims. Keep each claim short, in the \
answer's own words. Report at most ${MAX_CLAIMS}, the most consequential first.

For each claim give the tags it cites and one verdict. A fact about the patient that matches the patient record counts \
as supported even without a tag. A claim that a patient fits a trial is supported only when both the patient record (or a \
cited note) and the trial text back each part of the match.
- supported: the cited sources state it.
- partial: the sources support part of it, but a detail that matters (a criterion, number, stage, phase, status, date) is \
missing from them or differs.
- unsupported: the cited sources don't say it, or contradict it.
- uncited: it states a fact but cites no source.

Judge only against the source text given, never your own knowledge. A faithful paraphrase, or a dropped qualifier that \
doesn't change the meaning or whether the patient would fit, is supported: don't flag wording. For anything but \
supported, say in the note what is missing or wrong; for supported, leave the note empty. Report through the tool.`;

const TOOL: Anthropic.Tool = {
  name: "report_claims",
  description: "Report each factual claim in the answer with its verdict.",
  input_schema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        maxItems: MAX_CLAIMS,
        items: {
          type: "object",
          properties: {
            claim: { type: "string", description: "The claim, short, in the answer's words." },
            tags: { type: "array", items: { type: "string" }, description: "Tags the claim cites, like T1." },
            verdict: { type: "string", enum: ["supported", "partial", "unsupported", "uncited"] },
            note: { type: "string", description: "For anything but supported: what is missing or wrong. Otherwise empty." },
          },
          required: ["claim", "tags", "verdict", "note"],
        },
      },
    },
    required: ["claims"],
  },
};

const VERDICTS = new Set<GroundingItem["verdict"]>(["supported", "partial", "unsupported", "uncited"]);

// Disclaimers the model sometimes reports despite the instructions; they aren't claims to check.
const DISCLAIMER = /physician review|consult (your|a|the) (physician|doctor)|not (medical|treatment) advice/i;

export async function checkGrounding(
  llm: Anthropic,
  model: string,
  answer: string,
  sources: { tag: string; text: string }[],
  patientRecord: string | null,
): Promise<{ items: GroundingItem[]; inTokens: number; outTokens: number }> {
  const sourceText = sources.length
    ? sources.map((s) => s.text).join("\n\n")
    : "(The answer cites no sources.)";
  const record = patientRecord ? `<patient_record>\n${patientRecord}\n</patient_record>\n\n` : "";
  const msg = await tracedCreate("verify-answer-claims", llm, {
    model,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: `<answer>\n${answer}\n</answer>\n\n${record}<sources>\n${sourceText}\n</sources>` }],
  });
  const call = msg.content.find((b) => b.type === "tool_use");
  const raw = (call?.type === "tool_use" ? (call.input as { claims?: unknown }).claims : null) ?? [];
  if (!Array.isArray(raw)) throw new Error("The check returned no claims.");
  // The model's output is untrusted: keep only well-formed items, and tags that really were cited.
  const known = new Set(sources.map((s) => s.tag));
  const items: GroundingItem[] = raw.slice(0, MAX_CLAIMS).flatMap((c) => {
    const r = c as Partial<GroundingItem>;
    if (typeof r.claim !== "string" || !r.claim.trim() || !VERDICTS.has(r.verdict as GroundingItem["verdict"])) return [];
    if (DISCLAIMER.test(r.claim)) return [];
    // The checker sometimes lists a summary sentence and then says itself that it isn't a claim; drop those.
    if (/not a (factual )?claim/i.test(String(r.note ?? ""))) return [];
    const tags = Array.isArray(r.tags) ? r.tags.map(String).map((t) => t.replace(/[[\]]/g, "")).filter((t) => known.has(t)) : [];
    return [{ claim: r.claim.trim().slice(0, 300), tags, verdict: r.verdict as GroundingItem["verdict"], note: String(r.note ?? "").slice(0, 300) }];
  });
  return { items, inTokens: msg.usage.input_tokens, outTokens: msg.usage.output_tokens };
}
