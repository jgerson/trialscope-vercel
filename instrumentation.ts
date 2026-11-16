// Runs once when a server instance starts. Starts loading Langfuse tracing in the background (a no-op without Langfuse
// keys) without making the instance wait for it; see lib/langfuse-setup.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureLangfuse } = await import("./lib/langfuse-setup");
    void ensureLangfuse();
  }
}
