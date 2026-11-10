import type { Context, FiberState } from "@deepseek-ai/cordis";

const ACTIVE_FIBER_STATE = 2 satisfies FiberState;

export function refreshSettingsOnActivation(context: Context): void {
  context.on("internal/status", fiber => {
    if (fiber !== context.fiber || fiber.state !== ACTIVE_FIBER_STATE) return;
    try {
      context.get("settings")?.describe({ redactSecrets: true });
    } catch {
      context.logger("dsh-asr").warn("SETTINGS_REFRESH_FAILED");
    }
  });
}

type ContinueUpdate = () => void | Promise<void>;

export function registerConfigUpdates<Config>(context: Context, needsRestart: (config: Config) => boolean): void {
  context.on("internal/update", (...update:
    | [config: Config, next: ContinueUpdate]
    | [config: Config, noSave: boolean, next: ContinueUpdate]
  ) => {
    const [config] = update;
    if (needsRestart(config)) {
      // Cordis 4.0 passes the no-save flag before the continuation; 4.1 omits it.
      const next = update.length === 3 ? update[2] : update[1];
      return next();
    }
    context.fiber.config = config;
  });
}
