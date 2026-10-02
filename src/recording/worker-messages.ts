import { RECORDING_PROTOCOL_VERSION } from "./worker-types.js";
import type {
  RecordingFinalResultMessage,
  RecordingFinalResultPayload,
  RecordingFinalSegment,
  RecordingFinalizeMessage,
  RecordingDraftSegment,
  RecordingRevisionMessage,
  RecordingWarningMessage,
  RecordingWorkerErrorMessage,
  RecordingWorkerReadyMessage,
  RecordingWorkerToHostMessage,
} from "./worker-types.js";

const MAX_AUDIO_DURATION_MS = 14_400_000;
const MAX_SEGMENTS = 20_000;
const MAX_SEGMENT_TEXT_LENGTH = 20_000;
const MAX_TOTAL_TEXT_WIRE_BYTES = 24 * 1024 * 1024;
const WARNING_CODES = new Set([
  "DRAFT_INFERENCE_FAILED",
  "CHUNK_TEMPORARILY_UNREADABLE",
  "DRAFT_STALE",
]);
const ERROR_CODES = new Set([
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
const WORKER_STAGES = new Set([
  "initializing",
  "vad",
  "asr",
  "fbank",
  "embed",
  "cluster",
  "assign",
]);
const AUDIO_FILES = new Set(["audio.tmp.wav", "mic.tmp.wav", "system.tmp.wav"]);

export class RecordingWorkerSchemaError extends Error {
  readonly code = "SCHEMA_VIOLATION" as const;

  constructor() {
    super("Recording Worker message violates the protocol schema");
    this.name = "RecordingWorkerSchemaError";
  }
}

function failure(): never {
  throw new RecordingWorkerSchemaError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failure();
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) failure();
  return result;
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    failure();
  }
  return value as number;
}

function string(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) failure();
  return value;
}

function requestId(value: unknown): string {
  return string(value, 1, 64);
}

function sha256(value: unknown): string {
  const result = string(value, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) failure();
  return result;
}

function sanitizedMessage(value: unknown): string {
  const result = string(value, 1, 500);
  if (result.trim().length === 0 || /[\r\n]/.test(result)) failure();
  return result;
}

function workerStage(value: unknown, allowInitializing: boolean): string {
  if (
    typeof value !== "string" ||
    !WORKER_STAGES.has(value) ||
    (!allowInitializing && value === "initializing")
  ) failure();
  return value;
}

function ready(value: unknown): RecordingWorkerReadyMessage {
  const message = exactRecord(value, [
    "type",
    "recording_protocol_version",
    "kind",
    "engine_fingerprint",
    "load_ms",
  ]);
  if (
    message.type !== "ready" ||
    message.recording_protocol_version !== RECORDING_PROTOCOL_VERSION ||
    message.kind !== "recording"
  ) failure();
  sha256(message.engine_fingerprint);
  safeInteger(message.load_ms, 0);
  return message as unknown as RecordingWorkerReadyMessage;
}

function segment(value: unknown, seq: number, audioThroughMs: number): RecordingDraftSegment {
  const item = exactRecord(value, ["seq", "start_ms", "end_ms", "speaker_label", "text"]);
  if (safeInteger(item.seq, 0) !== seq || item.speaker_label !== null) failure();
  const startMs = safeInteger(item.start_ms, 0, audioThroughMs);
  safeInteger(item.end_ms, startMs, audioThroughMs);
  const text = string(item.text, 1, MAX_SEGMENT_TEXT_LENGTH);
  if (text.trim().length === 0) failure();
  return item as unknown as RecordingDraftSegment;
}

function segments(value: unknown, replaceFrom: number, audioThroughMs: number): RecordingDraftSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) failure();
  const result = value.map((item, index) => segment(item, replaceFrom + index, audioThroughMs));
  let previousStart = -1;
  let previousEnd = -1;
  let textBytes = 0;
  for (const item of result) {
    if (item.start_ms < previousStart || (item.start_ms === previousStart && item.end_ms < previousEnd)) {
      failure();
    }
    previousStart = item.start_ms;
    previousEnd = item.end_ms;
    textBytes += Buffer.byteLength(item.text);
    if (textBytes > MAX_TOTAL_TEXT_WIRE_BYTES) failure();
  }
  return result;
}

function revision(value: unknown): RecordingRevisionMessage {
  const message = exactRecord(value, [
    "type",
    "revision",
    "base_revision",
    "replace_from_seq",
    "audio_through_ms",
    "generated_at_ms",
    "segments",
  ]);
  if (message.type !== "revision") failure();
  safeInteger(message.revision, 1);
  safeInteger(message.base_revision, 0);
  const replaceFrom = safeInteger(message.replace_from_seq, 0, MAX_SEGMENTS);
  const audioThroughMs = safeInteger(message.audio_through_ms, 0, MAX_AUDIO_DURATION_MS);
  safeInteger(message.generated_at_ms, 0);
  segments(message.segments, replaceFrom, audioThroughMs);
  return message as unknown as RecordingRevisionMessage;
}

function warning(value: unknown): RecordingWarningMessage {
  const message = exactRecord(value, ["type", "code", "stage", "message"]);
  if (
    message.type !== "warning" ||
    typeof message.code !== "string" ||
    !WARNING_CODES.has(message.code)
  ) failure();
  workerStage(message.stage, false);
  sanitizedMessage(message.message);
  return message as unknown as RecordingWarningMessage;
}

