import { FrameProtocolError, decodeFrames, writeFrame } from "../worker/framing.js";
import {
  assertPositiveTimeout,
  assertWorkerLaunch,
  closeWorkerInput,
  EMPTY_STDERR,
  requireWorkerStreams,
  requireWorkerTreeExit,
  settleWorkerFailure,
  waitAbortable,
  waitBounded,
  WorkerProcessFailure,
  WorkerWaitFailure,
} from "../worker/client-process.js";
import type {
  WorkerFailureSettlement,
  WorkerSessionStreams,
} from "../worker/client-process.js";
import type {
  WorkerLaunchSpec,
  WorkerProcessHandle,
  WorkerProcessOutcome,
  WorkerSpawner,
} from "../worker/process.js";
import { drainStderrTail } from "../worker/stderr-tail.js";
import type { StderrTail } from "../worker/stderr-tail.js";
import {
  RecordingWorkerHostState,
  RecordingWorkerProtocolError,
} from "./worker-host-state.js";
import type { RecordingWorkerTerminal } from "./worker-host-state.js";
import {
  parseRecordingFinalizeMessage,
  parseRecordingWorkerMessage,
  RecordingWorkerSchemaError,
} from "./worker-messages.js";
import type {
  DraftTranscriptSnapshot,
  RecordingFinalizeMessage,
  RecordingFinalResultMessage,
  RecordingWarningMessage,
  RecordingWorkerErrorCode,
  RecordingWorkerReadyMessage,
} from "./worker-types.js";

export type RecordingWorkerClientErrorCode =
  | RecordingWorkerErrorCode
  | "WORKER_CANCELLED"
  | "WORKER_PROCESS_ERROR"
  | "WORKER_PROTOCOL_ERROR"
  | "WORKER_TIMEOUT";

export type RecordingWorkerDeadlinePhase = "ready" | "recording" | "finalize" | "termination";

interface RecordingWorkerClientErrorDetails {
  readonly cause?: unknown;
  readonly outcome?: WorkerProcessOutcome;
  readonly phase?: RecordingWorkerDeadlinePhase;
  readonly stage?: string;
  readonly stderr: StderrTail;
}

export class RecordingWorkerClientError extends Error {
  readonly outcome: WorkerProcessOutcome | undefined;
  readonly phase: RecordingWorkerDeadlinePhase | undefined;
  readonly stage: string | undefined;
  readonly stderrTail: string;
  readonly stderrTruncated: boolean;

  constructor(
    readonly code: RecordingWorkerClientErrorCode,
    message: string,
    details: RecordingWorkerClientErrorDetails,
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RecordingWorkerClientError";
    this.outcome = details.outcome;
    this.phase = details.phase;
    this.stage = details.stage;
    this.stderrTail = details.stderr.text;
    this.stderrTruncated = details.stderr.truncated;
  }

  static cancelled(phase: RecordingWorkerDeadlinePhase): RecordingWorkerClientError {
    return new RecordingWorkerClientError("WORKER_CANCELLED", "Recording Worker was cancelled", {
      phase,
      stderr: EMPTY_STDERR,
    });
  }
}

export interface RecordingWorkerClientOptions {
  readonly expectedFingerprint: string;
  readonly spawner: WorkerSpawner;
  readonly launch: WorkerLaunchSpec;
  readonly readyTimeoutMs: number;
  readonly finalizeDeadlineMs: number;
  readonly terminationTimeoutMs: number;
}

export interface RecordingWorkerStartOptions {
  readonly signal?: AbortSignal;
  readonly onReady?: (message: RecordingWorkerReadyMessage) => void;
  readonly onRevision?: (snapshot: DraftTranscriptSnapshot) => void;
  readonly onWarning?: (message: RecordingWarningMessage) => void;
}

export interface RecordingWorkerSession {
  readonly completion: Promise<RecordingFinalResultMessage>;
  snapshot(): DraftTranscriptSnapshot;
  finalize(message: RecordingFinalizeMessage): Promise<RecordingFinalResultMessage>;
  terminate(): Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (!settled) { settled = true; resolvePromise(value); }
    },
    reject(error) {
      if (!settled) { settled = true; rejectPromise(error); }
    },
  };
}

