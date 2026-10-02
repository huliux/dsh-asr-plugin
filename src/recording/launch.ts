import type { ProcessingLaunch } from "../worker/processing-launch.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkerEnvironment } from "../worker/launch.js";
import type { WorkerLaunchSpec } from "../worker/process.js";

export interface PackagedRecordingWorkerLaunchOptions {
  readonly processing?: ProcessingLaunch;
  readonly modelRoot: string;
  readonly packagedNativeRoot: string;
  readonly manifestPath: string;
  readonly meetingsRoot: string;
  readonly workRoot: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly expectedFingerprint: string;
  readonly graceMs: number;
}

export function createPackagedRecordingWorkerLaunch(
  options: PackagedRecordingWorkerLaunchOptions,
): WorkerLaunchSpec {
  const workerDirectory = dirname(fileURLToPath(import.meta.url));
  return {
    argv: [
      process.execPath,
      resolve(workerDirectory, "recording-entry.js"),
      options.modelRoot,
      options.packagedNativeRoot,
      options.manifestPath,
      options.meetingsRoot,
      options.workRoot,
      options.meetingId,
      options.runId,
      options.expectedFingerprint,
      ...(options.processing === undefined ? [] : [JSON.stringify(options.processing)]),
    ],
    cwd: workerDirectory,
    environment: createWorkerEnvironment(),
    graceMs: options.graceMs,
  };
}
