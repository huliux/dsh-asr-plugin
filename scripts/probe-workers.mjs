import { dirname, resolve } from "node:path";

import { fingerprintAssetManifest } from "../dist/assets/verify-assets.js";
import { openPcm16Wav } from "../dist/audio/wav-reader.js";
import { encodeFrame } from "../dist/worker/framing.js";
import { createPackagedWorkerLaunch } from "../dist/worker/launch.js";
import { createNodeWorkerSpawner } from "../dist/worker/node-spawner.js";
import { WorkerClient } from "../dist/worker/worker-client.js";
import { runWorkerPipeline } from "../dist/worker/worker-pipeline.js";

const MAX_RSS_BYTES = 2 * 1_024 ** 3;

function createClient(kind, expectedFingerprint, managedAudioDirectory) {
  return new WorkerClient({
    kind,
    expectedFingerprint,
    spawner: createNodeWorkerSpawner(),
    launch: createPackagedWorkerLaunch({
      kind,
      modelRoot: resolve("data/assets"),
      packagedNativeRoot: resolve("data/assets"),
      manifestPath: resolve("dist/assets/manifest.json"),
      managedAudioDirectory,
      graceMs: 2_000,
    }),
    readyTimeoutMs: 180_000,
    runDeadlineMs: 600_000,
    terminationTimeoutMs: 15_000,
  });
}

function labelCounts(segments) {
  const counts = {};
  for (const segment of segments) {
    counts[segment.speaker_label] = (counts[segment.speaker_label] ?? 0) + 1;
  }
  return counts;
}

async function audioMetadata(audioPath) {
  const reader = await openPcm16Wav(audioPath);
  try {
    return reader.metadata;
  } finally {
    await reader.close();
  }
}

async function runProbe(audioPath) {
  const manifestPath = resolve("dist/assets/manifest.json");
  const fingerprint = await fingerprintAssetManifest(manifestPath);
  const metadata = await audioMetadata(audioPath);
  const asrObservations = { loadMs: 0, progress: [] };
  const diarizationObservations = { loadMs: 0, progress: [] };
  const started = performance.now();
  const pipeline = await runWorkerPipeline({
    asr: createClient(
      "asr",
      fingerprint,
      dirname(audioPath),
    ),
    diarization: createClient(
      "diarization",
      fingerprint,
      dirname(audioPath),
    ),
    asrRun: {
      type: "run",
      request_id: "p0-05-asr",
      kind: "asr",
      base_transcript_version: 0,
      payload: { audio_path: audioPath, duration_ms: metadata.durationMs },
    },
    diarizationRequestId: "p0-05-diarization",
    onReady(kind, message) {
      const observations = kind === "asr" ? asrObservations : diarizationObservations;
      observations.loadMs = message.load_ms;
    },
    onProgress(kind, message) {
      const observations = kind === "asr" ? asrObservations : diarizationObservations;
      observations.progress.push([message.stage, message.ratio]);
    },
  });
  const pipelineWallMs = Math.round(performance.now() - started);
  const asr = pipeline.asr;
  if (asr.kind !== "asr" || asr.payload.blocks.length === 0) throw new Error("ASR_EMPTY");
  if (pipeline.type !== "diarized") throw new Error("DIARIZATION_EMPTY");
  const diarization = pipeline.diarization;
  if (diarization.kind !== "diarization") throw new Error("DIARIZATION_KIND_MISMATCH");
  const resourceWithinLimit = [asr, diarization].every(
    (result) => result.payload.metrics.max_rss_bytes <= MAX_RSS_BYTES,
  );
  if (!resourceWithinLimit) throw new Error("RESOURCE_LIMIT");
  return {
    ok: true,
    durationMs: metadata.durationMs,
    engineFingerprint: fingerprint,
    pipelineWallMs,
    asr: {
      blockCount: asr.payload.blocks.length,
      frameBytes: encodeFrame(asr).byteLength - 4,
      loadMs: asrObservations.loadMs,
      metrics: asr.payload.metrics,
      memoryHeadroomBytes: MAX_RSS_BYTES - asr.payload.metrics.max_rss_bytes,
      progress: asrObservations.progress,
      speechRegionCount: asr.payload.speech_regions.length,
    },
    diarization: {
      frameBytes: encodeFrame(diarization).byteLength - 4,
      labelCounts: labelCounts(diarization.payload.segments),
      loadMs: diarizationObservations.loadMs,
      metrics: diarization.payload.metrics,
      memoryHeadroomBytes: MAX_RSS_BYTES - diarization.payload.metrics.max_rss_bytes,
      progress: diarizationObservations.progress,
      resultReason: diarization.payload.result_reason,
      resultStatus: diarization.payload.result_status,
      segmentCount: diarization.payload.segments.length,
      warningCount: diarization.payload.warnings.length,
    },
  };
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
if (args.length !== 1) {
  console.error(JSON.stringify({ ok: false, code: "INVALID_ARGUMENTS" }));
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await runProbe(resolve(args[0]))));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "INTERNAL_ERROR",
      phase: typeof error === "object" && error !== null && "phase" in error
        ? String(error.phase)
        : undefined,
      stage: typeof error === "object" && error !== null && "stage" in error
        ? String(error.stage)
        : undefined,
    }));
    process.exitCode = 1;
  }
}
