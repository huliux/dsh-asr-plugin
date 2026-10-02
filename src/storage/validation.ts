import { MeetingRepositoryError } from "./errors.js";
import type {
  BeginDeletionInput,
  BeginRecordingFinalizationInput,
  BeginRetranscriptionInput,
  CompleteDeletionInput,
  CommitTranscriptInput,
  CreateImportInput,
  CreateRecordingInput,
  FinishRunInput,
  RecordManagedSourceInput,
  RecordRecordingStartedInput,
  RecordRecoveredRecordingSourceInput,
  RecordRecordingRecoveryFailureInput,
  RecordDeletionFailureInput,
  SourceFormat,
  TranscriptSegment,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 14_400_000;
const MAX_SEGMENTS = 20_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_TOTAL_TEXT_WIRE_BYTES = 24 * 1024 * 1024;

function invalidInput(message: string): never {
  throw new MeetingRepositoryError("INVALID_INPUT", message);
}

function validateIds(meetingId: string, runId: string): void {
  if (!UUID_PATTERN.test(meetingId) || !UUID_PATTERN.test(runId)) {
    invalidInput("Meeting or run id is invalid");
  }
}

function validateNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    invalidInput("Timestamp is invalid");
  }
}

function validateMeetingVersion(meetingId: string, expectedVersion: number): void {
  if (!UUID_PATTERN.test(meetingId)) invalidInput("Meeting id is invalid");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    invalidInput("Expected transcript version is invalid");
  }
}

function validateMeetingTitle(title: string): void {
  if (title.length < 1 || title.length > 200) {
    invalidInput("Meeting title is invalid");
  }
}

export function validateCreateImport(input: CreateImportInput): void {
  validateIds(input.meetingId, input.runId);
  validateMeetingTitle(input.title);
  if (input.sourceName.length < 1 || input.sourceName.length > 255) {
    invalidInput("Source name is invalid");
  }
  const formats: readonly SourceFormat[] = ["wav", "m4a", "mp3"];
  if (!formats.includes(input.sourceFormat)) invalidInput("Source format is invalid");
  if (!Number.isSafeInteger(input.sourceSizeBytes)
    || input.sourceSizeBytes < 1
    || input.sourceSizeBytes > MAX_SOURCE_BYTES) {
    invalidInput("Source size is invalid");
  }
  validateNow(input.nowMs);
}

export function validateCreateRecording(input: CreateRecordingInput): void {
  validateIds(input.meetingId, input.runId);
  validateMeetingTitle(input.title);
  validateNow(input.nowMs);
}

export function validateRecordRecordingStarted(input: RecordRecordingStartedInput): void {
  validateIds(input.meetingId, input.runId);
  validateNow(input.startedAtMs);
}

export function validateBeginRecordingFinalization(
  input: BeginRecordingFinalizationInput,
): void {
  validateIds(input.meetingId, input.runId);
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    invalidInput("Base transcript version is invalid");
  }
  validateNow(input.recordingEndedAtMs);
  validateNow(input.nowMs);
}

export function validateRecordManagedSource(input: RecordManagedSourceInput): void {
  validateIds(input.meetingId, input.runId);
  if (!/^[0-9a-f]{64}$/.test(input.sourceSha256)) {
    invalidInput("Managed source fingerprint is invalid");
  }
  validateNow(input.nowMs);
}

export function validateRecordRecoveredRecordingSource(
  input: RecordRecoveredRecordingSourceInput,
): void {
  validateMeetingVersion(input.meetingId, input.expectedVersion);
  if (!Number.isSafeInteger(input.sourceSizeBytes)
    || input.sourceSizeBytes < 1 || input.sourceSizeBytes > MAX_SOURCE_BYTES) {
    invalidInput("Source size is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sourceSha256)) {
    invalidInput("Source fingerprint is invalid");
  }
  validateNow(input.nowMs);
}

export function validateRecordRecordingRecoveryFailure(
  input: RecordRecordingRecoveryFailureInput,
): void {
  validateMeetingVersion(input.meetingId, input.expectedVersion);
  validateNow(input.nowMs);
}

function validateSegment(segment: TranscriptSegment, index: number, durationMs: number): void {
  if (segment.seq !== index) invalidInput("Transcript sequence is not contiguous");
  if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
    || segment.startMs < 0 || segment.endMs < segment.startMs
    || segment.endMs > durationMs) invalidInput("Transcript timestamp is invalid");
  if (segment.text.length < 1 || segment.text.length > MAX_TEXT_LENGTH
    || segment.text.trim().length === 0) invalidInput("Transcript text is invalid");
  if (segment.speakerLabel !== "UNKNOWN"
    && !/^Speaker [A-Z]+$/.test(segment.speakerLabel)) {
    invalidInput("Speaker label is invalid");
  }
}

