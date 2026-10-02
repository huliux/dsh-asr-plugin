import type { ManagedAudioStore } from "../storage/managed-audio-store.js";
import type {
  CommitTranscriptResult,
  MeetingRecord,
  MeetingRepository,
} from "../storage/meeting-repository.js";
import type { RecordingWorkerSession } from "../recording/worker-client.js";
import type { RecordingFinalResultMessage } from "../recording/worker-types.js";

export const RECORDING_FINALIZATION_DEADLINE_MS = 30_000;
const COMMIT_RESERVE_MS = 100;
const KNOWN_CODES = new Set([
  "INVALID_REQUEST",
  "ASSET_MISMATCH",
  "AUDIO_READ_FAILED",
  "MODEL_LOAD_FAILED",
  "MODEL_INFERENCE_FAILED",
  "NATIVE_LOAD_FAILED",
  "NATIVE_FAILURE",
  "RESOURCE_LIMIT",
  "WORKER_CANCELLED",
  "WORKER_PROCESS_ERROR",
  "WORKER_PROTOCOL_ERROR",
  "WORKER_TIMEOUT",
  "STORAGE_FAILURE",
]);

export interface RecordingFinalizationIdentity {
  readonly baseVersion: number;
  readonly captureEndUs: number;
  readonly deadlineAtMs: number;
  readonly meetingId: string;
  readonly recordingEndedAtMs: number;
  readonly requestId: string;
  readonly runId: string;
}

export interface RecordingFinalizationDependencies {
  readonly audioStore: ManagedAudioStore;
  readonly engineFingerprint: string;
  readonly monotonicNow?: () => number;
  readonly now: () => number;
  readonly repository: MeetingRepository;
  readonly worker: RecordingWorkerSession;
}

export interface FinalizeRecordingRunInput {
  readonly dependencies: RecordingFinalizationDependencies;
  readonly identity: RecordingFinalizationIdentity;
}

export class RecordingFinalizationError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super("Recording finalization failed", options);
    this.name = "RecordingFinalizationError";
  }
}

export async function waitForRecordingFinalization<T>(
  operation: Promise<T>,
  deadlineAtMs: number,
  monotonicNow: () => number,
): Promise<T> {
  const remaining = Math.floor(deadlineAtMs - monotonicNow());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new RecordingFinalizationError("WORKER_TIMEOUT");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RecordingFinalizationError("WORKER_TIMEOUT")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && KNOWN_CODES.has(code)) return code;
  }
  return "ENGINE_FAILURE";
}

function errorStage(error: unknown): string {
  if (typeof error === "object" && error !== null && "stage" in error) {
    const stage = error.stage;
    if (typeof stage === "string" && stage.length > 0 && stage.length <= 100) return stage;
  }
  return "finalizing";
}

function timestamp(dependencies: RecordingFinalizationDependencies): number {
  return Math.max(1, Math.trunc(dependencies.now()));
}

function assertResult(
  result: RecordingFinalResultMessage,
  identity: RecordingFinalizationIdentity,
  fingerprint: string,
): void {
  if (
    result.request_id !== identity.requestId ||
    result.base_transcript_version !== identity.baseVersion ||
    result.engine_fingerprint !== fingerprint
  ) throw new RecordingFinalizationError("WORKER_PROTOCOL_ERROR");
}

function candidate(result: RecordingFinalResultMessage) {
  return {
    audioFiles: result.payload.audio_files,
    durationMs: result.payload.duration_ms,
    sourceSha256: result.payload.source_sha256,
    sourceSizeBytes: result.payload.source_size_bytes,
  };
}

function assertPromoted(
  result: RecordingFinalResultMessage,
  promoted: Awaited<ReturnType<ManagedAudioStore["promoteRecordingCandidate"]>>,
): void {
  if (
    promoted.durationMs !== result.payload.duration_ms ||
    promoted.sourceSizeBytes !== result.payload.source_size_bytes ||
    promoted.sourceSha256 !== result.payload.source_sha256
  ) throw new RecordingFinalizationError("AUDIO_READ_FAILED");
}

