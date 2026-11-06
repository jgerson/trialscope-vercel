// Server-side settings. Read from environment variables (Vercel project settings or .env.local).
import "server-only";

export const config = {
  tpufKey: process.env.TURBOPUFFER_API_KEY ?? "",
  tpufRegion: process.env.TURBOPUFFER_REGION ?? "aws-us-east-1",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  copilotModel: process.env.COPILOT_MODEL ?? "claude-sonnet-5-5",
  appPassword: process.env.APP_PASSWORD ?? "",
  readOnly: ["1", "true", "yes"].includes((process.env.READ_ONLY ?? "").toLowerCase()),
  embedModel: "voyage/voyage-4-lite",
};

export const NS = {
  prefix: "ts-",
  trials: "ts-trials",
  pubmed: "ts-pubmed",
  patients: "ts-patients",
  patient: (id: string) => `ts-patient-${id}`,
};

export const RRF_K = 60;