function assertOptions(options: RecordingWorkerClientOptions): void {
  if (!/^[0-9a-f]{64}$/.test(options.expectedFingerprint)) {
    throw new TypeError("Recording Worker fingerprint must be lowercase SHA-256");
  }
  assertWorkerLaunch(options.launch);
  assertPositiveTimeout(options.readyTimeoutMs);
  assertPositiveTimeout(options.finalizeDeadlineMs);
  assertPositiveTimeout(options.terminationTimeoutMs);
}

function classifyFailure(
  failure: unknown,
  settlement: WorkerFailureSettlement,
  stderr: StderrTail,
): RecordingWorkerClientError {
  const details = { cause: failure, stderr, ...settlement };
  if (!settlement.quiet || settlement.outcome === undefined) {
    return new RecordingWorkerClientError(
      "WORKER_PROCESS_ERROR",
      "Recording Worker process did not converge",
      details,
    );
  }
  if (failure instanceof WorkerWaitFailure) {
    const code = failure.reason === "cancelled" ? "WORKER_CANCELLED" : "WORKER_TIMEOUT";
    return new RecordingWorkerClientError(code, failure.message, {
      ...details,
      phase: failure.phase as RecordingWorkerDeadlinePhase,
    });
  }
  if (
    failure instanceof FrameProtocolError ||
    failure instanceof RecordingWorkerSchemaError ||
    failure instanceof RecordingWorkerProtocolError
  ) {
    return new RecordingWorkerClientError(
      "WORKER_PROTOCOL_ERROR",
      "Recording Worker violated the protocol",
      details,
    );
  }
  return new RecordingWorkerClientError(
    "WORKER_PROCESS_ERROR",
    "Recording Worker process failed",
    details,
  );
}

function remoteFailure(
  terminal: Extract<RecordingWorkerTerminal, { type: "error" }>,
  stderr: StderrTail,
): RecordingWorkerClientError {
  return new RecordingWorkerClientError(terminal.message.code, terminal.message.message, {
    stage: terminal.message.stage,
    stderr,
  });
}

class ActiveRecordingWorkerSession implements RecordingWorkerSession {
  readonly completion: Promise<RecordingFinalResultMessage>;
  private readonly ready = deferred<RecordingWorkerSession>();
  private readonly state: RecordingWorkerHostState;
  private readonly stopController = new AbortController();
  private readonly signal: AbortSignal;
  private phase: RecordingWorkerDeadlinePhase = "ready";
  private deadline: number;
  private settled = false;
  private localFailure: unknown;

  constructor(
    private readonly options: RecordingWorkerClientOptions,
    private readonly startOptions: RecordingWorkerStartOptions,
    private readonly handle: WorkerProcessHandle,
  ) {
    this.state = new RecordingWorkerHostState({
      expectedFingerprint: options.expectedFingerprint,
    });
    this.signal = startOptions.signal === undefined
      ? this.stopController.signal
      : AbortSignal.any([startOptions.signal, this.stopController.signal]);
    this.deadline = performance.now() + options.readyTimeoutMs;
    this.completion = this.execute();
    this.completion.then(
      () => { this.settled = true; },
      (error: unknown) => { this.settled = true; this.ready.reject(error); },
    );
    void this.completion.catch(() => undefined);
  }

  waitUntilReady(): Promise<RecordingWorkerSession> {
    return this.ready.promise;
  }

  snapshot(): DraftTranscriptSnapshot {
    return this.state.snapshot();
  }

  async finalize(rawMessage: RecordingFinalizeMessage): Promise<RecordingFinalResultMessage> {
    let message: RecordingFinalizeMessage;
    try {
      message = parseRecordingFinalizeMessage(rawMessage);
      this.state.beginFinalize(message);
    } catch (error) {
      throw new RecordingWorkerClientError(
        "WORKER_PROTOCOL_ERROR",
        "Host FINALIZE violates the recording protocol",
        { cause: error, stderr: EMPTY_STDERR },
      );
    }
    this.phase = "finalize";
    this.deadline = performance.now() + this.options.finalizeDeadlineMs;
    const streams = requireWorkerStreams(this.handle);
    const sending = this.sendFinalize(streams, message);
    try {
      await Promise.race([sending, this.completion]);
    } catch (error) {
      if (error instanceof RecordingWorkerClientError) throw error;
      this.localFailure = error;
      this.stopController.abort();
    }
    return this.completion;
  }

