import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import {
  runRecordingWorkerServer,
  type LoadedRecordingWorkerRuntime,
} from "../../src/recording/worker-server.js";
import type { RecordingFinalResultPayload } from "../../src/recording/worker-types.js";
import { decodeFrames, writeFrame } from "../../src/worker/framing.js";

const FINGERPRINT = "a".repeat(64);

function finalPayload(): RecordingFinalResultPayload {
  return {
    duration_ms: 5_000,
    source_size_bytes: 160_044,
    source_sha256: "b".repeat(64),
    result_status: "completed",
    result_reason: null,
    segments: [
      { seq: 0, start_ms: 100, end_ms: 4_500, speaker_label: "Speaker A", text: "最终文本。" },
    ],
    audio_files: ["audio.tmp.wav", "mic.tmp.wav"],
    metrics: { finalization_ms: 20, max_rss_bytes: 30, cache_hits: 1, cache_misses: 0 },
  };
}

it("emits READY and revisions before consuming one FINALIZE and returning FINAL_RESULT", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const close = vi.fn(async () => undefined);
  const runtime: LoadedRecordingWorkerRuntime = {
    engineFingerprint: FINGERPRINT,
    close,
    async runDrafts({ signal, publishRevision }) {
      await publishRevision({
        type: "revision",
        revision: 1,
        base_revision: 0,
        replace_from_seq: 0,
        audio_through_ms: 5_000,
        generated_at_ms: 10,
        segments: [
          { seq: 0, start_ms: 100, end_ms: 4_500, speaker_label: null, text: "会中草稿。" },
        ],
      });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    async finalize() { return finalPayload(); },
  };
  const execution = runRecordingWorkerServer({
    input,
    output,
    diagnostics,
    load: async () => runtime,
  });
  await writeFrame(input, {
    type: "finalize",
    request_id: "44444444-4444-4444-8444-444444444444",
    base_transcript_version: 0,
    capture_end_us: 1_788_070_035_123_456,
  });
  input.end();

  const messages: Record<string, unknown>[] = [];
  for await (const message of decodeFrames(output)) messages.push(message);
  await expect(execution).resolves.toBe(0);
  expect(messages.map((message) => message.type)).toEqual(["ready", "revision", "final_result"]);
  expect(messages[2]).toMatchObject({
    request_id: "44444444-4444-4444-8444-444444444444",
    engine_fingerprint: FINGERPRINT,
  });
  expect(close).toHaveBeenCalledTimes(1);
});

it("returns a bounded initialization ERROR when the profile cannot load", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  input.end();
  const execution = runRecordingWorkerServer({
    input,
    output,
    diagnostics,
    load: async () => { throw Object.assign(new Error("private path"), { code: "MODEL_LOAD_FAILED" }); },
  });

  const messages: Record<string, unknown>[] = [];
  for await (const message of decodeFrames(output)) messages.push(message);
  await expect(execution).resolves.toBe(1);
  expect(messages).toEqual([{
    type: "error",
    request_id: null,
    code: "MODEL_LOAD_FAILED",
    stage: "initializing",
    message: "Recording model failed to load",
  }]);
});

it("emits one terminal ERROR if the draft loop crashes before FINALIZE", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const close = vi.fn(async () => undefined);
  const execution = runRecordingWorkerServer({
    input,
    output,
    diagnostics,
    load: async () => ({
      engineFingerprint: FINGERPRINT,
      close,
      async runDrafts() {
        throw Object.assign(new Error("private inference detail"), {
          code: "MODEL_INFERENCE_FAILED",
          stage: "asr",
        });
      },
      async finalize() { return finalPayload(); },
    }),
  });

  const messages: Record<string, unknown>[] = [];
  for await (const message of decodeFrames(output)) messages.push(message);
  input.end();
  await expect(execution).resolves.toBe(1);
  expect(messages.map((message) => message.type)).toEqual(["ready", "error"]);
  expect(messages[1]).toEqual({
    type: "error",
    request_id: null,
    code: "MODEL_INFERENCE_FAILED",
    stage: "asr",
    message: "Recording model inference failed",
  });
  expect(close).toHaveBeenCalledTimes(1);
});
