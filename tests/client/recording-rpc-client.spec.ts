import { expect, it, vi } from "vitest";

import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

import { RecordingRpcClient } from "../../src/client/recording-rpc-client.js";

const view = {
  meetingId: "11111111-1111-4111-8111-111111111111",
  jobId: "meeting-1",
  phase: "recording",
  mic: { requested: true, state: "on", errorCode: null },
  system: { requested: true, state: "on", errorCode: null },
  draftRevision: 2,
  draftStale: false,
  latestAudioAtMs: 1_788_080_005_000,
  latestDraftAtMs: 1_788_080_004_000,
  recordingStartedAtMs: 1_788_080_000_000,
  recordingEndedAtMs: null,
  recordingElapsedMs: 5_000,
  durationMs: null,
  transcriptVersion: null,
  resultStatus: null,
  finalizationMs: null,
  errorCode: null,
} as const;

function rpc(value: unknown): ClientConnectionRpc {
  return { call: vi.fn(async () => ({ ok: true as const, value })) };
}

it("validates the state projection instead of trusting loopback response bytes", async () => {
  const client = new RecordingRpcClient(rpc({
    recording: view,
    hasRecordingHistory: true,
    preview: [{
      seq: 0,
      startMs: 0,
      endMs: 2_000,
      speakerLabel: null,
      text: "草稿",
    }],
  }));

  await expect(client.state()).resolves.toMatchObject({
    recording: {
      phase: "recording",
      draftRevision: 2,
      draftStale: false,
      recordingStartedAtMs: 1_788_080_000_000,
      recordingElapsedMs: 5_000,
    },
    hasRecordingHistory: true,
    preview: [{ speakerLabel: null, text: "草稿" }],
  });
});

it("rejects response objects with unknown fields", async () => {
  const client = new RecordingRpcClient(rpc({
    recording: { ...view, processId: 42 },
    hasRecordingHistory: true,
    preview: [],
  }));

  await expect(client.state()).rejects.toThrow("INVALID_RESPONSE");
});

it("rejects recording views without a canonical Meeting UUID", async () => {
  const client = new RecordingRpcClient(rpc({
    recording: { ...view, meetingId: "MEETING-1" },
    hasRecordingHistory: true,
    preview: [],
  }));

  await expect(client.state()).rejects.toThrow("INVALID_RESPONSE");
});

it("rejects nullable or negative required recording counters", async () => {
  const nullableRevision = new RecordingRpcClient(rpc({
    recording: { ...view, draftRevision: null },
    hasRecordingHistory: true,
    preview: [],
  }));
  const negativeAudio = new RecordingRpcClient(rpc({
    recording: { ...view, latestAudioAtMs: -1 },
    hasRecordingHistory: true,
    preview: [],
  }));
  const elapsedWithoutStart = new RecordingRpcClient(rpc({
    recording: { ...view, recordingStartedAtMs: null },
    hasRecordingHistory: true,
    preview: [],
  }));

  await expect(nullableRevision.state()).rejects.toThrow("INVALID_RESPONSE");
  await expect(negativeAudio.state()).rejects.toThrow("INVALID_RESPONSE");
  await expect(elapsedWithoutStart.state()).rejects.toThrow("INVALID_RESPONSE");
});

it("rejects negative or inverted transcript segments", async () => {
  const negativeSeq = new RecordingRpcClient(rpc({
    recording: view,
    hasRecordingHistory: true,
    preview: [{ seq: -1, startMs: 0, endMs: 2_000, speakerLabel: null, text: "草稿" }],
  }));
  const invertedRange = new RecordingRpcClient(rpc({
    recording: view,
    hasRecordingHistory: true,
    preview: [{ seq: 0, startMs: 2_000, endMs: 1_000, speakerLabel: null, text: "草稿" }],
  }));

  await expect(negativeSeq.state()).rejects.toThrow("INVALID_RESPONSE");
  await expect(invertedRange.state()).rejects.toThrow("INVALID_RESPONSE");
});

it("严格解析 Meeting reference 候选并使用 namespaced endpoint", async () => {
  const connection = rpc([{
    meeting_id: "11111111-1111-4111-8111-111111111111",
    label: "产品周会",
    origin: "recording",
    phase: "recording",
    started_at: "2026-09-01T00:00:01.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    recording_elapsed_ms: 5_000,
    duration_ms: null,
  }]);
  const client = new RecordingRpcClient(connection);
  const signal = new AbortController().signal;

  await expect(client.referenceCandidates({
    session_id: "session-1",
    locale: "zh-CN",
    query: "产品",
  }, signal)).resolves.toEqual([{
    meeting_id: "11111111-1111-4111-8111-111111111111",
    label: "产品周会",
    origin: "recording",
    phase: "recording",
    started_at: "2026-09-01T00:00:01.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    recording_elapsed_ms: 5_000,
    duration_ms: null,
  }]);
  expect(connection.call).toHaveBeenCalledWith(
    "/api",
    "dsh-asr-recording/references/candidates",
    { session_id: "session-1", locale: "zh-CN", query: "产品" },
    signal,
  );
});

it("提交前通过 resolve endpoint 重验单个 Meeting", async () => {
  const candidate = {
    meeting_id: "11111111-1111-4111-8111-111111111111",
    label: "产品周会",
    origin: "import",
    phase: "completed",
    started_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    recording_elapsed_ms: null,
    duration_ms: 10_000,
  } as const;
  const connection = rpc(candidate);
  const client = new RecordingRpcClient(connection);

  await expect(client.resolveMeetingReference({
    locale: "zh-CN",
    meeting_id: candidate.meeting_id,
  })).resolves.toEqual(candidate);
  expect(connection.call).toHaveBeenCalledWith(
    "/api",
    "dsh-asr-recording/references/resolve",
    {
      locale: "zh-CN",
      meeting_id: candidate.meeting_id,
    },
    undefined,
  );
});

it("接受 Meeting 处理阶段而不把它误当成录音控制阶段", async () => {
  const candidate = {
    meeting_id: "11111111-1111-4111-8111-111111111111",
    label: "处理中会议",
    origin: "import",
    phase: "processing",
    started_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    recording_elapsed_ms: null,
    duration_ms: null,
  } as const;

  await expect(new RecordingRpcClient(rpc([candidate])).referenceCandidates({
    session_id: "session-1",
    locale: "zh-CN",
  })).resolves.toEqual([candidate]);
});

it("prepares models with a fixed empty request and validates the acknowledgement", async () => {
  const connection = rpc(null);
  const signal = new AbortController().signal;
  await expect(new RecordingRpcClient(connection).prepareModels(signal)).resolves.toBeUndefined();
  expect(connection.call).toHaveBeenCalled();
  await expect(new RecordingRpcClient(rpc({ path: "/other" })).prepareModels()).rejects.toThrow("INVALID_RESPONSE");
});
