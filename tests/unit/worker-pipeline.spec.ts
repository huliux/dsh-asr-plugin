import { describe, expect, it, vi } from "vitest";

import { runWorkerPipeline } from "../../src/worker/worker-pipeline.js";
import type {
  AsrResultMessage,
  DiarizationResultMessage,
  WorkerResultMessage,
  WorkerRunMessage,
} from "../../src/worker/types.js";

function asrResult(empty = false): AsrResultMessage {
  return {
    type: "result",
    request_id: "asr-request",
    kind: "asr",
    base_transcript_version: 2,
    payload: {
      blocks: empty ? [] : [{ seq: 0, start_ms: 0, end_ms: 80, text: "hello" }],
      speech_regions: empty ? [] : [{ start_ms: 0, end_ms: 100 }],
      empty_reason: empty ? "silent" : null,
      metrics: { vad_ms: 1, asr_ms: 2, max_rss_bytes: 3 },
    },
  };
}

function diarizationResult(): DiarizationResultMessage {
  return {
    type: "result",
    request_id: "diar-request",
    kind: "diarization",
    base_transcript_version: 2,
    payload: {
      result_status: "completed",
      result_reason: null,
      segments: [
        { seq: 0, start_ms: 0, end_ms: 80, text: "hello", speaker_label: "Speaker A" },
      ],
      warnings: [],
      metrics: {
        fbank_ms: 1,
        embed_ms: 2,
        cluster_ms: 3,
        assign_ms: 4,
        max_rss_bytes: 5,
      },
    },
  };
}

function asrRun() {
  return {
    type: "run",
    request_id: "asr-request",
    kind: "asr",
    base_transcript_version: 2,
    payload: { audio_path: "/meeting/audio.wav", duration_ms: 1_000 },
  } as const;
}

describe("two-Worker pipeline results", () => {
  it("skips diarization for a valid empty ASR result", async () => {
    const asr = { run: vi.fn(async () => asrResult(true) as WorkerResultMessage) };
    const diarization = { run: vi.fn() };
    const onHandoff = vi.fn();

    await expect(runWorkerPipeline({
      asr,
      diarization,
      asrRun: asrRun(),
      diarizationRequestId: "diar-request",
      onHandoff,
    })).resolves.toMatchObject({ type: "empty" });
    expect(diarization.run).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it("forwards only the validated ASR result into diarization", async () => {
    const asr = { run: vi.fn(async () => asrResult() as WorkerResultMessage) };
    const onHandoff = vi.fn();
    const diarization = {
      run: vi.fn(async (_run: WorkerRunMessage) => diarizationResult() as WorkerResultMessage),
    };

    await expect(runWorkerPipeline({
      asr,
      diarization,
      asrRun: asrRun(),
      diarizationRequestId: "diar-request",
      onHandoff,
    })).resolves.toMatchObject({ type: "diarized" });
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(diarization.run).toHaveBeenCalledWith({
      type: "run",
      request_id: "diar-request",
      kind: "diarization",
      base_transcript_version: 2,
      payload: {
        audio_path: "/meeting/audio.wav",
        duration_ms: 1_000,
        blocks: asrResult().payload.blocks,
        speech_regions: asrResult().payload.speech_regions,
      },
    }, {});
  });
});

describe("two-Worker pipeline cancellation", () => {
  it("checks the cancellation latch in the handoff gap", async () => {
    const controller = new AbortController();
    const asr = {
      async run() {
        controller.abort();
        return asrResult();
      },
    };
    const diarization = { run: vi.fn() };

    await expect(runWorkerPipeline({
      asr,
      diarization,
      asrRun: asrRun(),
      diarizationRequestId: "diar-request",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "WORKER_CANCELLED" });
    expect(diarization.run).not.toHaveBeenCalled();
  });
});
