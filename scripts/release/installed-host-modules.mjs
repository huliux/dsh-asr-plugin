import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Standalone probes use the installed host's missing peers, without changing profile files.
export function useInstalledHostModules(hostEntry) {
  const requireHost = createRequire(hostEntry);
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (!specifier.startsWith("@deepseek-ai/") ||
          !["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error.code)) throw error;
        return nextResolve(pathToFileURL(requireHost.resolve(specifier)).href, context);
      }
    },
  });
}

export async function mountInstalledHostTools(context, loadHost) {
  await context.plugin((await loadHost("dsh-system-prompt")).default);
  await context.plugin((await loadHost("dsh-tools")).default);
  if (typeof context.tools.setExecutor === "function") {
    await context.plugin((await loadHost("dsh-session-projection")).default);
    await context.plugin(await loadHost("dsh-tool-executor-native"));
  }
}

export async function executeInstalledHostTool(context, input) {
  if (typeof context.tools.setExecutor !== "function") return context.tools.execute(input);
  const { agent, callId, name, arguments: args, signal } = input;
  const { results } = await context.tools.execute({
    agent, signal,
    calls: [{ type: "tool-call", id: callId, name, arguments: JSON.stringify(args) }],
  });
  const settled = results[0];
  if (settled?.callId !== callId) throw new Error(`Missing tool result for ${callId}`);
  return settled.result;
}
