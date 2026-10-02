import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import type { Pcm16WavReader } from "../../src/audio/wav-reader.js";
import {
  createMeetingDiarizer,
} from "../../src/diarization/meeting-diarizer.js";
import type {
  SpeakerClusterer,
  SpeakerEmbeddingModel,
} from "../../src/diarization/meeting-diarizer.js";
import { writeSparseWave } from "../helpers/wav-fixture.js";

function virtualReader(durationMs: number): Pcm16WavReader & { maxReadFrames: number } {
  const frameCount = durationMs * 16;
  const reader = {
    maxReadFrames: 0,
    metadata: {
      bitDepth: 16 as const,
      channels: 1 as const,
      dataByteLength: frameCount * 2,
      dataOffset: 44,
      durationMs,
      frameCount,
      sampleRate: 16_000 as const,
    },
    async close() {},
    async readFrames(startFrame: number, endFrame: number) {
      reader.maxReadFrames = Math.max(reader.maxReadFrames, endFrame - startFrame);
      const voice = startFrame >= 4 * 16_000 ? 1 : 0;
      return new Float32Array(endFrame - startFrame).fill(voice);
    },
    async readFramesInto() {},
  };
  return reader;
}

function fakeEmbeddingModel(failedVoice?: number): SpeakerEmbeddingModel {
  return {
    async close() {},
    async embed(samples) {
      const voice = Math.round(samples[0] ?? 0);
      if (voice === failedVoice) throw new Error("boom");
      const embedding = new Float32Array(256);
      embedding[voice] = 1;
      return { embedding, fbankMs: 1, inferenceMs: 2 };
    },
  };
}

function scriptedEmbeddingModel(voices: readonly number[]): SpeakerEmbeddingModel {
  let callIndex = 0;
  return {
    async close() {},
    async embed() {
      const voice = voices[callIndex++];
      if (voice === undefined) throw new Error("Missing scripted embedding");
      const embedding = new Float32Array(256);
      embedding[voice] = 1;
      return { embedding, fbankMs: 1, inferenceMs: 2 };
    },
  };
}

function fixedClusterer(
  groups: readonly (readonly number[])[],
  heights: number[] = [],
): SpeakerClusterer {
  return {
    cluster(_embeddings, options) {
      heights.push(options.height);
      return groups;
    },
  };
}

function sizedGroups(sizes: readonly number[]): number[][] {
  const groups: number[][] = [];
  let next = 0;
  for (const size of sizes) {
    groups.push(Array.from({ length: size }, () => next++));
  }
  return groups;
}

function sequentialBlocks(count: number): Array<{
  endMs: number;
  seq: number;
  startMs: number;
  text: string;
}> {
  return Array.from({ length: count }, (_, seq) => ({
    endMs: (seq + 1) * 1_000,
    seq,
    startMs: seq * 1_000,
    text: `句子${seq}`,
  }));
}

const fakeClusterer: SpeakerClusterer = {
  cluster(embeddings) {
    const groups = new Map<number, number[]>();
    embeddings.forEach((embedding, index) => {
      const voice = embedding[1] === 1 ? 1 : 0;
      groups.set(voice, [...(groups.get(voice) ?? []), index]);
    });
    return [...groups.values()];
  },
};

