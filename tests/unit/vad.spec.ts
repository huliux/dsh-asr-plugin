import { describe, expect, it } from "vitest";

import type { Pcm16WavReader } from "../../src/audio/wav-reader.js";
import {
  VAD_CLASSES,
  VAD_OUTPUT_FRAMES,
  VAD_WINDOW_SAMPLES,
  StreamingBoundedVad,
  runBoundedVad,
} from "../../src/asr/bounded-vad.js";
import type { VadInferenceModel } from "../../src/asr/bounded-vad.js";
import {
  mergeSpeechBlocks,
  splitSpeechRegions,
} from "../../src/asr/vad-regions.js";

function virtualReader(samplesOrFrames: Float32Array | number): Pcm16WavReader {
  const frameCount =
    typeof samplesOrFrames === "number" ? samplesOrFrames : samplesOrFrames.length;
  const samples =
    typeof samplesOrFrames === "number" ? undefined : samplesOrFrames;
  return {
    metadata: {
      bitDepth: 16,
      channels: 1,
      dataByteLength: frameCount * 2,
      dataOffset: 44,
      durationMs: Math.ceil((frameCount * 1_000) / 16_000),
      frameCount,
      sampleRate: 16_000,
    },
    async close() {},
    async readFrames(startFrame, endFrame) {
      return samples?.slice(startFrame, endFrame) ?? new Float32Array(endFrame - startFrame);
    },
    async readFramesInto(startFrame, endFrame, target, targetOffset = 0) {
      if (samples === undefined) {
        target.fill(0, targetOffset, targetOffset + endFrame - startFrame);
      } else {
        target.set(samples.subarray(startFrame, endFrame), targetOffset);
      }
    },
  };
}

class EnergyVadModel implements VadInferenceModel {
  maxBatchWindows = 0;

  async infer(input: Float32Array, batchWindows: number): Promise<Float32Array> {
    this.maxBatchWindows = Math.max(this.maxBatchWindows, batchWindows);
    const output = new Float32Array(batchWindows * VAD_OUTPUT_FRAMES * VAD_CLASSES);
    for (let window = 0; window < batchWindows; window += 1) {
      for (let frame = 0; frame < VAD_OUTPUT_FRAMES; frame += 1) {
        const sample = Math.floor((frame * VAD_WINDOW_SAMPLES) / VAD_OUTPUT_FRAMES);
        const active = Math.abs(input[window * VAD_WINDOW_SAMPLES + sample] ?? 0) > 0.1;
        const offset = (window * VAD_OUTPUT_FRAMES + frame) * VAD_CLASSES;
        output[offset + (active ? 1 : 0)] = 1;
      }
    }
    return output;
  }
}

describe("VAD region rules", () => {
  it("保留长块之间的显著静音并应用 100ms padding", () => {
    expect(
      mergeSpeechBlocks(
        [
          { startMs: 1_000, endMs: 12_000, speakerTurn: 0 },
          { startMs: 15_000, endMs: 26_000, speakerTurn: 0 },
        ],
        30_000,
      ),
    ).toEqual([
      { startMs: 900, endMs: 12_100 },
      { startMs: 14_900, endMs: 26_100 },
    ]);
  });

  it("相邻说话人切换只使用 25ms padding", () => {
    expect(
      mergeSpeechBlocks(
        [
          { startMs: 1_000, endMs: 12_000, speakerTurn: 0 },
          { startMs: 12_100, endMs: 24_000, speakerTurn: 1 },
        ],
        24_000,
      ),
    ).toEqual([
      { startMs: 900, endMs: 12_025 },
      { startMs: 12_075, endMs: 24_000 },
    ]);
  });

  it("相邻 padding 相交时在中点交接且不重复 ASR 音频", () => {
    expect(
      mergeSpeechBlocks(
        [
          { startMs: 1_000, endMs: 12_000, speakerTurn: 0 },
          { startMs: 12_020, endMs: 24_000, speakerTurn: 1 },
        ],
        24_000,
      ),
    ).toEqual([
      { startMs: 900, endMs: 12_010 },
      { startMs: 12_010, endMs: 24_000 },
    ]);
  });
});

