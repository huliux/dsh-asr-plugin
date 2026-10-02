import { MAX_PROGRESS_MESSAGES } from "./messages.js";
import type { WorkerProcessOutcome } from "./process.js";
import type {
  AsrResultMessage,
  DiarizationResultMessage,
  WorkerErrorMessage,
  WorkerProgressMessage,
  WorkerReadyMessage,
  WorkerResultMessage,
  WorkerRunMessage,
  WorkerToHostMessage,
} from "./types.js";

export type WorkerHostEvent =
  | { readonly type: "send_run" }
  | { readonly type: "progress"; readonly message: WorkerProgressMessage }
  | { readonly type: "terminal" };

export type WorkerTerminal =
  | { readonly type: "result"; readonly message: WorkerResultMessage }
  | { readonly type: "error"; readonly message: WorkerErrorMessage };

export class WorkerProtocolError extends Error {
  readonly code = "WORKER_PROTOCOL_ERROR" as const;

  constructor(message = "Worker violated the protocol") {
    super(message);
    this.name = "WorkerProtocolError";
  }
}

interface WorkerHostStateOptions {
  readonly expectedFingerprint: string;
  readonly run: WorkerRunMessage;
}

type HostPhase = "awaiting_ready" | "running" | "terminal";

function protocolFailure(): never {
  throw new WorkerProtocolError();
}

function assertResultIdentity(result: WorkerResultMessage, run: WorkerRunMessage): void {
  if (
    result.request_id !== run.request_id ||
    result.kind !== run.kind ||
    result.base_transcript_version !== run.base_transcript_version
  ) protocolFailure();
}

function assertAsrTimeline(result: AsrResultMessage, durationMs: number): void {
  if (
    result.payload.blocks.some((block) => block.end_ms > durationMs) ||
    result.payload.speech_regions.some((region) => region.end_ms > durationMs)
  ) protocolFailure();
}

function assertDiarizationConservation(
  result: DiarizationResultMessage,
  run: Extract<WorkerRunMessage, { kind: "diarization" }>,
): void {
  if (result.payload.segments.length !== run.payload.blocks.length) protocolFailure();
  for (const [index, block] of run.payload.blocks.entries()) {
    const segment = result.payload.segments[index];
    if (
      segment === undefined ||
      segment.seq !== block.seq ||
      segment.start_ms !== block.start_ms ||
      segment.end_ms !== block.end_ms ||
      segment.text !== block.text
    ) protocolFailure();
  }
}

function assertResult(result: WorkerResultMessage, run: WorkerRunMessage): void {
  assertResultIdentity(result, run);
  if (result.kind === "asr" && run.kind === "asr") {
    assertAsrTimeline(result, run.payload.duration_ms);
    return;
  }
  if (result.kind === "diarization" && run.kind === "diarization") {
    assertDiarizationConservation(result, run);
    return;
  }
  protocolFailure();
}

export class WorkerHostState {
  private phase: HostPhase = "awaiting_ready";
  private progressCount = 0;
  private terminal: WorkerTerminal | undefined;

  constructor(private readonly options: WorkerHostStateOptions) {}

  receive(message: WorkerToHostMessage): WorkerHostEvent {
    if (this.phase === "terminal") protocolFailure();
    if (this.phase === "awaiting_ready") return this.receiveBeforeReady(message);
    return this.receiveWhileRunning(message);
  }

  private receiveBeforeReady(message: WorkerToHostMessage): WorkerHostEvent {
    if (message.type === "ready") return this.acceptReady(message);
    if (
      message.type === "error" &&
      message.request_id === null &&
      message.stage === "initializing"
    ) return this.acceptTerminal({ type: "error", message });
    return protocolFailure();
  }

  private acceptReady(message: WorkerReadyMessage): WorkerHostEvent {
    if (
      message.kind !== this.options.run.kind ||
      message.engine_fingerprint !== this.options.expectedFingerprint
    ) protocolFailure();
    this.phase = "running";
    return { type: "send_run" };
  }

  private receiveWhileRunning(message: WorkerToHostMessage): WorkerHostEvent {
    if (message.type === "progress") return this.acceptProgress(message);
    if (message.type === "result") {
      assertResult(message, this.options.run);
      return this.acceptTerminal({ type: "result", message });
    }
    if (
      message.type === "error" &&
      message.request_id === this.options.run.request_id &&
      message.stage !== "initializing"
    ) return this.acceptTerminal({ type: "error", message });
    return protocolFailure();
  }

  private acceptProgress(message: WorkerProgressMessage): WorkerHostEvent {
    if (
      message.request_id !== this.options.run.request_id ||
      ++this.progressCount > MAX_PROGRESS_MESSAGES
    ) protocolFailure();
    return { type: "progress", message };
  }

  private acceptTerminal(terminal: WorkerTerminal): WorkerHostEvent {
    this.phase = "terminal";
    this.terminal = terminal;
    return { type: "terminal" };
  }

  finish(outcome: WorkerProcessOutcome): WorkerTerminal {
    const terminal = this.terminal;
    if (terminal === undefined || outcome.signal !== null) protocolFailure();
    if (terminal.type === "result" && outcome.exitCode !== 0) protocolFailure();
    if (terminal.type === "error" && outcome.exitCode !== 1) protocolFailure();
    return terminal;
  }
}
