import { isAbsolute } from "node:path";

import type {
  AsrResultMessage,
  AsrResultPayload,
  AsrRunMessage,
  DiarizationBlock,
  DiarizationResultMessage,
  DiarizationResultPayload,
  DiarizationRunMessage,
  DiarizationWarning,
  DiarizedSegment,
  SpeechRegion,
  WorkerErrorMessage,
  WorkerKind,
  WorkerProgressMessage,
  WorkerReadyMessage,
  WorkerRunMessage,
  WorkerToHostMessage,
} from "./types.js";
import { WORKER_PROTOCOL_VERSION } from "./types.js";

const MAX_AUDIO_DURATION_MS = 14_400_000;
const MAX_AUDIO_PATH_LENGTH = 4_096;
const MAX_BLOCKS = 20_000;
const MAX_PROGRESS_MESSAGES = 1_000;
const MAX_TEXT_LENGTH = 20_000;
export const MAX_TOTAL_TEXT_WIRE_BYTES = 24 * 1024 * 1024;
const MAX_WARNINGS = 1_000;
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
const WARNING_CODES = new Set([
  "BLOCK_TOO_SHORT",
  "EMBEDDING_FAILED",
  "LOW_CONFIDENCE",
  "NO_CLUSTER_REFERENCE",
]);

export class WorkerSchemaError extends Error {
  readonly code = "SCHEMA_VIOLATION" as const;

  constructor(message = "Worker message violates the protocol schema") {
    super(message);
    this.name = "WorkerSchemaError";
  }
}

function failure(): never {
  throw new WorkerSchemaError();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failure();
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) failure();
  return record;
}

function assertSafeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    failure();
  }
  return value as number;
}

function assertFiniteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    failure();
  }
  return value;
}

function assertString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) failure();
  return value;
}

function assertRequestId(value: unknown): string {
  return assertString(value, 1, 64);
}

function assertKind(value: unknown, expectedKind: WorkerKind): void {
  if (value !== expectedKind) failure();
}

function assertAudioPath(value: unknown): string {
  const path = assertString(value, 1, MAX_AUDIO_PATH_LENGTH);
  if (!isAbsolute(path)) failure();
  return path;
}

function parseBlockFields(
  block: Record<string, unknown>,
  index: number,
  durationMs: number,
): DiarizationBlock {
  const seq = assertSafeInteger(block.seq);
  const startMs = assertSafeInteger(block.start_ms, 0, durationMs);
  const endMs = assertSafeInteger(block.end_ms, startMs, durationMs);
  const text = assertString(block.text, 1, MAX_TEXT_LENGTH);
  if (seq !== index || text.trim().length === 0) failure();
  return { seq, start_ms: startMs, end_ms: endMs, text };
}

function parseBlock(value: unknown, index: number, durationMs: number): DiarizationBlock {
  return parseBlockFields(
    exactRecord(value, ["seq", "start_ms", "end_ms", "text"]),
    index,
    durationMs,
  );
}

function assertSortedBlocks(blocks: readonly DiarizationBlock[]): void {
  let priorStart = -1;
  let priorEnd = -1;
  for (const block of blocks) {
    if (
      block.start_ms < priorStart ||
      (block.start_ms === priorStart && block.end_ms < priorEnd)
    ) failure();
    priorStart = block.start_ms;
    priorEnd = block.end_ms;
  }
}

function parseBlocks(value: unknown, durationMs: number): DiarizationBlock[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) failure();
  const blocks = value.map((item, index) => parseBlock(item, index, durationMs));
  let textWireBytes = 0;
  for (const block of blocks) {
    textWireBytes += Buffer.byteLength(JSON.stringify(block.text)) - 2;
    if (textWireBytes > MAX_TOTAL_TEXT_WIRE_BYTES) failure();
  }
  assertSortedBlocks(blocks);
  return blocks;
}

function parseRegion(value: unknown, durationMs: number): SpeechRegion {
  const region = exactRecord(value, ["start_ms", "end_ms"]);
  const startMs = assertSafeInteger(region.start_ms, 0, durationMs);
  const endMs = assertSafeInteger(region.end_ms, startMs + 1, durationMs);
  return { start_ms: startMs, end_ms: endMs };
}

