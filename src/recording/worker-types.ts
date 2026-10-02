export const RECORDING_PROTOCOL_VERSION = 1 as const;

export interface RecordingWorkerReadyMessage {
  readonly type: "ready";
  readonly recording_protocol_version: typeof RECORDING_PROTOCOL_VERSION;
  readonly kind: "recording";
  readonly engine_fingerprint: string;
  readonly load_ms: number;
}

export interface RecordingDraftSegment {
  readonly seq: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly speaker_label: null;
  readonly text: string;
}

export interface RecordingRevisionMessage {
  readonly type: "revision";
  readonly revision: number;
  readonly base_revision: number;
  readonly replace_from_seq: number;
  readonly audio_through_ms: number;
  readonly generated_at_ms: number;
  readonly segments: readonly RecordingDraftSegment[];
}

export type RecordingWarningCode =
  | "DRAFT_INFERENCE_FAILED"
  | "CHUNK_TEMPORARILY_UNREADABLE"
  | "DRAFT_STALE";

export type RecordingWorkerStage =
  | "initializing"
  | "vad"
  | "asr"
  | "fbank"
  | "embed"
  | "cluster"
  | "assign";

export interface RecordingWarningMessage {
  readonly type: "warning";
  readonly code: RecordingWarningCode;
  readonly stage: Exclude<RecordingWorkerStage, "initializing">;
  readonly message: string;
}

export interface RecordingFinalizeMessage {
  readonly type: "finalize";
  readonly request_id: string;
  readonly base_transcript_version: number;
  readonly capture_end_us: number;
}

export type RecordingFinalResultStatus = "completed" | "empty" | "partial";
export type RecordingFinalResultReason =
  | "silent"
  | "too_short"
  | "unknown_speaker_segments"
  | null;

export interface RecordingFinalSegment {
  readonly seq: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly speaker_label: string;
  readonly text: string;
}

export type RecordingAudioFile =
  | "audio.tmp.wav"
  | "mic.tmp.wav"
  | "system.tmp.wav";

export interface RecordingFinalResultPayload {
  readonly duration_ms: number;
  readonly source_size_bytes: number;
  readonly source_sha256: string;
  readonly result_status: RecordingFinalResultStatus;
  readonly result_reason: RecordingFinalResultReason;
  readonly segments: readonly RecordingFinalSegment[];
  readonly audio_files: readonly RecordingAudioFile[];
  readonly metrics: {
    readonly finalization_ms: number;
    readonly max_rss_bytes: number;
    readonly cache_hits: number;
    readonly cache_misses: number;
  };
}

export interface RecordingFinalResultMessage {
  readonly type: "final_result";
  readonly request_id: string;
  readonly base_transcript_version: number;
  readonly engine_fingerprint: string;
  readonly payload: RecordingFinalResultPayload;
}

export type RecordingWorkerErrorCode =
  | "INVALID_REQUEST"
  | "ASSET_MISMATCH"
  | "AUDIO_READ_FAILED"
  | "MODEL_LOAD_FAILED"
  | "MODEL_INFERENCE_FAILED"
  | "NATIVE_LOAD_FAILED"
  | "NATIVE_FAILURE"
  | "RESOURCE_LIMIT"
  | "INTERNAL_ERROR";

export interface RecordingWorkerErrorMessage {
  readonly type: "error";
  readonly request_id: string | null;
  readonly code: RecordingWorkerErrorCode;
  readonly stage: RecordingWorkerStage;
  readonly message: string;
}

export type RecordingWorkerToHostMessage =
  | RecordingWorkerReadyMessage
  | RecordingRevisionMessage
  | RecordingWarningMessage
  | RecordingFinalResultMessage
  | RecordingWorkerErrorMessage;

export interface DraftTranscriptSegment {
  readonly seq: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: null;
  readonly text: string;
}

export interface DraftTranscriptSnapshot {
  readonly revision: number;
  readonly audioThroughMs: number;
  readonly generatedAtMs: number;
  readonly segments: readonly DraftTranscriptSegment[];
}
