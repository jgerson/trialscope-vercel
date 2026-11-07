// The copilot: Claude with two tools backed by turbopuffer, streamed to the browser as NDJSON events.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { config, NS } from "./config";
import { buildFilters, listNotes, readArticle, search } from "./tpuf";
import { checkGrounding } from "./grounding";
import { startActiveObservation, startObservation, updateActiveObservation } from "@langfuse/tracing";
import { assistantMessage, promptOf, usageOf } from "./langfuse";
import { costOf, priceOf } from "./pricing";
import type { GroundingItem, Hit, Mode, Patient, SearchResponse, Usage } from "./types";

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
- Only state eligibility details that appear in the tool results. If a fit depends on something the results don't show, \
say it needs checking instead of assuming it.
- Format for a narrow side panel. Never use tables. Write one or two sentences, then a bulleted list of the best matches. \
Start each bullet with the tag and the NCT id in bold, like "[T1] **NCT01234567**", then the trial's short name and phase, \
then one sentence on why it fits. End with one line saying eligibility needs physician review.

${patient ? `Current patient: ${JSON.stringify(patient)}` : "No patient is selected; the 'patient' source is unavailable."}`;

/** A search as the copilot ran it, slimmed for the browser: enough for the Explain panel and the applied filters. */
export type StepSearch = Omit<SearchResponse, "hits" | "runs"> & {
  runs: (Omit<SearchResponse["runs"][number], "request"> & { request: null })[];
  hits: Hit[];
};

export type CopilotEvent =
  | {
      type: "step"; tool: string; input: Record<string, unknown>; results: number; ms: number;
      returned: { tag: string; title: string; key: string }[]; reasoning?: string;
      // Search steps only: the filters each source actually applied, and the full ranking for the Explain panel.
      filters?: { source: string; filters: string[] }[]; search?: StepSearch;
    }
  | { type: "text"; delta: string }
  | { type: "citations"; items: Record<string, Hit> }
  | { type: "error"; message: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; seconds: number }
  | { type: "checking" }
  | { type: "grounding"; items: GroundingItem[]; ms: number; usage: Usage }
  | { type: "grounding_error"; message: string };

const GATEWAY_URL = "https://ai-gateway.vercel.sh";

// Direct to Anthropic when ANTHROPIC_API_KEY is set; otherwise through AI Gateway with its key or the Vercel OIDC token.
export async function copilotClient(): Promise<Anthropic> {
  if (config.anthropicKey) return new Anthropic({ apiKey: config.anthropicKey });
  const authToken = config.gatewayKey || (await getVercelOidcToken());
  // One retry and a 40s cap per call, so a rate limit or a stuck model shows up as an error instead of a silent timeout.
  return new Anthropic({ baseURL: GATEWAY_URL, authToken, maxRetries: 1, timeout: 40_000 });
}

// One JSON line per step in the Vercel runtime logs, to see where a slow answer spent its time.
const trace = (event: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ copilot: event, model: config.copilotModel, ...data }));

const REASONING_MAX = 4000;

// What the model said before calling tools in a turn: its thinking blocks plus any text it wrote first.
// This is the model's own account of its choice, not a guaranteed explanation of it.
function reasoningOf(content: Anthropic.ContentBlock[]): string | undefined {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "thinking" && b.thinking.trim()) parts.push(b.thinking.trim());
    else if (b.type === "redacted_thinking") parts.push("Reasoning was redacted by the provider.");
    else if (b.type === "text" && b.text.trim()) parts.push(b.text.trim());
  }
  const all = parts.join("\n\n");
  if (!all) return undefined;
  return all.length > REASONING_MAX ? `${all.slice(0, REASONING_MAX)}…` : all;
}

// Langfuse observation names for the tools. Names are an API for dashboards and evaluators: keep them stable.
const TOOL_OBSERVATION: Record<string, string> = {
  search: "search-sources", read_patient_notes: "read-patient-notes", read_article: "read-article",
};

/**
 * Answer one copilot question. Traced in Langfuse as an agent: a generation per model turn, a tool observation per tool
 * call (siblings, in order), then the grounding check as an evaluator.
 */
export async function runCopilot(
  messages: Anthropic.MessageParam[],
  patient: Patient | null,
  mode: Mode,
  emit: (e: CopilotEvent) => void,
): Promise<void> {
  const last = messages.at(-1);
  const question = last?.role === "user"
    ? (typeof last.content === "string" ? last.content : last.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"))
    : "";
  return startActiveObservation("answer-copilot-question", async (agent) => {
    agent.update({
      input: question,
      metadata: { patientId: patient?.id ?? null, mode, model: config.copilotModel, earlierMessages: messages.length - 1 },
    });
    try {
      const r = await copilotLoop(messages, patient, mode, emit);
      agent.update({
        output: r.answer || null,
        metadata: { turns: r.calls, inTokens: r.inTokens, outTokens: r.outTokens, cost: r.cost, citations: r.citations, seconds: r.seconds },
        ...(r.answer ? {} : { level: "WARNING" as const, statusMessage: "No answer within the turn limit." }),
      });
    } catch (e) {
      agent.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) });
      throw e;
    }
  }, { asType: "agent" });
}

async function copilotLoop(
  messages: Anthropic.MessageParam[],
  patient: Patient | null,
  mode: Mode,
  emit: (e: CopilotEvent) => void,
): Promise<{ answer: string; calls: number; inTokens: number; outTokens: number; cost: number | null; citations: number; seconds: number }> {
  const llm = await copilotClient();
  const t0 = performance.now();
  const cites: Record<string, Hit> = {};
  const byKey = new Map<string, string>();
  const counts = { N: 0, P: 0, F: 0, T: 0 } as Record<string, number>;
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
    ` | ${h.title}\n` +
    // Full text: give the model whole passages (the best three per article), not the on-screen snippet.
    (h.kind === "fulltext"
      ? String(h.raw.passage ?? h.snippet) + (h.more ?? []).map((m) => `\n\n(also passage ${m.chunk}, ${m.section}):\n${m.text}`).join("")
      : h.snippet);

  async function runTool(name: string, input: Record<string, unknown>, reasoning?: string): Promise<string> {
    const t1 = performance.now();
    if (name === "read_patient_notes") {
      if (!patient) return "No patient selected.";
      // Capped: some models ask for 50+ notes, which bloats every later turn of the conversation.
      const notes = (await listNotes(patient.id)).slice(0, Math.min(Number(input.limit ?? 10), 20));
      updateActiveObservation({ metadata: { namespace: NS.patient(patient.id), notes: notes.length } }, { asType: "tool" });
      const returned: { tag: string; title: string; key: string }[] = [];
      const out = notes.map((n) => {
        const h: Hit = {
          key: `${NS.patient(patient.id)}:${n.id}`, id: n.id, kind: "notes", namespace: NS.patient(patient.id), title: n.title,
          url: null, meta: [n.visit_date, n.note_type, n.author], code: null, snippet: n.body.slice(0, 900), nsRank: 0, overall: 0,
          fused: 0, rrf: 0, vector: null, bm25: null, terms: [], raw: {},
        };
        const t = tag(h);
        returned.push({ tag: t, title: h.title, key: h.key });
        return fmt(t, h);
      });
      emit({ type: "step", tool: name, input, results: notes.length, ms: performance.now() - t1, returned, reasoning });
      return out.join("\n\n") || "No notes.";
    }
    if (name === "read_article") {
      const rows = await readArticle(String(input.pmcid ?? ""), Number(input.passage ?? 1), 1);
      updateActiveObservation({ metadata: { namespace: NS.pmc, passages: rows.length } }, { asType: "tool" });
      emit({ type: "step", tool: name, input, results: rows.length, ms: performance.now() - t1, returned: [], reasoning });
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
    updateActiveObservation({
      metadata: {
        mode, hits: res.hits.length, shownToModel: Math.min(res.hits.length, 15),
        // The turbopuffer filters each namespace actually applied, which can differ from what the model asked for.
        namespaces: res.runs.map((r) => ({ source: r.short, filters: r.filters })),
      },
    }, { asType: "tool" });
    // The model sees at most 15 hits; the step lists exactly those, with the tags it will cite.
    const shown = res.hits.slice(0, 15).map((h) => ({ t: tag(h), h }));
    // `raw` holds whole source documents and `request` the turbopuffer query body; the browser needs neither.
    const slim: StepSearch = {
      ...res,
      runs: res.runs.map((r) => ({ ...r, request: null })),
      hits: res.hits.map((h) => ({ ...h, raw: {} })),
    };
    emit({
      type: "step", tool: name, input, results: res.hits.length, ms: performance.now() - t1,
      returned: shown.map(({ t, h }) => ({ tag: t, title: h.title, key: h.key })), reasoning,
      filters: res.runs.map((r) => ({ source: r.short, filters: r.filters })), search: slim,
    });
    return shown.map(({ t, h }) => fmt(t, h)).join("\n\n") || "No results.";
  }

  const convo = [...messages];
  const used = { calls: 0, inTokens: 0, outTokens: 0 };
  let answer = "";
  const price = await priceOf(config.copilotModel);
  for (let turn = 0; turn < 6; turn++) {
    const params: Anthropic.MessageStreamParams = {
      model: config.copilotModel, max_tokens: 1500, system: SYSTEM(patient), tools: TOOLS, messages: [...convo],
      // The model thinks before choosing tools either way; "summarized" returns a summary of that thinking instead of an
      // empty block, for the Reasoning panel and Langfuse.
      thinking: { type: "adaptive", display: "summarized" },
    };
    // One generation per model call, with the exact prompt it was sent (system prompt, tools, every earlier turn).
    const gen = startObservation("generate-response", {
      model: config.copilotModel, modelParameters: { max_tokens: params.max_tokens, thinking: "adaptive, summarized" },
      input: promptOf(params), metadata: { turn },
    }, { asType: "generation" });
    const stream = llm.messages.stream(params);
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const tm = performance.now();
    let firstToken: number | null = null;
    stream.on("streamEvent", () => { firstToken ??= performance.now() - tm; });
    let msg: Anthropic.Message;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      gen.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) }).end();
      throw e;
    }
    gen.update({
      output: assistantMessage(msg.content),
      completionStartTime: firstToken === null ? undefined : new Date(performance.timeOrigin + tm + firstToken),
      ...usageOf(msg.usage, price),
      metadata: { turn, stopReason: msg.stop_reason },
    }).end();
    used.calls += 1;
    used.inTokens += msg.usage.input_tokens;
    used.outTokens += msg.usage.output_tokens;
    // Only a turn that calls tools has reasoning to attach; a final answer's text is the answer itself.
    const reasoning = msg.stop_reason === "tool_use" ? reasoningOf(msg.content) : undefined;
    trace("model", {
      turn, ms: Math.round(performance.now() - tm), firstTokenMs: firstToken && Math.round(firstToken), stop: msg.stop_reason,
      inTokens: msg.usage.input_tokens, outTokens: msg.usage.output_tokens, reasoning: reasoning?.slice(0, 500),
    });
    convo.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason !== "tool_use") {
      answer = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      break;
    }
    // Text written before a tool call is a preamble; the browser clears it when the next step arrives.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const tt = performance.now();
      // Every tool call in a turn shares that turn's reasoning: the model decided on them together.
      const input = block.input as Record<string, unknown>;
      const out = await startActiveObservation(TOOL_OBSERVATION[block.name] ?? "run-tool", async (obs) => {
        obs.update({ input, metadata: { tool: block.name, toolCallId: block.id, turn } });
        const text = await runTool(block.name, input, reasoning);
        // Exactly what the model was given back, tags and all.
        obs.update({ output: text });
        return text;
      }, { asType: "tool" });
      trace("tool", { turn, tool: block.name, ms: Math.round(performance.now() - tt), resultChars: out.length });
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    convo.push({ role: "user", content: results });
  }
  const cost = await costOf(config.copilotModel, used.inTokens, used.outTokens);
  trace("done", { totalMs: Math.round(performance.now() - t0), ...used, cost });
  emit({ type: "citations", items: cites });
  emit({ type: "usage", usage: { ...used, cost } });
  const seconds = (performance.now() - t0) / 1000;
  emit({ type: "done", seconds });
  const result = { answer, ...used, cost, citations: Object.keys(cites).length, seconds };
  if (!answer) return result;

  // Grounding check: give a fresh model call the answer plus the exact text of each cited source, as the copilot saw it.
  emit({ type: "checking" });
  const tg = performance.now();
  // Traced as an evaluator; its model call (verify-answer-claims) nests inside it.
  await startActiveObservation("check-answer-grounding", async (check) => {
    try {
      const citedTags = [...new Set([...answer.matchAll(/\[([NPFT]\d+)\]/g)].map((m) => m[1]))].filter((t) => cites[t]);
      const sources = citedTags.map((t) => ({ tag: t, text: fmt(t, cites[t]) }));
      check.update({ input: { answer, citedTags } });
      // The copilot was given the patient record in its system prompt, so the checker gets it too.
      const g = await checkGrounding(llm, config.copilotModel, answer, sources, patient ? JSON.stringify(patient) : null);
      const gCost = await costOf(config.copilotModel, g.inTokens, g.outTokens);
      const ms = performance.now() - tg;
      trace("grounding", { ms: Math.round(ms), claims: g.items.length,
        flagged: g.items.filter((i) => i.verdict !== "supported").length, inTokens: g.inTokens, outTokens: g.outTokens });
      emit({ type: "grounding", items: g.items, ms, usage: { calls: 1, inTokens: g.inTokens, outTokens: g.outTokens, cost: gCost } });
      const count = (v: GroundingItem["verdict"]) => g.items.filter((i) => i.verdict === v).length;
      check.update({
        output: { claims: g.items },
        metadata: {
          claims: g.items.length, supported: count("supported"), partial: count("partial"),
          unsupported: count("unsupported"), uncited: count("uncited"),
        },
      });
    } catch (e) {
      trace("grounding_error", { message: (e as Error).message.slice(0, 300) });
      check.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) });
      emit({ type: "grounding_error", message: "The source check couldn't run for this answer." });
    }
  }, { asType: "evaluator" });
  return result;
}