function speakerName(index: number): string {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `Speaker ${suffix}`;
}

function finalSegment(
  value: unknown,
  seq: number,
  durationMs: number,
  labels: Set<string>,
): RecordingFinalSegment {
  const item = exactRecord(value, ["seq", "start_ms", "end_ms", "speaker_label", "text"]);
  if (safeInteger(item.seq, 0) !== seq) failure();
  const startMs = safeInteger(item.start_ms, 0, durationMs);
  safeInteger(item.end_ms, startMs, durationMs);
  const label = string(item.speaker_label, 1, 32);
  if (label !== "UNKNOWN" && !labels.has(label)) {
    if (label !== speakerName(labels.size)) failure();
    labels.add(label);
  }
  const text = string(item.text, 1, MAX_SEGMENT_TEXT_LENGTH);
  if (text.trim().length === 0) failure();
  return item as unknown as RecordingFinalSegment;
}

function finalSegments(value: unknown, durationMs: number): RecordingFinalSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) failure();
  const labels = new Set<string>();
  const result = value.map((item, index) => finalSegment(item, index, durationMs, labels));
  let priorStart = -1;
  let priorEnd = -1;
  let textBytes = 0;
  for (const item of result) {
    if (item.start_ms < priorStart || (item.start_ms === priorStart && item.end_ms < priorEnd)) failure();
    priorStart = item.start_ms;
    priorEnd = item.end_ms;
    textBytes += Buffer.byteLength(item.text);
    if (textBytes > MAX_TOTAL_TEXT_WIRE_BYTES) failure();
  }
  return result;
}

function audioFiles(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > AUDIO_FILES.size) failure();
  if (!value.includes("audio.tmp.wav") || new Set(value).size !== value.length) failure();
  for (const item of value) {
    if (typeof item !== "string" || !AUDIO_FILES.has(item)) failure();
  }
}

function finalMetrics(value: unknown): void {
  const metrics = exactRecord(value, [
    "finalization_ms",
    "max_rss_bytes",
    "cache_hits",
    "cache_misses",
  ]);
  for (const key of Object.keys(metrics)) safeInteger(metrics[key], 0);
}

function finalStatus(payload: Record<string, unknown>, segments: readonly RecordingFinalSegment[]): void {
  const unknownCount = segments.filter((item) => item.speaker_label === "UNKNOWN").length;
  if (payload.result_status === "empty") {
    if (
      segments.length !== 0 ||
      (payload.result_reason !== "silent" && payload.result_reason !== "too_short")
    ) failure();
    return;
  }
  if (payload.result_status === "completed") {
    if (payload.result_reason !== null || unknownCount !== 0) failure();
    return;
  }
  if (
    payload.result_status !== "partial" ||
    payload.result_reason !== "unknown_speaker_segments" ||
    unknownCount === 0
  ) failure();
}

function finalPayload(value: unknown): RecordingFinalResultPayload {
  const payload = exactRecord(value, [
    "duration_ms",
    "source_size_bytes",
    "source_sha256",
    "result_status",
    "result_reason",
    "segments",
    "audio_files",
    "metrics",
  ]);
  const durationMs = safeInteger(payload.duration_ms, 0, MAX_AUDIO_DURATION_MS);
  safeInteger(payload.source_size_bytes, 0);
  sha256(payload.source_sha256);
  const parsedSegments = finalSegments(payload.segments, durationMs);
  audioFiles(payload.audio_files);
  finalMetrics(payload.metrics);
  finalStatus(payload, parsedSegments);
  return payload as unknown as RecordingFinalResultPayload;
}

function finalResult(value: unknown): RecordingFinalResultMessage {
  const message = exactRecord(value, [
    "type",
    "request_id",
    "base_transcript_version",
    "engine_fingerprint",
    "payload",
  ]);
  if (message.type !== "final_result") failure();
  requestId(message.request_id);
  safeInteger(message.base_transcript_version, 0);
  sha256(message.engine_fingerprint);
  finalPayload(message.payload);
  return message as unknown as RecordingFinalResultMessage;
}

function workerError(value: unknown): RecordingWorkerErrorMessage {
  const message = exactRecord(value, ["type", "request_id", "code", "stage", "message"]);
  if (message.type !== "error") failure();
  if (message.request_id !== null) requestId(message.request_id);
  if (typeof message.code !== "string" || !ERROR_CODES.has(message.code)) failure();
  workerStage(message.stage, true);
  sanitizedMessage(message.message);
  return message as unknown as RecordingWorkerErrorMessage;
}

export function parseRecordingFinalizeMessage(value: unknown): RecordingFinalizeMessage {
  const message = exactRecord(value, [
    "type",
    "request_id",
    "base_transcript_version",
    "capture_end_us",
  ]);
  if (message.type !== "finalize") failure();
  requestId(message.request_id);
  safeInteger(message.base_transcript_version, 0);
  safeInteger(message.capture_end_us, 1);
  return message as unknown as RecordingFinalizeMessage;
}

export function parseRecordingWorkerMessage(value: unknown): RecordingWorkerToHostMessage {
  const message = record(value);
  if (message.type === "ready") return ready(value);
  if (message.type === "revision") return revision(value);
  if (message.type === "warning") return warning(value);
  if (message.type === "final_result") return finalResult(value);
  if (message.type === "error") return workerError(value);
  return failure();
}
