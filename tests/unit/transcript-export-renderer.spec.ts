import { expect, it } from "vitest";

import { renderTranscriptExport } from "../../src/transcript-projection/transcript-export-renderer.js";
import type { CommittedTranscriptSnapshot } from "../../src/storage/meeting-repository.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const EXPORTED_AT_MS = Date.parse("2026-09-01T02:03:04.005Z");

function snapshot(): CommittedTranscriptSnapshot {
  return {
    meeting: {
      runIdentity: null,
    transcriptIdentity: null,
    meetingId: MEETING_ID,
      origin: "recording",
      title: "产品周会",
      sourceName: "recording.wav",
      sourceFormat: "wav",
      sourceSizeBytes: 64_044,
      sourceSha256: "b".repeat(64),
      durationMs: 65_000,
      status: "partial",
      committedStatus: "partial",
      transcriptVersion: 3,
      resultReason: "unknown_speaker_segments",
      engineFingerprint: "a".repeat(64),
      activeRunId: null,
      runKind: null,
      errorCode: null,
      errorStage: null,
      createdAtMs: Date.parse("2026-09-01T01:00:00.000Z"),
      updatedAtMs: Date.parse("2026-09-01T01:02:00.000Z"),
      recordingStartedAtMs: Date.parse("2026-09-01T01:00:01.000Z"),
      recordingEndedAtMs: Date.parse("2026-09-01T01:01:10.000Z"),
    },
    segments: [
      { seq: 0, startMs: 0, endMs: 1_234, speakerLabel: "Speaker A", text: "你好，world。" },
      { seq: 1, startMs: 60_000, endMs: 65_000, speakerLabel: "UNKNOWN", text: "第二段。" },
    ],
  };
}

it("逐段确定性渲染 Markdown 和纯文本", () => {
  expect(renderTranscriptExport(snapshot(), {
    format: "md",
    exportedAtMs: EXPORTED_AT_MS,
    includeSpeakers: true,
    includeTimestamps: true,
  })).toBe(`# Meeting transcript

title: "产品周会"
meeting_id: "${MEETING_ID}"
transcript_version: 3
recording_started_at: "2026-09-01T01:00:01.000Z"
recording_ended_at: "2026-09-01T01:01:10.000Z"
duration_ms: 65000
exported_at: "2026-09-01T02:03:04.005Z"

## Segment 1

time: 00:00:00.000 --> 00:00:01.234
speaker: "Speaker A"

你好，world。

## Segment 2

time: 00:01:00.000 --> 00:01:05.000
speaker: "UNKNOWN"

第二段。
`);

  expect(renderTranscriptExport(snapshot(), {
    format: "txt",
    exportedAtMs: EXPORTED_AT_MS,
    includeSpeakers: false,
    includeTimestamps: false,
  })).toBe(`title: "产品周会"
meeting_id: "${MEETING_ID}"
transcript_version: 3
recording_started_at: "2026-09-01T01:00:01.000Z"
recording_ended_at: "2026-09-01T01:01:10.000Z"
duration_ms: 65000
exported_at: "2026-09-01T02:03:04.005Z"

---

你好，world。

第二段。
`);
});

it("逐段确定性渲染标准 SRT 和带来源 NOTE 的 VTT", () => {
  expect(renderTranscriptExport(snapshot(), {
    format: "srt",
    exportedAtMs: EXPORTED_AT_MS,
    includeSpeakers: true,
    includeTimestamps: true,
  })).toBe(`1
00:00:00,000 --> 00:00:01,234
Speaker A
你好，world。

2
00:01:00,000 --> 00:01:05,000
UNKNOWN
第二段。
`);

  expect(renderTranscriptExport(snapshot(), {
    format: "vtt",
    exportedAtMs: EXPORTED_AT_MS,
    includeSpeakers: false,
    includeTimestamps: true,
  })).toBe(`WEBVTT

NOTE
title: "产品周会"
meeting_id: "${MEETING_ID}"
transcript_version: 3
recording_started_at: "2026-09-01T01:00:01.000Z"
recording_ended_at: "2026-09-01T01:01:10.000Z"
duration_ms: 65000
exported_at: "2026-09-01T02:03:04.005Z"

00:00:00.000 --> 00:00:01.234
你好，world。

00:01:00.000 --> 00:01:05.000
第二段。
`);
});
