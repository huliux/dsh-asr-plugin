import { encodeProcessingIdentity } from "./processing-identity.js";
import type { DatabaseSync } from "node:sqlite";

import {
  inReadOperation,
  inWriteTransaction,
  openMeetingDatabase,
} from "./database.js";
import { MeetingRepositoryError } from "./errors.js";
import { listMeetingReferenceRecords as queryMeetingReferenceRecords } from "./meeting-reference-query.js";
import {
  getCommittedTranscriptSlice as queryCommittedTranscriptSlice,
  getCommittedTranscriptSnapshot as queryCommittedTranscriptSnapshot,
  getMeetingPage as queryMeetingPage,
  searchMeetings as queryMeetings,
} from "./meeting-query.js";
import { parseMeetingRow } from "./row-mappers.js";
import {
  beginRecordingFinalization as beginRecordingFinalizationState,
  createRecording as createRecordingState,
  listRecordingsNeedingRecovery as listRecordingsNeedingRecoveryState,
  recordRecoveredRecordingSource as recordRecoveredRecordingSourceState,
  recordRecordingStarted as recordRecordingStartedState,
  recordRecordingRecoveryFailure as recordRecordingRecoveryFailureState,
} from "./recording-repository.js";
import type {
  BeginDeletionInput,
  BeginDeletionResult,
  BeginRecordingFinalizationInput,
  BeginRetranscriptionInput,
  BeginRetranscriptionResult,
  CompleteDeletionInput,
  CommitTranscriptInput,
  CommitTranscriptResult,
  CommittedTranscriptSlice,
  CommittedTranscriptSnapshot,
  CreateImportInput,
  CreateRecordingInput,
  FinishRunInput,
  FinishRunResult,
  GetCommittedTranscriptSliceInput,
  GetMeetingPageInput,
  ListMeetingReferenceRecordsInput,
  MeetingPage,
  MeetingRecord,
  MeetingStatus,
  RecordDeletionFailureInput,
  RecordManagedSourceInput,
  RecordManagedSourceResult,
  RecordRecordingStartedInput,
  RecordRecoveredRecordingSourceInput,
  RecordRecordingRecoveryFailureInput,
  SearchMeetingsInput,
  SearchMeetingsPage,
} from "./types.js";
import {
  validateBeginDeletion,
  validateBeginRetranscription,
  validateCommitIdentity,
  validateCompleteDeletion,
  validateCreateImport,
  validateFinishRun,
  validateRecordDeletionFailure,
  validateRecordManagedSource,
  validateTranscriptCandidate,
} from "./validation.js";

export interface MeetingRepository {
  beginDeletion(input: BeginDeletionInput): BeginDeletionResult;
  beginRecordingFinalization(input: BeginRecordingFinalizationInput): MeetingRecord;
  beginRetranscription(input: BeginRetranscriptionInput): BeginRetranscriptionResult;
  close(): void;
  commitTranscript(input: CommitTranscriptInput): CommitTranscriptResult;
  completeDeletion(input: CompleteDeletionInput): void;
  createImport(input: CreateImportInput): void;
  createRecording(input: CreateRecordingInput): MeetingRecord;
  finishRun(input: FinishRunInput): FinishRunResult;
  getMeeting(meetingId: string): MeetingRecord | null;
  hasRecordingHistory(): boolean;
  getCommittedTranscriptSlice(input: GetCommittedTranscriptSliceInput): CommittedTranscriptSlice;
  getCommittedTranscriptSnapshot(meetingId: string): CommittedTranscriptSnapshot;
  getMeetingPage(input: GetMeetingPageInput): MeetingPage;
  listMeetingReferenceRecords(input: ListMeetingReferenceRecordsInput): readonly MeetingRecord[];
  listDeletingMeetings(): readonly MeetingRecord[];
  listRecordingsNeedingRecovery(): readonly MeetingRecord[];
  recordDeletionFailure(input: RecordDeletionFailureInput): MeetingRecord;
  recordManagedSource(input: RecordManagedSourceInput): RecordManagedSourceResult;
  recordRecoveredRecordingSource(input: RecordRecoveredRecordingSourceInput): MeetingRecord;
  recordRecordingRecoveryFailure(input: RecordRecordingRecoveryFailureInput): MeetingRecord;
  recordRecordingStarted(input: RecordRecordingStartedInput): MeetingRecord;
  reconcileOrphanedRuns(nowMs: number): number;
  searchMeetings(input: SearchMeetingsInput): SearchMeetingsPage;
}

