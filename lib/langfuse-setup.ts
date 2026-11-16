// Langfuse exporter setup, kept apart from lib/langfuse.ts so instrumentation.ts can load it without server-only code.
// Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; LANGFUSE_BASE_URL picks the region
// (https://us.cloud.langfuse.com for US cloud).
//
// The tracer provider is Langfuse's own, not the global OpenTelemetry one, so Next.js's built-in request spans never
// reach Langfuse and nothing else in the app changes. Spans are batched; routes flush them with after(flushLangfuse)
// so a Vercel function doesn't freeze before they're sent.
//
// Loaded lazily: the exporter and OpenTelemetry SDK add about 55-70 ms to a cold start, so they're imported in the
// background (started by instrumentation.ts, without blocking the first request) rather than at module load. The
// warm-up route (/api/warm) waits for them, so by the time a search runs they're normally ready. A request that beats
// the load on a cold instance runs untraced (its tpCall log line is still written).

const g = globalThis as typeof globalThis & {
  __langfuse?: { forceFlush(): Promise<void> } | null;
  __langfuseLoading?: Promise<void>;
};

export const langfuseEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

/** True once the exporter is set up and spans will be recorded. */
export const langfuseReady = () => !!g.__langfuse;

/**
 * Start setting up the exporter (once per server instance) and return a promise for it. Safe to call often; callers on
 * a request path don't await it, the warm-up route does.
 */
export function ensureLangfuse(): Promise<void> {
  if (g.__langfuseLoading) return g.__langfuseLoading;
  if (!langfuseEnabled) {
    g.__langfuse = null;
    return (g.__langfuseLoading = Promise.resolve());
  }
  g.__langfuseLoading = (async () => {
    const [{ context }, { AsyncLocalStorageContextManager }, { BasicTracerProvider }, { LangfuseSpanProcessor }, { setLangfuseTracerProvider }] =
      await Promise.all([
        import("@opentelemetry/api"),
        import("@opentelemetry/context-async-hooks"),
        import("@opentelemetry/sdk-trace-base"),
        import("@langfuse/otel"),
        import("@langfuse/tracing"),
      ]);
    // Without a context manager, OpenTelemetry can't carry the active observation across awaits, and every
    // observation would start its own trace instead of nesting under the question it belongs to.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const processor = new LangfuseSpanProcessor({
      // Keys and LANGFUSE_BASE_URL are read from the environment by the processor itself.
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
    });
    setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
    g.__langfuse = processor;
  })().catch((e) => {
    console.log(JSON.stringify({ langfuse: "setup_error", message: String((e as Error)?.message ?? e).slice(0, 200) }));
    g.__langfuse = null;
  });
  return g.__langfuseLoading;
}

/** Send buffered spans. Pass to after() in each traced route. */
export async function flushLangfuse(): Promise<void> {
  try {
    await g.__langfuse?.forceFlush();
  } catch (e) {
    console.log(JSON.stringify({ langfuse: "flush_error", message: (e as Error).message.slice(0, 200) }));
  }
}
