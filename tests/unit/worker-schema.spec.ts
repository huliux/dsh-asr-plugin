import { describe, expect, it } from "vitest";

import {
  WorkerSchemaError,
  parseRunMessage,
  parseWorkerMessage,
} from "../../src/worker/messages.js";

const fingerprint = "a".repeat(64);

function asrRun(): Record<string, unknown> {
  return {
    type: "run",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: "/managed/audio.wav", duration_ms: 1_000 },
  };
}

function block(seq = 0): Record<string, unknown> {
  return { seq, start_ms: seq * 100, end_ms: seq * 100 + 80, text: `text-${seq}` };
}

function region(): Record<string, unknown> {
  return { start_ms: 0, end_ms: 100 };
}

function diarizationRun(): Record<string, unknown> {
  return {
    type: "run",
    request_id: "request-1",
    kind: "diarization",
    base_transcript_version: 2,
    payload: {
      audio_path: "/managed/audio.wav",
      duration_ms: 1_000,
      blocks: [block()],
      speech_regions: [region()],
    },
  };
}

function ready(): Record<string, unknown> {
  return {
    type: "ready",
    protocol_version: 2,
    kind: "asr",
    engine_fingerprint: fingerprint,
    load_ms: 10,
  };
}

function progress(): Record<string, unknown> {
  return { type: "progress", request_id: "request-1", stage: "vad", ratio: 0.5 };
}

function errorMessage(): Record<string, unknown> {
  return {
    type: "error",
    request_id: "request-1",
    code: "MODEL_INFERENCE_FAILED",
    stage: "asr",
    message: "Inference failed",
  };
}

function asrResult(): Record<string, unknown> {
  return {
    type: "result",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 0,
    payload: {
      blocks: [block()],
      speech_regions: [region()],
      empty_reason: null,
      metrics: { vad_ms: 1, asr_ms: 2, max_rss_bytes: 3 },
    },
  };
}

