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
  appPassword: process.env.APP_PASSWORD ?? "",
  readOnly: ["1", "true", "yes"].includes((process.env.READ_ONLY ?? "").toLowerCase()),
  embedModel: "voyage/voyage-4-lite",
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
