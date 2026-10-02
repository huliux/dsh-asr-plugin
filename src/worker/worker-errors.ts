import type { WorkerErrorCode, WorkerKind, WorkerStage } from "./types.js";

const WORKER_CODES = new Set<WorkerErrorCode>([
  "INVALID_REQUEST",
  "ASSET_MISMATCH",
  "AUDIO_READ_FAILED",
  "MODEL_LOAD_FAILED",
  "MODEL_INFERENCE_FAILED",
  "NATIVE_LOAD_FAILED",
  "NATIVE_FAILURE",
  "RESOURCE_LIMIT",
  "INTERNAL_ERROR",
]);

const MESSAGES: Readonly<Record<WorkerErrorCode, string>> = {
  INVALID_REQUEST: "Worker request is invalid",
  ASSET_MISMATCH: "Worker assets failed verification",
  AUDIO_READ_FAILED: "Managed audio could not be read",
  MODEL_LOAD_FAILED: "Model failed to load",
  MODEL_INFERENCE_FAILED: "Model inference failed",
  NATIVE_LOAD_FAILED: "Native runtime failed to load",
  NATIVE_FAILURE: "Native runtime failed",
  RESOURCE_LIMIT: "Worker resource limit was exceeded",
  INTERNAL_ERROR: "Worker failed internally",
};

export class WorkerRuntimeError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly stage?: WorkerStage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkerRuntimeError";
  }
}

function rawCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function mapCode(error: unknown): WorkerErrorCode {
  const code = rawCode(error);
  if (code !== undefined && WORKER_CODES.has(code as WorkerErrorCode)) {
    return code as WorkerErrorCode;
  }
  if (
    code?.startsWith("ASSET_") === true ||
    code === "MANIFEST_INVALID" ||
    code === "RUNTIME_MISMATCH"
  ) return "ASSET_MISMATCH";
  if (code === "INPUT_INVALID" || code === "NATIVE_INPUT_INVALID") return "INVALID_REQUEST";
  if (code === "NATIVE_LOAD_FAILED") return "NATIVE_LOAD_FAILED";
  if (code?.startsWith("NATIVE_") === true) return "NATIVE_FAILURE";
  return "INTERNAL_ERROR";
}

function stageFrom(error: unknown): WorkerStage | undefined {
  if (typeof error !== "object" || error === null || !("stage" in error)) return undefined;
  return typeof error.stage === "string" ? error.stage as WorkerStage : undefined;
}

function allowedStage(kind: WorkerKind, stage: WorkerStage): boolean {
  if (stage === "initializing") return true;
  return kind === "asr"
    ? stage === "vad" || stage === "asr"
    : stage === "fbank" || stage === "embed" || stage === "cluster" || stage === "assign";
}

export interface SanitizedWorkerFailure {
  readonly code: WorkerErrorCode;
  readonly message: string;
  readonly stage: WorkerStage;
}

export function sanitizeWorkerFailure(
  error: unknown,
  kind: WorkerKind,
  fallbackStage: WorkerStage,
): SanitizedWorkerFailure {
  const code = mapCode(error);
  const candidate = stageFrom(error);
  const stage = candidate !== undefined && allowedStage(kind, candidate)
    ? candidate
    : fallbackStage;
  return { code, message: MESSAGES[code], stage };
}

export function stageWorkerFailure(
  error: unknown,
  kind: WorkerKind,
  stage: Exclude<WorkerStage, "initializing">,
): WorkerRuntimeError {
  const failure = sanitizeWorkerFailure(error, kind, stage);
  return new WorkerRuntimeError(failure.code, failure.message, stage, { cause: error });
}