function commitInput(
  result: RecordingFinalResultMessage,
  identity: RecordingFinalizationIdentity,
  nowMs: number,
) {
  return {
    meetingId: identity.meetingId,
    runId: identity.runId,
    baseVersion: identity.baseVersion,
    resultStatus: result.payload.result_status,
    resultReason: result.payload.result_reason,
    durationMs: result.payload.duration_ms,
    sourceSizeBytes: result.payload.source_size_bytes,
    sourceSha256: result.payload.source_sha256,
    engineFingerprint: result.engine_fingerprint,
    segments: result.payload.segments.map((segment) => ({
      seq: segment.seq,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      speakerLabel: segment.speaker_label,
      text: segment.text,
    })),
    nowMs,
  };
}

function terminalMeeting(
  repository: MeetingRepository,
  identity: RecordingFinalizationIdentity,
): MeetingRecord | null {
  const meeting = repository.getMeeting(identity.meetingId);
  if (meeting === null || meeting.activeRunId === identity.runId) return null;
  return meeting;
}

async function cleanup(dependencies: RecordingFinalizationDependencies, meetingId: string): Promise<void> {
  await dependencies.audioStore.cleanupWork(meetingId).catch(() => undefined);
}

export async function finalizeRecordingRun(
  input: FinalizeRecordingRunInput,
): Promise<CommitTranscriptResult> {
  const { dependencies, identity } = input;
  const monotonicNow = dependencies.monotonicNow ?? performance.now.bind(performance);
  const deadline = identity.deadlineAtMs;
  try {
    dependencies.repository.beginRecordingFinalization({
      meetingId: identity.meetingId,
      runId: identity.runId,
      baseVersion: identity.baseVersion,
      recordingEndedAtMs: identity.recordingEndedAtMs,
      nowMs: timestamp(dependencies),
    });
    const result = await waitForRecordingFinalization(
      dependencies.worker.finalize({
        type: "finalize",
        request_id: identity.requestId,
        base_transcript_version: identity.baseVersion,
        capture_end_us: identity.captureEndUs,
      }),
      deadline,
      monotonicNow,
    );
    assertResult(result, identity, dependencies.engineFingerprint);
    const remaining = Math.floor(deadline - monotonicNow());
    if (remaining <= COMMIT_RESERVE_MS) throw new RecordingFinalizationError("WORKER_TIMEOUT");
    const signal = AbortSignal.timeout(remaining - COMMIT_RESERVE_MS);
    const promoted = await dependencies.audioStore.promoteRecordingCandidate(
      identity.meetingId,
      candidate(result),
      signal,
    );
    assertPromoted(result, promoted);
    if (deadline - monotonicNow() <= COMMIT_RESERVE_MS) {
      throw new RecordingFinalizationError("WORKER_TIMEOUT");
    }
    const committed = dependencies.repository.commitTranscript(
      commitInput(result, identity, timestamp(dependencies)),
    );
    await cleanup(dependencies, identity.meetingId);
    return committed;
  } catch (error) {
    const alreadyTerminal = terminalMeeting(dependencies.repository, identity);
    if (alreadyTerminal !== null) {
      await cleanup(dependencies, identity.meetingId);
      return { outcome: "run_not_active", meeting: alreadyTerminal };
    }
    const code = errorCode(error);
    try {
      const finished = dependencies.repository.finishRun({
        meetingId: identity.meetingId,
        runId: identity.runId,
        baseVersion: identity.baseVersion,
        outcome: "failed",
        errorCode: code,
        errorStage: errorStage(error),
        recordingEndedAtMs: identity.recordingEndedAtMs,
        nowMs: timestamp(dependencies),
      });
      if (finished.outcome === "already_committed") {
        await cleanup(dependencies, identity.meetingId);
        return { outcome: "run_not_active", meeting: finished.meeting };
      }
    } catch {
      // Preserve the original finalization error; recovery will reconcile an active run.
    }
    await cleanup(dependencies, identity.meetingId);
    throw error instanceof RecordingFinalizationError
      ? error
      : new RecordingFinalizationError(code, { cause: error });
  }
}
