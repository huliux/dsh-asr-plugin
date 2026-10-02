import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyAssets } from "../../src/assets/verify-assets.js";
import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import { loadSpeakerEmbeddingModel } from "../../src/diarization/embedding-model.js";
import { cosineDistance } from "../../src/diarization/vector.js";

const runFile = promisify(execFile);
const enabled = process.env.DSH_RUN_DIARIZATION_MODEL === "1";
const suite = describe.skipIf(!enabled);
let temporaryDirectory = "";
let assets: Readonly<Record<string, string>> = {};
const wavPaths: string[] = [];

async function synthesize(name: string, voice: string, text: string): Promise<void> {
  const aiffPath = join(temporaryDirectory, `${name}.aiff`);
  const wavPath = join(temporaryDirectory, `${name}.wav`);
  await runFile("/usr/bin/say", ["-v", voice, "-o", aiffPath, text]);
  await runFile("/usr/bin/afconvert", [
    aiffPath, "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", wavPath,
  ]);
  wavPaths.push(wavPath);
}

beforeAll(async () => {
  if (!enabled) return;
  temporaryDirectory = await mkdtemp(join(tmpdir(), "dsh-asr-speaker-model-"));
  await synthesize("same-a", "Tingting", "今天我们讨论项目进度和下一步工作。");
  await synthesize("same-b", "Tingting", "请确认方案以后我们继续完成测试。");
  await synthesize("different", "Meijia", "今天会议主要讨论产品计划和交付时间。");
  assets = await verifyAssets({
    assetRoot: resolve("data/assets"),
    manifestPath: resolve("src/assets/manifest.json"),
  });
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory !== "") {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

suite("speaker embedding ONNX model", () => {
  it("输出 finite 256 维单位向量，且同声线距离小于异声线", async () => {
    const model = await loadSpeakerEmbeddingModel({
      fbankPath: required("fbank-native"),
      modelPath: required("speaker-embedding-model"),
    });
    try {
      const embeddings = [];
      for (const wavPath of wavPaths) {
        const reader = await openPcm16Wav(wavPath);
        try {
          const output = await model.embed(await reader.readFrames(0, reader.metadata.frameCount));
          expect(output.embedding).toHaveLength(256);
          expect(output.embedding.every(Number.isFinite)).toBe(true);
          expect(Math.hypot(...output.embedding)).toBeCloseTo(1, 5);
          embeddings.push(output.embedding);
        } finally {
          await reader.close();
        }
      }
      const sameDistance = cosineDistance(embeddings[0]!, embeddings[1]!);
      const differentDistance = cosineDistance(embeddings[0]!, embeddings[2]!);
      expect(sameDistance).toBeLessThan(differentDistance);
    } finally {
      await model.close();
    }
  }, 120_000);
});

function required(id: string): string {
  const value = assets[id];
  if (value === undefined) throw new Error(`Required test asset is missing: ${id}`);
  return value;
}
