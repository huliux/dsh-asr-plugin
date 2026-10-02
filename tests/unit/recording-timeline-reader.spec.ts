import { expect, it } from "vitest";

import { RecordingTimelineReader } from "../../src/audio/recording-timeline-reader.js";
import { buildRecordingTimeline } from "../../src/audio/recording-timeline.js";

it("exposes a growing mixed timeline through the canonical PCM reader seam", async () => {
  const first = buildRecordingTimeline([{
    id: "mic-1",
    track: "mic",
    startUs: 1_000_000,
    endUs: 1_001_000,
    frameCount: 16,
  }]);
  const samples = new Map([
    ["mic-1", new Float32Array(16).fill(0.25)],
    ["mic-2", new Float32Array(16).fill(0.5)],
  ]);
  const reader = new RecordingTimelineReader(first, async (chunk, start, end) =>
    samples.get(chunk.id)!.slice(start, end));

  await expect(reader.readFrames(0, 16)).resolves.toEqual(new Float32Array(16).fill(0.25));
  reader.update(buildRecordingTimeline([
    ...first.chunks,
    {
      id: "mic-2",
      track: "mic",
      startUs: 1_001_000,
      endUs: 1_002_000,
      frameCount: 16,
    },
  ]));
  const output = new Float32Array(16);
  await reader.readFramesInto(16, 32, output);
  expect(output).toEqual(new Float32Array(16).fill(0.5));
  expect(reader.metadata.frameCount).toBe(32);
});

it("exposes dual-track overlap on the same PCM16 grid as the managed WAV", async () => {
  const timeline = buildRecordingTimeline([
    {
      id: "mic",
      track: "mic",
      startUs: 1_000_000,
      endUs: 1_001_000,
      frameCount: 16,
    },
    {
      id: "system",
      track: "system",
      startUs: 1_000_000,
      endUs: 1_001_000,
      frameCount: 16,
    },
  ]);
  const reader = new RecordingTimelineReader(timeline, async (chunk, start, end) => (
    new Float32Array(end - start).fill(
      chunk.track === "mic" ? 1 / 32_767 : -1 / 32_768,
    )
  ));

  await expect(reader.readFrames(0, 16)).resolves.toEqual(
    new Float32Array(16),
  );
});

it("rejects an origin shift after incremental state has attached", () => {
  const reader = new RecordingTimelineReader(buildRecordingTimeline([{
    id: "mic",
    track: "mic",
    startUs: 2_000_000,
    endUs: 2_001_000,
    frameCount: 16,
  }]), async () => new Float32Array(16));

  expect(() => reader.update(buildRecordingTimeline([{
    id: "system",
    track: "system",
    startUs: 1_000_000,
    endUs: 1_001_000,
    frameCount: 16,
  }]))).toThrowError(/origin changed/);
});

it("accepts late overlap that remains newer than the processed watermark", () => {
  const first = buildRecordingTimeline([{
    id: "system-1",
    track: "system",
    startUs: 1_000_000,
    endUs: 1_002_000,
    frameCount: 32,
  }]);
  const reader = new RecordingTimelineReader(first, async () => new Float32Array(16));
  const next = buildRecordingTimeline([
    ...first.chunks,
    {
      id: "mic-1",
      track: "mic",
      startUs: 1_001_000,
      endUs: 1_002_000,
      frameCount: 16,
    },
  ]);

  expect(() => reader.update(next, 16)).not.toThrow();
});
