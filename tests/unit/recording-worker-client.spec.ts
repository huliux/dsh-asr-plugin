import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { RecordingWorkerClient } from "../../src/recording/worker-client.js";
import type { RecordingFinalizeMessage } from "../../src/recording/worker-types.js";
import { decodeFrames, encodeFrame } from "../../src/worker/framing.js";
import type {
  WorkerProcessHandle,
  WorkerProcessOutcome,
  WorkerSpawner,
} from "../../src/worker/process.js";

const FINGERPRINT = "d".repeat(64);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
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
    handle: { stdin, stdout, stderr, done: outcome.promise, terminate, waitForExit },
  };
}

function client(
  process: FakeProcess,
  overrides: Partial<ConstructorParameters<typeof RecordingWorkerClient>[0]> = {},
): RecordingWorkerClient {
  const spawner: WorkerSpawner = { spawn: vi.fn(() => process.handle) };
  return new RecordingWorkerClient({
    expectedFingerprint: FINGERPRINT,
    spawner,
    launch: {
      argv: [globalThis.process.execPath, "/worker/recording-entry.js"],
      cwd: "/worker",
      environment: { LANG: "C.UTF-8" },
      graceMs: 10,
    },
    readyTimeoutMs: 500,
    finalizeDeadlineMs: 500,
    terminationTimeoutMs: 500,
    ...overrides,
  });
}

function ready(): Record<string, unknown> {
  return {
    type: "ready",
    recording_protocol_version: 1,
    kind: "recording",
    engine_fingerprint: FINGERPRINT,
    load_ms: 5,
  };
}

const FINALIZE: RecordingFinalizeMessage = {
  type: "finalize",
  request_id: "44444444-4444-4444-8444-444444444444",
  base_transcript_version: 0,
  capture_end_us: 1_788_070_035_123_456,
};

function finalResult(): Record<string, unknown> {
  return {
    type: "final_result",
    request_id: FINALIZE.request_id,
    base_transcript_version: 0,
    engine_fingerprint: FINGERPRINT,
    payload: {
      duration_ms: 5_000,
      source_size_bytes: 160_044,
      source_sha256: "e".repeat(64),
      result_status: "completed",
      result_reason: null,
      segments: [
        { seq: 0, start_ms: 100, end_ms: 4_500, speaker_label: "Speaker A", text: "最终文本。" },
      ],
      audio_files: ["audio.tmp.wav", "mic.tmp.wav"],
      metrics: { finalization_ms: 20, max_rss_bytes: 30, cache_hits: 1, cache_misses: 0 },
    },
  };
}

async function readOneFrame(stream: PassThrough): Promise<Record<string, unknown>> {
  const next = await decodeFrames(stream)[Symbol.asyncIterator]().next();
  if (next.done) throw new Error("missing frame");
  return next.value;
}

