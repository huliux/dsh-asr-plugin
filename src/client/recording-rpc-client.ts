import { callRecordingRpc } from "./recording-rpc-transport.js";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

import {
  type MeetingReferenceRpcCandidate,
  type MeetingReferenceRpcCandidatesPayload,
  type MeetingReferenceRpcPhase,
  type MeetingReferenceRpcResolvePayload,
  type RecordingRpcControlPayload,
  type RecordingRpcPhase,
  type RecordingRpcSegment,
  type RecordingRpcStateValue,
  type RecordingRpcTrack,
  type RecordingRpcView,
} from "../recording/rpc-contract.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("INVALID_RESPONSE");
  }
}

function nullableString(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error("INVALID_RESPONSE");
}

function nonnegativeInteger(value: unknown): number {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  throw new Error("INVALID_RESPONSE");
}

function nullableNonnegativeInteger(value: unknown): number | null {
  return value === null ? null : nonnegativeInteger(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error("INVALID_RESPONSE");
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function phase(value: unknown): RecordingRpcPhase {
  const phases: readonly RecordingRpcPhase[] = [
    "starting", "recording", "finalizing", "completed", "empty", "partial", "failed", "cancelled",
  ];
  if (phases.includes(value as RecordingRpcPhase)) return value as RecordingRpcPhase;
  throw new Error("INVALID_RESPONSE");
}

function referencePhase(value: unknown): MeetingReferenceRpcPhase {
  return value === "processing" ? value : phase(value);
}

function resultStatus(value: unknown): RecordingRpcView["resultStatus"] {
  if (value === null || value === "completed" || value === "empty" || value === "partial") return value;
  throw new Error("INVALID_RESPONSE");
}

function track(value: unknown): RecordingRpcTrack {
  const item = record(value);
  exact(item, ["errorCode", "requested", "state"]);
  if (typeof item.requested !== "boolean" ||
    (item.state !== "off" && item.state !== "on" && item.state !== "failed")) {
    throw new Error("INVALID_RESPONSE");
  }
  return { errorCode: nullableString(item.errorCode), requested: item.requested, state: item.state };
}

export function parseRecordingRpcView(value: unknown): RecordingRpcView {
  const item = record(value);
  exact(item, [
    "meetingId", "jobId", "phase", "mic", "system", "draftRevision", "draftStale", "latestAudioAtMs",
    "latestDraftAtMs", "recordingStartedAtMs", "recordingEndedAtMs", "recordingElapsedMs",
    "durationMs", "transcriptVersion", "resultStatus", "finalizationMs", "errorCode",
  ]);
  if (typeof item.meetingId !== "string" || !UUID_PATTERN.test(item.meetingId)
    || typeof item.jobId !== "string" ||
    typeof item.draftStale !== "boolean") {
    throw new Error("INVALID_RESPONSE");
  }
  const recordingStartedAtMs = nullableNonnegativeInteger(item.recordingStartedAtMs);
  const recordingEndedAtMs = nullableNonnegativeInteger(item.recordingEndedAtMs);
  const recordingElapsedMs = nullableNonnegativeInteger(item.recordingElapsedMs);
  if ((recordingStartedAtMs === null && recordingElapsedMs !== null)
    || (recordingEndedAtMs !== null && (recordingStartedAtMs === null
    || recordingEndedAtMs < recordingStartedAtMs
    || recordingElapsedMs !== recordingEndedAtMs - recordingStartedAtMs))) {
    throw new Error("INVALID_RESPONSE");
  }
  return {
    meetingId: item.meetingId,
    jobId: item.jobId,
    phase: phase(item.phase),
    mic: track(item.mic),
    system: track(item.system),
    draftRevision: nonnegativeInteger(item.draftRevision),
    draftStale: item.draftStale,
    latestAudioAtMs: nullableNonnegativeInteger(item.latestAudioAtMs),
    latestDraftAtMs: nullableNonnegativeInteger(item.latestDraftAtMs),
    recordingStartedAtMs,
    recordingEndedAtMs,
    recordingElapsedMs,
    durationMs: nullableNonnegativeInteger(item.durationMs),
    transcriptVersion: nullableNonnegativeInteger(item.transcriptVersion),
    resultStatus: resultStatus(item.resultStatus),
    finalizationMs: nullableNonnegativeInteger(item.finalizationMs),
    errorCode: nullableString(item.errorCode),
  };
}

function segment(value: unknown): RecordingRpcSegment {
  const item = record(value);
  exact(item, ["seq", "startMs", "endMs", "speakerLabel", "text"]);
  if (typeof item.text !== "string") {
    throw new Error("INVALID_RESPONSE");
  }
  const seq = nonnegativeInteger(item.seq);
  const startMs = nonnegativeInteger(item.startMs);
  const endMs = nonnegativeInteger(item.endMs);
  if (endMs < startMs) throw new Error("INVALID_RESPONSE");
  return {
    seq,
    startMs,
    endMs,
    speakerLabel: nullableString(item.speakerLabel),
    text: item.text,
  };
}

function parseState(value: unknown): RecordingRpcStateValue {
  const item = record(value);
  exact(item, ["recording", "preview", "hasRecordingHistory"]);
  if (typeof item.hasRecordingHistory !== "boolean") throw new Error("INVALID_RESPONSE");
  if (!Array.isArray(item.preview)) throw new Error("INVALID_RESPONSE");
  return {
    recording: item.recording === null ? null : parseRecordingRpcView(item.recording),
    hasRecordingHistory: item.hasRecordingHistory,
    preview: item.preview.map(segment),
  };
}

function referenceCandidate(value: unknown): MeetingReferenceRpcCandidate {
  const item = record(value);
  exact(item, [
    "meeting_id", "label", "origin", "phase", "started_at", "created_at",
    "recording_elapsed_ms", "duration_ms",
  ]);
  if (typeof item.meeting_id !== "string" || !UUID_PATTERN.test(item.meeting_id)
    || typeof item.label !== "string" || item.label.length < 1 || item.label.length > 255
    || (item.origin !== "import" && item.origin !== "recording")) {
    throw new Error("INVALID_RESPONSE");
  }
  return {
    meeting_id: item.meeting_id,
    label: item.label,
    origin: item.origin,
    phase: referencePhase(item.phase),
    started_at: nullableTimestamp(item.started_at),
    created_at: timestamp(item.created_at),
    recording_elapsed_ms: nullableNonnegativeInteger(item.recording_elapsed_ms),
    duration_ms: nullableNonnegativeInteger(item.duration_ms),
  };
}

function referenceCandidates(value: unknown): readonly MeetingReferenceRpcCandidate[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("INVALID_RESPONSE");
  return value.map(referenceCandidate);
}

async function call(
  rpc: ClientConnectionRpc,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await callRecordingRpc(rpc, endpoint, payload, signal);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export class RecordingRpcClient {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  async prepareModels(signal?: AbortSignal): Promise<void> {
    if (await call(this.rpc, "models/prepare", {}, signal) !== null) throw new Error("INVALID_RESPONSE");
  }

  async state(signal?: AbortSignal): Promise<RecordingRpcStateValue> {
    return parseState(await call(this.rpc, "state", {}, signal));
  }

  async referenceCandidates(
    payload: MeetingReferenceRpcCandidatesPayload,
    signal?: AbortSignal,
  ): Promise<readonly MeetingReferenceRpcCandidate[]> {
    return referenceCandidates(await call(
      this.rpc,
      "references/candidates",
      payload,
      signal,
    ));
  }

  async resolveMeetingReference(
    payload: MeetingReferenceRpcResolvePayload,
    signal?: AbortSignal,
  ): Promise<MeetingReferenceRpcCandidate> {
    return referenceCandidate(await call(this.rpc, "references/resolve", payload, signal));
  }

  async control(
    payload: RecordingRpcControlPayload,
    signal?: AbortSignal,
  ): Promise<RecordingRpcView> {
    return parseRecordingRpcView(await call(this.rpc, "control", payload, signal));
  }
}
