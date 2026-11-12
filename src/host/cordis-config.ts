import type { Context, FiberState } from "@deepseek-ai/cordis";

const ACTIVE_FIBER_STATE = 2 satisfies FiberState;

interface ConfigFiber {
  readonly config?: unknown;
  readonly effectiveConfig?: unknown;
}

/**
 * Cordis 4.1 keeps the raw plugin input on `fiber.config` and publishes the
 * resolved config (volatile accessors included) on `fiber.effectiveConfig`.
 * Older hosts only expose resolved values on `fiber.config`, so read both.
 */
export function effectiveConfig<Config>(context: Context): Config {
  const fiber = context.fiber as unknown as ConfigFiber;
  return (fiber.effectiveConfig ?? fiber.config) as Config;
}

/**
 * Volatile fields are `Volatile` refs in a resolved config, but hosts that keep
 * the raw input (or plain schema fields) expose the value directly.
 */
export function readVolatile<T>(value: unknown): T | undefined {
  if (value !== null && typeof value === "object" &&
    typeof (value as { get?: unknown }).get === "function") {
    return (value as { get(): T }).get();
  }
  return value as T | undefined;
}

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
    // Cordis 4.1 publishes the resolved config itself; only older hosts need the swap.
    if (!("effectiveConfig" in (context.fiber as unknown as ConfigFiber))) {
      context.fiber.config = config;
    }
  });
}
