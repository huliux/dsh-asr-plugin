import type { RecordingPermissions } from "./permission-contract.js";
import type { ModelDownloadStatus } from "../assets/model-download-contract.js";
import type { ModelSettingsStatus } from "../assets/model-settings-contract.js";
export const RECORDING_RPC_CHANNEL = "/dsh-asr-recording";
export const RECORDING_RPC_ENDPOINTS = [
  "state",
  "control",
  "references/candidates",
  "references/resolve",
  "models/status",
  "models/prepare",
  "models/download/status",
  "models/download/start",
  "models/download/cancel",
  "permissions/status",
  "permissions/test",
  "permissions/open-settings",
] as const;

export type RecordingRpcEndpoint = (typeof RECORDING_RPC_ENDPOINTS)[number];

export type RecordingRpcPhase =
  | "starting"
  | "recording"
  | "finalizing"
  | "completed"
  | "empty"
  | "partial"
  | "failed"
  | "cancelled";

export type MeetingReferenceRpcPhase = RecordingRpcPhase | "processing";

export interface RecordingRpcTrack {
  readonly errorCode: string | null;
  readonly requested: boolean;
  readonly state: "off" | "on" | "failed";
}

export interface RecordingRpcSegment {
  readonly endMs: number;
  readonly seq: number;
  readonly speakerLabel: string | null;
  readonly startMs: number;
  readonly text: string;
}

export interface RecordingRpcView {
  readonly draftRevision: number;
  readonly draftStale: boolean;
  readonly errorCode: string | null;
  readonly finalizationMs: number | null;
  readonly jobId: string;
  readonly latestAudioAtMs: number | null;
  readonly latestDraftAtMs: number | null;
  readonly meetingId: string;
  readonly mic: RecordingRpcTrack;
  readonly phase: RecordingRpcPhase;
  readonly recordingEndedAtMs: number | null;
  readonly recordingElapsedMs: number | null;
  readonly recordingStartedAtMs: number | null;
  readonly durationMs: number | null;
  readonly resultStatus: "completed" | "empty" | "partial" | null;
  readonly system: RecordingRpcTrack;
  readonly transcriptVersion: number | null;
}

export interface RecordingRpcStateValue {
  readonly hasRecordingHistory: boolean;
  readonly preview: readonly RecordingRpcSegment[];
  readonly recording: RecordingRpcView | null;
}

export interface RecordingRpcControlPayload {
  readonly action: "start" | "stop" | "mic_on" | "mic_off" | "system_on" | "system_off";
  readonly meeting_id?: string;
  readonly title?: string;
}

export interface MeetingReferenceRpcCandidate {
  readonly meeting_id: string;
  readonly label: string;
  readonly origin: "import" | "recording";
  readonly phase: MeetingReferenceRpcPhase;
  readonly started_at: string | null;
  readonly created_at: string;
  readonly recording_elapsed_ms: number | null;
  readonly duration_ms: number | null;
}

export interface MeetingReferenceRpcCandidatesPayload {
  readonly session_id: string;
  readonly locale: string;
  readonly query?: string;
}

export interface MeetingReferenceRpcResolvePayload {
  readonly locale: string;
  readonly meeting_id: string;
}

export type RecordingRpcValue = RecordingPermissions | null | ModelDownloadStatus | ModelSettingsStatus | RecordingRpcStateValue | RecordingRpcView
  | readonly MeetingReferenceRpcCandidate[] | MeetingReferenceRpcCandidate;

export type RecordingRpcResult<T = RecordingRpcValue> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly error: { readonly code: "internal"; readonly message: string; readonly details: {} };
  };
