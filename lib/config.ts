// Server-side settings. Read from environment variables (Vercel project settings or .env.local).
import "server-only";

export const config = {
  tpufKey: process.env.TURBOPUFFER_API_KEY ?? "",
  tpufRegion: process.env.TURBOPUFFER_REGION ?? "aws-us-east-1",
  // Copilot: an ANTHROPIC_API_KEY calls Anthropic directly. Without one, calls go through Vercel AI Gateway,
  // authenticated by AI_GATEWAY_API_KEY or, on Vercel (and locally after `vercel env pull`), the project's OIDC token.
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  gatewayKey: process.env.AI_GATEWAY_API_KEY ?? "",
  onVercel: Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN),
  copilotModel:
    process.env.COPILOT_MODEL ?? (process.env.ANTHROPIC_API_KEY ? "claude-sonnet-5-5" : "anthropic/claude-sonnet-5.5"),
  readOnly: ["1", "true", "yes"].includes((process.env.READ_ONLY ?? "").toLowerCase()),
  // Anthropic prompt caching for the copilot (COPILOT_PROMPT_CACHE=true). Each model call in a question re-sends the
  // system prompt, tools and earlier turns; cached, those cost a fraction of the input price on the next call.
  promptCache: ["1", "true", "yes"].includes((process.env.COPILOT_PROMPT_CACHE ?? "").toLowerCase()),
  embedModel: "voyage/voyage-4-lite",
  // Hybrid search fuses on turbopuffer (rerank_by ["RRF"]). Verification re-runs the two subqueries unfused, recomputes
  // RRF in the app and checks the two agree; it also powers the per-list ranks in the Explain panel (see fusionVerify).
  // Ranking boosts map BM25 into 0..1 with Saturate; this is the BM25 score that becomes 0.5 (see lib/ranking.ts).
  bm25Midpoint: Number(process.env.BOOST_BM25_MIDPOINT) > 0 ? Number(process.env.BOOST_BM25_MIDPOINT) : 6,
  // Model reranking (Fused by → Model rerank): turbopuffer's rerank_by with this model over the `text` attribute.
  rerankModel: process.env.RERANK_MODEL || "zeroentropy/zerank-2",
  rerankCandidates: Math.min(100, Math.max(10, Number(process.env.RERANK_CANDIDATES) || 20)),
  // How the app checks turbopuffer's RRF against its own: "lazy" (default) fetches the unfused lists only when you open
  // Explain; "always" fetches them with every hybrid search (one extra request per source); "off" never does.
  fusionVerify: ((v) => (["always", "true", "1"].includes(v) ? "always" : ["off", "false", "0", "no"].includes(v) ? "off" : "lazy"))(
    (process.env.FUSION_VERIFY ?? "").toLowerCase()) as "lazy" | "always" | "off",
  // Copilot model reranking: "ask" (default) only when the question explicitly asks for it; "auto" lets the model decide;
  // "never" and "always" override it.
  copilotRerank: ((v) => (["auto", "never", "always"].includes(v) ? v : "ask"))((process.env.COPILOT_RERANK ?? "").toLowerCase()) as
    "ask" | "auto" | "never" | "always",
};

export const copilotEnabled = Boolean(config.anthropicKey || config.gatewayKey || config.onVercel);

export const NS = {
  prefix: "ts-",
  trials: "ts-trials",
  pubmed: "ts-pubmed",
  patients: "ts-patients",
  patient: (id: string) => `ts-patient-${id}`,
};

export const RRF_K = 60;
