import { afterEach, expect, it } from "vitest";

import { DraftTranscriptPageError } from "../../src/recording/draft-transcript-page.js";
import type { DraftTranscriptSnapshot } from "../../src/recording/worker-types.js";
import {
  MEETING_ID,
  RUN_ID,
  createMeetingApplicationHarness,
  type MeetingApplicationHarness,
} from "../helpers/meeting-application-fixture.js";

let harness: MeetingApplicationHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

it("pages the active in-memory draft and rejects a cursor after its revision changes", async () => {
  harness = await createMeetingApplicationHarness();
  harness.repository.createRecording({
    meetingId: MEETING_ID,
    runId: RUN_ID,
    title: "现场会议",
    nowMs: 1_000,
  });
  let snapshot: DraftTranscriptSnapshot = {
    revision: 1,
    audioThroughMs: 5_000,
    generatedAtMs: 1_100,
    segments: [
      { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: null, text: "第一段。" },
      { seq: 1, startMs: 1_100, endMs: 4_500, speakerLabel: null, text: "第二段。" },
    ],
  };
  const detach = harness.application.attachRecordingDraft({
    meetingId: MEETING_ID,
    runId: RUN_ID,
    snapshot: () => snapshot,
  });

  const first = harness.application.getRecordingDraftPage({ meetingId: MEETING_ID, limit: 1 });
  expect(first).toMatchObject({ revision: 1, segments: [{ seq: 0, text: "第一段。" }] });
  expect(first.nextCursor).not.toBeNull();

  snapshot = {
    ...snapshot,
    revision: 2,
    audioThroughMs: 10_000,
    generatedAtMs: 1_200,
  };
  expect(() => harness!.application.getRecordingDraftPage({
    meetingId: MEETING_ID,
    cursor: first.nextCursor!,
  })).toThrowError(DraftTranscriptPageError);

  detach();
  expect(() => harness!.application.getRecordingDraftPage({ meetingId: MEETING_ID }))
    .toThrowError(/draft is unavailable/u);
});
