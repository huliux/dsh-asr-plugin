import type { ProcessingLaunch } from "./processing-launch.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkerLaunchSpec } from "./process.js";
import type { WorkerKind } from "./types.js";

const WORKER_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
] as const;

export function createWorkerEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of WORKER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export interface PackagedWorkerLaunchOptions {
  readonly kind: WorkerKind;
  readonly processing?: ProcessingLaunch;
  readonly modelRoot: string;
  readonly packagedNativeRoot: string;
  readonly manifestPath: string;
  readonly managedAudioDirectory: string;
  readonly graceMs: number;
}

export function createPackagedWorkerLaunch(
  options: PackagedWorkerLaunchOptions,
): WorkerLaunchSpec {
  const workerDirectory = dirname(fileURLToPath(import.meta.url));
  return {
    argv: [
      process.execPath,
      resolve(workerDirectory, `${options.kind}-entry.js`),
      options.modelRoot,
      options.packagedNativeRoot,
      options.manifestPath,
      options.managedAudioDirectory,
      ...(options.processing === undefined ? [] : [JSON.stringify(options.processing)]),
    ],
    cwd: workerDirectory,
    environment: createWorkerEnvironment(),
    graceMs: options.graceMs,
  };
}
