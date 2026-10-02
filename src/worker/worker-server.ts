import { finished } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";

import { decodeFrames, writeFrame } from "./framing.js";
import { parseRunMessage, parseWorkerMessage } from "./messages.js";
import type {
  AsrResultPayload,
  AsrRunMessage,
  DiarizationResultPayload,
  DiarizationRunMessage,
  WorkerKind,
  WorkerProgressStage,
  WorkerResultMessage,
} from "./types.js";
import { WORKER_PROTOCOL_VERSION } from "./types.js";
import { sanitizeWorkerFailure } from "./worker-errors.js";

type RunFor<K extends WorkerKind> = K extends "asr" ? AsrRunMessage : DiarizationRunMessage;
type PayloadFor<K extends WorkerKind> = K extends "asr"
  ? AsrResultPayload
  : DiarizationResultPayload;

export interface LoadedWorkerRuntime<K extends WorkerKind> {
  readonly engineFingerprint: string;
  execute(
    run: RunFor<K>,
    report: (stage: WorkerProgressStage, ratio: number) => Promise<void>,
  ): Promise<PayloadFor<K>>;
  close(): Promise<void>;
}

export interface WorkerServerOptions<K extends WorkerKind> {
  readonly kind: K;
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostics: Writable;
  load(): Promise<LoadedWorkerRuntime<K>>;
}

class InvalidWorkerInput extends Error {}

async function endWritable(stream: Writable): Promise<void> {
  if (stream.destroyed) return;
  stream.end();
  await finished(stream, { cleanup: true, readable: false }).catch(() => undefined);
}

async function finishStreams(options: WorkerServerOptions<WorkerKind>): Promise<void> {
  await endWritable(options.output);
  await endWritable(options.diagnostics);
}

function diagnostic(stream: Writable, code: string): void {
  if (!stream.destroyed) stream.write(`WORKER ${code}\n`);
}

async function readSingleRun<K extends WorkerKind>(
  input: Readable,
  kind: K,
): Promise<RunFor<K>> {
  const iterator = decodeFrames(input)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new InvalidWorkerInput("RUN is missing");
  const run = parseRunMessage(first.value, kind) as RunFor<K>;
  const extra = await iterator.next();
  if (!extra.done) throw new InvalidWorkerInput("Worker accepts exactly one RUN");
  return run;
}

async function writeMessage(
  output: Writable,
  message: object,
): Promise<void> {
  await writeFrame(output, message);
}

async function writeReady<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
  runtime: LoadedWorkerRuntime<K>,
  loadMs: number,
): Promise<void> {
  const message = {
    type: "ready",
    protocol_version: WORKER_PROTOCOL_VERSION,
    kind: options.kind,
    engine_fingerprint: runtime.engineFingerprint,
    load_ms: Math.max(0, Math.round(loadMs)),
  } as const;
  parseWorkerMessage(message, options.kind);
  await writeMessage(options.output, message);
}

function resultMessage<K extends WorkerKind>(
  kind: K,
  run: RunFor<K>,
  payload: PayloadFor<K>,
): WorkerResultMessage {
  return {
    type: "result",
    request_id: run.request_id,
    kind,
    base_transcript_version: run.base_transcript_version,
    payload,
  } as WorkerResultMessage;
}

async function writeError<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
  error: unknown,
  requestId: string | null,
  fallbackStage: WorkerProgressStage | "initializing",
): Promise<void> {
  const failure = sanitizeWorkerFailure(error, options.kind, fallbackStage);
  const message = { type: "error", request_id: requestId, ...failure } as const;
  parseWorkerMessage(message, options.kind);
  await writeMessage(options.output, message);
}

function progressReporter<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
  run: RunFor<K>,
): (stage: WorkerProgressStage, ratio: number) => Promise<void> {
  let count = 0;
  return async (stage, ratio) => {
    if (++count > 1_000) throw new Error("Worker emitted too many progress messages");
    const message = { type: "progress", request_id: run.request_id, stage, ratio } as const;
    parseWorkerMessage(message, options.kind);
    await writeMessage(options.output, message);
  };
}

async function closeRuntime(runtime: LoadedWorkerRuntime<WorkerKind>): Promise<unknown | undefined> {
  try {
    await runtime.close();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function failInitialization<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
  error: unknown,
  runtime?: LoadedWorkerRuntime<K>,
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

async function failUntrustedInput<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
  runtime: LoadedWorkerRuntime<K>,
): Promise<1> {
  await closeRuntime(runtime);
  diagnostic(options.diagnostics, "INVALID_REQUEST");
  await finishStreams(options);
  return 1;
}

async function finishExecution<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
  runtime: LoadedWorkerRuntime<K>,
  run: RunFor<K>,
): Promise<0 | 1> {
  let payload: PayloadFor<K> | undefined;
  let failure: unknown;
  try {
    payload = await runtime.execute(run, progressReporter(options, run));
  } catch (error) {
    failure = error;
  }
  const closeFailure = await closeRuntime(runtime);
  failure ??= closeFailure;
  try {
    if (failure !== undefined) {
      await writeError(options, failure, run.request_id, options.kind === "asr" ? "asr" : "embed");
      return 1;
    }
    const message = resultMessage(options.kind, run, payload!);
    try {
      parseWorkerMessage(message, options.kind);
    } catch (error) {
      await writeError(options, error, run.request_id, options.kind === "asr" ? "asr" : "embed");
      return 1;
    }
    await writeMessage(options.output, message);
    return 0;
  } catch (error) {
    diagnostic(options.diagnostics, "INTERNAL_ERROR");
    return 1;
  } finally {
    await finishStreams(options);
  }
}

export async function runWorkerServer<K extends WorkerKind>(
  options: WorkerServerOptions<K>,
): Promise<0 | 1> {
  const started = performance.now();
  let runtime: LoadedWorkerRuntime<K> | undefined;
  try {
    runtime = await options.load();
    await writeReady(options, runtime, performance.now() - started);
  } catch (error) {
    return failInitialization(options, error, runtime);
  }
  let run: RunFor<K>;
  try {
    run = await readSingleRun(options.input, options.kind);
  } catch {
    return failUntrustedInput(options, runtime);
  }
  return finishExecution(options, runtime, run);
}
