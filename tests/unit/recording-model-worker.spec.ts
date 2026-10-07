import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ResolvedRuntimeAssets } from "../../src/assets/runtime-assets.js";
import { recordingAudioLayout } from "../../src/storage/managed-audio-paths.js";
import { RecordingModelWorker } from "../../src/recording/model-worker.js";
import { runRecordingModelServer } from "../../src/recording/model-server.js";
import type { WorkerSpawner } from "../../src/worker/process.js";

const fingerprint = "a".repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assets: ResolvedRuntimeAssets = { engineFingerprint: fingerprint, modelSetFingerprint: fingerprint,
  modelRoot: "/models", packagedNativeRoot: "/native", manifestPath: "/manifest" };
function nativeBoundary() {
  let loaded = 0; let released = 0;
  const spawner: WorkerSpawner = { spawn: () => {
    const input = new PassThrough(); const output = new PassThrough();
    const diagnostics = new PassThrough();
    const done = runRecordingModelServer({ input, output, diagnostics, load: async () => {
      loaded++;
      return { engineFingerprint: fingerprint, close: async () => { released++; },
        createSession: async () => ({ engineFingerprint: fingerprint,
          runDrafts: async ({signal}) => {
            await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
          finalize: async () => ({ duration_ms: 1, source_size_bytes: 46, source_sha256: "b".repeat(64),
            result_status: "empty", result_reason: "too_short", segments: [], audio_files: ["audio.tmp.wav"],
            metrics: { finalization_ms: 0, max_rss_bytes: 0, cache_hits: 0, cache_misses: 0 } }),
          close: async () => {},
        }),
      };
    } }).then(exitCode => ({ exitCode, signal: null }));
    return { stdin: input, stdout: output, stderr: diagnostics, done,
      terminate: () => input.end(), waitForExit: async () => { await done; return true; } };
  } };
  return { spawner, counts: () => ({ loaded, released }) };
}

it("reuses ready models for two sessions and releases them after idle", async () => {
  const boundary = nativeBoundary();
  const worker = new RecordingModelWorker({ spawner: boundary.spawner,
    meetingsRoot: "/meetings", workRoot: "/work", idleTimeoutMs: 30 });
  try {
    await worker.prepare(assets);
    for (const n of [1, 2]) {
      const session = await worker.factory(assets).start({ meetingId: id(n), runId: id(n + 10), layout: recordingAudioLayout("/root", id(n)), signal: new AbortController().signal, onWarning: () => {} });
      expect(session.snapshot().revision).toBe(0);
      const result = await session.finalize({ type: "finalize", request_id: id(n),
        base_transcript_version: 0, capture_end_us: 1 });
      expect(result.payload.result_status).toBe("empty");
      expect(boundary.counts()).toEqual({ loaded: 1, released: 0 });
    }
    await delay(70);
    expect(boundary.counts()).toEqual({ loaded: 1, released: 1 });
    await worker.prepare(assets);
    expect(boundary.counts()).toEqual({ loaded: 2, released: 1 });
  } finally { await worker.dispose(); }
  expect(boundary.counts()).toEqual({ loaded: 2, released: 2 });
});

it("does not release an active session on the idle deadline and resets after cancellation", async () => {
  const boundary = nativeBoundary();
  const worker = new RecordingModelWorker({ spawner: boundary.spawner,
    meetingsRoot: "/meetings", workRoot: "/work", idleTimeoutMs: 20 });
  try {
    const session = await worker.factory(assets).start({ meetingId: id(1), runId: id(11), layout: recordingAudioLayout("/root", id(1)), signal: new AbortController().signal, onWarning: () => {} });
    await delay(50);
    expect(boundary.counts()).toEqual({ loaded: 1, released: 0 });
    await session.terminate();
    await worker.prepare(assets);
    expect(boundary.counts()).toEqual({ loaded: 2, released: 1 });
  } finally { await worker.dispose(); }
});

it("releases idle models before batch work and stops accepting preparation after disposal", async () => {
  const boundary = nativeBoundary();
  const worker = new RecordingModelWorker({ spawner: boundary.spawner,
    meetingsRoot: "/meetings", workRoot: "/work" });
  await worker.prepare(assets);
  await worker.releaseIdle();
  expect(boundary.counts()).toEqual({ loaded: 1, released: 1 });
  await worker.dispose();
  await expect(worker.prepare(assets)).rejects.toThrow("closed");
  expect(boundary.counts()).toEqual({ loaded: 1, released: 1 });
});

it("replaces idle models when their installation identity changes", async () => {
  const boundary = nativeBoundary();
  const worker = new RecordingModelWorker({ spawner: boundary.spawner,
    meetingsRoot: "/meetings", workRoot: "/work" });
  try {
    await worker.prepare(assets);
    await worker.prepare({ ...assets, modelRoot: "/replacement" });
    expect(boundary.counts()).toEqual({ loaded: 2, released: 1 });
  } finally { await worker.dispose(); }
  expect(boundary.counts()).toEqual({ loaded: 2, released: 2 });
});
