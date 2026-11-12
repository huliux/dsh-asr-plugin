import { describe, expect, it } from "vitest";

import { createProcessingIdentity } from "../../src/assets/processing-identity.js";
import type { AsrEngine, ProcessingMode } from "../../src/assets/processing-identity.js";
import type { AssetManifest, AssetRecord } from "../../src/assets/verify-assets.js";
import { parseProcessingLaunch } from "../../src/worker/processing-launch.js";

const SHA = "a".repeat(64);

function asset(id: string, kind: AssetRecord["kind"], relativePath: string): AssetRecord {
  return { byteLength: 1, id, kind, relativePath, sha256: SHA };
}

const manifest: AssetManifest = {
  assets: [
    asset("vad-model", "model", "models/vad/model.onnx"),
    asset("speaker-embedding-model", "model", "models/speaker/embedding.onnx"),
    asset("asr-model", "model", "models/asr/model_quant.onnx"),
    asset("punc-model", "model", "models/punc/model.onnx"),
    asset("parakeet-encoder", "model", "models/parakeet/encoder.int8.onnx"),
    asset("parakeet-tokens", "tokens", "models/parakeet/tokens.txt"),
    asset("fbank-native", "native", "native/darwin-arm64/fbank.node"),
  ],
} as AssetManifest;

function launch(mode: ProcessingMode, engine: AsrEngine, punctuationRoot: unknown): string {
  return JSON.stringify({
    identity: createProcessingIdentity(manifest, "b".repeat(64), mode, engine),
    punctuationRoot,
  });
}

function rejectionReason(input: string): unknown {
  try {
    parseProcessingLaunch(input);
  } catch (error) {
    return error;
  }
  throw new Error("expected the processing launch to be rejected");
}

describe("Worker processing launch", () => {
  it("accepts a self-punctuating engine without a punctuation root", () => {
    const parsed = parseProcessingLaunch(launch("enhanced", "parakeet", null));
    expect(parsed.identity.engine).toBe("parakeet");
    expect(parsed.identity.mode).toBe("enhanced");
    expect(parsed.identity.punctuationModelFingerprint).toBeNull();
    expect(parsed.punctuationRoot).toBeNull();
  });

  it("accepts a punctuated engine with its punctuation root", () => {
    const parsed = parseProcessingLaunch(launch("enhanced", "paraformer", "/data/assets/punctuation"));
    expect(parsed.identity.engine).toBe("paraformer");
    expect(parsed.punctuationRoot).toBe("/data/assets/punctuation");
  });

  it("accepts base mode without a punctuation root", () => {
    expect(parseProcessingLaunch(launch("base", "paraformer", null)).punctuationRoot).toBeNull();
  });

  it.each([
    ["a punctuated engine without a punctuation root", launch("enhanced", "paraformer", null)],
    ["a self-punctuating engine with a punctuation root", launch("enhanced", "parakeet", "/data/punc")],
    ["base mode with a punctuation root", launch("base", "paraformer", "/data/punc")],
    ["a relative punctuation root", launch("enhanced", "paraformer", "data/punc")],
    ["an oversized punctuation root", launch("enhanced", "paraformer", `/${"x".repeat(4_096)}`)],
    ["malformed JSON", "{"],
  ])("rejects %s", (_label, input) => {
    expect(rejectionReason(input)).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Worker processing launch is invalid",
    });
  });
});
