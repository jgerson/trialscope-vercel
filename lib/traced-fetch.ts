// A fetch that records each outgoing HTTP call as a span in Langfuse, nested under whatever is running (a turbopuffer
// step, a model call, a ClinicalTrials.gov read). It's passed to the turbopuffer and Anthropic clients and used for
// ClinicalTrials.gov, so a trace shows network time next to each service's own timings. Outside a trace, or without
// Langfuse keys, it's plain fetch.
//
// Recorded: method, host, path, status, time until the response headers arrived, and request and response sizes.
// For turbopuffer reads, also the full URL and the JSON request body, so the span is the exact call (paste it into
// curl with your own key). Never recorded: headers (they hold keys), query strings, response bodies, any request body
// sent elsewhere (model prompts carry patient text), and turbopuffer write bodies (their rows can hold patient notes).
import "server-only";
import { startObservation } from "@langfuse/tracing";
import { langfuseEnabled, langfuseReady } from "./langfuse-setup";
import { insideTrace } from "./langfuse";

export const tracedFetch: typeof fetch = async (input, init) => {
  if (!langfuseEnabled || !langfuseReady() || !insideTrace()) return fetch(input, init);
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return fetch(input, init);
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const requestBytes = typeof init?.body === "string" ? init.body.length : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let span: any;
  try {
    span = startObservation(`http ${method} ${url.host}`, {
      input: { method, host: url.host, path: url.pathname, ...tpufRequest(url, init?.body) },
      metadata: { kind: "http", method, host: url.host, path: url.pathname, requestBytes },
    }, { asType: "span" });
  } catch {
    return fetch(input, init); // tracing must never break the request
  }
  const t0 = performance.now();
  try {
    const res = await fetch(input, init);
    const ms = Math.round(performance.now() - t0);
    const len = Number(res.headers.get("content-length"));
    safe(() => span.update({
      output: { status: res.status, ms },
      // For a streamed response (the copilot's model calls) this is time to first byte; the stream continues after.
      metadata: { status: res.status, ms, responseBytes: Number.isFinite(len) && len > 0 ? len : undefined,
        streamed: (res.headers.get("content-type") ?? "").includes("event-stream") },
      ...(res.ok ? {} : { level: res.status >= 500 ? "ERROR" : "WARNING", statusMessage: `HTTP ${res.status}` }),
    }).end());
    return res;
  } catch (e) {
    safe(() => span.update({ level: "ERROR", statusMessage: String((e as Error)?.message ?? e).slice(0, 300) }).end());
    throw e;
  }
};

const TPUF_HOST = /(^|\.)turbopuffer\.com$/;
// Request keys that make a turbopuffer call a write; their bodies are never recorded.
const WRITE_KEYS = ["upsert_rows", "upsert_columns", "patch_rows", "patch_columns", "deletes", "delete_by_filter",
  "patch_by_filter", "copy_from_namespace"];
const MAX_BODY_CHARS = 16_000;

/** For a turbopuffer call: the full URL and, for a read, its JSON body. Nothing for any other host. */
function tpufRequest(url: URL, body: unknown): { url?: string; body?: unknown } {
  if (!TPUF_HOST.test(url.host)) return {};
  const full = { url: `${url.origin}${url.pathname}` };
  if (typeof body !== "string" || !body) return full;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return full;
  }
  if (json && typeof json === "object" && WRITE_KEYS.some((k) => k in json)) {
    return { ...full, body: { omitted: "write request (rows can hold patient notes)" } };
  }
  if (body.length > MAX_BODY_CHARS) return { ...full, body: { omitted: `request body over ${MAX_BODY_CHARS} characters`, chars: body.length } };
  return { ...full, body: json };
}

function safe(f: () => unknown) {
  try {
    f();
  } catch {
    // ignore tracing errors
  }
}
