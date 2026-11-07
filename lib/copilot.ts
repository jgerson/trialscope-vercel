// The copilot: Claude with two tools backed by turbopuffer, streamed to the browser as NDJSON events.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { config, NS } from "./config";
import { buildFilters, listNotes, readArticle, search } from "./tpuf";
import type { Hit, Mode, Patient } from "./types";

const TAG: Record<Hit["kind"], string> = { notes: "N", pubmed: "P", fulltext: "F", trials: "T" };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search TrialScope. Sources: 'patient' (the current patient's notes), 'pubmed' (oncology and cardiology abstracts, " +
      "2015 onward), 'fulltext' (passages from open-access full-text articles, best for methods, doses, thresholds and " +
      "detailed results) and 'trials' (ClinicalTrials.gov interventional studies). Hybrid search (BM25 + vector, fused with " +
      "RRF). Put drug names, genes and NCT ids in the query text. Use filters to narrow trials by status, phase, " +
      "country, patient age and sex.",
    input_schema: {
      type: "object",
      properties: {
        sources: { type: "array", items: { type: "string", enum: ["patient", "pubmed", "fulltext", "trials"] } },
        query: { type: "string" },
        trial_status: {
          type: "array",
          items: { type: "string", enum: ["Recruiting", "Not yet recruiting", "Active not recruiting", "Completed", "Enrolling by invitation"] },
        },
        trial_phases: { type: "array", items: { type: "string", enum: ["Early phase 1", "Phase 1", "Phase 2", "Phase 3", "Phase 4"] } },
        country: { type: "string", description: "e.g. 'United States'" },
        match_patient_age_sex: { type: "boolean" },
        pubmed_year_from: { type: "integer" },
        top_k: { type: "integer" },
      },
      required: ["sources", "query"],
    },
  },
  {
    name: "read_article",
    description: "Read the passages around a full-text result to see its context. Pass the PMC ID and passage number shown " +
      "in a 'fulltext' search result.",
    input_schema: {
      type: "object",
      properties: { pmcid: { type: "string" }, passage: { type: "integer" } },
      required: ["pmcid", "passage"],
    },
  },
  {
    name: "read_patient_notes",
    description: "Read the current patient's most recent notes in full, newest first.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
];

const SYSTEM = (patient: Patient | null) => `You are the TrialScope copilot, helping a physician search their own patient \
notes, PubMed and ClinicalTrials.gov. All patients are synthetic demo records.

Rules:
- Ground every claim in tool results and cite it with the tag shown in the result, like [N2], [P1], [F1] or [T3].
- For questions about methods, doses, thresholds or detailed outcomes, search 'fulltext'; abstracts often leave these out.
- For trial matching, first read the patient's notes, extract diagnosis, stage, biomarkers, age, sex and location, then \
search trials with filters (usually status Recruiting or Not yet recruiting, the patient's country, and match_patient_age_sex).
- Say plainly that eligibility needs physician review against the full protocol. Do not give treatment advice.
- Be concise: a short answer, then a bulleted list of the best matches with one line on why each fits. Use markdown.

${patient ? `Current patient: ${JSON.stringify(patient)}` : "No patient is selected; the 'patient' source is unavailable."}`;

export type CopilotEvent =
  | { type: "step"; tool: string; input: Record<string, unknown>; results: number; ms: number }
  | { type: "text"; delta: string }
  | { type: "citations"; items: Record<string, Hit> }
  | { type: "error"; message: string }
  | { type: "done"; seconds: number };

