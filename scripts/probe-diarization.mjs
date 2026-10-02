import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { verifyAssets } from "../dist/assets/verify-assets.js";
import { runBoundedVad } from "../dist/asr/bounded-vad.js";
import { createFunAsrRuntimeFactory } from "../dist/asr/funasr/factory.js";
import { runFunAsr } from "../dist/asr/funasr/pipeline.js";
import { loadVadModel } from "../dist/asr/vad-model.js";
import { openPcm16Wav } from "../dist/audio/wav-reader.js";
import { loadMeetingDiarizer } from "../dist/diarization/factory.js";

const MAX_RSS_BYTES = 2 * 1_024 ** 3;
let currentStage = "initializing";

function required(assets, id) {
  const value = assets[id];
  if (value === undefined) throw new Error("ASSET_MISSING");
  return value;
}

function asrFactory(assets) {
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

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].sort((left, right) => right - left);
}

function countByValue(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function blockDurationStats(blocks) {
  const durations = blocks.map((block) => block.endMs - block.startMs).sort((a, b) => a - b);
  return {
    medianMs: durations[Math.floor(durations.length / 2)] ?? 0,
    under1s: durations.filter((duration) => duration < 1_000).length,
    over9s: durations.filter((duration) => duration > 9_000).length,
  };
}

async function runProbe(inputPath, expectedSpeakers) {
  const started = performance.now();
  currentStage = "assets";
  const assets = await verifyAssets({
    assetRoot: resolve("data/assets"),
    manifestPath: resolve("dist/assets/manifest.json"),
  });
  const reader = await openPcm16Wav(resolve(inputPath));
  let vadModel;
  let diarizer;
  try {
    currentStage = "vad";
    vadModel = await loadVadModel(required(assets, "vad-model"));
    const vad = await runBoundedVad(reader, vadModel);
    await vadModel.close();
    vadModel = undefined;
    currentStage = "asr";
    const asr = await runFunAsr(reader, vad.asrChunks, asrFactory(assets));
    currentStage = "diarization";
    diarizer = await loadMeetingDiarizer({
      embeddingModelPath: required(assets, "speaker-embedding-model"),
      fbankPath: required(assets, "fbank-native"),
      hclusterPath: required(assets, "hcluster-native"),
    });
    const result = await diarizer.diarize(reader, asr.blocks, vad.speechRegions);
    const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
    return {
      ok: true,
      asrBlockCount: asr.blocks.length,
      asrMetrics: asr.metrics,
      blockDurations: blockDurationStats(asr.blocks),
      diarizationMetrics: result.metrics,
      durationMs: reader.metadata.durationMs,
      expectedSpeakers,
      labelSizes: countValues(result.segments.map((segment) => segment.speakerLabel)),
      maxRssBytes,
      memoryHeadroomBytes: MAX_RSS_BYTES - maxRssBytes,
      resourceWithinLimit: maxRssBytes <= MAX_RSS_BYTES,
      resultStatus: result.resultStatus,
      speakerCount: result.speakerCount,
      speakerCountMatchesTruth: result.speakerCount === expectedSpeakers,
      unknownBlockRatio: Number(
        (result.metrics.unknownBlockCount / result.segments.length).toFixed(6),
      ),
      vadMetrics: vad.metrics,
      wallMs: Math.round(performance.now() - started),
      warningCounts: countByValue(result.warnings.map((warning) => warning.code)),
    };
  } finally {
    await diarizer?.close();
    await vadModel?.close();
    await reader.close();
  }
}

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const inputPath = arguments_[0];
const expectedSpeakers = Number(arguments_[1]);
if (
  inputPath === undefined ||
  arguments_.length !== 2 ||
  !Number.isSafeInteger(expectedSpeakers) ||
  expectedSpeakers < 1 ||
  expectedSpeakers > 26
) {
  console.error(JSON.stringify({ ok: false, code: "INVALID_ARGUMENTS" }));
  process.exitCode = 1;
} else {
  try {
    const report = await runProbe(inputPath, expectedSpeakers);
    console.log(JSON.stringify(report));
    if (!report.resourceWithinLimit || !report.speakerCountMatchesTruth) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      stage: currentStage,
      message: error instanceof Error ? error.message : "Probe failed",
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "INTERNAL_ERROR",
    }));
    process.exitCode = 1;
  }
}
