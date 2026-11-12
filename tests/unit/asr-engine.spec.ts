import { expect, it } from "vitest";

import { createProcessingIdentity, parseProcessingIdentity } from "../../src/assets/processing-identity.js";
import {
  modelPackAssets, modelPackFingerprint, modelSetFingerprint, parseModelPackManifest,
} from "../../src/assets/model-pack.js";
import { parakeetChunkText } from "../../src/asr/parakeet/text.js";
import type { AssetManifest, AssetRecord } from "../../src/assets/verify-assets.js";

const SHA = "a".repeat(64);

function asset(id: string, kind: AssetRecord["kind"], relativePath: string): AssetRecord {
  return { byteLength: 1, id, kind, relativePath, sha256: SHA };
}

const manifest: AssetManifest = {
  assets: [
    asset("vad-model", "model", "models/vad/model.onnx"),
    asset("speaker-embedding-model", "model", "models/speaker/embedding.onnx"),
    asset("asr-config", "config", "models/asr/config.yaml"),
    asset("asr-model", "model", "models/asr/model_quant.onnx"),
    asset("asr-tokens", "tokens", "models/asr/tokens.json"),
    asset("punc-model", "model", "models/punc/model.onnx"),
    asset("parakeet-encoder", "model", "models/parakeet/encoder.int8.onnx"),
    asset("parakeet-tokens", "tokens", "models/parakeet/tokens.txt"),
    asset("fbank-native", "native", "native/darwin-arm64/fbank.node"),
  ],
} as AssetManifest;

it("选包时把 parakeet 资产与共享资产归为一组，且不混入 Paraformer 资产", () => {
  const ids = (pack?: Parameters<typeof modelPackAssets>[1]) =>
    modelPackAssets(manifest, pack).map(({ id }) => id).sort();

  expect(ids("parakeet")).toEqual(["parakeet-encoder", "parakeet-tokens", "speaker-embedding-model", "vad-model"]);
  expect(ids("base")).toEqual(["asr-config", "asr-model", "asr-tokens", "speaker-embedding-model", "vad-model"]);
  expect(ids("punctuation")).toEqual(["punc-model"]);
  expect(ids()).toHaveLength(8);
  expect(modelPackFingerprint(manifest, "parakeet")).not.toBe(modelPackFingerprint(manifest, "base"));
  expect(modelSetFingerprint(manifest)).toBe(modelSetFingerprint(manifest));
});

it("身份哈希区分识别引擎，并允许 Parakeet 在增强模式没有标点包", () => {
  const paraformer = createProcessingIdentity(manifest, "fingerprint", "enhanced", "paraformer");
  const parakeet = createProcessingIdentity(manifest, "fingerprint", "enhanced", "parakeet");

  expect(paraformer.engine).toBe("paraformer");
  expect(parakeet.engine).toBe("parakeet");
  expect(paraformer.punctuationModelFingerprint).toBe(modelPackFingerprint(manifest, "punctuation"));
  expect(parakeet.punctuationModelFingerprint).toBeNull();
  expect(parakeet.baseModelFingerprint).toBe(modelPackFingerprint(manifest, "parakeet"));
  expect(parakeet.engineFingerprint).not.toBe(paraformer.engineFingerprint);
  expect(parseProcessingIdentity(parakeet)).toEqual(parakeet);
});

it("读取历史身份记录时默认回退到 Paraformer", () => {
  const legacy = {
    mode: "base",
    baseModelFingerprint: modelPackFingerprint(manifest, "base"),
    punctuationModelFingerprint: null,
    compatibilityFingerprint: modelSetFingerprint(manifest),
    engineFingerprint: "b".repeat(64),
  };
  expect(parseProcessingIdentity(legacy)).toEqual({ ...legacy, engine: "paraformer" });
});

it("把 Parakeet 词级结果映射成共享的块与时间戳结构", () => {
  const span = {
    tokens: [" Ask", " not", " what", " your", " country", " can", " do", " for", " you", ",", " ask"],
    timestamps: [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0],
  };
  const text = parakeetChunkText(span, 3_000);

  expect(text.words).toEqual(["Ask", "not", "what", "your", "country", "can", "do", "for", "you", "ask"]);
  expect(text.tokens).toHaveLength(10);
  expect(text.rawText).toBe("Ask not what your country can do for you ask");
  expect(text.puncInput).toBe("Ask not what your country can do for you ask");
  expect(text.punctuation.list[0]).toBe("_");
  expect(text.punctuation.list[1]).toBe("_");
  expect(text.punctuation.ids).toHaveLength(10);
  // The comma rides on "you", so that word carries the separator mark.
  expect(text.punctuation.list[text.punctuation.ids[8]!]).toBe(",");
  expect(text.punctuation.ids[0]).toBe(0);
  expect(text.timestampsMs[0]).toEqual([0, 200]);
  for (const [index, [start, end]] of text.timestampsMs.entries()) {
    expect(start).toBeLessThan(end);
    if (index > 0) expect(start).toBeGreaterThanOrEqual(text.timestampsMs[index - 1]![1]);
  }
});

it("拒绝不对齐的 Parakeet token 流", () => {
  expect(() => parakeetChunkText({ tokens: [" a", " b"], timestamps: [0] }, 1_000))
    .toThrow(/timestamps do not align/);
});

it("accepts a parakeet model pack manifest", () => {
  const contents = {
    schemaVersion: 2 as const,
    packKind: "parakeet" as const,
    modelSetFingerprint: modelPackFingerprint(manifest, "parakeet"),
    compatibilityFingerprint: modelSetFingerprint(manifest),
    assets: modelPackAssets(manifest, "parakeet").map(({ id, kind, relativePath }) => ({
      id, kind, relativePath, byteLength: 1, sha256: SHA,
    })),
    materials: [
      { relativePath: "LICENSE", byteLength: 1, sha256: SHA },
      { relativePath: "THIRD_PARTY_NOTICES.md", byteLength: 1, sha256: SHA },
    ],
  };
  const parsed = parseModelPackManifest(Buffer.from(JSON.stringify(contents)), manifest);
  expect(parsed.schemaVersion).toBe(2);
  if (parsed.schemaVersion !== 2) throw new Error("expected schemaVersion 2");
  expect(parsed.packKind).toBe("parakeet");
});
