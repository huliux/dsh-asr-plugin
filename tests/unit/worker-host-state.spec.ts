import { describe, expect, it } from "vitest";

import { parseWorkerMessage } from "../../src/worker/messages.js";
import {
  WorkerHostState,
  WorkerProtocolError,
} from "../../src/worker/host-state.js";
import type { AsrRunMessage, DiarizationRunMessage } from "../../src/worker/types.js";

const fingerprint = "b".repeat(64);

function asrRun(): AsrRunMessage {
  return {
    type: "run",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 3,
    payload: { audio_path: "/managed/audio.wav", duration_ms: 1_000 },
  };
}

function diarizationRun(): DiarizationRunMessage {
  return {
    type: "run",
    request_id: "request-1",
    kind: "diarization",
    base_transcript_version: 3,
    payload: {
      audio_path: "/managed/audio.wav",
      duration_ms: 1_000,
      blocks: [{ seq: 0, start_ms: 0, end_ms: 80, text: "hello" }],
      speech_regions: [{ start_ms: 0, end_ms: 100 }],
    },
  };
}

function ready(kind: "asr" | "diarization" = "asr"): Record<string, unknown> {
  return {
    type: "ready",
    protocol_version: 2,
    kind,
    engine_fingerprint: fingerprint,
    load_ms: 5,
  };
}

function asrResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 3,
    payload: {
      blocks: [{ seq: 0, start_ms: 0, end_ms: 80, text: "hello" }],
      speech_regions: [{ start_ms: 0, end_ms: 100 }],
      empty_reason: null,
      metrics: { vad_ms: 1, asr_ms: 2, max_rss_bytes: 3 },
    },
    ...overrides,
  };
}

function diarizationResult(text = "hello"): Record<string, unknown> {
  return {
    type: "result",
    request_id: "request-1",
    kind: "diarization",
    base_transcript_version: 3,
    payload: {
      result_status: "completed",
      result_reason: null,
      segments: [
        { seq: 0, start_ms: 0, end_ms: 80, text, speaker_label: "Speaker A" },
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

function errorMessage(requestId: string | null): Record<string, unknown> {
  return {
    type: "error",
    request_id: requestId,
    code: "MODEL_INFERENCE_FAILED",
    stage: requestId === null ? "initializing" : "asr",
    message: "failed",
  };
}

describe("Worker Host state machine", () => {
  it("accepts RESULT only after READY and clean exit 0", () => {
    const state = new WorkerHostState({
      expectedFingerprint: fingerprint,
      run: asrRun(),
    });
    expect(state.receive(parseWorkerMessage(ready(), "asr"))).toEqual({ type: "send_run" });
    expect(state.receive(parseWorkerMessage(asrResult(), "asr"))).toEqual({ type: "terminal" });
    expect(state.finish({ exitCode: 0, signal: null })).toMatchObject({ type: "result" });
  });

  it("accepts initialization ERROR only before READY and with exit 1", () => {
    const state = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    state.receive(parseWorkerMessage(errorMessage(null), "asr"));
    expect(state.finish({ exitCode: 1, signal: null })).toMatchObject({ type: "error" });
  });

  it.each([
    ["progress before READY", { type: "progress", request_id: "request-1", stage: "vad", ratio: 0 }],
    ["result before READY", asrResult()],
    ["ERROR with request before READY", errorMessage("request-1")],
  ])("rejects %s", (_label, raw) => {
    const state = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    expect(() => state.receive(parseWorkerMessage(raw, "asr"))).toThrow(WorkerProtocolError);
  });

  it("rejects duplicate READY and any message after a terminal frame", () => {
    const duplicate = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    duplicate.receive(parseWorkerMessage(ready(), "asr"));
    expect(() => duplicate.receive(parseWorkerMessage(ready(), "asr")))
      .toThrow(WorkerProtocolError);

    const extra = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    extra.receive(parseWorkerMessage(ready(), "asr"));
    extra.receive(parseWorkerMessage(asrResult(), "asr"));
    expect(() => extra.receive(parseWorkerMessage(
      { type: "progress", request_id: "request-1", stage: "asr", ratio: 1 },
      "asr",
    ))).toThrow(WorkerProtocolError);
  });

  it("rejects mismatched fingerprint, request and base version", () => {
    const fingerprintMismatch = new WorkerHostState({
      expectedFingerprint: "c".repeat(64),
      run: asrRun(),
    });
    expect(() => fingerprintMismatch.receive(parseWorkerMessage(ready(), "asr")))
      .toThrow(WorkerProtocolError);

    for (const override of [
      { request_id: "other" },
      { base_transcript_version: 4 },
    ]) {
      const state = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
      state.receive(parseWorkerMessage(ready(), "asr"));
      expect(() => state.receive(parseWorkerMessage(asrResult(override), "asr")))
        .toThrow(WorkerProtocolError);
    }
  });

  it("caps progress messages at 1000", () => {
    const state = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    state.receive(parseWorkerMessage(ready(), "asr"));
    const progress = parseWorkerMessage(
      { type: "progress", request_id: "request-1", stage: "vad", ratio: 0.5 },
      "asr",
    );
    for (let index = 0; index < 1_000; index += 1) state.receive(progress);
    expect(() => state.receive(progress)).toThrow(WorkerProtocolError);
  });

  it("rejects EOF without terminal and terminal/exit mismatches", () => {
    const noResult = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    noResult.receive(parseWorkerMessage(ready(), "asr"));
    expect(() => noResult.finish({ exitCode: 0, signal: null })).toThrow(WorkerProtocolError);

    const resultExitOne = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    resultExitOne.receive(parseWorkerMessage(ready(), "asr"));
    resultExitOne.receive(parseWorkerMessage(asrResult(), "asr"));
    expect(() => resultExitOne.finish({ exitCode: 1, signal: null })).toThrow(WorkerProtocolError);

    const errorExitZero = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    errorExitZero.receive(parseWorkerMessage(errorMessage(null), "asr"));
    expect(() => errorExitZero.finish({ exitCode: 0, signal: null })).toThrow(WorkerProtocolError);
  });

  it("checks ASR result timestamps against the RUN duration", () => {
    const result = asrResult();
    (result.payload as Record<string, unknown>).blocks = [
      { seq: 0, start_ms: 900, end_ms: 1_001, text: "late" },
    ];
    const state = new WorkerHostState({ expectedFingerprint: fingerprint, run: asrRun() });
    state.receive(parseWorkerMessage(ready(), "asr"));
    expect(() => state.receive(parseWorkerMessage(result, "asr"))).toThrow(WorkerProtocolError);
  });

  it("requires diarization to conserve every ASR block", () => {
    const state = new WorkerHostState({ expectedFingerprint: fingerprint, run: diarizationRun() });
    state.receive(parseWorkerMessage(ready("diarization"), "diarization"));
    expect(() => state.receive(parseWorkerMessage(diarizationResult("changed"), "diarization")))
      .toThrow(WorkerProtocolError);
  });
});
