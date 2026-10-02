import { dirname, resolve } from "node:path";

import { fingerprintAssetManifest } from "../dist/assets/verify-assets.js";
import { openPcm16Wav } from "../dist/audio/wav-reader.js";
import { createPackagedWorkerLaunch } from "../dist/worker/launch.js";
import { createNodeWorkerSpawner } from "../dist/worker/node-spawner.js";
import { WorkerClient } from "../dist/worker/worker-client.js";

const MAX_CANCEL_LATENCY_MS = 5_000;

function client(kind, fingerprint, audioPath) {
  return new WorkerClient({
    kind,
    expectedFingerprint: fingerprint,
    spawner: createNodeWorkerSpawner(),
    launch: createPackagedWorkerLaunch({
      kind,
      modelRoot: resolve("data/assets"),
      packagedNativeRoot: resolve("data/assets"),
      manifestPath: resolve("dist/assets/manifest.json"),
      managedAudioDirectory: dirname(audioPath),
      graceMs: 2_000,
    }),
    readyTimeoutMs: 180_000,
    runDeadlineMs: 600_000,
    terminationTimeoutMs: 15_000,
  });
}

async function duration(audioPath) {
  const reader = await openPcm16Wav(audioPath);
  try {
    return reader.metadata.durationMs;
  } finally {
    await reader.close();
  }
}

async function cancelledRun(name, workerClient, run, installTrigger) {
  const controller = new AbortController();
  let abortAt = 0;
  let timer;
  const abort = () => {
    if (controller.signal.aborted) return;
    abortAt = performance.now();
    controller.abort();
  };
  const options = installTrigger(abort, (value) => { timer = value; });
  const started = performance.now();
  try {
    await workerClient.run(run, { ...options, signal: controller.signal });
    throw new Error("CANCELLATION_DID_NOT_WIN");
  } catch (error) {
    if (typeof error !== "object" || error === null || error.code !== "WORKER_CANCELLED") throw error;
    const latencyMs = Math.round(performance.now() - abortAt);
    return { name, latencyMs, totalMs: Math.round(performance.now() - started) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function beforeReady(abort, setTimer) {
  setTimer(setTimeout(abort, 10));
  return {};
}

function onReady(abort) {
  return { onReady: abort };
}

function onStage(stage, abort, delayMs = 0) {
  return {
    onProgress(message) {
      if (message.stage !== stage || message.ratio !== 0) return;
      if (delayMs === 0) abort();
      else setTimeout(abort, delayMs);
    },
  };
}

async function successfulAsr(asrClient, audioPath, durationMs) {
  const result = await asrClient.run({
    type: "run",
    request_id: "cancel-prerequisite",
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: audioPath, duration_ms: durationMs },
  });
  if (result.kind !== "asr" || result.payload.blocks.length === 0) throw new Error("ASR_EMPTY");
  return result;
}

async function runProbe(audioPath) {
  const fingerprint = await fingerprintAssetManifest(resolve("dist/assets/manifest.json"));
  const durationMs = await duration(audioPath);
  const asrClient = client("asr", fingerprint, audioPath);
  const asrRun = (requestId) => ({
    type: "run",
    request_id: requestId,
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: audioPath, duration_ms: durationMs },
  });
  const measurements = [];
  measurements.push(await cancelledRun(
    "before_ready", asrClient, asrRun("cancel-before-ready"), beforeReady,
  ));
  measurements.push(await cancelledRun(
    "ready_before_run", asrClient, asrRun("cancel-ready"), onReady,
  ));
  measurements.push(await cancelledRun(
    "vad", asrClient, asrRun("cancel-vad"), (abort) => onStage("vad", abort),
  ));
  measurements.push(await cancelledRun(
    "asr", asrClient, asrRun("cancel-asr"), (abort) => onStage("asr", abort),
  ));
  const asr = await successfulAsr(asrClient, audioPath, durationMs);
  const diarizationClient = client("diarization", fingerprint, audioPath);
  const diarizationRun = (requestId) => ({
    type: "run",
    request_id: requestId,
    kind: "diarization",
    base_transcript_version: 0,
    payload: {
      audio_path: audioPath,
      duration_ms: durationMs,
      blocks: asr.payload.blocks,
      speech_regions: asr.payload.speech_regions,
    },
  });
  measurements.push(await cancelledRun(
    "fbank", diarizationClient, diarizationRun("cancel-fbank"),
    (abort) => onStage("fbank", abort),
  ));
  measurements.push(await cancelledRun(
    "embed", diarizationClient, diarizationRun("cancel-embed"),
    (abort) => onStage("fbank", abort, 100),
  ));
  const withinLimit = measurements.every((measurement) =>
    measurement.latencyMs <= MAX_CANCEL_LATENCY_MS);
  return { ok: withinLimit, maxCancelLatencyMs: MAX_CANCEL_LATENCY_MS, measurements };
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
if (args.length !== 1) {
  console.error(JSON.stringify({ ok: false, code: "INVALID_ARGUMENTS" }));
  process.exitCode = 1;
} else {
  try {
    const report = await runProbe(resolve(args[0]));
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
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
