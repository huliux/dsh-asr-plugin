import { describe, expect, it } from "vitest";

import {
  parseFunAsrCmvn,
  parseFunAsrFrontendConfig,
  parseFunAsrPunctuationConfig,
  parseTokenList,
} from "../../src/asr/funasr/config.js";

const FRONTEND_CONFIG = `
model_conf:
  predictor_bias: 1
frontend_conf:
  fs: 16000
  window: hamming
  n_mels: 80
  frame_length: 25
  frame_shift: 10
  lfr_m: 7
  lfr_n: 6
`;

const PUNCTUATION_CONFIG = `
model_conf:
  punc_list:
    - <unk>
    - _
    - ，
    - 。
    - ？
    - 、
  sentence_end_id: 3
`;

describe("FunASR frozen assets", () => {
  it("只接受 P0 已冻结的 frontend 参数", () => {
    expect(parseFunAsrFrontendConfig(FRONTEND_CONFIG)).toEqual({
      frameLengthMs: 25,
      frameShiftMs: 10,
      inputSize: 560,
      lfrM: 7,
      lfrN: 6,
      numMels: 80,
      predictorBias: 1,
      sampleRate: 16_000,
      window: "hamming",
    });
    expect(() => parseFunAsrFrontendConfig(FRONTEND_CONFIG.replace("16000", "8000")))
      .toThrow(expect.objectContaining({ code: "ASSET_MISMATCH" }));
  });

  it("只接受固定标点表与句末 ID", () => {
    expect(parseFunAsrPunctuationConfig(PUNCTUATION_CONFIG)).toEqual({
      punctuationList: ["<unk>", "_", "，", "。", "？", "、"],
      sentenceEndId: 3,
    });
    expect(() => parseFunAsrPunctuationConfig(PUNCTUATION_CONFIG.replace("sentence_end_id: 3", "sentence_end_id: 2")))
      .toThrow(expect.objectContaining({ code: "ASSET_MISMATCH" }));
  });

  it("严格解析 560 维有限 CMVN", () => {
    const shifts = Array.from({ length: 560 }, (_, index) => String(-index / 10)).join(" ");
    const scales = Array.from({ length: 560 }, (_, index) => String(1 + index / 1_000)).join(" ");
    const cmvn = parseFunAsrCmvn(
      `<AddShift> 560 560\n<LearnRateCoef> 0 [ ${shifts} ]\n` +
      `<Rescale> 560 560\n<LearnRateCoef> 0 [ ${scales} ]`,
    );
    expect(cmvn.addShift).toHaveLength(560);
    expect(cmvn.rescale[559]).toBeCloseTo(1.559);
    expect(() => parseFunAsrCmvn("<AddShift> malformed"))
      .toThrow(expect.objectContaining({ code: "ASSET_MISMATCH" }));
  });

  it("拒绝重复、空值或非 unk 结尾的 token 表", () => {
    expect(parseTokenList('["<blank>","你","<unk>"]')).toEqual([
      "<blank>", "你", "<unk>",
    ]);
    for (const raw of ['["a","a","<unk>"]', '["a",""]', '{}']) {
      expect(() => parseTokenList(raw)).toThrow(
        expect.objectContaining({ code: "ASSET_MISMATCH" }),
      );
    }
  });
});
