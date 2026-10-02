import type { RecordingSessionView } from "../recording/recording-session.js";
import { MeetingRepositoryError } from "../storage/errors.js";
import type { MeetingRecord } from "../storage/meeting-repository.js";

export type MeetingReferencePhase =
  | "starting"
  | "recording"
  | "finalizing"
  | "processing"
  | "completed"
  | "empty"
  | "partial"
  | "failed"
  | "cancelled";

export interface MeetingReferenceCandidate {
  readonly meetingId: string;
  readonly label: string;
  readonly origin: MeetingRecord["origin"];
  readonly phase: MeetingReferencePhase;
  readonly startedAtMs: number | null;
  readonly createdAtMs: number;
  readonly recordingElapsedMs: number | null;
  readonly durationMs: number | null;
}

export interface GetMeetingReferenceCandidatesInput {
  readonly locale: string;
  readonly query?: string;
}

export interface ResolveMeetingReferenceInput {
  readonly locale: string;
  readonly meetingId: string;
}

export function validateMeetingReferenceLocale(locale: string): void {
  try {
    if (typeof locale !== "string" || locale.length > 100
      || Intl.getCanonicalLocales(locale).length !== 1) throw new RangeError();
  } catch {
    throw new MeetingRepositoryError("INVALID_INPUT", "Meeting reference locale is invalid");
  }
}

export function isActiveReferencePhase(phase: MeetingReferencePhase): boolean {
  return phase === "starting" || phase === "recording" || phase === "finalizing";
}

export function meetingReferenceCandidate(
  meeting: MeetingRecord,
  online: RecordingSessionView | null,
): MeetingReferenceCandidate {
  const current = online?.meetingId === meeting.meetingId ? online : null;
  const phase = current?.phase ?? meeting.status;
  if (phase === "deleting") throw new TypeError("Deleting Meeting cannot be referenced");
  return {
    meetingId: meeting.meetingId,
    label: meeting.title,
    origin: meeting.origin,
    phase,
    startedAtMs: current?.recordingStartedAtMs ?? meeting.recordingStartedAtMs,
    createdAtMs: meeting.createdAtMs,
    recordingElapsedMs: isActiveReferencePhase(phase)
      ? current?.recordingElapsedMs ?? null
      : null,
    durationMs: current?.durationMs ?? meeting.durationMs,
  };
}
