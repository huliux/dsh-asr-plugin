import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fingerprintAssetManifest } from "../../src/assets/verify-assets.js";
import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import { RecordingWorkerClient } from "../../src/recording/worker-client.js";
import { createWorkerEnvironment } from "../../src/worker/launch.js";
import type { WorkerSpawner } from "../../src/worker/process.js";
import {
  WORKER_READY_TIMEOUT_MS,
  WORKER_TERMINATION_GRACE_MS,
  WORKER_TERMINATION_TIMEOUT_MS,
  workerRunDeadlineMs,
} from "../../src/worker/timeouts.js";
import { WorkerClient } from "../../src/worker/worker-client.js";
import { runWorkerPipeline } from "../../src/worker/worker-pipeline.js";
import type { WorkerKind } from "../../src/worker/types.js";
import * as ProbePlugin from "../fixtures/dsh-subprocess-plugin.js";

const PROVIDER = "@deepseek-ai/dsh-subprocess-local";
const PROBE = "dsh-asr-subprocess-probe";
const audioPath = resolve("data/p0-wav/worker-smoke.wav");
const manifestPath = resolve("dist/assets/manifest.json");
const heavySuite = describe.skipIf(process.env.DSH_RUN_DSH_ASSEMBLED !== "1");
const recordingHeavySuite = describe.skipIf(process.env.DSH_RUN_RECORDING_WORKER !== "1");

let context: Context | undefined;
let fixtureRoot: string | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

async function loadComposition(): Promise<WorkerSpawner> {
  fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-loader-"));
  const configPath = join(fixtureRoot, "cordis.yml");
  await writeFile(configPath, [
    `- name: '${PROVIDER}'`,
    `- name: '${PROBE}'`,
    "",
  ].join("\n"));
  context = new Context();
  context.baseUrl = `${pathToFileURL(fixtureRoot).href}/`;
  await context.plugin(Loader);
  context.loader.builtins.include = Include;
  const modules = new Map<string, unknown>([
    [PROVIDER, LocalSubprocessRuntime],
    [PROBE, ProbePlugin],
  ]);
  context.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof context.loader.internal>;
  await context.loader.create({
    name: "cordis:include",
    config: { path: pathToFileURL(configPath).href },
  });
  await context.loader.await();
  return ProbePlugin.requireAssembledSpawner();
}

function fixtureClient(spawner: WorkerSpawner, code: string, readyTimeoutMs = 100): WorkerClient {
  return new WorkerClient({
    kind: "asr",
    expectedFingerprint: "0".repeat(64),
    spawner,
    launch: {
      argv: [process.execPath, "--input-type=module", "-e", code],
      cwd: resolve("."),
      environment: createWorkerEnvironment(),
      graceMs: 50,
    },
    readyTimeoutMs,
    runDeadlineMs: 1_000,
    terminationTimeoutMs: 5_000,
  });
}

function fixtureRun(requestId: string) {
  return {
    type: "run",
    request_id: requestId,
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: "/tmp/fixture.wav", duration_ms: 1 },
  } as const;
}

function realClient(
  kind: WorkerKind,
  fingerprint: string,
  spawner: WorkerSpawner,
  durationMs: number,
): WorkerClient {
  return new WorkerClient({
    kind,
    expectedFingerprint: fingerprint,
    spawner,
    launch: {
      argv: [
        process.execPath,
        resolve(`dist/worker/${kind}-entry.js`),
        resolve("data/assets"),
        resolve("data/assets"),
        manifestPath,
        dirname(audioPath),
      ],
      cwd: resolve("dist/worker"),
      environment: createWorkerEnvironment(),
      graceMs: WORKER_TERMINATION_GRACE_MS,
    },
    readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
    runDeadlineMs: workerRunDeadlineMs(durationMs),
    terminationTimeoutMs: WORKER_TERMINATION_TIMEOUT_MS,
  });
}

