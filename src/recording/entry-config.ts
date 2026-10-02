import { parseProcessingLaunch } from "../worker/processing-launch.js";
import type { ProcessingLaunch } from "../worker/processing-launch.js";
import { isAbsolute } from "node:path";

import { WorkerRuntimeError } from "../worker/worker-errors.js";

const MAX_PATH_LENGTH = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RecordingWorkerEntryConfig {
  readonly processing?: ProcessingLaunch;
  readonly modelRoot: string;
  readonly packagedNativeRoot: string;
  readonly manifestPath: string;
  readonly meetingsRoot: string;
  readonly workRoot: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly expectedFingerprint: string;
}

function invalid(message: string): never {
  throw new WorkerRuntimeError("INVALID_REQUEST", message);
}

function entryPath(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > MAX_PATH_LENGTH ||
    !isAbsolute(value)
  ) invalid("Recording Worker entry path is invalid");
  return value;
}

function identity(value: string | undefined): string {
  if (value === undefined || !UUID_PATTERN.test(value)) {
    invalid("Recording Worker identity is invalid");
  }
  return value;
}

function fingerprint(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
    invalid("Recording Worker fingerprint is invalid");
  }
  return value;
}

export function parseRecordingWorkerEntryConfig(
  argv: readonly string[],
): RecordingWorkerEntryConfig {
  if (argv.length !== 8 && argv.length !== 9) invalid("Recording Worker entry requires eight arguments");
  return {
    ...(argv[8] === undefined ? {} : { processing: parseProcessingLaunch(argv[8]) }),
    modelRoot: entryPath(argv[0]),
    packagedNativeRoot: entryPath(argv[1]),
    manifestPath: entryPath(argv[2]),
    meetingsRoot: entryPath(argv[3]),
    workRoot: entryPath(argv[4]),
    meetingId: identity(argv[5]),
    runId: identity(argv[6]),
    expectedFingerprint: fingerprint(argv[7]),
  };
}