class SqliteMeetingRepository implements MeetingRepository {
  constructor(private readonly database: DatabaseSync) {}

  beginDeletion(input: BeginDeletionInput): BeginDeletionResult {
    validateBeginDeletion(input);
    return inWriteTransaction(this.database, () => {
      const current = this.getRequiredMeeting(input.meetingId);
      this.assertExpectedVersion(current, input.expectedVersion);
      if (current.status === "deleting") {
        return { outcome: "resumed", meeting: current };
      }
      if (["recording", "processing"].includes(current.status)) {
        throw new MeetingRepositoryError(
          "INVALID_MEETING_STATE",
          "Active meeting cannot be deleted",
        );
      }
      const update = this.database.prepare(`
        UPDATE meetings SET status = 'deleting', error_code = NULL,
          error_stage = NULL, updated_at_ms = max(updated_at_ms, ?)
        WHERE meeting_id = ? AND transcript_version = ?
          AND status IN ('completed', 'empty', 'partial', 'failed', 'cancelled')
      `).run(input.nowMs, input.meetingId, input.expectedVersion);
      if (update.changes !== 1) {
        throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Deletion fence was not established");
      }
      return { outcome: "started", meeting: this.getRequiredMeeting(input.meetingId) };
    });
  }

  beginRecordingFinalization(input: BeginRecordingFinalizationInput): MeetingRecord {
    return beginRecordingFinalizationState(this.database, input);
  }

  close(): void {
    this.database.close();
  }

  completeDeletion(input: CompleteDeletionInput): void {
    validateCompleteDeletion(input);
    inWriteTransaction(this.database, () => {
      const current = this.getRequiredMeeting(input.meetingId);
      this.assertExpectedVersion(current, input.expectedVersion);
      if (current.status !== "deleting") {
        throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Meeting is not being deleted");
      }
      const result = this.database.prepare(`
        DELETE FROM meetings
        WHERE meeting_id = ? AND transcript_version = ? AND status = 'deleting'
      `).run(input.meetingId, input.expectedVersion);
      if (result.changes !== 1) {
        throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Deletion fence changed");
      }
    });
  }

  beginRetranscription(input: BeginRetranscriptionInput): BeginRetranscriptionResult {
    validateBeginRetranscription(input);
    return inWriteTransaction(this.database, () => {
      const current = this.getRequiredMeeting(input.meetingId);
      if (current.transcriptVersion !== input.expectedVersion) {
        throw new MeetingRepositoryError(
          "TRANSCRIPT_VERSION_CONFLICT",
          "Transcript version changed",
        );
      }
      const allowed: readonly MeetingStatus[] = [
        "completed", "empty", "partial", "failed", "cancelled",
      ];
      if (!allowed.includes(current.status)) {
        throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Meeting cannot be retranscribed");
      }
      if (this.hasActiveRun()) {
        throw new MeetingRepositoryError("ENGINE_BUSY", "Another transcription is active");
      }
      const update = this.database.prepare(`
        UPDATE meetings SET status = 'processing', active_run_id = ?,
          run_kind = 'retranscribe', error_code = NULL, error_stage = NULL,
          updated_at_ms = ?, run_identity = ?
        WHERE meeting_id = ? AND transcript_version = ?
          AND status IN ('completed', 'empty', 'partial', 'failed', 'cancelled')
      `).run(input.runId, input.nowMs, encodeProcessingIdentity(input.processingIdentity),
        input.meetingId, input.expectedVersion);
      if (update.changes !== 1) {
        throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Retranscription did not start");
      }
      return {
        baseVersion: input.expectedVersion,
        targetVersion: input.expectedVersion + 1,
        meeting: this.getRequiredMeeting(input.meetingId),
      };
    });
  }

  createImport(input: CreateImportInput): void {
    validateCreateImport(input);
    inWriteTransaction(this.database, () => {
      if (this.hasActiveRun()) {
        throw new MeetingRepositoryError("ENGINE_BUSY", "Another transcription is active");
      }
      this.database.prepare(`
        INSERT INTO meetings (
          meeting_id, origin, title, source_name, source_format, source_size_bytes,
          status, active_run_id, run_kind, created_at_ms, updated_at_ms, run_identity
        ) VALUES (?, 'import', ?, ?, ?, ?, 'processing', ?, 'import', ?, ?, ?)
      `).run(
        input.meetingId,
        input.title,
        input.sourceName,
        input.sourceFormat,
        input.sourceSizeBytes,
        input.runId,
        input.nowMs,
        input.nowMs,
        encodeProcessingIdentity(input.processingIdentity),
      );
    });
  }

