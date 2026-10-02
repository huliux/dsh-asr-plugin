import { finished } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";

import { decodeFrames, writeFrame } from "../worker/framing.js";
import {
  parseRecordingFinalizeMessage,
  parseRecordingWorkerMessage,
} from "./worker-messages.js";
import type {
  RecordingFinalizeMessage,
  RecordingFinalResultPayload,
  RecordingRevisionMessage,
  RecordingWarningMessage,
  RecordingWorkerErrorCode,
  RecordingWorkerStage,
} from "./worker-types.js";
import { RECORDING_PROTOCOL_VERSION } from "./worker-types.js";

const ERROR_CODES = new Set<RecordingWorkerErrorCode>([
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
const STAGES = new Set<RecordingWorkerStage>([
  "initializing",
  "vad",
  "asr",
  "fbank",
  "embed",
  "cluster",
  "assign",
]);
const ERROR_MESSAGES: Readonly<Record<RecordingWorkerErrorCode, string>> = {
  INVALID_REQUEST: "Recording Worker request is invalid",
  ASSET_MISMATCH: "Recording Worker assets failed verification",
  AUDIO_READ_FAILED: "Closed recording audio could not be read",
  MODEL_LOAD_FAILED: "Recording model failed to load",
  MODEL_INFERENCE_FAILED: "Recording model inference failed",
  NATIVE_LOAD_FAILED: "Recording native runtime failed to load",
  NATIVE_FAILURE: "Recording native runtime failed",
  RESOURCE_LIMIT: "Recording Worker resource limit was exceeded",
  INTERNAL_ERROR: "Recording Worker failed internally",
};

export interface RecordingDraftLoopOptions {
  readonly signal: AbortSignal;
  publishRevision(message: RecordingRevisionMessage): Promise<void>;
  publishWarning(message: RecordingWarningMessage): Promise<void>;
}

export interface LoadedRecordingWorkerRuntime {
  readonly engineFingerprint: string;
  runDrafts(options: RecordingDraftLoopOptions): Promise<void>;
  finalize(message: RecordingFinalizeMessage): Promise<RecordingFinalResultPayload>;
  close(): Promise<void>;
}

export interface RecordingWorkerServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostics: Writable;
  load(): Promise<LoadedRecordingWorkerRuntime>;
}

class InvalidRecordingInput extends Error {}

async function endWritable(stream: Writable): Promise<void> {
  if (stream.destroyed) return;
  stream.end();
  await finished(stream, { cleanup: true, readable: false }).catch(() => undefined);
}

async function finishStreams(options: RecordingWorkerServerOptions): Promise<void> {
  await endWritable(options.output);
  await endWritable(options.diagnostics);
}

function diagnostic(stream: Writable, code: string): void {
  if (!stream.destroyed) stream.write(`RECORDING_WORKER ${code}\n`);
}

async function writeMessage(output: Writable, message: object): Promise<void> {
  parseRecordingWorkerMessage(message);
  await writeFrame(output, message);
}

async function writeReady(
  options: RecordingWorkerServerOptions,
  runtime: LoadedRecordingWorkerRuntime,
  loadMs: number,
): Promise<void> {
  await writeMessage(options.output, {
    type: "ready",
    recording_protocol_version: RECORDING_PROTOCOL_VERSION,
    kind: "recording",
    engine_fingerprint: runtime.engineFingerprint,
    load_ms: Math.max(0, Math.round(loadMs)),
  });
}

function rawCode(error: unknown): RecordingWorkerErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && ERROR_CODES.has(code as RecordingWorkerErrorCode)) {
      return code as RecordingWorkerErrorCode;
    }
  }
  return "INTERNAL_ERROR";
}

function rawStage(error: unknown, fallback: RecordingWorkerStage): RecordingWorkerStage {
  if (typeof error === "object" && error !== null && "stage" in error) {
    const stage = error.stage;
    if (typeof stage === "string" && STAGES.has(stage as RecordingWorkerStage)) {
      return stage as RecordingWorkerStage;
    }
  }
  return fallback;
}

async function writeError(
  options: RecordingWorkerServerOptions,
  error: unknown,
  requestId: string | null,
  fallbackStage: RecordingWorkerStage,
): Promise<void> {
  const code = rawCode(error);
  await writeMessage(options.output, {
    type: "error",
    request_id: requestId,
    code,
    stage: rawStage(error, fallbackStage),
    message: ERROR_MESSAGES[code],
  });
}

