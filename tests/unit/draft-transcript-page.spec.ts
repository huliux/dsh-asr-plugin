import { expect, it } from "vitest";

import { getDraftTranscriptPage } from "../../src/recording/draft-transcript-page.js";
import type { DraftTranscriptSnapshot } from "../../src/recording/worker-types.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

function snapshot(revision: number): DraftTranscriptSnapshot {
  return {
    revision,
    audioThroughMs: 15_000,
    generatedAtMs: 1_788_070_000_000,
    segments: [
      { seq: 0, startMs: 100, endMs: 4_000, speakerLabel: null, text: "第一段" },
      { seq: 1, startMs: 4_100, endMs: 9_000, speakerLabel: null, text: "第二段" },
      { seq: 2, startMs: 9_100, endMs: 14_000, speakerLabel: null, text: "第三段" },
    ],
  };
}

it("pages one immutable draft revision and rejects its cursor after revision replacement", () => {
  const first = getDraftTranscriptPage({ meetingId: MEETING_ID, snapshot: snapshot(7), limit: 2 });
  expect(first).toEqual({
    revision: 7,
    audioThroughMs: 15_000,
    generatedAtMs: 1_788_070_000_000,
    segments: [
      { seq: 0, startMs: 100, endMs: 4_000, speakerLabel: null, text: "第一段" },
      { seq: 1, startMs: 4_100, endMs: 9_000, speakerLabel: null, text: "第二段" },
    ],
    nextCursor: expect.any(String),
  });
  expect(getDraftTranscriptPage({
    meetingId: MEETING_ID,
    snapshot: snapshot(7),
    cursor: first.nextCursor!,
    limit: 2,
  }).segments).toEqual([
    { seq: 2, startMs: 9_100, endMs: 14_000, speakerLabel: null, text: "第三段" },
  ]);

  expect(() => getDraftTranscriptPage({
    meetingId: MEETING_ID,
    snapshot: snapshot(8),
    cursor: first.nextCursor!,
    limit: 2,
  })).toThrow(expect.objectContaining({ code: "DRAFT_REVISION_CONFLICT" }));
});

it("explains draft limit and cursor recovery at the pagination boundary", () => {
  expect(() => getDraftTranscriptPage({
    meetingId: MEETING_ID, snapshot: snapshot(7), limit: 200,
  })).toThrow(expect.objectContaining({
    code: "INVALID_INPUT", message: expect.stringContaining("1..100"),
  }));
  expect(() => getDraftTranscriptPage({
    meetingId: MEETING_ID, snapshot: snapshot(7), cursor: "broken",
  })).toThrow(expect.objectContaining({
    code: "INVALID_INPUT", message: expect.stringContaining("first page"),
  }));
});