describe("DSH subprocess through a real Loader composition", () => {
  it("drives one Recording Worker session through the assembled DSH subprocess", async () => {
    const spawner = await loadComposition();
    const client = new RecordingWorkerClient({
      expectedFingerprint: "0".repeat(64),
      spawner,
      launch: {
        argv: [process.execPath, resolve("tests/fixtures/recording-worker.mjs")],
        cwd: resolve("."),
        environment: createWorkerEnvironment(),
        graceMs: 50,
      },
      readyTimeoutMs: 1_000,
      finalizeDeadlineMs: 1_000,
      terminationTimeoutMs: 5_000,
    });
    const revisions: number[] = [];
    const session = await client.start({
      onRevision(snapshot) { revisions.push(snapshot.revision); },
    });
    await vi.waitFor(() => expect(revisions).toEqual([1]));

    await expect(session.finalize({
      type: "finalize",
      request_id: "44444444-4444-4444-8444-444444444444",
      base_transcript_version: 0,
      capture_end_us: 1,
    })).resolves.toMatchObject({ type: "final_result", payload: { result_status: "empty" } });
  });

  it("injects the adapter and disposes a live process tree", async () => {
    const spawner = await loadComposition();
    const code = [
      "import { spawn } from 'node:child_process';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);",
      "process.stdout.write(String(child.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const handle = spawner.spawn({
      argv: [process.execPath, "--input-type=module", "-e", code],
      cwd: resolve("."),
      environment: createWorkerEnvironment(),
      graceMs: 50,
    });
    const [data] = await once(handle.stdout!, "data") as [Buffer];
    expect(Number.parseInt(String(data), 10)).toBeGreaterThan(0);

    await context!.fiber.dispose();
    context = undefined;
    await expect(handle.waitForExit()).resolves.toBe(true);
    await expect(handle.done).resolves.toMatchObject({ exitCode: null });
    expect(() => ProbePlugin.requireAssembledSpawner()).toThrow("DSH_SUBPROCESS_NOT_INJECTED");
  });

  it("classifies a DSH-managed READY timeout and converges the tree", async () => {
    const client = fixtureClient(await loadComposition(), "setInterval(() => {}, 1000)", 25);
    await expect(client.run(fixtureRun("dsh-timeout"))).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
      phase: "ready",
    });
  });

  it("classifies a DSH-managed crash without mistaking exit for success", async () => {
    const client = fixtureClient(await loadComposition(), "process.exit(7)");
    await expect(client.run(fixtureRun("dsh-crash"))).rejects.toMatchObject({
      code: "WORKER_PROTOCOL_ERROR",
      outcome: { exitCode: 7, signal: null },
    });
  });
});

heavySuite("real Workers through assembled DSH subprocess", () => {
  it("runs the same ASR to diarization pipeline", async () => {
    const spawner = await loadComposition();
    const fingerprint = await fingerprintAssetManifest(manifestPath);
    const reader = await openPcm16Wav(audioPath);
    const durationMs = reader.metadata.durationMs;
    await reader.close();
    const pipeline = await runWorkerPipeline({
      asr: realClient("asr", fingerprint, spawner, durationMs),
      diarization: realClient("diarization", fingerprint, spawner, durationMs),
      asrRun: {
        type: "run",
        request_id: "dsh-real-asr",
        kind: "asr",
        base_transcript_version: 0,
        payload: { audio_path: audioPath, duration_ms: durationMs },
      },
      diarizationRequestId: "dsh-real-diarization",
    });

    expect(pipeline.type).toBe("diarized");
    if (pipeline.type !== "diarized") throw new Error("DSH_PIPELINE_EMPTY");
    expect(pipeline.diarization.payload.segments).toHaveLength(pipeline.asr.payload.blocks.length);
  }, 60_000);

  it("cancels a fully loaded Worker through DSH tree termination", async () => {
    const spawner = await loadComposition();
    const fingerprint = await fingerprintAssetManifest(manifestPath);
    const controller = new AbortController();
    const client = realClient("asr", fingerprint, spawner, 30_000);
    await expect(client.run({
      type: "run",
      request_id: "dsh-real-cancel",
      kind: "asr",
      base_transcript_version: 0,
      payload: { audio_path: audioPath, duration_ms: 30_000 },
    }, {
      signal: controller.signal,
      onProgress(message) {
        if (message.stage === "vad" && message.ratio === 0) controller.abort();
      },
    })).rejects.toMatchObject({ code: "WORKER_CANCELLED", phase: "run" });
  }, 30_000);
});

