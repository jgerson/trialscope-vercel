// The copilot: Claude with two tools backed by turbopuffer, streamed to the browser as NDJSON events.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { config, NS } from "./config";
import { buildFilters, listNotes, search } from "./tpuf";
import { checkGrounding } from "./grounding";
import { costOf } from "./pricing";
import type { GroundingItem, Hit, Mode, Patient, SearchResponse, Usage } from "./types";

const TAG: Record<Hit["kind"], string> = { notes: "N", pubmed: "P", trials: "T" };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search TrialScope. Sources: 'patient' (the current patient's notes), 'pubmed' (oncology and cardiology abstracts, " +
      "2015 onward) and 'trials' (ClinicalTrials.gov interventional studies). Hybrid search (BM25 + vector, fused with " +
      "RRF). Put drug names, genes and NCT ids in the query text. Use filters to narrow trials by status, phase, " +
      "country, patient age and sex.",
    input_schema: {
      type: "object",
      properties: {
        sources: { type: "array", items: { type: "string", enum: ["patient", "pubmed", "trials"] } },
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
    name: "read_patient_notes",
    description: "Read the current patient's most recent notes in full, newest first.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
];

const SYSTEM = (patient: Patient | null) => `You are the TrialScope copilot, helping a physician search their own patient \
notes, PubMed and ClinicalTrials.gov. All patients are synthetic demo records.

Rules:
- Ground every claim in tool results and cite it with the tag shown in the result, like [N2], [P1] or [T3].
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

export async function runCopilot(
  messages: Anthropic.MessageParam[],
  patient: Patient | null,
  mode: Mode,
  emit: (e: CopilotEvent) => void,
): Promise<void> {
  const llm = await copilotClient();
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
  const fmt = (t: string, h: Hit) => `[${t}] ${[h.code, ...h.meta].filter(Boolean).join(" | ")} | ${h.title}\n${h.snippet}`;

  async function runTool(name: string, input: Record<string, unknown>, reasoning?: string): Promise<string> {
    const t1 = performance.now();
    if (name === "read_patient_notes") {
      if (!patient) return "No patient selected.";
      // Capped: some models ask for 50+ notes, which bloats every later turn of the conversation.
      const notes = (await listNotes(patient.id)).slice(0, Math.min(Number(input.limit ?? 10), 20));
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
    const sources = (input.sources as string[]) ?? [];
    const targets: { namespace: string; filter: unknown[] | null }[] = [];
    if (sources.includes("patient") && patient) targets.push({ namespace: NS.patient(patient.id), filter: null });
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
  for (let turn = 0; turn < 6; turn++) {
    const stream = llm.messages.stream({
      model: config.copilotModel, max_tokens: 1500, system: SYSTEM(patient), tools: TOOLS, messages: convo,
    });
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const tm = performance.now();
    let firstToken: number | null = null;
    stream.on("streamEvent", () => { firstToken ??= performance.now() - tm; });
    const msg = await stream.finalMessage();
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
      const out = await runTool(block.name, block.input as Record<string, unknown>, reasoning);
      trace("tool", { turn, tool: block.name, ms: Math.round(performance.now() - tt), resultChars: out.length });
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    convo.push({ role: "user", content: results });
  }
  const cost = await costOf(config.copilotModel, used.inTokens, used.outTokens);
  trace("done", { totalMs: Math.round(performance.now() - t0), ...used, cost });
  emit({ type: "citations", items: cites });
  emit({ type: "usage", usage: { ...used, cost } });
  emit({ type: "done", seconds: (performance.now() - t0) / 1000 });
  if (!answer) return;

  // Grounding check: give a fresh model call the answer plus the exact text of each cited source, as the copilot saw it.
  emit({ type: "checking" });
  const tg = performance.now();
  try {
    const citedTags = [...new Set([...answer.matchAll(/\[([NPT]\d+)\]/g)].map((m) => m[1]))].filter((t) => cites[t]);
    const sources = citedTags.map((t) => ({ tag: t, text: fmt(t, cites[t]) }));
    // The copilot was given the patient record in its system prompt, so the checker gets it too.
    const g = await checkGrounding(llm, config.copilotModel, answer, sources, patient ? JSON.stringify(patient) : null);
    const gCost = await costOf(config.copilotModel, g.inTokens, g.outTokens);
    const ms = performance.now() - tg;
    trace("grounding", { ms: Math.round(ms), claims: g.items.length,
      flagged: g.items.filter((i) => i.verdict !== "supported").length, inTokens: g.inTokens, outTokens: g.outTokens });
    emit({ type: "grounding", items: g.items, ms, usage: { calls: 1, inTokens: g.inTokens, outTokens: g.outTokens, cost: gCost } });
  } catch (e) {
    trace("grounding_error", { message: (e as Error).message.slice(0, 300) });
    emit({ type: "grounding_error", message: "The source check couldn't run for this answer." });
  }
}
