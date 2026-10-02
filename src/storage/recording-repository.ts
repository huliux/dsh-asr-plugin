import { encodeProcessingIdentity } from "./processing-identity.js";
import type { DatabaseSync } from "node:sqlite";

import { inReadOperation, inWriteTransaction } from "./database.js";
import { MeetingRepositoryError } from "./errors.js";
import { parseMeetingRow } from "./row-mappers.js";
import type {
  BeginRecordingFinalizationInput,
  CreateRecordingInput,
  MeetingRecord,
  RecordRecordingStartedInput,
  RecordRecordingRecoveryFailureInput,
  RecordRecoveredRecordingSourceInput,
} from "./types.js";
import {
  validateBeginRecordingFinalization,
  validateCreateRecording,
  validateRecordRecordingStarted,
  validateRecordRecoveredRecordingSource,
  validateRecordRecordingRecoveryFailure,
} from "./validation.js";

function requiredMeeting(database: DatabaseSync, meetingId: string): MeetingRecord {
  const row = database.prepare("SELECT * FROM meetings WHERE meeting_id = ?").get(meetingId);
  if (row === undefined) {
    throw new MeetingRepositoryError("MEETING_NOT_FOUND", "Meeting does not exist");
  }
  return parseMeetingRow(row);
}

function hasActiveRun(database: DatabaseSync): boolean {
  return database.prepare(
    "SELECT 1 AS found FROM meetings WHERE status IN ('recording', 'processing') LIMIT 1",
  ).get() !== undefined;
}

export function listRecordingsNeedingRecovery(
  database: DatabaseSync,
): readonly MeetingRecord[] {
  return inReadOperation(() => database.prepare(`
    SELECT * FROM meetings
    WHERE origin = 'recording' AND status IN ('failed', 'cancelled')
      AND (source_size_bytes IS NULL OR source_sha256 IS NULL)
    ORDER BY created_at_ms, meeting_id
  `).all().map(parseMeetingRow));
}

export function beginRecordingFinalization(
  database: DatabaseSync,
  input: BeginRecordingFinalizationInput,
): MeetingRecord {
  validateBeginRecordingFinalization(input);
  return inWriteTransaction(database, () => {
    const update = database.prepare(`
      UPDATE meetings SET status = 'processing',
        recording_ended_at_ms = COALESCE(recording_ended_at_ms, ?),
        updated_at_ms = max(updated_at_ms, ?, ?)
      WHERE meeting_id = ? AND status = 'recording'
        AND active_run_id = ? AND run_kind = 'recording'
        AND recording_started_at_ms IS NOT NULL
        AND ? >= recording_started_at_ms
        AND transcript_version = ?
    `).run(
      input.recordingEndedAtMs,
      input.recordingEndedAtMs,
      input.nowMs,
      input.meetingId,
      input.runId,
      input.recordingEndedAtMs,
      input.baseVersion,
    );
    if (update.changes !== 1) {
      throw new MeetingRepositoryError(
        "RUN_STATE_CONFLICT",
        "Recording finalization did not start",
      );
    }
    return requiredMeeting(database, input.meetingId);
  });
}

export function createRecording(
  database: DatabaseSync,
  input: CreateRecordingInput,
): MeetingRecord {
  validateCreateRecording(input);
  return inWriteTransaction(database, () => {
    if (hasActiveRun(database)) {
      throw new MeetingRepositoryError("ENGINE_BUSY", "Another transcription is active");
    }
    database.prepare(`
      INSERT INTO meetings (
        meeting_id, origin, title, source_name, source_format,
        status, active_run_id, run_kind, created_at_ms, updated_at_ms, run_identity
      ) VALUES (?, 'recording', ?, 'recording.wav', 'wav',
        'recording', ?, 'recording', ?, ?, ?)
    `).run(input.meetingId, input.title, input.runId, input.nowMs, input.nowMs,
      encodeProcessingIdentity(input.processingIdentity));
    return requiredMeeting(database, input.meetingId);
  });
}

