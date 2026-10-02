import { expect, it } from "vitest";

import {
  MAX_RECORDING_CHUNKS_PER_TRACK,
  buildRecordingTimeline,
  renderRecordingWindow,
  type RecordingChunk,
} from "../../src/audio/recording-timeline.js";

function chunk(
  id: string,
  track: "mic" | "system",
  startUs: number,
  endUs: number,
): RecordingChunk {
  return { id, track, startUs, endUs, frameCount: Math.round((endUs - startUs) * 0.016) };
}

it("mixes single, dual, gap and off-on chunks on one absolute timeline", async () => {
  const timeline = buildRecordingTimeline([
    chunk("mic-1", "mic", 1_000_000, 1_002_000),
    chunk("mic-2", "mic", 1_004_000, 1_005_000),
    chunk("system-1", "system", 1_001_000, 1_003_000),
  ]);
  const samples = new Map([
    ["mic-1", new Float32Array(32).fill(0.25)],
    ["mic-2", new Float32Array(16).fill(0.5)],
    ["system-1", new Float32Array(32).fill(-0.25)],
  ]);

  expect(timeline).toMatchObject({ originUs: 1_000_000, frameCount: 80 });
  const mixed = await renderRecordingWindow(timeline, 0, 80, async (item, start, end) => (
    samples.get(item.id)!.slice(start, end)
  ));

  expect([...mixed]).toEqual([
    ...new Array(16).fill(0.25),
    ...new Array(16).fill(0),
    ...new Array(16).fill(-0.25),
    ...new Array(16).fill(0),
    ...new Array(16).fill(0.5),
  ]);
});

it("accepts the five-second chunk count of a 183-minute meeting but remains bounded", () => {
  const chunks = Array.from({ length: 2_204 }, (_, index) => ({
    id: `mic-${index}`,
    track: "mic" as const,
    startUs: index * 5_000_000,
    endUs: (index + 1) * 5_000_000,
    frameCount: 80_000,
  }));
  expect(buildRecordingTimeline(chunks).chunks).toHaveLength(2_204);
  expect(() => buildRecordingTimeline(Array.from(
    { length: MAX_RECORDING_CHUNKS_PER_TRACK + 1 },
    (_, index) => ({
      id: `bounded-${index}`,
      track: "mic" as const,
      startUs: index * 1_000,
      endUs: (index + 1) * 1_000,
      frameCount: 16,
    }),
  ))).toThrowError(/too many chunks/);
});
