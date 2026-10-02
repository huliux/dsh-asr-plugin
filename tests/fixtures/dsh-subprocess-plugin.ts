import type { Context } from "@deepseek-ai/cordis";

import { createDshWorkerSpawner } from "../../src/worker/dsh-spawner.js";
import type { WorkerSpawner } from "../../src/worker/process.js";

export const name = "dsh-asr-subprocess-probe";
export const inject = ["subprocess"];

let activeSpawner: WorkerSpawner | undefined;

export function apply(ctx: Context): void {
  const spawner = createDshWorkerSpawner(ctx.subprocess);
  activeSpawner = spawner;
  ctx.effect(() => () => {
    if (activeSpawner === spawner) activeSpawner = undefined;
  }, "dsh-asr subprocess probe");
}

export function requireAssembledSpawner(): WorkerSpawner {
  if (activeSpawner === undefined) throw new Error("DSH_SUBPROCESS_NOT_INJECTED");
  return activeSpawner;
}