export function recordRecordingStarted(
  database: DatabaseSync,
  input: RecordRecordingStartedInput,
): MeetingRecord {
  validateRecordRecordingStarted(input);
  return inWriteTransaction(database, () => {
    const update = database.prepare(`
      UPDATE meetings SET recording_started_at_ms = ?,
        updated_at_ms = max(updated_at_ms, ?)
      WHERE meeting_id = ? AND status = 'recording'
        AND active_run_id = ? AND run_kind = 'recording'
        AND recording_started_at_ms IS NULL
        AND ? >= created_at_ms
    `).run(
      input.startedAtMs,
      input.startedAtMs,
      input.meetingId,
      input.runId,
      input.startedAtMs,
    );
    const current = requiredMeeting(database, input.meetingId);
    if (update.changes === 1) return current;
    if (input.startedAtMs < current.createdAtMs) {
      throw new MeetingRepositoryError("INVALID_INPUT", "Recording start precedes its request");
    }
    if (current.status === "recording" && current.activeRunId === input.runId
      && current.recordingStartedAtMs !== null) return current;
    throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Recording start was not recorded");
  });
}

function assertRecoveredSourceMatches(
  current: MeetingRecord,
  input: RecordRecoveredRecordingSourceInput,
): void {
  if (current.sourceSizeBytes !== null && current.sourceSizeBytes !== input.sourceSizeBytes) {
    throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Managed source size changed");
  }
  if (current.sourceSha256 !== null && current.sourceSha256 !== input.sourceSha256) {
    throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Managed source fingerprint changed");
  }
}

export function recordRecoveredRecordingSource(
  database: DatabaseSync,
  input: RecordRecoveredRecordingSourceInput,
): MeetingRecord {
  validateRecordRecoveredRecordingSource(input);
  return inWriteTransaction(database, () => {
    const current = requiredMeeting(database, input.meetingId);
    if (current.transcriptVersion !== input.expectedVersion) {
      throw new MeetingRepositoryError("TRANSCRIPT_VERSION_CONFLICT", "Transcript version changed");
    }
    if (current.origin !== "recording" || !["failed", "cancelled"].includes(current.status)) {
      throw new MeetingRepositoryError(
        "INVALID_MEETING_STATE",
        "Recording source cannot be recovered in the current state",
      );
    }
    assertRecoveredSourceMatches(current, input);
    const update = database.prepare(`
      UPDATE meetings SET
        source_size_bytes = COALESCE(source_size_bytes, ?),
        source_sha256 = COALESCE(source_sha256, ?),
        updated_at_ms = max(updated_at_ms, ?)
      WHERE meeting_id = ? AND transcript_version = ?
        AND origin = 'recording' AND status IN ('failed', 'cancelled')
    `).run(
      input.sourceSizeBytes,
      input.sourceSha256,
      input.nowMs,
      input.meetingId,
      input.expectedVersion,
    );
    if (update.changes !== 1) {
      throw new MeetingRepositoryError("RUN_STATE_CONFLICT", "Recovered source was not recorded");
    }
    return requiredMeeting(database, input.meetingId);
  });
}

export function recordRecordingRecoveryFailure(
  database: DatabaseSync,
  input: RecordRecordingRecoveryFailureInput,
): MeetingRecord {
  validateRecordRecordingRecoveryFailure(input);
  return inWriteTransaction(database, () => {
    const current = requiredMeeting(database, input.meetingId);
    if (current.transcriptVersion !== input.expectedVersion) {
      throw new MeetingRepositoryError("TRANSCRIPT_VERSION_CONFLICT", "Transcript version changed");
    }
    if (current.origin !== "recording" || !["failed", "cancelled"].includes(current.status)) {
      throw new MeetingRepositoryError(
        "INVALID_MEETING_STATE",
        "Recording recovery failure cannot be recorded in the current state",
      );
    }
    database.prepare(`
      UPDATE meetings SET error_code = 'AUDIO_RECOVERY_FAILED',
        error_stage = 'recovering_audio', updated_at_ms = max(updated_at_ms, ?)
      WHERE meeting_id = ? AND transcript_version = ?
        AND origin = 'recording' AND status IN ('failed', 'cancelled')
    `).run(input.nowMs, input.meetingId, input.expectedVersion);
    return requiredMeeting(database, input.meetingId);
  });
}
