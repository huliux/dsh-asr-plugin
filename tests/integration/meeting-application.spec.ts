import { createProcessingIdentity } from "../../src/assets/processing-identity.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobId } from "@deepseek-ai/dsh-jobs";
import { afterEach, expect, it } from "vitest";

import { ManagedAudioError } from "../../src/audio/managed-audio-error.js";
import { RuntimeAssetsError } from "../../src/assets/runtime-assets-error.js";
import { AssetVerificationError } from "../../src/assets/verify-assets.js";
import {
  MeetingRepositoryError,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import { decodeTranscriptCursor, encodeTranscriptCursor } from "../../src/storage/query-cursor.js";
import { WorkerClientError } from "../../src/worker/worker-client.js";
import {
  deferred,
  MEETING_ID,
  TestAudioStore,
  asrResult,
  createMeetingApplicationHarness,
  diarizationResult,
  failingRunner,
  immediateRunner,
  type CreateMeetingApplicationHarnessOptions,
  type MeetingApplicationHarness,
} from "../helpers/meeting-application-fixture.js";
import {
  commitMeeting,
  meetingId,
  retranscribeRunId,
} from "../helpers/meeting-repository-fixture.js";

const harnesses: MeetingApplicationHarness[] = [];
const outputRoots: string[] = [];

async function harness(
  options: CreateMeetingApplicationHarnessOptions = {},
): Promise<MeetingApplicationHarness> {
  const value = await createMeetingApplicationHarness(options);
  harnesses.push(value);
  return value;
}

async function settled(value: MeetingApplicationHarness, jobId: string) {
  return value.context.jobs.wait(JobId(jobId), 2_000);
}

function failCommit(repository: MeetingRepository): MeetingRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "commitTranscript") {
        return () => {
          throw new MeetingRepositoryError("STORAGE_FAILURE", "injected commit failure");
        };
      }
      const member = Reflect.get(target, property) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