describe("RecordingWorkerClient", () => {
  it("times out before READY and converges the process tree", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });

    await expect(client(process, { readyTimeoutMs: 10 }).start()).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
      phase: "ready",
    });
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalledTimes(1);
  });

  it("treats explicit recording termination as cancellation after tree settlement", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const starting = client(process).start();
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;

    await expect(session.terminate()).resolves.toBeUndefined();
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalledTimes(1);
  });

  it("keeps one framed session alive through revisions and one FINALIZE", async () => {
    const process = fakeProcess();
    const onRevision = vi.fn();
    const starting = client(process).start({ onRevision });
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;

    process.stdout.write(encodeFrame({
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 10,
      segments: [
        { seq: 0, start_ms: 100, end_ms: 4_500, speaker_label: null, text: "会中草稿。" },
      ],
    }));
    await vi.waitFor(() => expect(onRevision).toHaveBeenCalledTimes(1));
    expect(session.snapshot()).toMatchObject({ revision: 1, segments: [{ text: "会中草稿。" }] });

    const finalizing = session.finalize(FINALIZE);
    await expect(readOneFrame(process.stdin)).resolves.toEqual(FINALIZE);
    process.stdout.end(encodeFrame(finalResult()));
    process.stderr.end();
    process.outcome.resolve({ exitCode: 0, signal: null });

    await expect(finalizing).resolves.toMatchObject({ type: "final_result" });
    expect(process.waitForExit).toHaveBeenCalledTimes(1);
    expect(process.terminate).not.toHaveBeenCalled();
  });

  it("accepts an in-flight revision after FINALIZE before the terminal result", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const onRevision = vi.fn();
    const starting = client(process).start({ onRevision });
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;

    const finalizing = session.finalize(FINALIZE);
    await expect(readOneFrame(process.stdin)).resolves.toEqual(FINALIZE);
    process.stdout.write(encodeFrame({
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 10,
      segments: [
        { seq: 0, start_ms: 100, end_ms: 4_500, speaker_label: null, text: "收尾前草稿。" },
      ],
    }));
    process.stdout.end(encodeFrame(finalResult()));
    process.stderr.end();
    process.outcome.resolve({ exitCode: 0, signal: null });

    await expect(finalizing).resolves.toMatchObject({ type: "final_result" });
    expect(onRevision).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      revision: 1,
      segments: [{ text: "收尾前草稿。" }],
    });
    expect(process.terminate).not.toHaveBeenCalled();
  });

  it("accepts an in-flight warning after FINALIZE before the terminal result", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const onWarning = vi.fn();
    const starting = client(process).start({ onWarning });
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;

    const finalizing = session.finalize(FINALIZE);
    await expect(readOneFrame(process.stdin)).resolves.toEqual(FINALIZE);
    process.stdout.write(encodeFrame({
      type: "warning",
      code: "DRAFT_STALE",
      stage: "asr",
      message: "Draft processing is behind the recording cadence",
    }));
    process.stdout.end(encodeFrame(finalResult()));
    process.stderr.end();
    process.outcome.resolve({ exitCode: 0, signal: null });

    await expect(finalizing).resolves.toMatchObject({ type: "final_result" });
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(process.terminate).not.toHaveBeenCalled();
  });

  it("terminates and classifies a failed FINALIZE pipe write", async () => {
    let process!: FakeProcess;
    process = fakeProcess(() => {
      process.stdout.end();
      process.stderr.end();
      process.outcome.resolve({ exitCode: null, signal: "SIGTERM" });
    });
    const starting = client(process).start();
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;
    process.stdin.destroy(new Error("pipe closed"));

    await expect(session.finalize(FINALIZE)).rejects.toMatchObject({
      code: "WORKER_PROCESS_ERROR",
    });
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalled();
  });

  it("classifies clean EOF without a terminal after a long recording as protocol failure", async () => {
    const process = fakeProcess();
    const starting = client(process, { readyTimeoutMs: 10 }).start();
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;
    await new Promise((resolve) => setTimeout(resolve, 15));
    process.stdout.end();
    process.stderr.end();
    process.outcome.resolve({ exitCode: 0, signal: null });

    await expect(session.completion).rejects.toMatchObject({
      code: "WORKER_PROTOCOL_ERROR",
    });
  });

  it("classifies a Worker crash after READY without losing the last accepted snapshot", async () => {
    const process = fakeProcess();
    const starting = client(process).start();
    process.stdout.write(encodeFrame(ready()));
    const session = await starting;
    process.stdout.write(encodeFrame({
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 10,
      segments: [
        { seq: 0, start_ms: 100, end_ms: 4_500, speaker_label: null, text: "会中草稿。" },
      ],
    }));
    await vi.waitFor(() => expect(session.snapshot().revision).toBe(1));
    process.stdout.end();
    process.stderr.end();
    process.outcome.resolve({ exitCode: 1, signal: null });

    await expect(session.completion).rejects.toMatchObject({ code: "WORKER_PROTOCOL_ERROR" });
    expect(session.snapshot()).toMatchObject({ revision: 1, segments: [{ text: "会中草稿。" }] });
  });
});
