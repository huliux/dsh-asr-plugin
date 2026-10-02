import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeAssets, stageModelPack } from "../../src/assets/runtime-assets.js";
import type { ResolvedRuntimeAssets } from "../../src/assets/runtime-assets.js";
import { fingerprintAssetManifest } from "../../src/assets/verify-assets.js";
import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import { createPackagedWorkerLaunch } from "../../src/worker/launch.js";
import { createNodeWorkerSpawner } from "../../src/worker/node-spawner.js";
import { WorkerClient } from "../../src/worker/worker-client.js";
import type { WorkerKind } from "../../src/worker/types.js";

const suite = describe.skipIf(process.env.DSH_RUN_MODEL_MODES !== "1");
const audioPath = resolve("data/p0-wav/worker-smoke.wav");

function client(kind: WorkerKind, assets: ResolvedRuntimeAssets) {
  const launch = createPackagedWorkerLaunch({ ...assets, kind,
    managedAudioDirectory: dirname(audioPath), graceMs: 2_000 });
  return new WorkerClient({ kind, expectedFingerprint: assets.engineFingerprint,
    spawner: createNodeWorkerSpawner(),
    launch: { ...launch, argv: [launch.argv[0]!, resolve(`dist/worker/${kind}-entry.js`),
      ...launch.argv.slice(2)] },
    readyTimeoutMs: 180_000, runDeadlineMs: 600_000, terminationTimeoutMs: 15_000 });
}

async function asr(assets: ResolvedRuntimeAssets, durationMs: number) {
  const result = await client("asr", assets).run({ type: "run", kind: "asr",
    request_id: "model-mode-asr", base_transcript_version: 0,
    payload: { audio_path: audioPath, duration_ms: durationMs } });
  if (result.kind !== "asr") throw new Error("Unexpected Worker result");
  expect(result.payload.metrics.max_rss_bytes).toBeLessThanOrEqual(2 * 1024 ** 3);
  return result.payload;
}

suite("real explicit model modes", () => {
  it("runs base without punctuation and retains enhanced legacy output", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-model-modes-"));
    const input = { dataRoot: root, packageRoot: resolve(".") };
    const reader = await openPcm16Wav(audioPath);
    const durationMs = reader.metadata.durationMs;
    await reader.close();
    try {
      await stageModelPack({ ...input,
        modelPackPath: resolve("data/model-pack-qualification/dsh-asr-models-base-a0eb5b1a.tar") });
      const baseAssets = await resolveRuntimeAssets({ ...input, mode: "base" });
      const base = await asr(baseAssets, durationMs);
      expect(base.blocks.length).toBeGreaterThan(0);
      expect(base.blocks.every((block) => !/[，。！？、]/.test(block.text))).toBe(true);
      const speakers = await client("diarization", baseAssets).run({ type: "run", kind: "diarization",
        request_id: "model-mode-speakers", base_transcript_version: 0,
        payload: { audio_path: audioPath, duration_ms: durationMs,
          blocks: base.blocks, speech_regions: base.speech_regions } });
      expect(speakers.kind).toBe("diarization");
      if (speakers.kind !== "diarization") throw new Error("Unexpected speaker result");
      expect(speakers.payload.segments.map(({ speaker_label: _label, ...block }) => block))
        .toEqual(base.blocks);
      await stageModelPack({ ...input,
        modelPackPath: resolve("data/model-pack-qualification/dsh-asr-models-punctuation-d17edf3a.tar") });
      expect(await asr(await resolveRuntimeAssets({ ...input, mode: "base" }), durationMs)).toMatchObject({
        blocks: base.blocks, speech_regions: base.speech_regions,
      });
      const enhanced = await asr(await resolveRuntimeAssets({ ...input, mode: "enhanced" }), durationMs);
      const legacy = await asr({ modelRoot: resolve("data/assets"),
        manifestPath: baseAssets.manifestPath, packagedNativeRoot: baseAssets.packagedNativeRoot,
        modelSetFingerprint: baseAssets.modelSetFingerprint,
        engineFingerprint: await fingerprintAssetManifest(baseAssets.manifestPath) }, durationMs);
      expect(enhanced.blocks).toEqual(legacy.blocks);
      expect(enhanced.speech_regions).toEqual(legacy.speech_regions);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 240_000);
});
