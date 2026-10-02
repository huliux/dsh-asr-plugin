import { describe, expect, it } from "vitest";

import type { Pcm16WavReader } from "../../src/audio/wav-reader.js";
import { FunAsrError } from "../../src/asr/funasr/errors.js";
import { splitSpeechRegions } from "../../src/asr/vad-regions.js";
import {
  runFunAsr,
  runFunAsrDraftWithLoadedRuntime,
  runFunAsrWithLoadedRuntime,
} from "../../src/asr/funasr/pipeline.js";
import type {
  FunAsrChunkDraft,
  FunAsrRuntimeFactory,
} from "../../src/asr/funasr/pipeline.js";

function virtualReader(durationMs: number): Pcm16WavReader & { maxReadFrames: number } {
  const frameCount = (durationMs * 16_000) / 1_000;
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
      return new Float32Array(endFrame - startFrame);
    },
    async readFramesInto(
      _startFrame: number,
      _endFrame: number,
      _target: Float32Array,
      _targetOffset = 0,
    ) {},
  };
  return reader;
}

function draft(text = "今天"): FunAsrChunkDraft {
  return {
    featureFrames: 2,
    frontendMs: 1,
    inferenceMs: 2,
    puncInput: text,
    rawText: text,
    timestampsMs: [[0, 100], [100, 200]],
    tokenCount: 2,
    tokens: ["今", "天"],
  };
}

function fakeFactory(
  events: string[],
  recognize: (call: number) => Promise<FunAsrChunkDraft> = async () => draft(),
): FunAsrRuntimeFactory {
  let calls = 0;
  return {
    async loadPunctuator() {
      events.push("load-punc");
      return {
        async close() { events.push("close-punc"); },
        async punctuate() {
          events.push("punc");
          return { inferenceMs: 1, punctuationIds: [1, 3], text: "今天。" };
        },
        punctuationList: ["<unk>", "_", "，", "。", "？", "、"],
      };
    },
    async loadRecognizer() {
      events.push("load-asr");
      return {
        async close() { events.push("close-asr"); },
        async recognize() {
          events.push("asr");
          calls += 1;
          return recognize(calls);
        },
      };
    },
  };
}