  createRecording(input: CreateRecordingInput): MeetingRecord {
    return createRecordingState(this.database, input);
  }

  commitTranscript(input: CommitTranscriptInput): CommitTranscriptResult {
    validateCommitIdentity(input);
    return inWriteTransaction(this.database, () => {
      const current = this.getMeeting(input.meetingId);
      if (current === null) {
        throw new MeetingRepositoryError("MEETING_NOT_FOUND", "Meeting does not exist");
      }
      if (current.status !== "processing" || current.activeRunId !== input.runId
        || current.transcriptVersion !== input.baseVersion) {
        return { outcome: "run_not_active", meeting: current };
      }
      if (current.runIdentity !== null && current.runIdentity.engineFingerprint !== input.engineFingerprint) {
        throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Transcript processing identity changed");
      }
      validateTranscriptCandidate(input);
      this.assertCommitSource(current, input);
      const newVersion = input.baseVersion + 1;
      this.replaceSegments(input, newVersion);
      this.completeTranscriptCommit(input, newVersion);
      return { outcome: "committed", meeting: this.getRequiredMeeting(input.meetingId) };
    });
  }

  finishRun(input: FinishRunInput): FinishRunResult {
    validateFinishRun(input);
    return inWriteTransaction(this.database, () => {
      const current = this.getRequiredMeeting(input.meetingId);
      this.assertRecordingEnd(current, input);
      const endedAtMs = input.recordingEndedAtMs ?? null;
      const update = this.database.prepare(`
        UPDATE meetings SET
          status = ?, active_run_id = NULL, run_kind = NULL,
          error_code = ?, error_stage = ?,
          updated_at_ms = max(updated_at_ms, ?, COALESCE(?, 0)),
          recording_ended_at_ms = CASE
            WHEN ? IS NULL THEN recording_ended_at_ms
            ELSE COALESCE(recording_ended_at_ms, ?)
          END
        WHERE meeting_id = ? AND status IN ('recording', 'processing')
          AND active_run_id = ? AND transcript_version = ?
      `).run(
        input.outcome,
        input.errorCode,
        input.errorStage,
        input.nowMs,
        endedAtMs,
        endedAtMs,
        endedAtMs,
        input.meetingId,
        input.runId,
        input.baseVersion,
      );
      const meeting = this.getRequiredMeeting(input.meetingId);
      if (update.changes === 1) return { outcome: "updated", meeting };
      if (meeting.transcriptVersion > input.baseVersion
        && meeting.committedStatus !== null) {
        return { outcome: "already_committed", meeting };
      }
      throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Run did not finish its target");
    });
  }

  private assertRecordingEnd(current: MeetingRecord, input: FinishRunInput): void {
    if (input.recordingEndedAtMs === undefined) return;
    const isTargetRun = current.activeRunId === input.runId
      && current.transcriptVersion === input.baseVersion
      && ["recording", "processing"].includes(current.status);
    if (!isTargetRun) return;
    if (current.runKind !== "recording" || current.recordingStartedAtMs === null
      || input.recordingEndedAtMs < current.recordingStartedAtMs) {
      throw new MeetingRepositoryError("INVALID_INPUT", "Recording end is not trustworthy");
    }
  }

  getMeeting(meetingId: string): MeetingRecord | null {
    return inReadOperation(() => {
      const row = this.database.prepare(`
        SELECT * FROM meetings WHERE meeting_id = ?
      `).get(meetingId);
      return row === undefined ? null : parseMeetingRow(row);
    });
  }

  hasRecordingHistory(): boolean {
    return inReadOperation(() => this.database.prepare(`
      SELECT 1 FROM meetings WHERE origin = 'recording'
        AND recording_started_at_ms IS NOT NULL AND status <> 'deleting' LIMIT 1
    `).get() !== undefined);
  }

  getCommittedTranscriptSlice(input: GetCommittedTranscriptSliceInput): CommittedTranscriptSlice {
    return queryCommittedTranscriptSlice(this.database, input);
  }

