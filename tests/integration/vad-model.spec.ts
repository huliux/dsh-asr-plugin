import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import { verifyAssets } from "../../src/assets/verify-assets.js";
import { runBoundedVad } from "../../src/asr/bounded-vad.js";
import { loadVadModel } from "../../src/asr/vad-model.js";
import { createWave } from "../helpers/wav-fixture.js";

let temporaryDirectory: string;
let modelPath: string;

describe.skipIf(process.env.DSH_RUN_VAD_MODEL !== "1")("VAD ONNX model", () => {
  beforeAll(async () => {
    const assets = await verifyAssets({ assetRoot: resolve("data/assets"),
      manifestPath: resolve("src/assets/manifest.json") });
    if (assets["vad-model"] === undefined) throw new Error("VAD model is missing from the manifest");
    modelPath = assets["vad-model"];
    temporaryDirectory = await mkdtemp(join(tmpdir(), "dsh-asr-vad-model-"));
  });
  afterAll(async () => {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it("通过正式 adapter 对规范静音 WAV 执行有界推理", async () => {
    const filePath = join(temporaryDirectory, "silence.wav");
    await writeFile(filePath, createWave(new Int16Array(12 * 16_000)));
    const reader = await openPcm16Wav(filePath);
    const model = await loadVadModel(modelPath);
    try {
      const result = await runBoundedVad(reader, model);
      expect(result.speechRegions).toEqual([]);
      expect(result.metrics).toMatchObject({
        batchCount: 1,
        maxBatchWindows: 2,
        windowCount: 2,
      });
    } finally {
      await reader.close();
      await model.close();
    }
  });
});