afterEach(async () => {
  for (const value of harnesses.splice(0)) await value.dispose();
  for (const root of outputRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([
  {
    name: "completed",
    asr: immediateRunner(asrResult()),
    diarization: immediateRunner(diarizationResult()),
    expectedStatus: "completed",
    expectedSegments: 1,
  },
  {
    name: "partial",
    asr: immediateRunner(asrResult()),
    diarization: immediateRunner(diarizationResult(true)),
    expectedStatus: "partial",
    expectedSegments: 1,
  },
  {
    name: "empty",
    asr: immediateRunner(asrResult(true)),
    diarization: failingRunner(new Error("diarization must not start")),
    expectedStatus: "empty",
    expectedSegments: 0,
  },
])("完成 $name 导入并原子发布可读版本", async ({
  asr,
  diarization,
  expectedStatus,
  expectedSegments,
}) => {
  const value = await harness({ asr, diarization });
  const started = await value.application.startImport({ path: "/input/weekly-review.wav" });
  expect(started).toEqual({ meetingId: MEETING_ID, jobId: "meeting-1", status: "processing" });
  expect(value.application.activeJobIdFor(value.repository.getMeeting(MEETING_ID)!))
    .toBe(started.jobId);

  await expect(settled(value, started.jobId)).resolves.toMatchObject({ status: "completed" });
  const page = value.repository.getMeetingPage({ meetingId: MEETING_ID });
  expect(page.meeting).toMatchObject({
    title: "weekly-review",
    status: expectedStatus,
    committedStatus: expectedStatus,
    transcriptVersion: 1,
  });
  expect(page.transcript.segments).toHaveLength(expectedSegments);
  expect(value.application.activeJobIdFor(page.meeting)).toBeNull();
  expect(value.audio.cleaned).toEqual([MEETING_ID]);
  expect(value.audio.closeCount).toBe(1);
});

it("通过 Application 一次读取非空 committed Agent 投影", async () => {
  const value = await harness();
  const started = await value.application.startImport({ path: "/input/weekly-review.wav" });
  await settled(value, started.jobId);

  const projection = value.application.getMeetingAgentProjection({ meetingId: MEETING_ID });

  expect(projection.meeting).toMatchObject({
    meetingId: MEETING_ID,
    status: "completed",
    committedStatus: "completed",
    transcriptVersion: 1,
    durationMs: 1_000,
  });
  expect(projection.transcript).toEqual({
    projection: "agent",
    available: true,
    version: 1,
    resultStatus: "completed",
    segments: [{
      anchor: `${MEETING_ID}@v1:0`,
      seq: 0,
      startMs: 0,
      endMs: 500,
      speakerLabel: "Speaker A",
      text: "会议正文",
    }],
    nextCursor: null,
    coverage: {
      returnedFromSeq: 0,
      returnedThroughSeq: 0,
      returnedFromMs: 0,
      returnedThroughMs: 500,
      returnedSegments: 1,
      totalSegments: 1,
      remainingSegments: 0,
      complete: true,
      renderedBytes: expect.any(Number),
    },
  });
  expect(projection.transcript.coverage?.renderedBytes).toBeGreaterThan(0);
});

it("通过 Application 导出 committed 原稿", async () => {
  const value = await harness();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-application-export-"));
  outputRoots.push(outputRoot);
  const started = await value.application.startImport({ path: "/input/weekly-review.wav" });
  await settled(value, started.jobId);
  const outputPath = join(outputRoot, "weekly-review.md");

  const receipt = await value.application.exportTranscript({
    meetingId: MEETING_ID,
    format: "md",
    outputPath,
  });

  expect(receipt).toMatchObject({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    outputPath,
    format: "md",
    segmentCount: 1,
  });
  expect(await readFile(outputPath, "utf8")).toContain("会议正文");
});

it("Agent 投影在交付预算内保留完整 segment 并报告剩余覆盖", async () => {
  const value = await harness();
  const texts = Array.from({ length: 100 }, (_, index) => `${index}:`.padEnd(1_000, "文"));
  commitMeeting(value.repository, 10, { texts, title: "长会议" });

  const projection = value.application.getMeetingAgentProjection({ meetingId: meetingId(10) });
  const coverage = projection.transcript.coverage!;

  expect(coverage.renderedBytes).toBeLessThanOrEqual(48_000);
  expect(coverage.returnedSegments).toBeGreaterThan(0);
  expect(coverage.returnedSegments).toBeLessThan(texts.length);
  expect(coverage.totalSegments).toBe(texts.length);
  expect(coverage.remainingSegments).toBe(texts.length - coverage.returnedSegments);
  expect(coverage.complete).toBe(false);
  expect(projection.transcript.nextCursor).toEqual(expect.any(String));
  expect(projection.transcript.segments.every((segment) => segment.text.length === 1_000)).toBe(true);
});

it("Agent 投影对超过旧分页上限的会议报告全量覆盖", async () => {
  const value = await harness();
  const texts = Array.from({ length: 1_000 }, (_, index) => `片段 ${index}`);
  commitMeeting(value.repository, 11, { texts, title: "千段会议" });

  const projection = value.application.getMeetingAgentProjection({ meetingId: meetingId(11) });
  const coverage = projection.transcript.coverage!;

  expect(coverage.totalSegments).toBe(1_000);
  expect(coverage.returnedThroughSeq).toBeLessThan(999);
  expect(coverage.remainingSegments).toBe(1_000 - coverage.returnedSegments);
  expect(coverage.complete).toBe(false);
  expect(projection.transcript.nextCursor).toEqual(expect.any(String));
});

it("Agent continuation cursor 无重复地读完同一 committed 版本", async () => {
  const value = await harness();
  const texts = Array.from({ length: 1_000 }, (_, index) => `短片段 ${index}`);
  commitMeeting(value.repository, 12, { texts, title: "游标会议" });
  const seen: number[] = [];
  let cursor: string | undefined;

  do {
    const projection = value.application.getMeetingAgentProjection({
      meetingId: meetingId(12),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const coverage = projection.transcript.coverage!;
    expect(coverage.totalSegments).toBe(texts.length);
    expect(coverage.renderedBytes).toBeLessThanOrEqual(48_000);
    seen.push(...projection.transcript.segments.map((segment) => segment.seq));
    cursor = projection.transcript.nextCursor ?? undefined;
  } while (cursor !== undefined);

  expect(seen).toEqual(Array.from({ length: texts.length }, (_, index) => index));
});

it("Agent 投影拒绝跳过未交付中间页的游标", async () => {
  const value = await harness();
  const texts = Array.from({ length: 633 }, (_, seq) => `${seq}:`.padEnd(150, "文"));
  commitMeeting(value.repository, 91, { texts });
  const first = value.application.getMeetingAgentProjection({ meetingId: meetingId(91) });
  const firstEnd = first.transcript.coverage!.returnedThroughSeq!;
  expect(firstEnd).toBeGreaterThan(0);
  expect(firstEnd).toBeLessThan(499);

  const skipped = encodeTranscriptCursor({
    meetingId: meetingId(91), version: 1, projection: "agent", lastSeq: 499,
    nextSegmentDigest: decodeTranscriptCursor(first.transcript.nextCursor!).nextSegmentDigest!,
  });
  expect(() => value.application.getMeetingAgentProjection({
    meetingId: meetingId(91), cursor: skipped,
  })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => value.application.getMeetingAgentProjection({
    meetingId: meetingId(91), cursor: "broken",
  })).toThrow(expect.objectContaining({
    code: "INVALID_INPUT", message: expect.stringContaining("first page"),
  }));
  const oldCursor = encodeTranscriptCursor({
    meetingId: meetingId(91), version: 1, projection: "agent", lastSeq: firstEnd,
  });
  expect(() => value.application.getMeetingAgentProjection({
    meetingId: meetingId(91), cursor: oldCursor,
  })).toThrow(expect.objectContaining({
    code: "INVALID_INPUT", message: expect.stringContaining("first page"),
  }));

  const next = value.application.getMeetingAgentProjection({
    meetingId: meetingId(91), cursor: first.transcript.nextCursor!,
  });
  expect(next.transcript.coverage?.returnedFromSeq).toBe(firstEnd + 1);
});

it("超长单段不能静默进入 DSH spill，前页保留且续读明确失败", async () => {
  const value = await harness();
  const text = `正文${"\u0001".repeat(19_998)}`;
  commitMeeting(value.repository, 13, { texts: ["正常段", text], title: "超长单段" });

  const projection = value.application.getMeetingAgentProjection({ meetingId: meetingId(13) });
  const coverage = projection.transcript.coverage!;

  expect(coverage.renderedBytes).toBeLessThanOrEqual(48_000);
  expect(coverage.complete).toBe(false);
  expect(projection.transcript.segments).toEqual([
    expect.objectContaining({ seq: 0, text: "正常段" }),
  ]);
  expect(() => value.application.getMeetingAgentProjection({
    meetingId: meetingId(13), cursor: projection.transcript.nextCursor!,
  })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("page 与 Agent continuation cursor 不能跨投影复用", async () => {
  const value = await harness();
  const texts = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(1_000, "文"));
  commitMeeting(value.repository, 14, { texts, title: "游标隔离" });
  const pageCursor = value.application.getMeetingPage({
    meetingId: meetingId(14),
    limit: 1,
  }).transcript.nextCursor!;
  const agentCursor = value.application.getMeetingAgentProjection({
    meetingId: meetingId(14),
  }).transcript.nextCursor!;

  expect(() => value.application.getMeetingAgentProjection({
    meetingId: meetingId(14),
    cursor: pageCursor,
  })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => value.application.getMeetingPage({
    meetingId: meetingId(14),
    cursor: agentCursor,
  })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("Agent continuation cursor 在 committed version 变化后冲突", async () => {
  const value = await harness();
  const texts = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(1_000, "文"));
  commitMeeting(value.repository, 15, { texts, title: "版本变化" });
  const cursor = value.application.getMeetingAgentProjection({
    meetingId: meetingId(15),
  }).transcript.nextCursor!;
  value.repository.beginRetranscription({
    meetingId: meetingId(15),
    expectedVersion: 1,
    runId: retranscribeRunId(15),
    nowMs: 16_000,
  });
  value.repository.commitTranscript({
    meetingId: meetingId(15),
    runId: retranscribeRunId(15),
    baseVersion: 1,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 1_000,
    engineFingerprint: "b".repeat(64),
    segments: [{
      seq: 0,
      startMs: 0,
      endMs: 500,
      speakerLabel: "Speaker A",
      text: "新版本",
    }],
    nowMs: 16_001,
  });

  expect(() => value.application.getMeetingAgentProjection({
    meetingId: meetingId(15),
    cursor,
  })).toThrow(expect.objectContaining({ code: "TRANSCRIPT_VERSION_CONFLICT" }));
});

it("显式标题只保留 trim 后的有效值", async () => {
  const value = await harness();
  const started = await value.application.startImport({
    path: "/input/weekly-review.wav",
    title: "  产品周会  ",
  });
  await settled(value, started.jobId);
  expect(value.repository.getMeeting(MEETING_ID)?.title).toBe("产品周会");
});

it.each([
  {
    name: "同 fd 落盘",
    audio: new TestAudioStore({
      persistError: new ManagedAudioError("STORAGE_FAILURE", "private source path"),
    }),
    expectedCode: "STORAGE_FAILURE",
    expectedStage: "validating",
  },
  {
    name: "规范化",
    audio: new TestAudioStore({
      normalizeError: new ManagedAudioError("AUDIO_DECODE_FAILED", "private decoder detail"),
    }),
    expectedCode: "AUDIO_DECODE_FAILED",
    expectedStage: "normalizing",
  },
])("$name 失败后收敛 DB、job 和资源", async ({ audio, expectedCode, expectedStage }) => {
  const value = await harness({ audio });
  const started = await value.application.startImport({ path: "/private/input.wav" });
  const snapshot = await settled(value, started.jobId);

  expect(snapshot).toMatchObject({ status: "failed", detail: expectedCode });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "failed", errorCode: expectedCode, errorStage: expectedStage,
  });
  const output = value.context.jobs.read(JobId(started.jobId)).chunks.at(-1)!.text;
  expect(JSON.parse(output)).toMatchObject({ stage: expectedStage, error_code: expectedCode });
  expect(output).not.toContain("/private/input.wav");
  expect(audio.cleaned).toEqual([MEETING_ID]);
  expect(audio.closeCount).toBe(1);
});

it.each([
  {
    name: "ASR 加载",
    runner: failingRunner(new WorkerClientError(
      "WORKER_PROCESS_ERROR",
      "private worker crash detail",
      { stderr: { text: "private stderr", truncated: false } },
    )),
    expectedCode: "ENGINE_FAILURE",
    expectedStage: "loading_asr",
  },
  {
    name: "ASR 协议",
    runner: failingRunner(new WorkerClientError(
      "WORKER_PROTOCOL_ERROR",
      "private framing detail",
      { stderr: { text: "private stderr", truncated: false } },
    ), true),
    expectedCode: "WORKER_PROTOCOL_ERROR",
    expectedStage: "transcribing",
  },
  {
    name: "Worker 资产",
    runner: failingRunner(new WorkerClientError(
      "ASSET_MISMATCH",
      "private asset path",
      { stderr: { text: "private stderr", truncated: false } },
    )),
    expectedCode: "MODEL_NOT_READY",
    expectedStage: "loading_asr",
  },
  {
    name: "Host 资产解析",
    runner: failingRunner(new RuntimeAssetsError(
      "MODEL_NOT_READY",
      "private model root",
    )),
    expectedCode: "MODEL_NOT_READY",
    expectedStage: "loading_asr",
  },
  {
    name: "Host 资产完整性",
    runner: failingRunner(new AssetVerificationError(
      "ASSET_MISSING",
      "private model path",
      "example-model",
    )),
    expectedCode: "MODEL_NOT_READY",
    expectedStage: "loading_asr",
  },
])("$name 失败只公开稳定错误码", async ({ runner, expectedCode, expectedStage }) => {
  const value = await harness({ asr: runner });
  const started = await value.application.startImport({ path: "/private/input.wav" });
  const snapshot = await settled(value, started.jobId);

  expect(snapshot).toMatchObject({ status: "failed", detail: expectedCode });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "failed", errorCode: expectedCode, errorStage: expectedStage,
  });
  expect(snapshot.detail).not.toContain("private");
});

it.each([
  { name: "加载", afterReady: false, expectedStage: "loading_diarization" },
  { name: "推理", afterReady: true, expectedStage: "diarizing" },
])("Diarization $name 失败归入正确阶段", async ({ afterReady, expectedStage }) => {
  const value = await harness({
    diarization: failingRunner(new Error("private diarization failure"), afterReady),
  });
  const started = await value.application.startImport({ path: "/private/input.wav" });
  await expect(settled(value, started.jobId)).resolves.toMatchObject({
    status: "failed", detail: "ENGINE_FAILURE",
  });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "failed", errorCode: "ENGINE_FAILURE", errorStage: expectedStage,
  });
});

it("提交失败回滚候选并把 meeting/job 收敛为失败", async () => {
  const value = await harness({ repositoryAdapter: failCommit });
  const started = await value.application.startImport({ path: "/input.wav" });
  await expect(settled(value, started.jobId)).resolves.toMatchObject({
    status: "failed", detail: "STORAGE_FAILURE",
  });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "failed", transcriptVersion: 0, errorCode: "STORAGE_FAILURE", errorStage: "committing",
  });
  expect(value.repository.getMeetingPage({ meetingId: MEETING_ID }).transcript.available).toBe(false);
});

it("提交已赢时清理失败不伪造 DB 回滚或 failed job", async () => {
  const audio = new TestAudioStore({ cleanupError: new Error("cleanup denied") });
  const value = await harness({ audio });
  const started = await value.application.startImport({ path: "/input.wav" });
  const snapshot = await settled(value, started.jobId);

  expect(snapshot).toMatchObject({ status: "completed" });
  expect(snapshot.detail).toContain("cleanup_error=STORAGE_FAILURE");
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "completed", transcriptVersion: 1, errorCode: null,
  });
  expect(JSON.parse(value.context.jobs.read(JobId(started.jobId)).chunks.at(-1)!.text)).toMatchObject({
    stage: "cleaning", error_code: "STORAGE_FAILURE",
  });
});

