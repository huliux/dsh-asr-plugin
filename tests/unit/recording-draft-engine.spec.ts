import { expect, it, vi } from "vitest";

import {
  RecordingDraftEngine,
} from "../../src/recording/draft-engine.js";
import { buildRecordingTimeline } from "../../src/audio/recording-timeline.js";
import type { ClosedRecordingChunks } from "../../src/audio/closed-recording-chunks.js";

it("advances in five-second windows and supersedes by token timestamp midpoint", async () => {
  const timeline = buildRecordingTimeline([{
    id: "mic-1",
    track: "mic",
    startUs: 1_000_000,
    endUs: 11_000_000,
    frameCount: 160_000,
  }]);
  const chunks: ClosedRecordingChunks = {
    scan: async () => timeline,
    read: async (_chunk, start, end) => new Float32Array(end - start),
  };
  const recognize = vi.fn()
    .mockResolvedValueOnce([
      { startMs: 100, endMs: 1_000, text: "稳定前缀。", breakAfter: true },
      { startMs: 2_000, endMs: 4_500, text: "旧尾段。", breakAfter: true },
    ])
    .mockResolvedValueOnce([
      { startMs: 100, endMs: 2_000, text: "不应覆盖。", breakAfter: true },
      { startMs: 2_100, endMs: 7_500, text: "新尾段。", breakAfter: true },
    ]);
  let now = 10;
  const engine = new RecordingDraftEngine({
    chunks,
    recognize,
    now: () => now++,
  });

  await expect(engine.nextRevision()).resolves.toMatchObject({
    revision: 1,
    base_revision: 0,
    replace_from_seq: 0,
    audio_through_ms: 5_000,
    segments: [
      { seq: 0, start_ms: 100, end_ms: 1_000, text: "稳定前缀。" },
      { seq: 1, start_ms: 2_000, end_ms: 4_500, text: "旧尾段。" },
    ],
  });
  await expect(engine.nextRevision()).resolves.toMatchObject({
    revision: 2,
    base_revision: 1,
    replace_from_seq: 2,
    audio_through_ms: 10_000,
    segments: [
      { seq: 2, start_ms: 4_100, end_ms: 9_500, text: "新尾段。" },
    ],
  });
  await expect(engine.nextRevision()).resolves.toBeNull();
  expect(recognize).toHaveBeenNthCalledWith(1, expect.any(Float32Array));
  expect(recognize.mock.calls[0]![0]).toHaveLength(80_000);
  expect(recognize.mock.calls[1]![0]).toHaveLength(128_000);
});

it("coalesces token units into bounded readable draft segments", async () => {
  const timeline = buildRecordingTimeline([{
    id: "mic-1",
    track: "mic",
    startUs: 1_000_000,
    endUs: 6_000_000,
    frameCount: 80_000,
  }]);
  const engine = new RecordingDraftEngine({
    chunks: {
      scan: async () => timeline,
      read: async (_chunk, start, end) => new Float32Array(end - start),
    },
    recognize: async () => [
      { startMs: 10, endMs: 100, text: "Hello", breakAfter: false },
      { startMs: 100, endMs: 200, text: "world。", breakAfter: true },
    ],
  });

  await expect(engine.nextRevision()).resolves.toMatchObject({
    segments: [{ seq: 0, start_ms: 10, end_ms: 200, text: "Hello world。" }],
  });
});

it("leaves a closed tail shorter than one cadence for the next revision", async () => {
  let frameCount = 96_000;
  const chunks: ClosedRecordingChunks = {
    scan: async () => buildRecordingTimeline([{
      id: "mic-1",
      track: "mic",
      startUs: 1_000_000,
      endUs: 1_000_000 + frameCount * 1_000_000 / 16_000,
      frameCount,
    }]),
    read: async (_chunk, start, end) => new Float32Array(end - start),
  };
  const engine = new RecordingDraftEngine({ chunks, recognize: async () => [] });

  await expect(engine.nextRevision()).resolves.toMatchObject({ audio_through_ms: 5_000 });
  await expect(engine.nextRevision()).resolves.toBeNull();
  frameCount = 176_000;
  await expect(engine.nextRevision()).resolves.toMatchObject({ audio_through_ms: 10_000 });
  await expect(engine.nextRevision()).resolves.toBeNull();
});

it("classifies an unbounded recognizer result as a terminal resource limit", async () => {
  const timeline = buildRecordingTimeline([{
    id: "mic-1",
    track: "mic",
    startUs: 1_000_000,
    endUs: 6_000_000,
    frameCount: 80_000,
  }]);
  const unit = { startMs: 0, endMs: 1, text: "字", breakAfter: true };
  const engine = new RecordingDraftEngine({
    chunks: {
      scan: async () => timeline,
      read: async (_chunk, start, end) => new Float32Array(end - start),
    },
    recognize: async () => Array.from({ length: 20_001 }, () => unit),
  });

  await expect(engine.nextRevision()).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
});
