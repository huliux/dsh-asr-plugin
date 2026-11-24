import { describe, expect, it } from "vitest";

import { OkfError } from "../../src/okf/contracts.js";
import { buildOkfMeetingView } from "../../src/okf/meeting-view.js";
import type {
  CommittedTranscriptSnapshot,
  MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import type { MeetingRecord, TranscriptSegment } from "../../src/storage/types.js";

type MeetingSource = Pick<MeetingRepository, "getMeeting" | "getCommittedTranscriptSnapshot">;

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT_MS = Date.parse("2026-11-20T08:55:00.000Z");
const UPDATED_AT_MS = Date.parse("2026-11-20T09:10:00.000Z");

function meetingRecord(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    runIdentity: null,
    transcriptIdentity: null,
    meetingId: MEETING_ID,
    origin: "import",
    title: "Weekly product sync",
    sourceName: "weekly-sync.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    sourceSha256: null,
    durationMs: null,
    status: "partial",
    committedStatus: "partial",
    transcriptVersion: 3,
    resultReason: null,
    engineFingerprint: "a".repeat(64),
    activeRunId: null,
    runKind: null,
    errorCode: null,
    errorStage: null,
    createdAtMs: CREATED_AT_MS,
    updatedAtMs: UPDATED_AT_MS,
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
    ...overrides,
  };
}

const SEGMENTS: readonly TranscriptSegment[] = [
  { seq: 0, startMs: 0, endMs: 1_200, speakerLabel: " Alice ", text: "Hello" },
  { seq: 1, startMs: 1_200, endMs: 2_500, speakerLabel: "Bob", text: "Hi" },
  { seq: 2, startMs: 2_500, endMs: 3_700, speakerLabel: "Alice", text: "Long time" },
  { seq: 3, startMs: 3_700, endMs: 4_100, speakerLabel: "   ", text: "Unlabelled" },
  { seq: 4, startMs: 4_100, endMs: 5_000, speakerLabel: "Carol", text: "Bye" },
];

interface FakeSource extends MeetingSource {
  readonly snapshotCalls: string[];
}

function source(
  record: MeetingRecord | null,
  segments: readonly TranscriptSegment[],
): FakeSource {
  const snapshotCalls: string[] = [];
  return {
    snapshotCalls,
    getMeeting(meetingId: string): MeetingRecord | null {
      return record !== null && record.meetingId === meetingId ? record : null;
    },
    getCommittedTranscriptSnapshot(meetingId: string): CommittedTranscriptSnapshot {
      snapshotCalls.push(meetingId);
      return {
        meeting: record ?? meetingRecord({ meetingId }),
        segments,
      };
    },
  };
}

function okfError(run: () => unknown): OkfError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkfError) return error;
    throw error;
  }
  throw new Error("expected buildOkfMeetingView to throw an OkfError");
}

describe("buildOkfMeetingView", () => {
  it("freezes a committed transcript into the bundle view", () => {
    const record = meetingRecord();
    const view = buildOkfMeetingView(source(record, SEGMENTS), MEETING_ID);
    expect(view).toEqual({
      meetingId: MEETING_ID,
      title: "Weekly product sync",
      startedAtMs: CREATED_AT_MS,
      durationMs: 5_000,
      speakers: ["Alice", "Bob", "Carol"],
      transcriptVersion: 3,
      committedAtMs: UPDATED_AT_MS,
      partial: true,
      segments: [
        { seq: 0, speaker: " Alice ", startMs: 0, endMs: 1_200, text: "Hello" },
        { seq: 1, speaker: "Bob", startMs: 1_200, endMs: 2_500, text: "Hi" },
        { seq: 2, speaker: "Alice", startMs: 2_500, endMs: 3_700, text: "Long time" },
        { seq: 3, speaker: "   ", startMs: 3_700, endMs: 4_100, text: "Unlabelled" },
        { seq: 4, speaker: "Carol", startMs: 4_100, endMs: 5_000, text: "Bye" },
      ],
    });
  });

  it("prefers the recording start and the reported duration when both exist", () => {
    const startedAtMs = Date.parse("2026-11-20T09:00:00.000Z");
    const record = meetingRecord({
      recordingStartedAtMs: startedAtMs,
      durationMs: 123_456,
    });
    const view = buildOkfMeetingView(source(record, SEGMENTS), MEETING_ID);
    expect(view.startedAtMs).toBe(startedAtMs);
    expect(view.durationMs).toBe(123_456);
  });

  it("uses the furthest segment end when the meeting has no duration", () => {
    const record = meetingRecord({ durationMs: null });
    const segments: readonly TranscriptSegment[] = [
      { seq: 0, startMs: 0, endMs: 900, speakerLabel: "Alice", text: "First" },
      { seq: 1, startMs: 900, endMs: 7_500, speakerLabel: "Alice", text: "Longest" },
      { seq: 2, startMs: 2_000, endMs: 2_400, speakerLabel: "Alice", text: "Later, shorter" },
    ];
    const view = buildOkfMeetingView(source(record, segments), MEETING_ID);
    expect(view.durationMs).toBe(7_500);
  });

  it("keeps speakers in first-appearance order and drops blank labels", () => {
    const record = meetingRecord();
    const segments: readonly TranscriptSegment[] = [
      { seq: 0, startMs: 0, endMs: 10, speakerLabel: " Bob ", text: "1" },
      { seq: 1, startMs: 10, endMs: 20, speakerLabel: "Alice", text: "2" },
      { seq: 2, startMs: 20, endMs: 30, speakerLabel: "", text: "3" },
      { seq: 3, startMs: 30, endMs: 40, speakerLabel: "Bob", text: "4" },
      { seq: 4, startMs: 40, endMs: 50, speakerLabel: "  Alice  ", text: "5" },
    ];
    const view = buildOkfMeetingView(source(record, segments), MEETING_ID);
    expect(view.speakers).toEqual(["Bob", "Alice"]);
  });

  it("marks a completed transcript as not partial", () => {
    const record = meetingRecord({
      status: "completed",
      committedStatus: "completed",
    });
    const view = buildOkfMeetingView(source(record, SEGMENTS), MEETING_ID);
    expect(view.partial).toBe(false);
  });

  it("rejects a meeting that does not exist", () => {
    const fake = source(null, SEGMENTS);
    const error = okfError(() => buildOkfMeetingView(fake, MEETING_ID));
    expect(error.code).toBe("OKF_NO_TRANSCRIPT");
    expect(fake.snapshotCalls).toEqual([]);
  });

  it("rejects a meeting that never committed a transcript", () => {
    const record = meetingRecord({
      status: "processing",
      committedStatus: null,
      transcriptVersion: 0,
      activeRunId: "run-1",
      runKind: "import",
    });
    const fake = source(record, SEGMENTS);
    const error = okfError(() => buildOkfMeetingView(fake, MEETING_ID));
    expect(error.code).toBe("OKF_NO_TRANSCRIPT");
    expect(fake.snapshotCalls).toEqual([]);
  });

  it("rejects a committed status without a committed transcript version", () => {
    const record = meetingRecord({ transcriptVersion: 0 });
    const error = okfError(() => buildOkfMeetingView(source(record, SEGMENTS), MEETING_ID));
    expect(error.code).toBe("OKF_NO_TRANSCRIPT");
  });

  it("rejects a committed transcript that has no segments", () => {
    const record = meetingRecord();
    const error = okfError(() => buildOkfMeetingView(source(record, []), MEETING_ID));
    expect(error.code).toBe("OKF_NO_TRANSCRIPT");
  });
});