function validateSegments(input: CommitTranscriptInput): void {
  if (input.segments.length > MAX_SEGMENTS) invalidInput("Transcript has too many segments");
  let priorStart = -1;
  let priorEnd = -1;
  let textWireBytes = 0;
  for (let index = 0; index < input.segments.length; index += 1) {
    const segment = input.segments[index]!;
    validateSegment(segment, index, input.durationMs);
    if (segment.startMs < priorStart
      || (segment.startMs === priorStart && segment.endMs < priorEnd)) {
      invalidInput("Transcript timestamps are not ordered");
    }
    priorStart = segment.startMs;
    priorEnd = segment.endMs;
    textWireBytes += Buffer.byteLength(JSON.stringify(segment.text)) - 2;
    if (textWireBytes > MAX_TOTAL_TEXT_WIRE_BYTES) {
      invalidInput("Transcript text exceeds the storage boundary");
    }
  }
}

export function validateCommitIdentity(input: CommitTranscriptInput): void {
  validateIds(input.meetingId, input.runId);
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    invalidInput("Base transcript version is invalid");
  }
  validateNow(input.nowMs);
}

export function validateTranscriptCandidate(input: CommitTranscriptInput): void {
  if (!Number.isSafeInteger(input.durationMs)
    || input.durationMs < 0 || input.durationMs > MAX_AUDIO_DURATION_MS) {
    invalidInput("Audio duration is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.engineFingerprint)) {
    invalidInput("Engine fingerprint is invalid");
  }
  const hasSourceSize = input.sourceSizeBytes !== undefined;
  const hasSourceHash = input.sourceSha256 !== undefined;
  if (hasSourceSize !== hasSourceHash) invalidInput("Source metadata is incomplete");
  if (hasSourceSize && (!Number.isSafeInteger(input.sourceSizeBytes)
    || input.sourceSizeBytes! < 1 || input.sourceSizeBytes! > MAX_SOURCE_BYTES)) {
    invalidInput("Source size is invalid");
  }
  if (hasSourceHash && !/^[0-9a-f]{64}$/.test(input.sourceSha256!)) {
    invalidInput("Source fingerprint is invalid");
  }
  validateSegments(input);
  const hasUnknown = input.segments.some((segment) => segment.speakerLabel === "UNKNOWN");
  if (input.resultStatus === "empty") {
    if (input.segments.length !== 0 || !["silent", "too_short"].includes(input.resultReason ?? "")) {
      invalidInput("Empty transcript result is inconsistent");
    }
  } else if (input.resultStatus === "partial") {
    if (!hasUnknown || input.resultReason !== "unknown_speaker_segments") {
      invalidInput("Partial transcript result is inconsistent");
    }
  } else if (input.segments.length === 0 || hasUnknown || input.resultReason !== null) {
    invalidInput("Completed transcript result is inconsistent");
  }
}

export function validateFinishRun(input: FinishRunInput): void {
  validateIds(input.meetingId, input.runId);
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    invalidInput("Base transcript version is invalid");
  }
  if (input.errorCode.length < 1 || input.errorCode.length > 100
    || input.errorStage.length < 1 || input.errorStage.length > 100) {
    invalidInput("Run error details are invalid");
  }
  if (input.outcome === "cancelled" && input.errorCode !== "CANCELLED_BY_USER") {
    invalidInput("Cancelled run code is invalid");
  }
  if (input.recordingEndedAtMs !== undefined) validateNow(input.recordingEndedAtMs);
  validateNow(input.nowMs);
}

export function validateBeginRetranscription(input: BeginRetranscriptionInput): void {
  validateIds(input.meetingId, input.runId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    invalidInput("Expected transcript version is invalid");
  }
  validateNow(input.nowMs);
}

export function validateBeginDeletion(input: BeginDeletionInput): void {
  validateMeetingVersion(input.meetingId, input.expectedVersion);
  validateNow(input.nowMs);
}

export function validateRecordDeletionFailure(input: RecordDeletionFailureInput): void {
  validateMeetingVersion(input.meetingId, input.expectedVersion);
  validateNow(input.nowMs);
}

export function validateCompleteDeletion(input: CompleteDeletionInput): void {
  validateMeetingVersion(input.meetingId, input.expectedVersion);
}