  getCommittedTranscriptSnapshot(meetingId: string): CommittedTranscriptSnapshot {
    return queryCommittedTranscriptSnapshot(this.database, meetingId);
  }

  getMeetingPage(input: GetMeetingPageInput): MeetingPage {
    return queryMeetingPage(this.database, input);
  }

  listMeetingReferenceRecords(input: ListMeetingReferenceRecordsInput): readonly MeetingRecord[] {
    return queryMeetingReferenceRecords(this.database, input);
  }

  listDeletingMeetings(): readonly MeetingRecord[] {
    return inReadOperation(() => this.database.prepare(`
      SELECT * FROM meetings WHERE status = 'deleting'
      ORDER BY created_at_ms, meeting_id
    `).all().map(parseMeetingRow));
  }

  listRecordingsNeedingRecovery(): readonly MeetingRecord[] {
    return listRecordingsNeedingRecoveryState(this.database);
  }

  recordDeletionFailure(input: RecordDeletionFailureInput): MeetingRecord {
    validateRecordDeletionFailure(input);
    return inWriteTransaction(this.database, () => {
      const current = this.getRequiredMeeting(input.meetingId);
      this.assertExpectedVersion(current, input.expectedVersion);
      if (current.status !== "deleting") {
        throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Meeting is not being deleted");
      }
      this.database.prepare(`
        UPDATE meetings SET error_code = 'DELETE_INCOMPLETE',
          error_stage = 'deleting_files', updated_at_ms = max(updated_at_ms, ?)
        WHERE meeting_id = ? AND transcript_version = ? AND status = 'deleting'
      `).run(input.nowMs, input.meetingId, input.expectedVersion);
      return this.getRequiredMeeting(input.meetingId);
    });
  }

  recordManagedSource(input: RecordManagedSourceInput): RecordManagedSourceResult {
    validateRecordManagedSource(input);
    return inWriteTransaction(this.database, () => {
      const update = this.database.prepare(`
        UPDATE meetings SET source_sha256 = ?, updated_at_ms = ?
        WHERE meeting_id = ? AND status = 'processing'
          AND active_run_id = ? AND source_sha256 IS NULL
      `).run(input.sourceSha256, input.nowMs, input.meetingId, input.runId);
      const meeting = this.getRequiredMeeting(input.meetingId);
      if (update.changes === 1) return { outcome: "updated", meeting };
      if (meeting.status === "processing" && meeting.activeRunId === input.runId
        && meeting.sourceSha256 !== null && meeting.sourceSha256 !== input.sourceSha256) {
        throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Managed source changed");
      }
      if (meeting.status === "processing" && meeting.activeRunId === input.runId
        && meeting.sourceSha256 === input.sourceSha256) {
        return { outcome: "updated", meeting };
      }
      return { outcome: "run_not_active", meeting };
    });
  }

  recordRecoveredRecordingSource(input: RecordRecoveredRecordingSourceInput): MeetingRecord {
    return recordRecoveredRecordingSourceState(this.database, input);
  }

  recordRecordingRecoveryFailure(input: RecordRecordingRecoveryFailureInput): MeetingRecord {
    return recordRecordingRecoveryFailureState(this.database, input);
  }

  recordRecordingStarted(input: RecordRecordingStartedInput): MeetingRecord {
    return recordRecordingStartedState(this.database, input);
  }

