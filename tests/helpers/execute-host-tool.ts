import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

export async function executeHostTool(context: Context, input: {
  agent?: Agent;
  callId: string;
  name: string;
  arguments: unknown;
  signal: AbortSignal;
}) {
  const { agent, callId, name, arguments: args, signal } = input;
  const { results } = await context.tools.execute({
    calls: [{ type: "tool-call", id: ToolCallId(callId), name, arguments: JSON.stringify(args) }],
    signal,
    ...(agent === undefined ? {} : { agent }),
  });
  const settled = results[0];
  if (settled?.callId !== callId) throw new Error(`Missing tool result for ${callId}`);
  return settled.result;
}