function parseRegions(value: unknown, durationMs: number): SpeechRegion[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) failure();
  const regions = value.map((item) => parseRegion(item, durationMs));
  let priorStart = -1;
  let priorEnd = -1;
  for (const region of regions) {
    if (
      region.start_ms < priorStart ||
      (region.start_ms === priorStart && region.end_ms < priorEnd)
    ) failure();
    priorStart = region.start_ms;
    priorEnd = region.end_ms;
  }
  return regions;
}

function parseRunBase(message: Record<string, unknown>, expectedKind: WorkerKind): void {
  if (message.type !== "run") failure();
  assertRequestId(message.request_id);
  assertKind(message.kind, expectedKind);
  assertSafeInteger(message.base_transcript_version);
}

function parseAsrRun(message: Record<string, unknown>): AsrRunMessage {
  const payload = exactRecord(message.payload, ["audio_path", "duration_ms"]);
  assertAudioPath(payload.audio_path);
  assertSafeInteger(payload.duration_ms, 0, MAX_AUDIO_DURATION_MS);
  return message as unknown as AsrRunMessage;
}

function parseDiarizationRun(message: Record<string, unknown>): DiarizationRunMessage {
  const payload = exactRecord(
    message.payload,
    ["audio_path", "duration_ms", "blocks", "speech_regions"],
  );
  assertAudioPath(payload.audio_path);
  const durationMs = assertSafeInteger(payload.duration_ms, 0, MAX_AUDIO_DURATION_MS);
  if (parseBlocks(payload.blocks, durationMs).length === 0) failure();
  parseRegions(payload.speech_regions, durationMs);
  return message as unknown as DiarizationRunMessage;
}

export function parseRunMessage(value: unknown, expectedKind: WorkerKind): WorkerRunMessage {
  const message = exactRecord(
    value,
    ["type", "request_id", "kind", "base_transcript_version", "payload"],
  );
  parseRunBase(message, expectedKind);
  return expectedKind === "asr" ? parseAsrRun(message) : parseDiarizationRun(message);
}

function parseReady(value: unknown, expectedKind: WorkerKind): WorkerReadyMessage {
  const message = exactRecord(
    value,
    ["type", "protocol_version", "kind", "engine_fingerprint", "load_ms"],
  );
  if (message.type !== "ready" || message.protocol_version !== WORKER_PROTOCOL_VERSION) failure();
  assertKind(message.kind, expectedKind);
  if (!/^[0-9a-f]{64}$/.test(assertString(message.engine_fingerprint, 64, 64))) failure();
  assertSafeInteger(message.load_ms);
  return message as unknown as WorkerReadyMessage;
}

function allowedStages(kind: WorkerKind): ReadonlySet<string> {
  return kind === "asr"
    ? new Set(["vad", "asr"])
    : new Set(["fbank", "embed", "cluster", "assign"]);
}

function parseProgress(value: unknown, expectedKind: WorkerKind): WorkerProgressMessage {
  const message = exactRecord(value, ["type", "request_id", "stage", "ratio"]);
  if (message.type !== "progress") failure();
  assertRequestId(message.request_id);
  if (typeof message.stage !== "string" || !allowedStages(expectedKind).has(message.stage)) failure();
  assertFiniteNumber(message.ratio, 0, 1);
  return message as unknown as WorkerProgressMessage;
}

function parseError(value: unknown, expectedKind: WorkerKind): WorkerErrorMessage {
  const message = exactRecord(value, ["type", "request_id", "code", "stage", "message"]);
  if (message.type !== "error") failure();
  if (message.request_id !== null) assertRequestId(message.request_id);
  if (typeof message.code !== "string" || !ERROR_CODES.has(message.code)) failure();
  const stages = allowedStages(expectedKind);
  if (message.stage !== "initializing" && (
    typeof message.stage !== "string" || !stages.has(message.stage)
  )) failure();
  const summary = assertString(message.message, 1, 500);
  if (summary.trim().length === 0 || /[\r\n]/.test(summary)) failure();
  return message as unknown as WorkerErrorMessage;
}

function parseMetrics(
  value: unknown,
  keys: readonly string[],
): Record<string, number> {
  const metrics = exactRecord(value, keys);
  for (const key of keys) assertSafeInteger(metrics[key]);
  return metrics as Record<string, number>;
}