it("DSH job 预检失败时关闭 fd 且不创建 meeting", async () => {
  const value = await harness({ attachController: false });
  await expect(value.application.startImport({ path: "/input.wav" })).rejects.toThrow(
    "no job controller",
  );
  expect(value.audio.closeCount).toBe(1);
  expect(value.repository.getMeeting(MEETING_ID)).toBeNull();
  expect(value.context.jobs.list()).toEqual([]);
});

it("调用方在 job 发布前取消时不打开文件或创建 meeting", async () => {
  const value = await harness();
  const controller = new AbortController();
  controller.abort();
  await expect(value.application.startImport({ path: "/input.wav", signal: controller.signal }))
    .rejects.toMatchObject({ code: "CANCELLED_BY_USER" });
  expect(value.audio.opened).toEqual([]);
  expect(value.repository.getMeeting(MEETING_ID)).toBeNull();
});


it("captures processing identity at task start and applies later selection only to new runs", async () => {
  const manifest = { schemaVersion: 2 as const, algorithmRevision: "test-v1", assets: [] };
  const base = createProcessingIdentity(manifest, "a".repeat(64), "base");
  const enhanced = createProcessingIdentity(manifest, "a".repeat(64), "enhanced");
  let selected = base;
  const gate = deferred<void>();
  const value = await harness({ prepareRuntime: async () => {
    const processingIdentity = selected;
    await gate.promise;
    return { processingIdentity, engineFingerprint: processingIdentity.engineFingerprint,
      asr: immediateRunner(asrResult(true)), diarization: immediateRunner(diarizationResult()) };
  } });
  const pending = value.application.startImport({ path: "/input/mode.wav" });
  selected = enhanced;
  gate.resolve();
  const first = await pending;
  await expect(settled(value, first.jobId)).resolves.toMatchObject({ status: "completed" });
  expect(value.repository.getMeeting(first.meetingId)).toMatchObject({
    runIdentity: base, transcriptIdentity: base, engineFingerprint: base.engineFingerprint,
  });
  const next = await value.application.startRetranscription({ meetingId: first.meetingId, expectedVersion: 1 });
  await expect(settled(value, next.jobId)).resolves.toMatchObject({ status: "completed" });
  expect(value.repository.getMeeting(first.meetingId)).toMatchObject({
    runIdentity: enhanced, transcriptIdentity: enhanced, transcriptVersion: 2,
  });
});
