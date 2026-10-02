import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createProcessingIdentity } from "../dist/assets/processing-identity.js";
import { fingerprintAssetManifest, readAssetManifest } from "../dist/assets/verify-assets.js";
import { openPcm16Wav } from "../dist/audio/wav-reader.js";
import { createPackagedWorkerLaunch } from "../dist/worker/launch.js";
import { createNodeWorkerSpawner } from "../dist/worker/node-spawner.js";
import { WorkerClient } from "../dist/worker/worker-client.js";
import { runWorkerPipeline } from "../dist/worker/worker-pipeline.js";

const [baselinePath, reportPath] = process.argv.slice(2).map((path) => resolve(path));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const manifestPath = resolve("dist/assets/manifest.json");
const manifest = await readAssetManifest(manifestPath);
const fingerprint = await fingerprintAssetManifest(manifestPath);
const normalize = (blocks) => blocks.map((block) => block.text).join("").replace(/[\p{P}\p{Z}\s]/gu, "");
const report = { gate: "representative-model-modes", status: "no_go", samples: [] };

function client(kind, identity, audioPath) {
  return new WorkerClient({ kind, expectedFingerprint: identity.engineFingerprint,
    spawner: createNodeWorkerSpawner(),
    launch: createPackagedWorkerLaunch({ kind, manifestPath, modelRoot: resolve("data/assets"),
      packagedNativeRoot: resolve("dist"), managedAudioDirectory: dirname(audioPath), graceMs: 2_000,
      processing: { identity, punctuationRoot: identity.mode === "enhanced" ? resolve("data/assets") : null } }),
    readyTimeoutMs: 180_000, runDeadlineMs: 600_000, terminationTimeoutMs: 15_000 });
}

async function sampleRun(sample, mode) {
  const identity = createProcessingIdentity(manifest, fingerprint, mode);
  const audioPath = resolve(`data/p0-wav/${sample.sample_id}.wav`);
  const reader = await openPcm16Wav(audioPath);
  const durationMs = reader.metadata.durationMs;
  await reader.close();
  const started = performance.now();
  const result = await runWorkerPipeline({ asr: client("asr", identity, audioPath),
    diarization: client("diarization", identity, audioPath),
    asrRun: { type: "run", kind: "asr", request_id: `quality-${mode}-${sample.sample_id}`,
      base_transcript_version: 0, payload: { audio_path: audioPath, duration_ms: durationMs } },
    diarizationRequestId: `quality-${mode}-${sample.sample_id}-speakers` });
  assert.equal(result.type, "diarized");
  const asr = result.asr.payload;
  const speakers = result.diarization.payload;
  assert.deepEqual(asr.speech_regions, sample.candidate.asr.speech_regions);
  assert.equal(normalize(asr.blocks), normalize(sample.candidate.asr.blocks));
  assert(asr.metrics.max_rss_bytes <= 2 * 1024 ** 3);
  assert(speakers.metrics.max_rss_bytes <= 2 * 1024 ** 3);
  if (mode === "enhanced") {
    assert.deepEqual(asr.blocks, sample.candidate.asr.blocks);
    assert.deepEqual(speakers.segments, sample.candidate.diarization.segments);
  }
  const labels = {};
  for (const segment of speakers.segments) labels[segment.speaker_label] = (labels[segment.speaker_label] ?? 0) + 1;
  return { sample: sample.sample_id, mode, identity, durationMs,
    elapsedMs: Math.round(performance.now() - started), blocks: asr.blocks.length,
    wordsPreserved: true, speechRegionsPreserved: true, enhancedBaselineExact: mode === "enhanced",
    resultStatus: speakers.result_status, labels,
    targetExceptions: asr.blocks.filter((block) => block.end_ms - block.start_ms > 8_000 ||
      Array.from(block.text).length > 80).length,
    asrMetrics: asr.metrics, speakerMetrics: speakers.metrics };
}

try {
  for (const sample of baseline) for (const mode of ["base", "enhanced"]) {
    const observed = await sampleRun(sample, mode);
    report.samples.push(observed);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ sample: observed.sample, mode, blocks: observed.blocks,
      labels: observed.labels, elapsedMs: observed.elapsedMs })}\n`);
  }
  report.status = "go";
} catch (error) {
  report.code = error?.code ?? "MODE_QUALITY_FAILED";
  process.exitCode = 1;
} finally {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
