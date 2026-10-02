import type { ProcessingIdentity } from "../assets/processing-identity.js";
import type { AudioSourceFormat } from "../audio/source-format.js";

export type SourceFormat = AudioSourceFormat;
export type MeetingOrigin = "import" | "recording";
export type MeetingStatus =
  | "recording"
  | "processing"
  | "completed"
  | "empty"
  | "partial"
  | "failed"
  | "cancelled"
  | "deleting";
export type CommittedStatus = "completed" | "empty" | "partial";
export type RunKind = "import" | "retranscribe" | "recording";

export interface MeetingRecord {
  readonly runIdentity: ProcessingIdentity | null;
  readonly transcriptIdentity: ProcessingIdentity | null;
  readonly meetingId: string;
  readonly origin: MeetingOrigin;
  readonly title: string;
  readonly sourceName: string;
  readonly sourceFormat: SourceFormat;
  readonly sourceSizeBytes: number | null;
  readonly sourceSha256: string | null;
  readonly durationMs: number | null;
  readonly status: MeetingStatus;
  readonly committedStatus: CommittedStatus | null;
  readonly transcriptVersion: number;
  readonly resultReason: string | null;
  readonly engineFingerprint: string | null;
  readonly activeRunId: string | null;
  readonly runKind: RunKind | null;
  readonly errorCode: string | null;
  readonly errorStage: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly recordingStartedAtMs: number | null;
  readonly recordingEndedAtMs: number | null;
}

export interface CreateImportInput {
  readonly processingIdentity?: ProcessingIdentity;
  readonly meetingId: string;
  readonly title: string;
  readonly sourceName: string;
  readonly sourceFormat: SourceFormat;
  readonly sourceSizeBytes: number;
  readonly runId: string;
  readonly nowMs: number;
}

export interface CreateRecordingInput {
  readonly processingIdentity?: ProcessingIdentity;
  readonly meetingId: string;
  readonly title: string;
  readonly runId: string;
  readonly nowMs: number;
}

export interface RecordRecordingStartedInput {
  readonly meetingId: string;
  readonly runId: string;
  readonly startedAtMs: number;
}

export interface BeginRecordingFinalizationInput {
  readonly meetingId: string;
  readonly runId: string;
  readonly baseVersion: number;
  readonly recordingEndedAtMs: number;
  readonly nowMs: number;
}

export interface RecordManagedSourceInput {
  readonly meetingId: string;
  readonly runId: string;
  readonly sourceSha256: string;
  readonly nowMs: number;
}

export interface RecordManagedSourceResult {
  readonly outcome: "updated" | "run_not_active";
  readonly meeting: MeetingRecord;
}

export interface RecordRecoveredRecordingSourceInput {
  readonly meetingId: string;
  readonly expectedVersion: number;
  readonly sourceSizeBytes: number;
  readonly sourceSha256: string;
  readonly nowMs: number;
}

export interface RecordRecordingRecoveryFailureInput {
  readonly meetingId: string;
  readonly expectedVersion: number;
  readonly nowMs: number;
}

export interface TranscriptSegment {
  readonly seq: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly text: string;
}

export interface CommitTranscriptInput {
  readonly meetingId: string;
  readonly runId: string;
  readonly baseVersion: number;
  readonly resultStatus: CommittedStatus;
  readonly resultReason: string | null;
  readonly durationMs: number;
  readonly sourceSizeBytes?: number;
  readonly sourceSha256?: string;
  readonly engineFingerprint: string;
  readonly segments: readonly TranscriptSegment[];
  readonly nowMs: number;
}

export interface CommitTranscriptResult {
  readonly outcome: "committed" | "run_not_active";
  readonly meeting: MeetingRecord;
}

export interface GetMeetingPageInput {
  readonly meetingId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AnchoredTranscriptSegment extends TranscriptSegment {
  readonly anchor: string;
}

export interface MeetingTranscriptPage {
  readonly available: boolean;
  readonly version: number | null;
  readonly resultStatus: CommittedStatus | null;
  readonly segments: readonly AnchoredTranscriptSegment[];
  readonly nextCursor: string | null;
  readonly totalSegments: number;
}

export interface MeetingPage {
  readonly meeting: MeetingRecord;
  readonly transcript: MeetingTranscriptPage;
}

export interface GetCommittedTranscriptSliceInput {
  readonly meetingId: string;
  readonly afterSeq: number;
  readonly expectedVersion?: number;
  readonly limit: number;
}

export interface CommittedTranscriptSlice {
  readonly meeting: MeetingRecord;
  readonly available: boolean;
  readonly version: number | null;
  readonly resultStatus: CommittedStatus | null;
  readonly segments: readonly AnchoredTranscriptSegment[];
  readonly totalSegments: number;
}

export interface CommittedTranscriptSnapshot {
  readonly meeting: MeetingRecord;
  readonly segments: readonly TranscriptSegment[];
}

export interface SearchMeetingsInput {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MeetingSearchHit {
  readonly anchor: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly snippet: string;
}

export interface MeetingSearchItem {
  readonly meetingId: string;
  readonly origin: MeetingOrigin;
  readonly title: string;
  readonly createdAtMs: number;
  readonly durationMs: number | null;
  readonly status: MeetingStatus;
  readonly transcriptVersion: number;
  readonly hits: readonly MeetingSearchHit[];
}

export interface SearchMeetingsPage {
  readonly items: readonly MeetingSearchItem[];
  readonly nextCursor: string | null;
}

export interface ListMeetingReferenceRecordsInput {
  readonly locale: string;
  readonly limit: number;
  readonly preferredMeetingId?: string;
  readonly query?: string;
}

export interface FinishRunInput {
  readonly meetingId: string;
  readonly runId: string;
  readonly baseVersion: number;
  readonly outcome: "cancelled" | "failed";
  readonly errorCode: string;
  readonly errorStage: string;
  readonly recordingEndedAtMs?: number;
  readonly nowMs: number;
}

export interface FinishRunResult {
  readonly outcome: "updated" | "already_committed";
  readonly meeting: MeetingRecord;
}

export interface BeginRetranscriptionInput {
  readonly processingIdentity?: ProcessingIdentity;
  readonly meetingId: string;
  readonly expectedVersion: number;
  readonly runId: string;
  readonly nowMs: number;
}

export interface BeginRetranscriptionResult {
  readonly baseVersion: number;
  readonly targetVersion: number;
  readonly meeting: MeetingRecord;
}

export interface BeginDeletionInput {
  readonly meetingId: string;
  readonly expectedVersion: number;
  readonly nowMs: number;
}

export interface BeginDeletionResult {
  readonly outcome: "started" | "resumed";
  readonly meeting: MeetingRecord;
}

export interface RecordDeletionFailureInput {
  readonly meetingId: string;
  readonly expectedVersion: number;
  readonly nowMs: number;
}

export interface CompleteDeletionInput {
  readonly meetingId: string;
  readonly expectedVersion: number;
}
