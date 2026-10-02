import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { verifyAssets } from "../dist/assets/verify-assets.js";
import { runBoundedVad } from "../dist/asr/bounded-vad.js";
import { loadVadModel } from "../dist/asr/vad-model.js";
import { openPcm16Wav } from "../dist/audio/wav-reader.js";

function elapsed(started) {
  return Math.round(performance.now() - started);
}

async function runProbe(inputPath) {
  const assetStarted = performance.now();
  const assets = await verifyAssets({
    assetRoot: resolve("data/assets"),
    manifestPath: resolve("dist/assets/manifest.json"),
  });
  const modelPath = assets["vad-model"];
  if (modelPath === undefined) throw new Error("VAD_MODEL_MISSING");
  const assetVerificationMs = elapsed(assetStarted);
  const reader = await openPcm16Wav(resolve(inputPath));
  let model;
  try {
    const loadStarted = performance.now();
    model = await loadVadModel(modelPath);
    const modelLoadMs = elapsed(loadStarted);
    const result = await runBoundedVad(reader, model);
    return {
      ok: true,
      assetVerificationMs,
      asrChunkCount: result.asrChunks.length,
      durationMs: reader.metadata.durationMs,
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
      metrics: result.metrics,
      modelLoadMs,
      speechRegionCount: result.speechRegions.length,
    };
  } finally {
    await reader.close();
    await model?.close();
  }
}

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const inputPath = arguments_[0];
if (inputPath === undefined || arguments_.length !== 1) {
  console.error(JSON.stringify({ ok: false, code: "INVALID_ARGUMENTS" }));
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await runProbe(inputPath)));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "INTERNAL_ERROR",
      }),
    );
    process.exitCode = 1;
  }
}