describe("runFunAsr", () => {
  it("processes base text without loading punctuation", async () => {
    const events: string[] = [];
    const result = await runFunAsr(
      virtualReader(5_000), [{ startMs: 0, endMs: 5_000 }], fakeFactory(events), "base",
    );
    expect(result.blocks).toEqual([{ seq: 0, startMs: 0, endMs: 200, text: "今天" }]);
    expect(result.metrics.punctuationInferenceMs).toBe(0);
    expect(events).toEqual(["load-asr", "asr", "close-asr"]);
  });


  it("shares bounded time and pause boundaries between base drafts and final blocks", async () => {
    const resultDraft = {
      ...draft(), tokens: ["今", "天", "开", "会", "结", "束"], tokenCount: 6,
      rawText: "今天开会结束", puncInput: "今天开会结束",
      timestampsMs: [[0, 100], [100, 8_000], [8_000, 8_100], [8_699, 8_800],
        [9_400, 9_500], [9_500, 9_600]] as const,
    };
    const runtime = {
      mode: "base" as const,
      recognizer: { async close() {}, async recognize() { return resultDraft; } },
    };
    const chunks = [{ startMs: 1_000, endMs: 11_000 }];
    const final = await runFunAsrWithLoadedRuntime(virtualReader(11_000), chunks, runtime);
    const provisional = await runFunAsrDraftWithLoadedRuntime(virtualReader(11_000), chunks, runtime);
    expect(final.blocks).toEqual([
      { seq: 0, startMs: 1_000, endMs: 9_000, text: "今天" },
      { seq: 1, startMs: 9_000, endMs: 9_800, text: "开会" },
      { seq: 2, startMs: 10_400, endMs: 10_600, text: "结束" },
    ]);
    expect(provisional.units.map((unit) => unit.breakAfter)).toEqual([
      false, true, false, true, false, true,
    ]);
    expect(provisional.units.map((unit) => unit.text)).toEqual(resultDraft.tokens);
    expect(final.metrics.punctuationInferenceMs).toBe(0);
    expect(provisional.metrics.punctuationInferenceMs).toBe(0);
  });

  it("bounds dense mixed-language base text and retains indivisible long tokens", async () => {
    const tokens = ["a".repeat(81), "hello", "world", ...Array.from({ length: 80 }, () => "中")];
    const timestampsMs = tokens.map((_, index) => [index * 10, index * 10 + 10] as const);
    const runtime = {
      mode: "base" as const,
      recognizer: { async close() {}, async recognize() {
        return { ...draft(), tokens, tokenCount: tokens.length, timestampsMs,
          rawText: tokens.join(""), puncInput: tokens.join(" ") };
      } },
    };
    const result = await runFunAsrWithLoadedRuntime(
      virtualReader(5_000), [{ startMs: 0, endMs: 5_000 }], runtime,
    );
    expect(result.blocks.map((block) => block.text)).toEqual([
      "a".repeat(81), `hello world ${"中".repeat(68)}`, "中".repeat(12),
    ]);
    expect(result.blocks.map((block) => [block.startMs, block.endMs])).toEqual([
      [0, 10], [10, 710], [710, 830],
    ]);
  });

  it("rejects missing timestamps in base finalization and drafts", async () => {
    const runtime = {
      mode: "base" as const,
      recognizer: { async close() {}, async recognize() {
        return { ...draft(), timestampsMs: null };
      } },
    };
    for (const run of [runFunAsrWithLoadedRuntime, runFunAsrDraftWithLoadedRuntime]) {
      await expect(run(virtualReader(5_000), [{ startMs: 0, endMs: 5_000 }], runtime))
        .rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    }
  });
  it("为录音草稿保留可按时间戳中点裁剪的 token 单元", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events);
    const runtime = {
      recognizer: await factory.loadRecognizer(),
      punctuator: await factory.loadPunctuator(),
    };

    const result = await runFunAsrDraftWithLoadedRuntime(
      virtualReader(5_000),
      [{ startMs: 0, endMs: 5_000 }],
      runtime,
    );

    expect(result.units).toEqual([
      { startMs: 0, endMs: 100, text: "今", breakAfter: false },
      { startMs: 100, endMs: 200, text: "天。", breakAfter: true },
    ]);
    expect(events).toEqual(["load-asr", "load-punc", "asr", "punc"]);
  });

  it("录音草稿拒绝缺少 token 时间戳的非空识别结果", async () => {
    const factory = fakeFactory([], async () => ({ ...draft(), timestampsMs: null }));
    const runtime = {
      recognizer: await factory.loadRecognizer(),
      punctuator: await factory.loadPunctuator(),
    };

    await expect(runFunAsrDraftWithLoadedRuntime(
      virtualReader(5_000),
      [{ startMs: 0, endMs: 5_000 }],
      runtime,
    )).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
  });

  it("复用已加载的 ASR/PUNC runtime 处理多个录音窗口且不擅自关闭", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events);
    const runtime = {
      recognizer: await factory.loadRecognizer(),
      punctuator: await factory.loadPunctuator(),
    };

    await runFunAsrWithLoadedRuntime(
      virtualReader(5_000),
      [{ startMs: 0, endMs: 5_000 }],
      runtime,
    );
    await runFunAsrWithLoadedRuntime(
      virtualReader(5_000),
      [{ startMs: 0, endMs: 5_000 }],
      runtime,
    );

    expect(events).toEqual(["load-asr", "load-punc", "asr", "punc", "asr", "punc"]);
  });

  it("对 120 秒输入顺序处理两个 60 秒 chunk，并在释放 ASR 后加载标点", async () => {
    const reader = virtualReader(120_000);
    const events: string[] = [];
    const chunks = splitSpeechRegions([{ startMs: 0, endMs: 120_000 }]);

    const result = await runFunAsr(reader, chunks, fakeFactory(events));

    expect(result.blocks).toEqual([
      { seq: 0, startMs: 0, endMs: 200, text: "今天。" },
      { seq: 1, startMs: 60_000, endMs: 60_200, text: "今天。" },
    ]);
    expect(result.emptyReason).toBeNull();
    expect(result.metrics).toMatchObject({ chunkCount: 2, featureFrames: 4, tokenCount: 4 });
    expect(reader.maxReadFrames).toBe(60 * 16_000);
    expect(events).toEqual([
      "load-asr", "asr", "asr", "close-asr",
      "load-punc", "punc", "punc", "close-punc",
    ]);
  });

  it("合法静音不加载任何模型", async () => {
    const events: string[] = [];
    const result = await runFunAsr(virtualReader(10_000), [], fakeFactory(events));
    expect(result).toMatchObject({ blocks: [], emptyReason: "silent" });
    expect(events).toEqual([]);
  });

  it("任一 chunk 识别失败时关闭 ASR 且不加载标点", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events, async (call) => {
      if (call === 2) throw new Error("boom");
      return draft();
    });

    await expect(
      runFunAsr(
        virtualReader(120_000),
        splitSpeechRegions([{ startMs: 0, endMs: 120_000 }]),
        factory,
      ),
    ).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    expect(events).toEqual(["load-asr", "asr", "asr", "close-asr"]);
  });

  it("不把底层 ONNX 失败误判为空 chunk，并保留原错误对象", async () => {
    const events: string[] = [];
    const failure = new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR ASR ONNX inference failed");
    const factory = fakeFactory(events, async () => { throw failure; });

    await expect(
      runFunAsr(virtualReader(10_000), [{ startMs: 0, endMs: 10_000 }], factory),
    ).rejects.toBe(failure);
    expect(events).toEqual(["load-asr", "asr", "close-asr"]);
  });

  it("跳过单个合法空识别 chunk，不把整场升级为失败", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events, async (call) => call === 3
      ? {
          ...draft(""),
          puncInput: "",
          rawText: "",
          timestampsMs: [],
          tokenCount: 0,
          tokens: [],
        }
      : draft());

    const result = await runFunAsr(
      virtualReader(180_000),
      splitSpeechRegions([{ startMs: 0, endMs: 180_000 }]),
      factory,
    );

    expect(result.blocks).toEqual([
      { seq: 0, startMs: 0, endMs: 200, text: "今天。" },
      { seq: 1, startMs: 60_000, endMs: 60_200, text: "今天。" },
    ]);
    expect(result.metrics).toMatchObject({ chunkCount: 3, featureFrames: 6, tokenCount: 4 });
    expect(events).toEqual([
      "load-asr", "asr", "asr", "asr", "close-asr",
      "load-punc", "punc", "punc", "close-punc",
    ]);
  });

  it("全部 speech chunk 均为空识别时返回 too_short，且不加载标点", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events, async () => ({
      ...draft(""),
      puncInput: "",
      rawText: "",
      timestampsMs: [],
      tokenCount: 0,
      tokens: [],
    }));

    const result = await runFunAsr(
      virtualReader(10_000),
      [{ startMs: 0, endMs: 10_000 }],
      factory,
    );

    expect(result).toMatchObject({
      blocks: [],
      emptyReason: "too_short",
      metrics: { chunkCount: 1, featureFrames: 2, tokenCount: 0 },
    });
    expect(events).toEqual(["load-asr", "asr", "close-asr"]);
  });

  it("零 token 草稿仍须满足空文本契约", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events, async () => ({
      ...draft("残留文本"),
      timestampsMs: [],
      tokenCount: 0,
      tokens: [],
    }));

    await expect(
      runFunAsr(virtualReader(10_000), [{ startMs: 0, endMs: 10_000 }], factory),
    ).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    expect(events).toEqual(["load-asr", "asr", "close-asr"]);
  });

  it("接受并钳制 40ms BiCIF 量化尾差", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events, async () => ({
      ...draft(),
      timestampsMs: [[0, 100], [100, 10_040]],
    }));

    const result = await runFunAsr(
      virtualReader(10_000),
      [{ startMs: 0, endMs: 10_000 }],
      factory,
    );
    expect(result.blocks[0]?.endMs).toBe(10_000);
    expect(events).toContain("load-punc");
  });

  it("在加载标点模型前拒绝超过 40ms 的 token 时间戳尾差", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events, async () => ({
      ...draft(),
      timestampsMs: [[0, 100], [100, 10_041]],
    }));

    await expect(
      runFunAsr(virtualReader(10_000), [{ startMs: 0, endMs: 10_000 }], factory),
    ).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    expect(events).toEqual(["load-asr", "asr", "close-asr"]);
  });

  it("标点失败时关闭标点模型并拒绝半份结果", async () => {
    const events: string[] = [];
    const factory = fakeFactory(events);
    factory.loadPunctuator = async () => {
      events.push("load-punc");
      return {
        async close() { events.push("close-punc"); },
        async punctuate() {
          events.push("punc");
          throw new Error("boom");
        },
        punctuationList: ["<unk>", "_", "，", "。", "？", "、"],
      };
    };

    await expect(
      runFunAsr(virtualReader(10_000), [{ startMs: 0, endMs: 10_000 }], factory),
    ).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    expect(events).toEqual([
      "load-asr", "asr", "close-asr", "load-punc", "punc", "close-punc",
    ]);
  });

  it("把未知模型加载异常映射为稳定错误码", async () => {
    const factory = fakeFactory([]);
    factory.loadRecognizer = async () => { throw new Error("private path"); };
    await expect(
      runFunAsr(virtualReader(10_000), [{ startMs: 0, endMs: 10_000 }], factory),
    ).rejects.toMatchObject({ code: "MODEL_LOAD_FAILED" });
  });

  it("拒绝越界或超过 60 秒的 chunk", async () => {
    const reader = virtualReader(120_000);
    const factory = fakeFactory([]);
    for (const chunk of [
      { startMs: -1, endMs: 1_000 },
      { startMs: 0, endMs: 60_001 },
      { startMs: 100_000, endMs: 120_001 },
    ]) {
      await expect(runFunAsr(reader, [chunk], factory)).rejects.toMatchObject({
        code: "MODEL_INFERENCE_FAILED",
      });
    }
  });
});