  reconcileOrphanedRuns(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new MeetingRepositoryError("INVALID_INPUT", "Timestamp is invalid");
    }
    return inWriteTransaction(this.database, () => {
      const result = this.database.prepare(`
        UPDATE meetings SET
          status = 'failed', active_run_id = NULL, run_kind = NULL,
          error_code = 'ORPHANED_BY_RESTART', error_stage = 'startup',
          updated_at_ms = max(updated_at_ms, ?)
        WHERE status IN ('recording', 'processing')
      `).run(nowMs);
      return Number(result.changes);
    });
  }

  searchMeetings(input: SearchMeetingsInput): SearchMeetingsPage {
    return queryMeetings(this.database, input);
  }

  private completeTranscriptCommit(input: CommitTranscriptInput, newVersion: number): void {
    const update = this.database.prepare(`
      UPDATE meetings SET
        status = ?, committed_status = ?, transcript_version = ?, result_reason = ?,
        engine_fingerprint = ?, duration_ms = ?, transcript_identity = run_identity,
        source_size_bytes = COALESCE(source_size_bytes, ?),
        source_sha256 = COALESCE(source_sha256, ?),
        active_run_id = NULL, run_kind = NULL,
        error_code = NULL, error_stage = NULL,
        updated_at_ms = max(updated_at_ms, ?)
      WHERE meeting_id = ? AND status = 'processing'
        AND active_run_id = ? AND transcript_version = ?
    `).run(
      input.resultStatus,
      input.resultStatus,
      newVersion,
      input.resultReason,
      input.engineFingerprint,
      input.durationMs,
      input.sourceSizeBytes ?? null,
      input.sourceSha256 ?? null,
      input.nowMs,
      input.meetingId,
      input.runId,
      input.baseVersion,
    );
    if (update.changes !== 1) {
      throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Transcript commit lost its run");
    }
  }

  private getRequiredMeeting(meetingId: string): MeetingRecord {
    const meeting = this.getMeeting(meetingId);
    if (meeting === null) {
      throw new MeetingRepositoryError("MEETING_NOT_FOUND", "Meeting does not exist");
    }
    return meeting;
  }

  private assertCommitSource(current: MeetingRecord, input: CommitTranscriptInput): void {
    const inputSize = input.sourceSizeBytes ?? null;
    const inputHash = input.sourceSha256 ?? null;
    if (current.origin === "recording"
      && ((current.sourceSizeBytes ?? inputSize) === null
        || (current.sourceSha256 ?? inputHash) === null)) {
      throw new MeetingRepositoryError("INVALID_INPUT", "Recording source metadata is required");
    }
    if (inputSize !== null && current.sourceSizeBytes !== null
      && inputSize !== current.sourceSizeBytes) {
      throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Managed source size changed");
    }
    if (inputHash !== null && current.sourceSha256 !== null
      && inputHash !== current.sourceSha256) {
      throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Managed source fingerprint changed");
    }
  }

  private assertExpectedVersion(meeting: MeetingRecord, expectedVersion: number): void {
    if (meeting.transcriptVersion !== expectedVersion) {
      throw new MeetingRepositoryError(
        "TRANSCRIPT_VERSION_CONFLICT",
        "Transcript version changed",
      );
    }
  }

  private hasActiveRun(): boolean {
    return this.database.prepare(
      "SELECT 1 AS found FROM meetings WHERE status IN ('recording', 'processing') LIMIT 1",
    ).get() !== undefined;
  }

  private replaceSegments(input: CommitTranscriptInput, newVersion: number): void {
    this.database.prepare("DELETE FROM segments WHERE meeting_id = ?").run(input.meetingId);
    const insert = this.database.prepare(`
      INSERT INTO segments (
        meeting_id, transcript_version, seq, start_ms, end_ms, speaker_label, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const segment of input.segments) {
      insert.run(
        input.meetingId,
        newVersion,
        segment.seq,
        segment.startMs,
        segment.endMs,
        segment.speakerLabel,
        segment.text,
      );
    }
  }
}

export function openMeetingRepository(filename: string): MeetingRepository {
  return new SqliteMeetingRepository(openMeetingDatabase(filename));
}

export type {
  AnchoredTranscriptSegment,
  BeginDeletionInput,
  BeginDeletionResult,
  BeginRecordingFinalizationInput,
  BeginRetranscriptionInput,
  BeginRetranscriptionResult,
  CommittedStatus,
  CommitTranscriptInput,
  CommitTranscriptResult,
  CommittedTranscriptSlice,
  CommittedTranscriptSnapshot,
  CompleteDeletionInput,
  CreateImportInput,
  CreateRecordingInput,
  FinishRunInput,
  FinishRunResult,
  GetCommittedTranscriptSliceInput,
  GetMeetingPageInput,
  ListMeetingReferenceRecordsInput,
  MeetingPage,
  MeetingRecord,
  MeetingSearchHit,
  MeetingSearchItem,
  MeetingStatus,
  RecordManagedSourceInput,
  RecordManagedSourceResult,
  RecordRecoveredRecordingSourceInput,
  RecordRecordingRecoveryFailureInput,
  RecordDeletionFailureInput,
  RunKind,
  SearchMeetingsInput,
  SearchMeetingsPage,
  SourceFormat,
  TranscriptSegment,
} from "./types.js";
export { MeetingRepositoryError } from "./errors.js";
export type { MeetingRepositoryErrorCode } from "./errors.js";
