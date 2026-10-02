import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { verifyAssets } from "../dist/assets/verify-assets.js";
import { createFunAsrRuntimeFactory } from "../dist/asr/funasr/factory.js";
import { runFunAsr } from "../dist/asr/funasr/pipeline.js";
import { splitSpeechRegions } from "../dist/asr/vad-regions.js";
import { openPcm16Wav } from "../dist/audio/wav-reader.js";

function required(assets, id) {
  const value = assets[id];
  if (value === undefined) throw new Error("ASSET_MISSING");
  return value;
}

function runtimeFactory(assets) {
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

async function runProbe(inputPath, requestedDurationMs) {
  const assets = await verifyAssets({
    assetRoot: resolve("data/assets"),
    manifestPath: resolve("dist/assets/manifest.json"),
  });
  const reader = await openPcm16Wav(resolve(inputPath));
  try {
    const durationMs = Math.min(requestedDurationMs, reader.metadata.durationMs);
    if (durationMs !== requestedDurationMs) throw new Error("AUDIO_TOO_SHORT");
    const chunks = splitSpeechRegions([{ startMs: 0, endMs: durationMs }]);
    const started = performance.now();
    const result = await runFunAsr(reader, chunks, runtimeFactory(assets));
    return {
      ok: true,
      blockCount: result.blocks.length,
      durationMs,
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
      metrics: result.metrics,
      wallMs: Math.round(performance.now() - started),
    };
  } finally {
    await reader.close();
  }
}

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const inputPath = arguments_[0];
const durationMs = Number(arguments_[1]);
if (
  inputPath === undefined ||
  arguments_.length !== 2 ||
  ![30_000, 60_000, 120_000].includes(durationMs)
) {
  console.error(JSON.stringify({ ok: false, code: "INVALID_ARGUMENTS" }));
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await runProbe(inputPath, durationMs)));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "INTERNAL_ERROR",
    }));
    process.exitCode = 1;
  }
}