async function closeRuntime(runtime: LoadedRecordingWorkerRuntime): Promise<unknown | undefined> {
  try {
    await runtime.close();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function readFinalize(input: Readable): Promise<RecordingFinalizeMessage> {
  try {
    const iterator = decodeFrames(input)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new InvalidRecordingInput("FINALIZE is missing");
    const message = parseRecordingFinalizeMessage(first.value);
    const extra = await iterator.next();
    if (!extra.done) throw new InvalidRecordingInput("Worker accepts one FINALIZE");
    return message;
  } catch (error) {
    if (error instanceof InvalidRecordingInput) throw error;
    throw new InvalidRecordingInput("FINALIZE is invalid", { cause: error });
  }
}

function unexpectedDraftEnd(task: Promise<void>): Promise<never> {
  return task.then(
    () => Promise.reject(new Error("Recording draft loop ended before FINALIZE")),
    (error: unknown) => Promise.reject(error),
  );
}

async function stopDrafts(controller: AbortController, task: Promise<void>): Promise<unknown | undefined> {
  controller.abort();
  try {
    await task;
    return undefined;
  } catch (error) {
    return error;
  }
}

function startDrafts(
  options: RecordingWorkerServerOptions,
  runtime: LoadedRecordingWorkerRuntime,
  controller: AbortController,
): Promise<void> {
  return runtime.runDrafts({
    signal: controller.signal,
    publishRevision: (message) => writeMessage(options.output, message),
    publishWarning: (message) => writeMessage(options.output, message),
  });
}

async function failInitialization(
  options: RecordingWorkerServerOptions,
  error: unknown,
  runtime?: LoadedRecordingWorkerRuntime,
): Promise<1> {
  if (runtime !== undefined) await closeRuntime(runtime);
  try {
    await writeError(options, error, null, "initializing");
  } catch {
    diagnostic(options.diagnostics, "INITIALIZATION_FAILED");
  }
  await finishStreams(options);
  return 1;
}

async function failBeforeFinalize(
  options: RecordingWorkerServerOptions,
  runtime: LoadedRecordingWorkerRuntime,
  controller: AbortController,
  draftTask: Promise<void>,
  error: unknown,
): Promise<1> {
  await stopDrafts(controller, draftTask);
  await closeRuntime(runtime);
  if (error instanceof InvalidRecordingInput) {
    diagnostic(options.diagnostics, "INVALID_REQUEST");
  } else {
    await writeError(options, error, null, "asr").catch(() => {
      diagnostic(options.diagnostics, "DRAFT_FAILED");
    });
  }
  await finishStreams(options);
  return 1;
}

async function finishFinalization(
  options: RecordingWorkerServerOptions,
  runtime: LoadedRecordingWorkerRuntime,
  finalize: RecordingFinalizeMessage,
): Promise<0 | 1> {
  let payload: RecordingFinalResultPayload | undefined;
  let failure: unknown;
  try {
    payload = await runtime.finalize(finalize);
  } catch (error) {
    failure = error;
  }
  failure ??= await closeRuntime(runtime);
  try {
    if (failure !== undefined) {
      await writeError(options, failure, finalize.request_id, "asr");
      return 1;
    }
    await writeMessage(options.output, {
      type: "final_result",
      request_id: finalize.request_id,
      base_transcript_version: finalize.base_transcript_version,
      engine_fingerprint: runtime.engineFingerprint,
      payload,
    });
    return 0;
  } catch {
    diagnostic(options.diagnostics, "INTERNAL_ERROR");
    return 1;
  } finally {
    await finishStreams(options);
  }
}

export async function runRecordingWorkerServer(
  options: RecordingWorkerServerOptions,
): Promise<0 | 1> {
  const started = performance.now();
  let runtime: LoadedRecordingWorkerRuntime | undefined;
  try {
    runtime = await options.load();
    await writeReady(options, runtime, performance.now() - started);
  } catch (error) {
    return failInitialization(options, error, runtime);
  }
  const controller = new AbortController();
  const draftTask = startDrafts(options, runtime, controller);
  let finalize: RecordingFinalizeMessage;
  try {
    finalize = await Promise.race([readFinalize(options.input), unexpectedDraftEnd(draftTask)]);
  } catch (error) {
    return failBeforeFinalize(options, runtime, controller, draftTask, error);
  }
  const draftFailure = await stopDrafts(controller, draftTask);
  if (draftFailure !== undefined) {
    return failBeforeFinalize(options, runtime, controller, draftTask, draftFailure);
  }
  return finishFinalization(options, runtime, finalize);
}
