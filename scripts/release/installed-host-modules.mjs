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
