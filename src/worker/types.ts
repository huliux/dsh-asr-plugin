export const WORKER_PROTOCOL_VERSION = 2 as const;

export type WorkerKind = "asr" | "diarization";
export type AsrProgressStage = "vad" | "asr";
export type DiarizationProgressStage = "fbank" | "embed" | "cluster" | "assign";
export type WorkerProgressStage = AsrProgressStage | DiarizationProgressStage;
export type WorkerStage = WorkerProgressStage | "initializing";

export type WorkerErrorCode =
  | "INVALID_REQUEST"
  | "ASSET_MISMATCH"
  | "AUDIO_READ_FAILED"
  | "MODEL_LOAD_FAILED"
  | "MODEL_INFERENCE_FAILED"
  | "NATIVE_LOAD_FAILED"
  | "NATIVE_FAILURE"
  | "RESOURCE_LIMIT"
  | "INTERNAL_ERROR";

export interface WorkerReadyMessage {
  readonly type: "ready";
  readonly protocol_version: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: WorkerKind;
  readonly engine_fingerprint: string;
  readonly load_ms: number;
}

export interface WorkerRunBase {
  readonly type: "run";
  readonly request_id: string;
  readonly base_transcript_version: number;
}

export interface AsrRunPayload {
  readonly audio_path: string;
  readonly duration_ms: number;
}

export interface DiarizationBlock {
  readonly seq: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
}

export interface SpeechRegion {
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface DiarizationRunPayload extends AsrRunPayload {
  readonly blocks: readonly DiarizationBlock[];
  readonly speech_regions: readonly SpeechRegion[];
}

export interface AsrRunMessage extends WorkerRunBase {
  readonly kind: "asr";
  readonly payload: AsrRunPayload;
}

export interface DiarizationRunMessage extends WorkerRunBase {
  readonly kind: "diarization";
  readonly payload: DiarizationRunPayload;
}

export type WorkerRunMessage = AsrRunMessage | DiarizationRunMessage;

export interface WorkerProgressMessage {
  readonly type: "progress";
  readonly request_id: string;
  readonly stage: WorkerProgressStage;
  readonly ratio: number;
}

export interface WorkerErrorMessage {
  readonly type: "error";
  readonly request_id: string | null;
  readonly code: WorkerErrorCode;
  readonly stage: WorkerStage;
  readonly message: string;
}

export interface AsrResultMetrics {
  readonly vad_ms: number;
  readonly asr_ms: number;
  readonly max_rss_bytes: number;
}

export interface AsrResultPayload {
  readonly blocks: readonly DiarizationBlock[];
  readonly speech_regions: readonly SpeechRegion[];
  readonly empty_reason: "silent" | "too_short" | null;
  readonly metrics: AsrResultMetrics;
}

export interface DiarizedSegment extends DiarizationBlock {
  readonly speaker_label: string;
}

export type DiarizationWarningCode =
  | "BLOCK_TOO_SHORT"
  | "EMBEDDING_FAILED"
  | "LOW_CONFIDENCE"
  | "NO_CLUSTER_REFERENCE";

export interface DiarizationWarning {
  readonly code: DiarizationWarningCode;
  readonly seq: number;
}

export interface DiarizationResultMetrics {
  readonly fbank_ms: number;
  readonly embed_ms: number;
  readonly cluster_ms: number;
  readonly assign_ms: number;
  readonly max_rss_bytes: number;
}

export interface DiarizationResultPayload {
  readonly result_status: "completed" | "partial";
  readonly result_reason: "unknown_speaker_segments" | null;
  readonly segments: readonly DiarizedSegment[];
  readonly warnings: readonly DiarizationWarning[];
  readonly metrics: DiarizationResultMetrics;
}

export interface AsrResultMessage {
  readonly type: "result";
  readonly request_id: string;
  readonly kind: "asr";
  readonly base_transcript_version: number;
  readonly payload: AsrResultPayload;
}

export interface DiarizationResultMessage {
  readonly type: "result";
  readonly request_id: string;
  readonly kind: "diarization";
  readonly base_transcript_version: number;
  readonly payload: DiarizationResultPayload;
}

export type WorkerResultMessage = AsrResultMessage | DiarizationResultMessage;
export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerProgressMessage
  | WorkerErrorMessage
  | WorkerResultMessage;