recordingHeavySuite("real Recording Worker through assembled DSH subprocess", () => {
  it("replays a bounded draft after restart and returns a verified final candidate", async () => {
    const spawner = await loadComposition();
    const fingerprint = await fingerprintAssetManifest(manifestPath);
    const meetingId = "11111111-1111-4111-8111-111111111111";
    const runId = "22222222-2222-4222-8222-222222222222";
    const meetingsRoot = join(fixtureRoot!, "meetings");
    const workRoot = join(fixtureRoot!, "work");
    const chunks = join(meetingsRoot, meetingId, "recording", "mic", "chunks");
    await mkdir(chunks, { recursive: true, mode: 0o700 });
    await mkdir(join(meetingsRoot, meetingId, "recording", "system", "chunks"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(workRoot, meetingId, "recording"), { recursive: true, mode: 0o700 });
    const reader = await openPcm16Wav(audioPath);
    const endUs = 1_000_000 + Math.round((reader.metadata.frameCount * 1_000_000) / 16_000);
    const captureEndUs = endUs + Math.round((reader.metadata.frameCount * 1_000_000) / 16_000);
    await reader.close();
    await copyFile(audioPath, join(chunks, `1000000-${endUs}.wav`));
    await copyFile(audioPath, join(chunks, `${endUs}-${captureEndUs}.wav`));
    const client = new RecordingWorkerClient({
      expectedFingerprint: fingerprint,
      spawner,
      launch: {
        argv: [
          process.execPath,
          resolve("dist/recording/recording-entry.js"),
          resolve("data/assets"),
          resolve("data/assets"),
          manifestPath,
          meetingsRoot,
          workRoot,
          meetingId,
          runId,
          fingerprint,
        ],
        cwd: resolve("dist/recording"),
        environment: createWorkerEnvironment(),
        graceMs: WORKER_TERMINATION_GRACE_MS,
      },
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      finalizeDeadlineMs: 30_000,
      terminationTimeoutMs: WORKER_TERMINATION_TIMEOUT_MS,
    });
    const revisions: number[] = [];
    const session = await client.start({
      onRevision(snapshot) { revisions.push(snapshot.revision); },
    });
    await vi.waitFor(() => expect(revisions.length).toBeGreaterThan(0), {
      timeout: 30_000,
      interval: 100,
    });
    expect(revisions[0]).toBe(1);
    expect(session.snapshot().revision).toBeGreaterThanOrEqual(1);
    expect(session.snapshot().audioThroughMs).toBeGreaterThan(0);
    const firstAudioThroughMs = session.snapshot().audioThroughMs;
    await expect(session.terminate()).resolves.toBeUndefined();

    const replayRevisions: number[] = [];
    const replay = await client.start({
      onRevision(snapshot) { replayRevisions.push(snapshot.revision); },
    });
    await vi.waitFor(() => expect(replayRevisions.length).toBeGreaterThan(0), {
      timeout: 30_000,
      interval: 100,
    });
    expect(replayRevisions[0]).toBe(1);
    expect(replay.snapshot().audioThroughMs).toBe(firstAudioThroughMs);
    const finalized = await replay.finalize({
      type: "finalize",
      request_id: "44444444-4444-4444-8444-444444444444",
      base_transcript_version: 0,
      capture_end_us: captureEndUs,
    });
    expect(finalized.payload.duration_ms).toBeGreaterThan(0);
    expect(finalized.payload.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finalized.payload.audio_files).toContain("audio.tmp.wav");
    expect(finalized.payload.segments.length).toBeGreaterThan(0);
  }, 60_000);
});
