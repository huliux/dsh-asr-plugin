import type { MeetingRepository } from "../storage/meeting-repository.js";
import type { MeetingRecord } from "../storage/types.js";
import { OkfError, type OkfMeetingView, type OkfSegmentView } from "./contracts.js";

type MeetingSource = Pick<MeetingRepository, "getMeeting" | "getCommittedTranscriptSnapshot">;

function meetingStartMs(meeting: MeetingRecord): number {
  return meeting.recordingStartedAtMs ?? meeting.createdAtMs;
}

function meetingDurationMs(meeting: MeetingRecord, segments: readonly OkfSegmentView[]): number {
  if (meeting.durationMs !== null) return meeting.durationMs;
  return segments.reduce((longest, segment) => Math.max(longest, segment.endMs), 0);
}

/**
 * Distinct speaker labels in first-appearance order. Labels come from
 * diarization and may be empty; empty labels are dropped rather than merged.
 */
function speakerNames(segments: readonly OkfSegmentView[]): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const segment of segments) {
    const name = segment.speaker.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Reads one committed transcript version and freezes it into the bundle view.
 * The view is a plain value so ingestion never re-reads a moving transcript.
 */
export function buildOkfMeetingView(source: MeetingSource, meetingId: string): OkfMeetingView {
  const meeting = source.getMeeting(meetingId);
  if (meeting === null) {
    throw new OkfError("OKF_NO_TRANSCRIPT", `Meeting ${meetingId} does not exist`);
  }
  if (meeting.committedStatus === null || meeting.transcriptVersion === 0) {
    throw new OkfError("OKF_NO_TRANSCRIPT", `Meeting ${meetingId} has no committed transcript`);
  }
  const snapshot = source.getCommittedTranscriptSnapshot(meetingId);
  const segments: OkfSegmentView[] = snapshot.segments.map((segment) => ({
    seq: segment.seq,
    speaker: segment.speakerLabel,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));
  if (segments.length === 0) {
    throw new OkfError("OKF_NO_TRANSCRIPT", `Meeting ${meetingId} committed an empty transcript`);
  }
  return {
    meetingId: meeting.meetingId,
    title: meeting.title,
    startedAtMs: meetingStartMs(meeting),
    durationMs: meetingDurationMs(meeting, segments),
    speakers: speakerNames(segments),
    transcriptVersion: meeting.transcriptVersion,
    committedAtMs: meeting.updatedAtMs,
    partial: meeting.committedStatus === "partial",
    segments,
  };
}