function parseAsrPayload(value: unknown): AsrResultPayload {
  const payload = exactRecord(
    value,
    ["blocks", "speech_regions", "empty_reason", "metrics"],
  );
  const blocks = parseBlocks(payload.blocks, MAX_AUDIO_DURATION_MS);
  parseRegions(payload.speech_regions, MAX_AUDIO_DURATION_MS);
  parseMetrics(payload.metrics, ["vad_ms", "asr_ms", "max_rss_bytes"]);
  if (blocks.length === 0) {
    if (payload.empty_reason !== "silent" && payload.empty_reason !== "too_short") failure();
  } else if (payload.empty_reason !== null) failure();
  return payload as unknown as AsrResultPayload;
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

function parseSegments(value: unknown): DiarizedSegment[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) failure();
  const labels = new Set<string>();
  const segments = value.map((item, index) => {
    const segment = exactRecord(item, ["seq", "start_ms", "end_ms", "text", "speaker_label"]);
    const block = parseBlockFields(segment, index, MAX_AUDIO_DURATION_MS);
    const label = assertString(segment.speaker_label, 1, 32);
    if (label !== "UNKNOWN" && !labels.has(label)) {
      if (label !== speakerName(labels.size)) failure();
      labels.add(label);
    }
    return { ...block, speaker_label: label };
  });
  assertSortedBlocks(segments);
  return segments;
}

function parseWarnings(value: unknown, segmentCount: number): DiarizationWarning[] {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) failure();
  const seen = new Set<number>();
  return value.map((item) => {
    const warning = exactRecord(item, ["code", "seq"]);
    if (typeof warning.code !== "string" || !WARNING_CODES.has(warning.code)) failure();
    const seq = assertSafeInteger(warning.seq, 0, segmentCount - 1);
    if (seen.has(seq)) failure();
    seen.add(seq);
    return warning as unknown as DiarizationWarning;
  });
}

function assertDiarizationStatus(
  payload: Record<string, unknown>,
  segments: readonly DiarizedSegment[],
  warnings: readonly DiarizationWarning[],
): void {
  const unknown = segments.filter((segment) => segment.speaker_label === "UNKNOWN");
  const warningSeqs = new Set(warnings.map((warning) => warning.seq));
  if (unknown.some((segment) => !warningSeqs.has(segment.seq))) failure();
  if (unknown.length === 0) {
    if (payload.result_status !== "completed" || payload.result_reason !== null) failure();
  } else if (
    payload.result_status !== "partial" ||
    payload.result_reason !== "unknown_speaker_segments"
  ) failure();
}

function parseDiarizationPayload(value: unknown): DiarizationResultPayload {
  const payload = exactRecord(
    value,
    ["result_status", "result_reason", "segments", "warnings", "metrics"],
  );
  const segments = parseSegments(payload.segments);
  const warnings = parseWarnings(payload.warnings, segments.length);
  parseMetrics(
    payload.metrics,
    ["fbank_ms", "embed_ms", "cluster_ms", "assign_ms", "max_rss_bytes"],
  );
  assertDiarizationStatus(payload, segments, warnings);
  return payload as unknown as DiarizationResultPayload;
}

function parseResult(value: unknown, expectedKind: WorkerKind): AsrResultMessage | DiarizationResultMessage {
  const message = exactRecord(
    value,
    ["type", "request_id", "kind", "base_transcript_version", "payload"],
  );
  if (message.type !== "result") failure();
  assertRequestId(message.request_id);
  assertKind(message.kind, expectedKind);
  assertSafeInteger(message.base_transcript_version);
  if (expectedKind === "asr") {
    parseAsrPayload(message.payload);
    return message as unknown as AsrResultMessage;
  }
  parseDiarizationPayload(message.payload);
  return message as unknown as DiarizationResultMessage;
}

export function parseWorkerMessage(value: unknown, expectedKind: WorkerKind): WorkerToHostMessage {
  const envelope = asRecord(value);
  switch (envelope.type) {
    case "ready": return parseReady(value, expectedKind);
    case "progress": return parseProgress(value, expectedKind);
    case "error": return parseError(value, expectedKind);
    case "result": return parseResult(value, expectedKind);
    default: return failure();
  }
}

export { MAX_PROGRESS_MESSAGES };
