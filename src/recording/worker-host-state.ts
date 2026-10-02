import type {
  DraftTranscriptSegment,
  DraftTranscriptSnapshot,
  RecordingFinalizeMessage,
  RecordingFinalResultMessage,
  RecordingRevisionMessage,
  RecordingWarningMessage,
  RecordingWorkerErrorMessage,
  RecordingWorkerToHostMessage,
} from "./worker-types.js";
import type { WorkerProcessOutcome } from "../worker/process.js";

export class RecordingWorkerProtocolError extends Error {
  readonly code = "WORKER_PROTOCOL_ERROR" as const;

  constructor() {
    super("Recording Worker violated the protocol");
    this.name = "RecordingWorkerProtocolError";
  }
}

interface RecordingWorkerHostStateOptions {
  readonly expectedFingerprint: string;
}

const MAX_SEGMENTS = 20_000;

export type RecordingWorkerHostEvent =
  | { readonly type: "ready" }
  | { readonly type: "revision"; readonly snapshot: DraftTranscriptSnapshot }
  | { readonly type: "warning"; readonly message: RecordingWarningMessage }
  | { readonly type: "terminal" };

export type RecordingWorkerTerminal =
  | { readonly type: "result"; readonly message: RecordingFinalResultMessage }
  | { readonly type: "error"; readonly message: RecordingWorkerErrorMessage };

type HostPhase = "awaiting_ready" | "recording" | "finalizing" | "terminal";

function draftSegment(segment: RecordingRevisionMessage["segments"][number]): DraftTranscriptSegment {
  return {
    seq: segment.seq,
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    speakerLabel: null,
    text: segment.text,
  };
}

function copySnapshot(snapshot: DraftTranscriptSnapshot): DraftTranscriptSnapshot {
  return {
    ...snapshot,
    segments: snapshot.segments.map((segment) => ({ ...segment })),
  };
}

export class RecordingWorkerHostState {
  private phase: HostPhase = "awaiting_ready";
  private finalize: RecordingFinalizeMessage | undefined;
  private terminal: RecordingWorkerTerminal | undefined;
  private warningCount = 0;
  private current: DraftTranscriptSnapshot = {
    revision: 0,
    audioThroughMs: 0,
    generatedAtMs: 0,
    segments: [],
  };

  constructor(private readonly options: RecordingWorkerHostStateOptions) {}

  receive(message: RecordingWorkerToHostMessage): RecordingWorkerHostEvent {
    if (this.phase === "awaiting_ready") return this.receiveBeforeReady(message);
    if (this.phase === "recording") return this.receiveWhileRecording(message);
    if (this.phase === "finalizing") return this.receiveWhileFinalizing(message);
    throw new RecordingWorkerProtocolError();
  }

  snapshot(): DraftTranscriptSnapshot {
    return copySnapshot(this.current);
  }

  beginFinalize(message: RecordingFinalizeMessage): RecordingFinalizeMessage {
    if (this.phase !== "recording") throw new RecordingWorkerProtocolError();
    this.phase = "finalizing";
    this.finalize = message;
    return message;
  }

  finish(outcome: WorkerProcessOutcome): RecordingWorkerTerminal {
    const terminal = this.terminal;
    if (terminal === undefined || outcome.signal !== null) throw new RecordingWorkerProtocolError();
    if (terminal.type === "result" && outcome.exitCode !== 0) throw new RecordingWorkerProtocolError();
    if (terminal.type === "error" && outcome.exitCode !== 1) throw new RecordingWorkerProtocolError();
    return terminal;
  }

  private receiveBeforeReady(message: RecordingWorkerToHostMessage): RecordingWorkerHostEvent {
    if (message.type === "ready") {
      if (message.engine_fingerprint !== this.options.expectedFingerprint) {
        throw new RecordingWorkerProtocolError();
      }
      this.phase = "recording";
      return { type: "ready" };
    }
    if (message.type === "error" && message.request_id === null && message.stage === "initializing") {
      return this.acceptTerminal({ type: "error", message });
    }
    throw new RecordingWorkerProtocolError();
  }

  private receiveWhileRecording(message: RecordingWorkerToHostMessage): RecordingWorkerHostEvent {
    if (message.type === "revision") {
      this.current = this.applyRevision(message);
      return { type: "revision", snapshot: this.snapshot() };
    }
    if (message.type === "warning") return this.acceptWarning(message);
    if (message.type === "error" && message.request_id === null && message.stage !== "initializing") {
      return this.acceptTerminal({ type: "error", message });
    }
    throw new RecordingWorkerProtocolError();
  }

  private receiveWhileFinalizing(message: RecordingWorkerToHostMessage): RecordingWorkerHostEvent {
    const finalize = this.finalize;
    if (finalize === undefined) throw new RecordingWorkerProtocolError();
    if (message.type === "revision") {
      this.current = this.applyRevision(message);
      return { type: "revision", snapshot: this.snapshot() };
    }
    if (message.type === "warning") {
      return this.acceptWarning(message);
    }
    if (message.type === "final_result") {
      if (
        message.request_id !== finalize.request_id ||
        message.base_transcript_version !== finalize.base_transcript_version ||
        message.engine_fingerprint !== this.options.expectedFingerprint
      ) throw new RecordingWorkerProtocolError();
      return this.acceptTerminal({ type: "result", message });
    }
    if (
      message.type === "error" &&
      message.request_id === finalize.request_id &&
      message.stage !== "initializing"
    ) {
      return this.acceptTerminal({ type: "error", message });
    }
    throw new RecordingWorkerProtocolError();
  }

  private acceptWarning(message: RecordingWarningMessage): RecordingWorkerHostEvent {
    if (++this.warningCount > 1_000) throw new RecordingWorkerProtocolError();
    return { type: "warning", message };
  }

  private acceptTerminal(terminal: RecordingWorkerTerminal): RecordingWorkerHostEvent {
    this.phase = "terminal";
    this.terminal = terminal;
    return { type: "terminal" };
  }

  private applyRevision(message: RecordingRevisionMessage): DraftTranscriptSnapshot {
    if (
      message.revision !== this.current.revision + 1 ||
      message.base_revision !== this.current.revision ||
      message.replace_from_seq > this.current.segments.length ||
      message.audio_through_ms < this.current.audioThroughMs
    ) throw new RecordingWorkerProtocolError();
    const prefix = this.current.segments.slice(0, message.replace_from_seq);
    const segments = [...prefix, ...message.segments.map(draftSegment)];
    if (segments.length > MAX_SEGMENTS) throw new RecordingWorkerProtocolError();
    let previousStart = -1;
    let previousEnd = -1;
    for (const segment of segments) {
      if (
        segment.startMs < previousStart ||
        (segment.startMs === previousStart && segment.endMs < previousEnd)
      ) throw new RecordingWorkerProtocolError();
      previousStart = segment.startMs;
      previousEnd = segment.endMs;
    }
    return {
      revision: message.revision,
      audioThroughMs: message.audio_through_ms,
      generatedAtMs: message.generated_at_ms,
      segments,
    };
  }
}
