// Per-token list prices from AI Gateway's public model list, for the cost shown under each copilot answer.
// It's an estimate: it ignores prompt-cache discounts and any provider-specific pricing.
import "server-only";

type Price = { input: number; output: number };
let cache: { at: number; prices: Map<string, Price> } | null = null;
const DAY = 24 * 60 * 60 * 1000;

async function prices(): Promise<Map<string, Price>> {
  if (cache && Date.now() - cache.at < DAY) return cache.prices;
  const res = await fetch("https://ai-gateway.vercel.sh/v1/models", { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`models list ${res.status}`);
  const { data } = (await res.json()) as { data: { id: string; pricing?: { input?: string; output?: string } }[] };
  const map = new Map<string, Price>();
  for (const m of data) {
    const input = Number(m.pricing?.input), output = Number(m.pricing?.output);
    if (Number.isFinite(input) && Number.isFinite(output)) map.set(m.id, { input, output });
  }
  cache = { at: Date.now(), prices: map };
  return map;
}

/** Dollars per input and output token on `model`, or null when the model isn't an AI Gateway id or the list is unreachable. */
export async function priceOf(model: string): Promise<Price | null> {
  if (!model.includes("/")) return null; // a direct Anthropic model id, not priced through the gateway
  try {
    return (await prices()).get(model) ?? null;
  } catch {
    return null;
  }
}

/** Dollars for this many tokens on `model`, or null when the price is unknown. */
export async function costOf(model: string, inTokens: number, outTokens: number): Promise<number | null> {
  const p = await priceOf(model);
  return p ? inTokens * p.input + outTokens * p.output : null;
}
