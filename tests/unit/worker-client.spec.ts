import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { decodeFrames, encodeFrame } from "../../src/worker/framing.js";
import {
  WorkerClient,
  WorkerClientError,
} from "../../src/worker/worker-client.js";
import type {
  WorkerProcessHandle,
  WorkerProcessOutcome,
  WorkerSpawner,
} from "../../src/worker/process.js";
import type { AsrRunMessage } from "../../src/worker/types.js";

const fingerprint = "d".repeat(64);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function asrRun(): AsrRunMessage {
  return {
    type: "run",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: "/managed/audio.wav", duration_ms: 1_000 },
  };
}

function ready(): Record<string, unknown> {
  return {
    type: "ready",
    protocol_version: 2,
    kind: "asr",
    engine_fingerprint: fingerprint,
    load_ms: 5,
  };
}

function result(): Record<string, unknown> {
  return {
    type: "result",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 0,
    payload: {
      blocks: [{ seq: 0, start_ms: 0, end_ms: 80, text: "hello" }],
      speech_regions: [{ start_ms: 0, end_ms: 100 }],
      empty_reason: null,
      metrics: { vad_ms: 1, asr_ms: 2, max_rss_bytes: 3 },
    },
  };
}

function remoteError(): Record<string, unknown> {
  return {
    type: "error",
    request_id: "request-1",
    code: "MODEL_INFERENCE_FAILED",
    stage: "asr",
    message: "Inference failed",
  };
}

interface FakeProcess {
  readonly handle: WorkerProcessHandle;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly outcome: Deferred<WorkerProcessOutcome>;
  readonly terminate: ReturnType<typeof vi.fn>;
  readonly waitForExit: ReturnType<typeof vi.fn>;
}

function fakeProcess(onTerminate?: () => void): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outcome = deferred<WorkerProcessOutcome>();
  const terminate = vi.fn(() => onTerminate?.());
  const waitForExit = vi.fn(async () => true);
  return {
    stdin,
    stdout,
    stderr,
    outcome,
    terminate,
    waitForExit,
    handle: {
      stdin,
      stdout,
      stderr,
      done: outcome.promise,
      terminate,
      waitForExit,
    },
  };
}

function client(process: FakeProcess, overrides: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}) {
  const spawner: WorkerSpawner = { spawn: vi.fn(() => process.handle) };
  return new WorkerClient({
    kind: "asr",
    expectedFingerprint: fingerprint,
    spawner,
    launch: {
      argv: [globalThis.process.execPath, "/worker/asr-entry.js"],
      cwd: "/worker",
      environment: { LANG: "C.UTF-8" },
      graceMs: 10,
    },
    readyTimeoutMs: 500,
    runDeadlineMs: 500,
    terminationTimeoutMs: 500,
    ...overrides,
  });
}

async function readRun(stream: PassThrough): Promise<Record<string, unknown>> {
  for await (const message of decodeFrames(stream)) return message;
  throw new Error("missing RUN");
}

