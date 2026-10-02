import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyAssets } from "../../src/assets/verify-assets.js";
import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import { createFunAsrRuntimeFactory } from "../../src/asr/funasr/factory.js";
import { runFunAsr } from "../../src/asr/funasr/pipeline.js";
import { splitSpeechRegions } from "../../src/asr/vad-regions.js";
import { createWave } from "../helpers/wav-fixture.js";

const runFile = promisify(execFile);
const enabled = process.env.DSH_RUN_FUNASR_MODEL === "1";
const suite = describe.skipIf(!enabled);
let temporaryDirectory = "";
let shortWavPath = "";
let shortTailWavPath = "";
let verifiedAssets: Readonly<Record<string, string>> = {};
let wavPath = "";

beforeAll(async () => {
  if (!enabled) return;
  temporaryDirectory = await mkdtemp(join(tmpdir(), "dsh-asr-funasr-"));
  const aiffPath = join(temporaryDirectory, "speech.aiff");
  shortWavPath = join(temporaryDirectory, "short.wav");
  shortTailWavPath = join(temporaryDirectory, "short-tail.wav");
  wavPath = join(temporaryDirectory, "speech.wav");
  await writeFile(shortWavPath, createWave(new Int16Array(160)));
  await writeFile(shortTailWavPath, createWave(new Int16Array(60_041 * 16)));
  await runFile("/usr/bin/say", [
    "-v", "Tingting", "-o", aiffPath,
    "今天我们讨论项目进度，确认下一步工作。",
  ]);
  await runFile("/usr/bin/afconvert", [
    aiffPath, "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", wavPath,
  ]);
  verifiedAssets = await verifyAssets({
    assetRoot: resolve("data/assets"),
    manifestPath: resolve("src/assets/manifest.json"),
  });
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory !== "") {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

suite("FunASR real models", () => {
  it("以顺序模型生命周期转写规范中文语音", async () => {
    const reader = await openPcm16Wav(wavPath);
    try {
      const result = await runFunAsr(
        reader,
        [{ startMs: 0, endMs: reader.metadata.durationMs }],
        factoryFrom(verifiedAssets),
      );
      expect(result.blocks.length).toBeGreaterThan(0);
      const transcript = result.blocks.map((block) => block.text).join("");
      expect(transcript).toContain("今天");
      expect(transcript).toContain("项目");
      expect(result.metrics.tokenCount).toBeGreaterThan(0);
      let previousEnd = 0;
      for (const [index, block] of result.blocks.entries()) {
        expect(block.seq).toBe(index);
        expect(block.startMs).toBeGreaterThanOrEqual(0);
        expect(block.startMs).toBeGreaterThanOrEqual(previousEnd);
        expect(block.endMs).toBeGreaterThan(block.startMs);
        expect(block.endMs).toBeLessThanOrEqual(reader.metadata.durationMs);
        previousEnd = block.endMs;
      }
    } finally {
      await reader.close();
    }
  }, 120_000);

  it("将不足一个 frontend 帧的输入收敛为整次失败", async () => {
    const reader = await openPcm16Wav(shortWavPath);
    try {
      await expect(runFunAsr(
        reader,
        [{ startMs: 0, endMs: reader.metadata.durationMs }],
        factoryFrom(verifiedAssets),
      )).rejects.toMatchObject({ code: "MODEL_INFERENCE_FAILED" });
    } finally {
      await reader.close();
    }
  }, 120_000);

  it("刚超过 60 秒的 region 不产生会击穿 ONNX 的毫秒级尾块", async () => {
    const reader = await openPcm16Wav(shortTailWavPath);
    try {
      const result = await runFunAsr(
        reader,
        splitSpeechRegions([{ startMs: 0, endMs: reader.metadata.durationMs }]),
        factoryFrom(verifiedAssets),
      );
      expect(result.metrics.chunkCount).toBe(2);
    } finally {
      await reader.close();
    }
  }, 120_000);
});

function required(assets: Readonly<Record<string, string>>, id: string): string {
  const value = assets[id];
  if (value === undefined) throw new Error(`Required test asset is missing: ${id}`);
  return value;
}

function factoryFrom(assets: Readonly<Record<string, string>>) {
  return createFunAsrRuntimeFactory({
    asrCmvnPath: required(assets, "asr-cmvn"),
    asrConfigPath: required(assets, "asr-config"),
    asrModelPath: required(assets, "asr-model"),
    asrTokensPath: required(assets, "asr-tokens"),
    fbankPath: required(assets, "fbank-native"),
    punctuationConfigPath: required(assets, "punc-config"),
    punctuationModelPath: required(assets, "punc-model"),
    punctuationTokensPath: required(assets, "punc-tokens"),
  });
}
