import { describe, expect, it } from "vitest";

import { planEmbeddingWindows } from "../../src/diarization/windows.js";

describe("embedding window planning", () => {
  it("短 block 只读取自身，长 block 使用 6 秒窗口与至多 3 秒步长", () => {
    expect(planEmbeddingWindows(
      { seq: 0, startMs: 1_000, endMs: 5_000, text: "短句" },
      [],
    )).toEqual([{ startMs: 1_000, endMs: 5_000 }]);

    expect(planEmbeddingWindows(
      { seq: 0, startMs: 0, endMs: 12_000, text: "长句" },
      [],
    )).toEqual([
      { startMs: 0, endMs: 6_000 },
      { startMs: 3_000, endMs: 9_000 },
      { startMs: 6_000, endMs: 12_000 },
    ]);
  });

  it("VAD gate 只保留至少 1 秒语音的窗口", () => {
    expect(planEmbeddingWindows(
      { seq: 0, startMs: 0, endMs: 12_000, text: "长句" },
      [{ startMs: 3_500, endMs: 4_500 }],
    )).toEqual([
      { startMs: 0, endMs: 6_000 },
      { startMs: 3_000, endMs: 9_000 },
    ]);
  });

  it("所有窗口均不足 gate 时只保留语音覆盖最多的一窗", () => {
    expect(planEmbeddingWindows(
      { seq: 0, startMs: 0, endMs: 12_000, text: "长句" },
      [{ startMs: 10_000, endMs: 10_500 }],
    )).toEqual([{ startMs: 6_000, endMs: 12_000 }]);
  });
});