export async function runCopilot(
  messages: Anthropic.MessageParam[],
  patient: Patient | null,
  mode: Mode,
  emit: (e: CopilotEvent) => void,
): Promise<void> {
  const llm = new Anthropic({ apiKey: config.anthropicKey });
  const t0 = performance.now();
  const cites: Record<string, Hit> = {};
  const byKey = new Map<string, string>();
  const counts = { N: 0, P: 0, T: 0 } as Record<string, number>;
  const tag = (h: Hit) => {
    if (!byKey.has(h.key)) {
      const t = TAG[h.kind];
      counts[t] += 1;
      byKey.set(h.key, `${t}${counts[t]}`);
      cites[`${t}${counts[t]}`] = h;
    }
    return byKey.get(h.key)!;
  };
  const fmt = (t: string, h: Hit) =>
    `[${t}] ${[h.code, ...h.meta, h.section ? `section: ${h.section}` : "", h.chunk ? `passage ${h.chunk}` : ""].filter(Boolean).join(" | ")}` +
    ` | ${h.title}\n${h.snippet}`;

  async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
    const t1 = performance.now();
    if (name === "read_patient_notes") {
      if (!patient) return "No patient selected.";
      const notes = (await listNotes(patient.id)).slice(0, Number(input.limit ?? 10));
      const out = notes.map((n) => {
        const h: Hit = {
          key: `${NS.patient(patient.id)}:${n.id}`, id: n.id, kind: "notes", namespace: NS.patient(patient.id), title: n.title,
          url: null, meta: [n.visit_date, n.note_type, n.author], code: null, snippet: n.body.slice(0, 900), nsRank: 0, overall: 0,
          fused: 0, rrf: 0, vector: null, bm25: null, terms: [], raw: {},
        };
        return fmt(tag(h), h);
      });
      emit({ type: "step", tool: name, input, results: notes.length, ms: performance.now() - t1 });
      return out.join("\n\n") || "No notes.";
    }
    if (name === "read_article") {
      const rows = await readArticle(String(input.pmcid ?? ""), Number(input.passage ?? 1), 1);
      emit({ type: "step", tool: name, input, results: rows.length, ms: performance.now() - t1 });
      return rows.map((r) => `passage ${r.chunk} | ${r.section}\n${r.passage}`).join("\n\n") || "No passages found.";
    }
    const sources = (input.sources as string[]) ?? [];
    const targets: { namespace: string; filter: unknown[] | null }[] = [];
    if (sources.includes("patient") && patient) targets.push({ namespace: NS.patient(patient.id), filter: null });
    if (sources.includes("fulltext")) targets.push({ namespace: NS.pmc, filter: buildFilters("fulltext", { yearFrom: Number(input.pubmed_year_from ?? 0) }) });
    if (sources.includes("pubmed")) targets.push({ namespace: NS.pubmed, filter: buildFilters("pubmed", { yearFrom: Number(input.pubmed_year_from ?? 0) }) });
    if (sources.includes("trials")) {
      targets.push({
        namespace: NS.trials,
        filter: buildFilters("trials", {
          status: input.trial_status as string[], phases: input.trial_phases as string[], country: input.country as string,
          matchPatient: Boolean(input.match_patient_age_sex),
        }, patient),
      });
    }
    if (!targets.length) return "No valid sources.";
    const res = await search(targets, String(input.query ?? ""), mode, Number(input.top_k ?? 8));
    emit({ type: "step", tool: name, input, results: res.hits.length, ms: performance.now() - t1 });
    return res.hits.slice(0, 15).map((h) => fmt(tag(h), h)).join("\n\n") || "No results.";
  }

  const convo = [...messages];
  for (let turn = 0; turn < 6; turn++) {
    const stream = llm.messages.stream({
      model: config.copilotModel, max_tokens: 1500, system: SYSTEM(patient), tools: TOOLS, messages: convo,
    });
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const msg = await stream.finalMessage();
    convo.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason !== "tool_use") break;
    // Text written before a tool call is a preamble; the browser clears it when the next step arrives.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const out = await runTool(block.name, block.input as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    convo.push({ role: "user", content: results });
  }
  emit({ type: "citations", items: cites });
  emit({ type: "done", seconds: (performance.now() - t0) / 1000 });
}