describe("WorkerClient", () => {
  it("writes one RUN, waits for EOF/exit/tree quiescence, and returns RESULT", async () => {
    const process = fakeProcess();
    const onReady = vi.fn();
    const execution = client(process).run(asrRun(), { onReady });
    process.stdout.write(encodeFrame(ready()));
    await expect(readRun(process.stdin)).resolves.toEqual(asrRun());
    process.stdout.end(encodeFrame(result()));
    process.stderr.end();
    process.outcome.resolve({ exitCode: 0, signal: null });

    await expect(execution).resolves.toMatchObject({ type: "result", kind: "asr" });
    expect(process.waitForExit).toHaveBeenCalledTimes(1);
    expect(process.terminate).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ load_ms: 5 }));
  });

  it("surfaces a normally converged Worker ERROR with bounded diagnostics", async () => {
    const process = fakeProcess();
    const execution = client(process).run(asrRun());
    process.stdout.write(encodeFrame(ready()));
    await readRun(process.stdin);
    process.stderr.end(Buffer.concat([Buffer.alloc(70_000, "a"), Buffer.from("tail-marker")]));
    process.stdout.end(encodeFrame(remoteError()));
    process.outcome.resolve({ exitCode: 1, signal: null });

    const error = await execution.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "MODEL_INFERENCE_FAILED",
      stage: "asr",
      stderrTruncated: true,
    });
    expect((error as WorkerClientError).stderrTail).toHaveLength(65_536);
    expect((error as WorkerClientError).stderrTail.endsWith("tail-marker")).toBe(true);
    expect(process.terminate).not.toHaveBeenCalled();
  });

  it("treats RESULT followed by exit 1 as a protocol failure", async () => {
    const process = fakeProcess();
    const execution = client(process).run(asrRun());
    process.stdout.write(encodeFrame(ready()));
    await readRun(process.stdin);
    process.stdout.end(encodeFrame(result()));
    process.stderr.end();
    process.outcome.resolve({ exitCode: 1, signal: null });

    await expect(execution).rejects.toMatchObject({ code: "WORKER_PROTOCOL_ERROR" });
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalled();
  });

  it.each([
    ["EOF without RESULT", Buffer.alloc(0)],
    ["a half frame", Buffer.from([0, 0])],
    [
      "an extra frame after RESULT",
      Buffer.concat([
        encodeFrame(result()),
        encodeFrame({ type: "progress", request_id: "request-1", stage: "asr", ratio: 1 }),
      ]),
    ],
  ])("rejects %s and still converges", async (_label, terminalBytes) => {
    const process = fakeProcess();
    const execution = client(process).run(asrRun());
    process.stdout.write(encodeFrame(ready()));
    await readRun(process.stdin);
    process.stdout.end(terminalBytes);
    process.stderr.end();
    process.outcome.resolve({ exitCode: 0, signal: null });

    await expect(execution).rejects.toMatchObject({ code: "WORKER_PROTOCOL_ERROR" });
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalled();
  });

  it("classifies kill -9 as a process failure", async () => {
    const process = fakeProcess();
    const execution = client(process).run(asrRun());
    process.stdout.write(encodeFrame(ready()));
    await readRun(process.stdin);
    process.stdout.end();
    process.stderr.end();
    process.outcome.resolve({ exitCode: null, signal: "SIGKILL" });

    await expect(execution).rejects.toMatchObject({ code: "WORKER_PROCESS_ERROR" });
  });

  it("terminates and converges the process when cancelled before READY", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const controller = new AbortController();
    const execution = client(process).run(asrRun(), { signal: controller.signal });
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "WORKER_CANCELLED" });
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalled();
  });

  it("terminates and converges when cancelled during an inference stage", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const controller = new AbortController();
    const execution = client(process).run(asrRun(), { signal: controller.signal });
    process.stdout.write(encodeFrame(ready()));
    await readRun(process.stdin);
    process.stdout.write(encodeFrame({
      type: "progress",
      request_id: "request-1",
      stage: "vad",
      ratio: 0.5,
    }));
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "WORKER_CANCELLED" });
    expect(process.terminate).toHaveBeenCalledTimes(1);
  });

  it("enforces the READY timeout without relying on progress", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const execution = client(process, { readyTimeoutMs: 20 }).run(asrRun());

    await expect(execution).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
      phase: "ready",
    });
    expect(process.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not extend the RUN deadline when progress arrives", async () => {
    let interval: NodeJS.Timeout | undefined;
    let process!: FakeProcess;
    process = fakeProcess(() => {
      if (interval !== undefined) clearInterval(interval);
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const execution = client(process, { runDeadlineMs: 30 }).run(asrRun());
    process.stdout.write(encodeFrame(ready()));
    await readRun(process.stdin);
    interval = setInterval(() => {
      process.stdout.write(encodeFrame({
        type: "progress",
        request_id: "request-1",
        stage: "asr",
        ratio: 0.5,
      }));
    }, 5);

    await expect(execution).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
      phase: "run",
    });
    expect(process.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects a handle without all three protocol pipes", async () => {
    const process = fakeProcess();
    const spawner: WorkerSpawner = {
      spawn: () => ({ ...process.handle, stdout: undefined }),
    };
    const workerClient = client(process, { spawner });

    await expect(workerClient.run(asrRun())).rejects.toMatchObject({
      code: "WORKER_PROCESS_ERROR",
    });
  });

  it("rejects an invalid outbound RUN before spawning", async () => {
    const process = fakeProcess();
    const workerClient = client(process);
    const invalid = { ...asrRun(), request_id: "" } as AsrRunMessage;

    await expect(workerClient.run(invalid)).rejects.toMatchObject({
      code: "WORKER_PROTOCOL_ERROR",
    });
  });
});