describe("VAD region chunking", () => {
  it("不把刚超过 60 秒的 region 切出模型无法处理的毫秒级尾块", () => {
    expect(splitSpeechRegions([{ startMs: 1_000, endMs: 61_041 }])).toEqual([
      { startMs: 1_000, endMs: 60_941 },
      { startMs: 60_941, endMs: 61_041 },
    ]);
  });

  it("把超长 speech region 守恒切成最多 60 秒的 ASR chunks", () => {
    const chunks = splitSpeechRegions([{ startMs: 1_000, endMs: 126_000 }]);
    expect(chunks).toEqual([
      { startMs: 1_000, endMs: 61_000 },
      { startMs: 61_000, endMs: 121_000 },
      { startMs: 121_000, endMs: 126_000 },
    ]);
    expect(chunks.every((chunk) => chunk.endMs - chunk.startMs <= 60_000)).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + chunk.endMs - chunk.startMs, 0)).toBe(125_000);
  });
});

describe("runBoundedVad", () => {
  it("合法静音返回空结果", async () => {
    const result = await runBoundedVad(virtualReader(30 * 16_000), new EnergyVadModel());
    expect(result.speechRegions).toEqual([]);
    expect(result.asrChunks).toEqual([]);
  });

  it("从合成双语音段生成排序且有界的 regions", async () => {
    const samples = new Float32Array(30 * 16_000);
    samples.fill(0.5, 1 * 16_000, 6 * 16_000);
    samples.fill(0.5, 14 * 16_000, 22 * 16_000);

    const result = await runBoundedVad(virtualReader(samples), new EnergyVadModel());

    expect(result.speechRegions).toHaveLength(2);
    expect(result.speechRegions[0]).toMatchObject({
      startMs: expect.closeTo(900, -2),
      endMs: expect.closeTo(6_100, -2),
    });
    expect(result.speechRegions[1]).toMatchObject({
      startMs: expect.closeTo(13_900, -2),
      endMs: expect.closeTo(22_100, -2),
    });
    expect(result.asrChunks).toEqual(result.speechRegions);
  });
});

describe("runBoundedVad bounds", () => {
  it("十分钟输入仍只保留一个固定 batch 和一个窗口跨度", async () => {
    const model = new EnergyVadModel();
    const result = await runBoundedVad(virtualReader(600 * 16_000), model);

    expect(result.metrics.windowCount).toBe(296);
    expect(result.metrics.maxBatchWindows).toBe(6);
    expect(result.metrics.maxBatchInputSamples).toBe(
      6 * VAD_WINDOW_SAMPLES,
    );
    expect(result.metrics.maxPendingFrames).toBeLessThanOrEqual(VAD_OUTPUT_FRAMES);
    expect(model.maxBatchWindows).toBe(6);
  });

  it.each([
    ["错误长度", () => new Float32Array(1)],
    ["非有限值", () => {
      const output = new Float32Array(VAD_OUTPUT_FRAMES * VAD_CLASSES);
      output[0] = Number.NaN;
      return output;
    }],
  ] as const)("拒绝模型的%s输出", async (_label, output) => {
    const model: VadInferenceModel = { async infer() { return output(); } };
    await expect(runBoundedVad(virtualReader(16_000), model)).rejects.toMatchObject({
      code: "MODEL_INFERENCE_FAILED",
    });
  });
});

describe("StreamingBoundedVad", () => {
  it("incremental advance plus final flush exactly matches the batch result", async () => {
    const samples = new Float32Array(30 * 16_000);
    samples.fill(0.5, 1 * 16_000, 6 * 16_000);
    samples.fill(0.5, 14 * 16_000, 22 * 16_000);
    const reader = virtualReader(samples);
    const streaming = new StreamingBoundedVad(reader, new EnergyVadModel());

    await streaming.advance(10 * 16_000);
    await streaming.advance(20 * 16_000);
    await streaming.advance(30 * 16_000, true);

    const reference = await runBoundedVad(reader, new EnergyVadModel());
    expect(streaming.snapshot(reader.metadata.durationMs)).toEqual({
      asrChunks: reference.asrChunks,
      speechRegions: reference.speechRegions,
    });
  });
});