  async terminate(): Promise<void> {
    if (this.settled) return;
    this.stopController.abort();
    try {
      await this.completion;
    } catch (error) {
      if (error instanceof RecordingWorkerClientError && error.code === "WORKER_CANCELLED") return;
      throw error;
    }
  }

  private async sendFinalize(
    streams: WorkerSessionStreams,
    message: RecordingFinalizeMessage,
  ): Promise<void> {
    await waitBounded(writeFrame(streams.stdin, message), this.signal, this.deadline, "finalize");
    await waitBounded(closeWorkerInput(streams.stdin), this.signal, this.deadline, "finalize");
  }

  private async execute(): Promise<RecordingFinalResultMessage> {
    const stderrPromise = this.handle.stderr === undefined
      ? Promise.resolve(EMPTY_STDERR)
      : drainStderrTail(this.handle.stderr);
    let terminal: RecordingWorkerTerminal;
    try {
      terminal = await this.drive(requireWorkerStreams(this.handle));
    } catch (failure) {
      const settlement = await settleWorkerFailure(
        this.handle,
        this.options.terminationTimeoutMs,
      );
      const stderr = await stderrPromise;
      throw classifyFailure(this.localFailure ?? failure, settlement, stderr);
    }
    const stderr = await stderrPromise;
    if (terminal.type === "error") throw remoteFailure(terminal, stderr);
    return terminal.message;
  }

  private async drive(streams: WorkerSessionStreams): Promise<RecordingWorkerTerminal> {
    const iterator = decodeFrames(streams.stdout)[Symbol.asyncIterator]();
    while (true) {
      const next = await this.nextFrame(iterator);
      if (next.done) break;
      const message = parseRecordingWorkerMessage(next.value);
      const event = this.state.receive(message);
      if (event.type === "ready") {
        if (message.type !== "ready") throw new RecordingWorkerProtocolError();
        this.phase = "recording";
        this.startOptions.onReady?.(message);
        this.ready.resolve(this);
      } else if (event.type === "revision") {
        this.startOptions.onRevision?.(event.snapshot);
      } else if (event.type === "warning") {
        this.startOptions.onWarning?.(event.message);
      } else if (this.phase !== "finalize") {
        this.phase = "termination";
        this.deadline = performance.now() + this.options.terminationTimeoutMs;
      }
    }
    if (this.phase === "ready" || this.phase === "recording") {
      this.phase = "termination";
      this.deadline = performance.now() + this.options.terminationTimeoutMs;
    }
    const outcome = await waitBounded(this.handle.done, this.signal, this.deadline, this.phase);
    await requireWorkerTreeExit(
      this.handle,
      this.signal,
      this.deadline,
      this.phase,
      this.options.terminationTimeoutMs,
    );
    if (outcome.signal !== null) throw new WorkerProcessFailure("Recording Worker was signalled");
    return this.state.finish(outcome);
  }

  private nextFrame(
    iterator: AsyncIterator<Record<string, unknown>>,
  ): Promise<IteratorResult<Record<string, unknown>>> {
    const next = iterator.next();
    if (this.phase === "recording") return waitAbortable(next, this.signal, this.phase);
    return waitBounded(next, this.signal, this.deadline, this.phase);
  }
}

export class RecordingWorkerClient {
  constructor(private readonly options: RecordingWorkerClientOptions) {
    assertOptions(options);
  }

  async start(startOptions: RecordingWorkerStartOptions = {}): Promise<RecordingWorkerSession> {
    if (startOptions.signal?.aborted === true) {
      throw RecordingWorkerClientError.cancelled("ready");
    }
    let handle: WorkerProcessHandle;
    try {
      handle = this.options.spawner.spawn(this.options.launch);
    } catch (error) {
      throw new RecordingWorkerClientError(
        "WORKER_PROCESS_ERROR",
        "Recording Worker process failed to spawn",
        { cause: error, stderr: EMPTY_STDERR },
      );
    }
    return new ActiveRecordingWorkerSession(this.options, startOptions, handle).waitUntilReady();
  }
}