describe("MeetingDiarizer interface", () => {
  it("逐项守恒 ASR blocks，并按首次出现顺序只新增匿名标签", async () => {
    const reader = virtualReader(10_000);
    const diarizer = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: fakeEmbeddingModel(),
    });
    const blocks = [
      { seq: 0, startMs: 0, endMs: 2_000, text: "甲" },
      { seq: 1, startMs: 2_000, endMs: 4_000, text: "乙" },
      { seq: 2, startMs: 4_000, endMs: 6_000, text: "丙" },
      { seq: 3, startMs: 6_000, endMs: 8_000, text: "丁" },
    ];

    const result = await diarizer.diarize(reader, blocks, [
      { startMs: 0, endMs: 8_000 },
    ]);

    expect(result.segments).toEqual([
      { ...blocks[0], speakerLabel: "Speaker A" },
      { ...blocks[1], speakerLabel: "Speaker A" },
      { ...blocks[2], speakerLabel: "Speaker B" },
      { ...blocks[3], speakerLabel: "Speaker B" },
    ]);
    expect(result).toMatchObject({
      resultReason: null,
      resultStatus: "completed",
      speakerCount: 2,
    });
    await diarizer.close();
  });

  it("对无法可靠提取且没有近邻的 block 显式返回 UNKNOWN", async () => {
    const reader = virtualReader(20_000);
    const diarizer = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: fakeEmbeddingModel(),
    });
    const blocks = [
      { seq: 0, startMs: 0, endMs: 2_000, text: "有效" },
      { seq: 1, startMs: 15_000, endMs: 15_050, text: "太短" },
    ];

    const result = await diarizer.diarize(reader, blocks, [
      { startMs: 0, endMs: 2_000 },
      { startMs: 15_000, endMs: 15_050 },
    ]);

    expect(result.segments).toEqual([
      { ...blocks[0], speakerLabel: "Speaker A" },
      { ...blocks[1], speakerLabel: "UNKNOWN" },
    ]);
    expect(result).toMatchObject({
      resultReason: "unknown_speaker_segments",
      resultStatus: "partial",
      warnings: [{ code: "BLOCK_TOO_SHORT", seq: 1 }],
    });
    await diarizer.close();
  });

  it("长 block 只读取通过 VAD gate 的 6 秒窗口", async () => {
    const reader = virtualReader(12_000);
    const diarizer = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: fakeEmbeddingModel(),
    });

    const result = await diarizer.diarize(
      reader,
      [{ seq: 0, startMs: 0, endMs: 12_000, text: "长句" }],
      [{ startMs: 3_500, endMs: 4_500 }],
    );

    expect(result.metrics.embeddingWindowCount).toBe(2);
    expect(reader.maxReadFrames).toBe(6 * 16_000);
    await diarizer.close();
  });

  it("将向上取整毫秒映射的尾帧钳制到真实 WAV frameCount", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-asr-diarization-tail-"));
    const filePath = join(directory, "audio.wav");
    await writeSparseWave(filePath, 16_011);
    const reader = await openPcm16Wav(filePath);
    const diarizer = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: fakeEmbeddingModel(),
    });

    try {
      expect(reader.metadata).toMatchObject({ durationMs: 1_001, frameCount: 16_011 });
      const result = await diarizer.diarize(
        reader,
        [{ seq: 0, startMs: 0, endMs: 1_001, text: "尾帧" }],
        [{ startMs: 0, endMs: 1_001 }],
      );
      expect(result).toMatchObject({ resultStatus: "completed", speakerCount: 1 });
      expect(result.metrics.embeddingWindowCount).toBe(1);
    } finally {
      await diarizer.close();
      await reader.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("拒绝越界 block，且全量 embedding 故障不伪装成 partial", async () => {
    const reader = virtualReader(10_000);
    const invalid = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: fakeEmbeddingModel(),
    });
    await expect(invalid.diarize(
      reader,
      [{ seq: 0, startMs: 0, endMs: 10_001, text: "越界" }],
      [],
    )).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await invalid.close();

    const failed = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: fakeEmbeddingModel(0),
    });
    await expect(failed.diarize(
      reader,
      [{ seq: 0, startMs: 0, endMs: 2_000, text: "失败" }],
      [{ startMs: 0, endMs: 2_000 }],
    )).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    await failed.close();
  });

  it("使用 height=1，并保留短会议中达到 FunASR 放宽门的四个主簇", async () => {
    const sizes = [25, 8, 5, 5, ...Array.from({ length: 24 }, () => 1)];
    const voices = sizes.flatMap((size, voice) => Array.from({ length: size }, () => voice));
    const heights: number[] = [];
    const blocks = sequentialBlocks(voices.length);
    const diarizer = createMeetingDiarizer({
      clusterer: fixedClusterer(sizedGroups(sizes), heights),
      embeddingModel: scriptedEmbeddingModel(voices),
    });

    const result = await diarizer.diarize(
      virtualReader(blocks.length * 1_000), blocks, [{ startMs: 0, endMs: blocks.length * 1_000 }],
    );

    expect(heights).toEqual([1]);
    expect(result.speakerCount).toBe(4);
    await diarizer.close();
  });

  it("长会议不把低于 2% 证据门的声学碎片创建为说话人", async () => {
    const sizes = [200, 200, 200, 13, ...Array.from({ length: 38 }, () => 1)];
    const voices = sizes.flatMap((size, voice) =>
      Array.from({ length: size }, () => Math.min(voice, 4)));
    const blocks = sequentialBlocks(voices.length);
    const diarizer = createMeetingDiarizer({
      clusterer: fixedClusterer(sizedGroups(sizes)),
      embeddingModel: scriptedEmbeddingModel(voices),
    });

    const result = await diarizer.diarize(
      virtualReader(blocks.length * 1_000), blocks, [{ startMs: 0, endMs: blocks.length * 1_000 }],
    );

    expect(result.speakerCount).toBe(3);
    expect(result.metrics.unknownBlockCount).toBeGreaterThan(0);
    await diarizer.close();
  });

  it("使用 0.7 置信门分配非聚类参考 block", async () => {
    const near = new Float32Array(256);
    near[0] = 0.31;
    near[1] = Math.sqrt(1 - 0.31 ** 2);
    let callIndex = 0;
    const model: SpeakerEmbeddingModel = {
      async close() {},
      async embed() {
        const embedding = callIndex++ === 0
          ? Float32Array.from({ length: 256 }, (_, index) => Number(index === 0))
          : near;
        return { embedding, fbankMs: 1, inferenceMs: 2 };
      },
    };
    const blocks = [
      { seq: 0, startMs: 0, endMs: 1_000, text: "参考" },
      { seq: 1, startMs: 9_000, endMs: 9_500, text: "待分配" },
    ];
    const diarizer = createMeetingDiarizer({ clusterer: fakeClusterer, embeddingModel: model });

    const result = await diarizer.diarize(virtualReader(10_000), blocks, []);

    expect(result.segments[1]?.speakerLabel).toBe("Speaker A");
    await diarizer.close();
  });

  it("多个等距近邻标签不一致时不做时间回填", async () => {
    const blocks = [
      { seq: 0, startMs: 0, endMs: 3_000, text: "甲一" },
      { seq: 1, startMs: 1_000, endMs: 3_000, text: "甲二" },
      { seq: 2, startMs: 2_000, endMs: 2_050, text: "待定" },
      { seq: 3, startMs: 2_000, endMs: 3_000, text: "乙" },
    ];
    const diarizer = createMeetingDiarizer({
      clusterer: fakeClusterer,
      embeddingModel: scriptedEmbeddingModel([0, 0, 1]),
    });

    const result = await diarizer.diarize(virtualReader(4_000), blocks, []);

    expect(result.segments[2]?.speakerLabel).toBe("UNKNOWN");
    await diarizer.close();
  });
});
