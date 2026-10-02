import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintAssetManifest } from "../../src/assets/verify-assets.js";
import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import { createWorkerEnvironment } from "../../src/worker/launch.js";
import { createNodeWorkerSpawner } from "../../src/worker/node-spawner.js";
import { WorkerClient } from "../../src/worker/worker-client.js";
import type { WorkerKind, WorkerRunMessage } from "../../src/worker/types.js";

const enabled = process.env.DSH_RUN_WORKERS === "1";
const suite = describe.skipIf(!enabled);
const audioPath = resolve("data/p0-wav/worker-smoke.wav");
const manifestPath = resolve("dist/assets/manifest.json");
const ASSET_FAILURE_FINGERPRINT = "0".repeat(64);

interface WorkerPaths {
  readonly managedAudioDirectory: string;
  readonly manifestPath: string;
  readonly modelRoot: string;
  readonly packagedNativeRoot: string;
}

function client(
  kind: WorkerKind,
  fingerprint: string,
  paths: WorkerPaths = {
    modelRoot: resolve("data/assets"),
    packagedNativeRoot: resolve("data/assets"),
    manifestPath,
    managedAudioDirectory: dirname(audioPath),
  },
) {
  return new WorkerClient({
    kind,
    expectedFingerprint: fingerprint,
    spawner: createNodeWorkerSpawner(),
    launch: {
      argv: [
        process.execPath,
        resolve(`dist/worker/${kind}-entry.js`),
        paths.modelRoot,
        paths.packagedNativeRoot,
        paths.manifestPath,
        paths.managedAudioDirectory,
      ],
      cwd: resolve("dist/worker"),
      environment: createWorkerEnvironment(),
      graceMs: 2_000,
    },
    readyTimeoutMs: 180_000,
    runDeadlineMs: 600_000,
    terminationTimeoutMs: 15_000,
  });
}

function assetFailurePaths(root: string): WorkerPaths {
  return {
    modelRoot: root,
    packagedNativeRoot: root,
    manifestPath: join(root, "manifest.json"),
    managedAudioDirectory: root,
  };
}

function assetFailureRun(root: string): WorkerRunMessage {
  return {
    type: "run",
    request_id: "asset-failure",
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: join(root, "audio.wav"), duration_ms: 0 },
  };
}

async function expectAssetMismatch(
  paths: WorkerPaths,
  run: WorkerRunMessage,
  stage?: string,
): Promise<void> {
  await expect(client("asr", ASSET_FAILURE_FINGERPRINT, paths).run(run)).rejects.toMatchObject({
    code: "ASSET_MISMATCH",
    ...(stage === undefined ? {} : { stage }),
  });
}

async function writeHashMismatchManifest(root: string, paths: WorkerPaths): Promise<void> {
  const content = Buffer.from("tampered");
  await mkdir(join(root, "models"));
  await writeFile(join(root, "models", "model.onnx"), content);
  await writeFile(paths.manifestPath, JSON.stringify({
    schemaVersion: 2,
    algorithmRevision: "test-v1",
    assets: [{
      id: "model",
      kind: "model",
      relativePath: "models/model.onnx",
      byteLength: content.byteLength,
      sha256: "0".repeat(64),
    }],
  }));
}

async function writeAbiMismatchManifest(paths: WorkerPaths): Promise<void> {
  await writeFile(paths.manifestPath, JSON.stringify({
    schemaVersion: 2,
    algorithmRevision: "test-v1",
    assets: [{
      id: "native",
      kind: "native",
      relativePath: "native/native.node",
      byteLength: 0,
      sha256: createHash("sha256").update("").digest("hex"),
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        nodeMajor: 23,
        napi: Number(process.versions.napi),
      },
    }],
  }));
}

suite("real one-shot Workers pipeline", () => {
  it("runs ASR then diarization through one WorkerClient implementation", async () => {
    const fingerprint = await fingerprintAssetManifest(manifestPath);
    const reader = await openPcm16Wav(audioPath);
    const durationMs = reader.metadata.durationMs;
    await reader.close();
    const readyMessages: Array<{ kind: WorkerKind; loadMs: number }> = [];
    const asr = await client("asr", fingerprint).run({
      type: "run",
      request_id: "real-asr",
      kind: "asr",
      base_transcript_version: 0,
      payload: { audio_path: audioPath, duration_ms: durationMs },
    }, { onReady: (message) => readyMessages.push({ kind: message.kind, loadMs: message.load_ms }) });
    expect(asr.kind).toBe("asr");
    if (asr.kind !== "asr") throw new Error("ASR result kind mismatch");
    expect(asr.payload.blocks.length).toBeGreaterThan(0);
    expect(asr.payload.metrics.max_rss_bytes).toBeLessThanOrEqual(2 * 1_024 ** 3);

    const diarization = await client("diarization", fingerprint).run({
      type: "run",
      request_id: "real-diarization",
      kind: "diarization",
      base_transcript_version: 0,
      payload: {
        audio_path: audioPath,
        duration_ms: durationMs,
        blocks: asr.payload.blocks,
        speech_regions: asr.payload.speech_regions,
      },
    }, { onReady: (message) => readyMessages.push({ kind: message.kind, loadMs: message.load_ms }) });
    expect(diarization.kind).toBe("diarization");
    if (diarization.kind !== "diarization") throw new Error("Diarization result kind mismatch");
    expect(diarization.payload.segments).toHaveLength(asr.payload.blocks.length);
    expect(diarization.payload.metrics.max_rss_bytes).toBeLessThanOrEqual(2 * 1_024 ** 3);
    expect(diarization.payload.segments.map(({ speaker_label: _label, ...segment }) => segment))
      .toEqual(asr.payload.blocks);
    expect(readyMessages.map((message) => message.kind)).toEqual(["asr", "diarization"]);
    expect(readyMessages.every((message) => message.loadMs > 0)).toBe(true);
  }, 180_000);
});

suite("real one-shot Workers failures", () => {
  it("reports missing, corrupt, hash-mismatched and ABI-mismatched assets before READY", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-worker-assets-"));
    const paths = assetFailurePaths(fixtureRoot);
    const run = assetFailureRun(fixtureRoot);
    try {
      await expectAssetMismatch(paths, run, "initializing");
      await writeFile(paths.manifestPath, "{broken");
      await expectAssetMismatch(paths, run);
      await writeHashMismatchManifest(fixtureRoot, paths);
      await expectAssetMismatch(paths, run);
      await writeAbiMismatchManifest(paths);
      await expectAssetMismatch(paths, run);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  }, 60_000);

  it("terminates a fully loaded Worker whose manifest fingerprint differs", async () => {
    await expect(client("asr", "0".repeat(64)).run({
      type: "run",
      request_id: "fingerprint-mismatch",
      kind: "asr",
      base_transcript_version: 0,
      payload: { audio_path: audioPath, duration_ms: 30_000 },
    })).rejects.toMatchObject({ code: "WORKER_PROTOCOL_ERROR" });
  }, 180_000);
});
