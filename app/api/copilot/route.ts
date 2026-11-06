import type Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { runCopilot, type CopilotEvent } from "@/lib/copilot";
import { getPatient } from "@/lib/patients";
import type { Mode } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!config.anthropicKey) {
    return Response.json({ error: "The copilot is off. Set ANTHROPIC_API_KEY to turn it on." }, { status: 503 });
  }
  const { messages, patientId, mode } = (await req.json()) as {
    messages: Anthropic.MessageParam[]; patientId?: string; mode?: Mode;
  };
  const patient = await getPatient(patientId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: CopilotEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runCopilot(messages.slice(-12), patient, mode ?? "hybrid", emit);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
