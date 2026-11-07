import type Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { copilotEnabled } from "@/lib/config";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { runCopilot, type CopilotEvent } from "@/lib/copilot";
import { getPatient } from "@/lib/patients";
import { requireUserId } from "@/lib/session";
import type { Mode } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (!copilotEnabled) {
    return Response.json({ error: "The copilot is off. Deploy on Vercel with AI Gateway, or set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY." }, { status: 503 });
  }
  const { messages, patientId, mode, conversationId } = (await req.json()) as {
    messages: Anthropic.MessageParam[]; patientId?: string; mode?: Mode; conversationId?: string;
  };
  const patient = await getPatient(patientId);
  // Langfuse groups a conversation's questions into one session; the browser makes a new id per patient and panel.
  const sessionId = typeof conversationId === "string" && /^[\w-]{8,64}$/.test(conversationId) ? conversationId : undefined;
  // Runs once the streamed response has finished, so the trace is sent before the function is frozen.
  after(flushLangfuse);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: CopilotEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await newTrace(
          { userId: user, sessionId, tags: ["copilot"], metadata: { patientId: patient?.id ?? "none" } },
          () => runCopilot(messages.slice(-12), patient, mode ?? "hybrid", emit),
        );
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
