import { describe, expect, it } from "vitest";

import { applyCmvn, applyLfr } from "../../src/asr/funasr/frontend.js";
import {
  TokenIdConverter,
  buildSentenceBlocks,
  codeMixSplitWords,
  sentencePostprocess,
  sentencePostprocessWithTimestamps,
  splitToMiniSentences,
} from "../../src/asr/funasr/text.js";
import { decodeBiCifTokenTimestamps } from "../../src/asr/funasr/timestamps.js";

describe("FunASR frontend", () => {
  it("按左侧 padding 与 stride 应用 LFR", () => {
    const input = new Float32Array([1, 10, 2, 20, 3, 30, 4, 40]);
    const lfr = applyLfr(input, 4, 2, 3, 2);

    expect(lfr.frames).toBe(2);
    expect([...lfr.data]).toEqual([
      1, 10, 1, 10, 2, 20,
      2, 20, 3, 30, 4, 40,
    ]);
  });

  it("逐维应用 CMVN 且拒绝维度不足", () => {
    expect(
      [...applyCmvn(
        new Float32Array([1, 2, 3, 4]),
        2,
        2,
        {
          addShift: new Float32Array([-1, -2]),
          rescale: new Float32Array([2, 0.5]),
        },
      )],
    ).toEqual([0, 0, 4, 1]);
    expect(() =>
      applyCmvn(new Float32Array([1, 2]), 1, 2, {
        addShift: new Float32Array(1),
        rescale: new Float32Array(1),
      }),
    ).toThrow(expect.objectContaining({ code: "ASSET_MISMATCH" }));
  });
});

describe("FunASR text postprocessing", () => {
  it("处理中英混合 token 与缩写", () => {
    expect(sentencePostprocess(["你", "好", "open@@", "ai"])).toEqual({
      sentence: "你好openai",
      tokens: ["你", "好", "openai"],
    });
    const timestamped = sentencePostprocessWithTimestamps(
      ["你", "好", "u", "s", "a"],
      [[0, 100], [100, 200], [200, 300], [300, 400], [400, 500]],
    );
    expect(timestamped.tokens).toEqual(["你", "好", "U", "S", "A"]);
    expect(timestamped.timestamps).toHaveLength(timestamped.tokens.length);
  });

  it("合并英文 BPE token 时同步合并时间戳", () => {
    expect(
      sentencePostprocessWithTimestamps(
        ["open@@", "ai"],
        [[0, 100], [100, 300]],
      ),
    ).toEqual({
      sentence: "openai",
      timestamps: [[0, 300]],
      tokens: ["openai"],
    });
  });

  it("中文边界前先提交英文 BPE 片段并保持时间单调", () => {
    expect(sentencePostprocess(["open@@", "中", "ai"])).toEqual({
      sentence: "open中ai",
      tokens: ["open", "中", "ai"],
    });
    expect(
      sentencePostprocessWithTimestamps(
        ["open@@", "中", "ai"],
        [[0, 100], [100, 200], [200, 300]],
      ),
    ).toEqual({
      sentence: "open 中 ai",
      timestamps: [[0, 100], [100, 200], [200, 300]],
      tokens: ["open", "中", "ai"],
    });
  });
});

describe("FunASR text helpers and timestamps", () => {
  it("拆分标点输入与固定长度 mini sentences", () => {
    expect(codeMixSplitWords("今天 openai 发布 GPT")).toEqual([
      "今", "天", "openai", "发", "布", "GPT",
    ]);
    expect(splitToMiniSentences([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2], [3, 4], [5],
    ]);
  });

  it("未知 token 稳定映射到末尾 unk", () => {
    const converter = new TokenIdConverter(["<blank>", "你", "<unk>"]);
    expect(converter.tokensToIds(["你", "missing"])).toEqual([1, 2]);
    expect(converter.idsToTokens([1, 99])).toEqual(["你", "<unk>"]);
  });

  it("解码 BiCIF 时间戳并保持 token 单调", () => {
    const result = decodeBiCifTokenTimestamps(
      ["今", "天"],
      Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
      null,
      { totalOffset: 0 },
    );

    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBeGreaterThanOrEqual(0);
    expect(result[0]![1]).toBeGreaterThan(result[0]![0]);
    expect(result[1]![0]).toBeGreaterThanOrEqual(result[0]![1]);
  });

  it("按标点生成带 chunk 偏移的句级 blocks", () => {
    expect(
      buildSentenceBlocks(
        ["今", "天", "开", "会"],
        [[0, 100], [100, 200], [300, 400], [400, 500]],
        [1, 3, 1, 3],
        ["<unk>", "_", "，", "。", "？", "、"],
        1_000,
        2_000,
      ),
    ).toEqual([
      { startMs: 1_000, endMs: 1_200, text: "今天。" },
      { startMs: 1_300, endMs: 1_500, text: "开会。" },
    ]);
  });
});
