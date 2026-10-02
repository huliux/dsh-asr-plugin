import { describe, expect, it } from "vitest";

import { RecordingWorkerHostState } from "../../src/recording/worker-host-state.js";
import {
  parseRecordingFinalizeMessage,
  parseRecordingWorkerMessage,
} from "../../src/recording/worker-messages.js";

const FINGERPRINT = "a".repeat(64);

describe("RecordingWorkerHostState", () => {
  it("accepts READY followed by the first bounded draft revision", () => {
    const state = new RecordingWorkerHostState({ expectedFingerprint: FINGERPRINT });

    expect(state.receive(parseRecordingWorkerMessage({
      type: "ready",
      recording_protocol_version: 1,
      kind: "recording",
      engine_fingerprint: FINGERPRINT,
      load_ms: 900,
    }))).toEqual({ type: "ready" });

    const event = state.receive(parseRecordingWorkerMessage({
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 1_788_070_000_000,
      segments: [{
        seq: 0,
        start_ms: 120,
        end_ms: 4_700,
        speaker_label: null,
        text: "开始讨论。",
      }],
    }));

    expect(event).toMatchObject({ type: "revision", snapshot: { revision: 1 } });
    expect(state.snapshot()).toEqual({
      revision: 1,
      audioThroughMs: 5_000,
      generatedAtMs: 1_788_070_000_000,
      segments: [{
        seq: 0,
        startMs: 120,
        endMs: 4_700,
        speakerLabel: null,
        text: "开始讨论。",
      }],
    });
  });

  it("does not expose mutable references to the accepted draft snapshot", () => {
    const state = new RecordingWorkerHostState({ expectedFingerprint: FINGERPRINT });
    state.receive(parseRecordingWorkerMessage({
      type: "ready",
      recording_protocol_version: 1,
      kind: "recording",
      engine_fingerprint: FINGERPRINT,
      load_ms: 1,
    }));
    const event = state.receive(parseRecordingWorkerMessage({
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 10,
      segments: [{
        seq: 0,
        start_ms: 120,
        end_ms: 4_900,
        speaker_label: null,
        text: "原始草稿。",
      }],
    }));
    if (event.type !== "revision") throw new Error("revision event expected");
    (event.snapshot.segments as unknown as Array<{ text: string }>)[0]!.text = "外部篡改";

    expect(state.snapshot().segments).toEqual([expect.objectContaining({ text: "原始草稿。" })]);
  });


  it("rejects non-exact or unsafe READY and revision messages", () => {
    const ready = {
      type: "ready",
      recording_protocol_version: 1,
      kind: "recording",
      engine_fingerprint: FINGERPRINT,
      load_ms: 900,
    };
    const revision = {
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 1_788_070_000_000,
      segments: [{
        seq: 0,
        start_ms: 120,
        end_ms: 4_700,
        speaker_label: null,
        text: "开始讨论。",
      }],
    };
    const invalid = [
      { ...ready, extra: true },
      { ...ready, engine_fingerprint: "A".repeat(64) },
      { ...ready, load_ms: -1 },
      { ...revision, extra: true },
      { ...revision, revision: 1.5 },
      { ...revision, audio_through_ms: Number.MAX_SAFE_INTEGER + 1 },
      { ...revision, segments: [{ ...revision.segments[0], speaker_label: "Speaker A" }] },
      { ...revision, segments: [{ ...revision.segments[0], text: "  " }] },
      { ...revision, segments: [{ ...revision.segments[0], seq: 1 }] },
      { ...revision, segments: [{ ...revision.segments[0], start_ms: 4_701 }] },
    ];

    for (const message of invalid) {
      expect(() => parseRecordingWorkerMessage(message)).toThrow(
        expect.objectContaining({ code: "SCHEMA_VIOLATION" }),
      );
    }
  });

  it("atomically replaces a suffix and rejects a broken revision chain", () => {
    const state = new RecordingWorkerHostState({ expectedFingerprint: FINGERPRINT });
    state.receive(parseRecordingWorkerMessage({
      type: "ready",
      recording_protocol_version: 1,
      kind: "recording",
      engine_fingerprint: FINGERPRINT,
      load_ms: 1,
    }));
    state.receive(parseRecordingWorkerMessage({
      type: "revision",
      revision: 1,
      base_revision: 0,
      replace_from_seq: 0,
      audio_through_ms: 5_000,
      generated_at_ms: 10,
      segments: [
        { seq: 0, start_ms: 100, end_ms: 2_000, speaker_label: null, text: "第一段。" },
        { seq: 1, start_ms: 2_100, end_ms: 4_500, speaker_label: null, text: "旧尾段。" },
      ],
    }));
    state.receive(parseRecordingWorkerMessage({
      type: "revision",
      revision: 2,
      base_revision: 1,
      replace_from_seq: 1,
      audio_through_ms: 6_000,
      generated_at_ms: 20,
      segments: [
        { seq: 1, start_ms: 2_050, end_ms: 4_000, speaker_label: null, text: "新尾段一。" },
        { seq: 2, start_ms: 4_100, end_ms: 5_800, speaker_label: null, text: "新尾段二。" },
      ],
    }));
    const accepted = state.snapshot();
    expect(accepted.segments.map((segment) => segment.text)).toEqual([
      "第一段。",
      "新尾段一。",
      "新尾段二。",
    ]);

    const invalid = [
      { revision: 4, base_revision: 2, replace_from_seq: 3, audio_through_ms: 7_000, segments: [] },
      { revision: 3, base_revision: 1, replace_from_seq: 3, audio_through_ms: 7_000, segments: [] },
      { revision: 3, base_revision: 2, replace_from_seq: 4, audio_through_ms: 7_000, segments: [] },
      { revision: 3, base_revision: 2, replace_from_seq: 3, audio_through_ms: 5_999, segments: [] },
      {
        revision: 3,
        base_revision: 2,
        replace_from_seq: 1,
        audio_through_ms: 7_000,
        segments: [
          { seq: 1, start_ms: 50, end_ms: 90, speaker_label: null, text: "时间倒退。" },
        ],
      },
    ];
    for (const patch of invalid) {
      expect(() => state.receive(parseRecordingWorkerMessage({
        type: "revision",
        generated_at_ms: 30,
        ...patch,
      }))).toThrow(expect.objectContaining({ code: "WORKER_PROTOCOL_ERROR" }));
      expect(state.snapshot()).toStrictEqual(accepted);
    }
  });

  it("accepts a warning and one FINALIZE before the matching FINAL_RESULT", () => {
    const state = new RecordingWorkerHostState({ expectedFingerprint: FINGERPRINT });
    state.receive(parseRecordingWorkerMessage({
      type: "ready",
      recording_protocol_version: 1,
      kind: "recording",
      engine_fingerprint: FINGERPRINT,
      load_ms: 900,
    }));

    expect(state.receive(parseRecordingWorkerMessage({
      type: "warning",
      code: "DRAFT_STALE",
      stage: "asr",
      message: "Draft cadence missed once",
    }))).toMatchObject({ type: "warning", message: { code: "DRAFT_STALE" } });

    const finalize = parseRecordingFinalizeMessage({
      type: "finalize",
      request_id: "44444444-4444-4444-8444-444444444444",
      base_transcript_version: 0,
      capture_end_us: 1_788_070_035_123_456,
    });
    expect(state.beginFinalize(finalize)).toBe(finalize);

    const result = parseRecordingWorkerMessage({
      type: "final_result",
      request_id: "44444444-4444-4444-8444-444444444444",
      base_transcript_version: 0,
      engine_fingerprint: FINGERPRINT,
      payload: {
        duration_ms: 35_124,
        source_size_bytes: 1_124_012,
        source_sha256: "b".repeat(64),
        result_status: "completed",
        result_reason: null,
        segments: [{
          seq: 0,
          start_ms: 120,
          end_ms: 34_700,
          speaker_label: "Speaker A",
          text: "最终文本。",
        }],
        audio_files: ["audio.tmp.wav", "mic.tmp.wav", "system.tmp.wav"],
        metrics: {
          finalization_ms: 5_450,
          max_rss_bytes: 1_900_000_000,
          cache_hits: 420,
          cache_misses: 3,
        },
      },
    });
    expect(state.receive(result)).toEqual({ type: "terminal" });
    expect(state.finish({ exitCode: 0, signal: null })).toEqual({
      type: "result",
      message: result,
    });
  });

  it("rejects an initialization error after FINALIZE and keeps awaiting its terminal", () => {
    const state = new RecordingWorkerHostState({ expectedFingerprint: FINGERPRINT });
    state.receive(parseRecordingWorkerMessage({
      type: "ready",
      recording_protocol_version: 1,
      kind: "recording",
      engine_fingerprint: FINGERPRINT,
      load_ms: 1,
    }));
    state.beginFinalize(parseRecordingFinalizeMessage({
      type: "finalize",
      request_id: "44444444-4444-4444-8444-444444444444",
      base_transcript_version: 0,
      capture_end_us: 1,
    }));

    expect(() => state.receive(parseRecordingWorkerMessage({
      type: "error",
      request_id: "44444444-4444-4444-8444-444444444444",
      code: "MODEL_LOAD_FAILED",
      stage: "initializing",
      message: "Worker failed during finalization",
    }))).toThrow(expect.objectContaining({ code: "WORKER_PROTOCOL_ERROR" }));

    const error = parseRecordingWorkerMessage({
      type: "error",
      request_id: "44444444-4444-4444-8444-444444444444",
      code: "MODEL_INFERENCE_FAILED",
      stage: "asr",
      message: "Worker failed during finalization",
    });
    expect(state.receive(error)).toEqual({ type: "terminal" });
    expect(state.finish({ exitCode: 1, signal: null })).toEqual({ type: "error", message: error });
  });
});