function diarizationResult(): Record<string, unknown> {
  return {
    type: "result",
    request_id: "request-1",
    kind: "diarization",
    base_transcript_version: 2,
    payload: {
      result_status: "partial",
      result_reason: "unknown_speaker_segments",
      segments: [
        { ...block(0), speaker_label: "Speaker A" },
        { ...block(1), speaker_label: "UNKNOWN" },
      ],
      warnings: [{ code: "BLOCK_TOO_SHORT", seq: 1 }],
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

function withField(
  value: Record<string, unknown>,
  key: string,
  replacement: unknown,
): Record<string, unknown> {
  return { ...value, [key]: replacement };
}

describe("Worker message schemas", () => {
  it("accepts every valid message shape", () => {
    expect(parseRunMessage(asrRun(), "asr").kind).toBe("asr");
    expect(parseRunMessage(diarizationRun(), "diarization").kind).toBe("diarization");
    expect(parseWorkerMessage(ready(), "asr").type).toBe("ready");
    expect(parseWorkerMessage(progress(), "asr").type).toBe("progress");
    expect(parseWorkerMessage(errorMessage(), "asr").type).toBe("error");
    expect(parseWorkerMessage(asrResult(), "asr").type).toBe("result");
    expect(parseWorkerMessage(diarizationResult(), "diarization").type).toBe("result");
  });

  it("rejects non-object roots without leaking implementation errors", () => {
    for (const value of [null, [], "ready", 2]) {
      expect(() => parseWorkerMessage(value, "asr")).toThrow(WorkerSchemaError);
    }
  });

  it.each([
    ["ready", ready(), "asr"],
    ["run", asrRun(), "asr"],
    ["progress", progress(), "asr"],
    ["error", errorMessage(), "asr"],
    ["result", asrResult(), "asr"],
  ] as const)("rejects an unknown top-level field on %s", (_label, message, kind) => {
    expect(() => kind === "asr" && message.type === "run"
      ? parseRunMessage({ ...message, extra: true }, kind)
      : parseWorkerMessage({ ...message, extra: true }, kind))
      .toThrow(WorkerSchemaError);
  });

  it("rejects unknown nested fields", () => {
    const run = asrRun();
    run.payload = { ...(run.payload as Record<string, unknown>), extra: true };
    expect(() => parseRunMessage(run, "asr")).toThrow(WorkerSchemaError);

    const result = asrResult();
    const payload = result.payload as Record<string, unknown>;
    payload.metrics = { ...(payload.metrics as Record<string, unknown>), extra: true };
    expect(() => parseWorkerMessage(result, "asr")).toThrow(WorkerSchemaError);
  });

  it.each([
    ["NaN ratio", () => parseWorkerMessage(withField(progress(), "ratio", Number.NaN), "asr")],
    ["infinite ratio", () => parseWorkerMessage(withField(progress(), "ratio", Infinity), "asr")],
    ["unsafe version", () => parseRunMessage(withField(asrRun(), "base_transcript_version", 2 ** 53), "asr")],
    ["fractional duration", () => {
      const run = asrRun();
      run.payload = { audio_path: "/managed/audio.wav", duration_ms: 1.5 };
      return parseRunMessage(run, "asr");
    }],
    ["negative metric", () => {
      const result = asrResult();
      (result.payload as Record<string, unknown>).metrics = {
        vad_ms: -1,
        asr_ms: 2,
        max_rss_bytes: 3,
      };
      return parseWorkerMessage(result, "asr");
    }],
  ])("rejects %s", (_label, operation) => {
    expect(operation).toThrow(WorkerSchemaError);
  });

  it("enforces identifiers, paths, text and collection limits", () => {
    expect(() => parseRunMessage(withField(asrRun(), "request_id", ""), "asr"))
      .toThrow(WorkerSchemaError);
    expect(() => parseRunMessage(withField(asrRun(), "request_id", "x".repeat(65)), "asr"))
      .toThrow(WorkerSchemaError);

    const relative = asrRun();
    relative.payload = { audio_path: "relative.wav", duration_ms: 1_000 };
    expect(() => parseRunMessage(relative, "asr")).toThrow(WorkerSchemaError);

    const longPath = asrRun();
    longPath.payload = { audio_path: `/${"x".repeat(4_096)}`, duration_ms: 1_000 };
    expect(() => parseRunMessage(longPath, "asr")).toThrow(WorkerSchemaError);

    const longText = asrResult();
    (longText.payload as Record<string, unknown>).blocks = [
      { seq: 0, start_ms: 0, end_ms: 1, text: "x".repeat(20_001) },
    ];
    expect(() => parseWorkerMessage(longText, "asr")).toThrow(WorkerSchemaError);

    const tooMany = diarizationRun();
    (tooMany.payload as Record<string, unknown>).blocks = Array(20_001).fill(block());
    expect(() => parseRunMessage(tooMany, "diarization")).toThrow(WorkerSchemaError);

    expect(() => parseWorkerMessage(
      withField(errorMessage(), "message", "x".repeat(501)),
      "asr",
    )).toThrow(WorkerSchemaError);
  });

  it("caps aggregate JSON-escaped transcript bytes below the frame boundary", () => {
    const result = asrResult();
    (result.payload as Record<string, unknown>).blocks = Array.from(
      { length: 1_259 },
      (_, seq) => ({ seq, start_ms: seq, end_ms: seq, text: "x".repeat(20_000) }),
    );

    expect(() => parseWorkerMessage(result, "asr")).toThrow(WorkerSchemaError);
  });

  it("enforces ASR empty-result and timeline invariants", () => {
    const empty = asrResult();
    const emptyPayload = empty.payload as Record<string, unknown>;
    emptyPayload.blocks = [];
    emptyPayload.empty_reason = "silent";
    expect(parseWorkerMessage(empty, "asr").type).toBe("result");

    emptyPayload.empty_reason = null;
    expect(() => parseWorkerMessage(empty, "asr")).toThrow(WorkerSchemaError);

    const unsorted = asrResult();
    (unsorted.payload as Record<string, unknown>).blocks = [block(1), block(0)];
    expect(() => parseWorkerMessage(unsorted, "asr")).toThrow(WorkerSchemaError);
  });

  it("enforces diarization label, warning and status invariants", () => {
    const skippedLabel = diarizationResult();
    const payload = skippedLabel.payload as Record<string, unknown>;
    payload.segments = [{ ...block(), speaker_label: "Speaker B" }];
    payload.warnings = [];
    payload.result_status = "completed";
    payload.result_reason = null;
    expect(() => parseWorkerMessage(skippedLabel, "diarization")).toThrow(WorkerSchemaError);

    const missingWarning = diarizationResult();
    (missingWarning.payload as Record<string, unknown>).warnings = [];
    expect(() => parseWorkerMessage(missingWarning, "diarization"))
      .toThrow(WorkerSchemaError);

    const falsePartial = diarizationResult();
    const falsePayload = falsePartial.payload as Record<string, unknown>;
    falsePayload.segments = [{ ...block(), speaker_label: "Speaker A" }];
    falsePayload.warnings = [];
    expect(() => parseWorkerMessage(falsePartial, "diarization")).toThrow(WorkerSchemaError);
  });

  it("rejects kind-specific stages and payloads", () => {
    expect(() => parseWorkerMessage(progress(), "diarization")).toThrow(WorkerSchemaError);
    expect(() => parseRunMessage(asrRun(), "diarization")).toThrow(WorkerSchemaError);
    expect(() => parseWorkerMessage(asrResult(), "diarization")).toThrow(WorkerSchemaError);
  });
});
