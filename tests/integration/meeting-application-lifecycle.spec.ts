import { JobId } from "@deepseek-ai/dsh-jobs";
import { afterEach, expect, it } from "vitest";

import { ManagedAudioError } from "../../src/audio/managed-audio-error.js";
import type { MeetingRepository } from "../../src/storage/meeting-repository.js";
import type { WorkerResultMessage } from "../../src/worker/types.js";
import type { WorkerRunner } from "../../src/worker/worker-pipeline.js";
import {
  MEETING_ID,
  RUN_ID,
  SECOND_MEETING_ID,
  TestAudioStore,
  asrResult,
  createMeetingApplicationHarness,
  deferred,
  failingRunner,
  heldRunner,
  type Deferred,
  type MeetingApplicationHarness,
} from "../helpers/meeting-application-fixture.js";

const THIRD_MEETING_ID = "55555555-5555-4555-8555-555555555555";
const THIRD_RUN_ID = "66666666-6666-4666-8666-666666666666";
const harnesses: MeetingApplicationHarness[] = [];

async function harness(options: Parameters<typeof createMeetingApplicationHarness>[0] = {}) {
  const value = await createMeetingApplicationHarness(options);
  harnesses.push(value);
  return value;
}

function seedCompleted(
  repository: MeetingRepository,
  meetingId = MEETING_ID,
  runId = RUN_ID,
  nowMs = 1_000,
): void {
  repository.createImport({
    meetingId,
    title: "历史会议",
    sourceName: "history.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId,
    nowMs,
  });
  repository.commitTranscript({
    meetingId,
    runId,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 1_000,
    engineFingerprint: "a".repeat(64),
    segments: [{
      seq: 0,
      startMs: 0,
      endMs: 500,
      speakerLabel: "Speaker A",
      text: "旧版本正文",
    }],
    nowMs: nowMs + 1,
  });
}

function gatedRunner(
  entered: Deferred<void>,
  release: Deferred<void>,
  result: WorkerResultMessage,
): WorkerRunner {
  return {
    async run(run, options) {
      options?.onReady?.({
        type: "ready",
        protocol_version: 2,
        kind: run.kind,
        engine_fingerprint: "a".repeat(64),
        load_ms: 1,
      });
      entered.resolve();
      await release.promise;
      return result;
    },
  };
}

afterEach(async () => {
  for (const value of harnesses.splice(0)) await value.dispose();
});

it("重跑提交前持续读取旧版本，成功后一次切到新版本", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const value = await harness({ asr: gatedRunner(entered, release, asrResult()) });
  seedCompleted(value.repository);

  const started = await value.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  });
  expect(started).toEqual({
    meetingId: MEETING_ID,
    jobId: "meeting-1",
    status: "processing",
    baseVersion: 1,
    targetVersion: 2,
  });
  await entered.promise;
  expect(value.repository.getMeetingPage({ meetingId: MEETING_ID })).toMatchObject({
    meeting: { status: "processing", transcriptVersion: 1 },
    transcript: { available: true, version: 1, segments: [{ text: "旧版本正文" }] },
  });

  release.resolve();
  await expect(value.context.jobs.wait(JobId(started.jobId), 2_000))
    .resolves.toMatchObject({ status: "completed" });
  expect(value.repository.getMeetingPage({ meetingId: MEETING_ID })).toMatchObject({
    meeting: { status: "completed", transcriptVersion: 2 },
    transcript: { version: 2, segments: [{ text: "会议正文" }] },
  });
  expect(value.audio.prepared).toEqual([MEETING_ID]);
  expect(value.audio.persisted).toEqual([]);
});

it("重跑失败与取消都保留旧 committed 版本", async () => {
  const failed = await harness({ asr: failingRunner(new Error("worker crash")) });
  seedCompleted(failed.repository);
  const failedJob = await failed.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  });
  await failed.context.jobs.wait(JobId(failedJob.jobId), 2_000);
  expect(failed.repository.getMeetingPage({ meetingId: MEETING_ID })).toMatchObject({
    meeting: { status: "failed", transcriptVersion: 1, errorCode: "ENGINE_FAILURE" },
    transcript: { version: 1, segments: [{ text: "旧版本正文" }] },
  });

  const entered = deferred<void>();
  const cancelled = await harness({ asr: heldRunner(entered) });
  seedCompleted(cancelled.repository);
  const cancelledJob = await cancelled.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  });
  await entered.promise;
  cancelled.context.jobs.kill(JobId(cancelledJob.jobId));
  await cancelled.context.jobs.wait(JobId(cancelledJob.jobId), 2_000);
  expect(cancelled.repository.getMeetingPage({ meetingId: MEETING_ID })).toMatchObject({
    meeting: { status: "cancelled", transcriptVersion: 1 },
    transcript: { version: 1, segments: [{ text: "旧版本正文" }] },
  });
});

it("version 0 的失败会议可重跑为 v1", async () => {
  const value = await harness();
  value.repository.createImport({
    meetingId: MEETING_ID,
    title: "首次失败",
    sourceName: "failed.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: RUN_ID,
    nowMs: 1_000,
  });
  value.repository.finishRun({
    meetingId: MEETING_ID,
    runId: RUN_ID,
    baseVersion: 0,
    outcome: "failed",
    errorCode: "ENGINE_FAILURE",
    errorStage: "transcribing",
    nowMs: 1_001,
  });

  const started = await value.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 0,
  });
  await value.context.jobs.wait(JobId(started.jobId), 2_000);
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "completed", transcriptVersion: 1,
  });
});

it("失败录音在同一 Host 进程内恢复规范音频后可直接重跑", async () => {
  const value = await harness();
  value.repository.createRecording({
    meetingId: MEETING_ID,
    title: "停止收尾失败的录音",
    runId: RUN_ID,
    nowMs: 1_000,
  });
  value.repository.finishRun({
    meetingId: MEETING_ID,
    runId: RUN_ID,
    baseVersion: 0,
    outcome: "failed",
    errorCode: "WORKER_TIMEOUT",
    errorStage: "recording",
    nowMs: 1_001,
  });

  const started = await value.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 0,
  });
  await value.context.jobs.wait(JobId(started.jobId), 2_000);

  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "completed",
    transcriptVersion: 1,
    sourceSizeBytes: 32_044,
    sourceSha256: "c".repeat(64),
  });
});

it("重跑预检拒绝版本漂移、缺失 source 与全局 busy", async () => {
  const missingAudio = new TestAudioStore({
    assertSourceError: new ManagedAudioError("INVALID_PATH", "source missing"),
  });
  const missing = await harness({ audio: missingAudio });
  seedCompleted(missing.repository);
  await expect(missing.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 0,
  })).rejects.toMatchObject({ code: "TRANSCRIPT_VERSION_CONFLICT" });
  expect(missingAudio.asserted).toEqual([]);
  await expect(missing.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  })).rejects.toMatchObject({ code: "INVALID_MEETING_STATE" });
  expect(missing.context.jobs.list()).toEqual([]);

  const entered = deferred<void>();
  const busy = await harness({ asr: heldRunner(entered) });
  const active = await busy.application.startImport({ path: "/active.wav" });
  await entered.promise;
  await expect(busy.application.startRetranscription({
    meetingId: SECOND_MEETING_ID,
    expectedVersion: 1,
  })).rejects.toMatchObject({ code: "ENGINE_BUSY" });
  busy.context.jobs.kill(JobId(active.jobId));
  await busy.context.jobs.wait(JobId(active.jobId), 2_000);
});

it("删除目标活动时返回 job id，但另一会议的活动任务不阻塞删除", async () => {
  const cleanupGate = deferred<void>();
  const audio = new TestAudioStore({ cleanupGate: cleanupGate.promise });
  const target = await harness({ audio });
  seedCompleted(target.repository);
  const rerun = await target.application.startRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  });
  while (target.audio.cleaned.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(target.application.deleteMeeting({
    meetingId: MEETING_ID,
    expectedVersion: 2,
  })).rejects.toSatisfy((error: unknown) => (
    (error as { code?: string }).code === "INVALID_MEETING_STATE"
    && (error as Error).message.includes(rerun.jobId)
    && (error as Error).message.includes("job_kill")
    && (error as Error).message.includes("job_output(wait:true)")
    && !(error as Error).message.includes("job_wait")
  ));
  cleanupGate.resolve();
  await target.context.jobs.wait(JobId(rerun.jobId), 2_000);

  const entered = deferred<void>();
  const other = await harness({ asr: heldRunner(entered) });
  seedCompleted(other.repository, SECOND_MEETING_ID, THIRD_RUN_ID);
  const active = await other.application.startImport({ path: "/active.wav" });
  await entered.promise;
  await expect(other.application.deleteMeeting({
    meetingId: SECOND_MEETING_ID,
    expectedVersion: 1,
  })).resolves.toEqual({
    meetingId: SECOND_MEETING_ID,
    deleted: true,
    freedBytes: 1_024,
  });
  expect(other.repository.getMeeting(SECOND_MEETING_ID)).toBeNull();
  other.context.jobs.kill(JobId(active.jobId));
  await other.context.jobs.wait(JobId(active.jobId), 2_000);
});

it("文件删除失败保留栅栏，再次调用续清成功", async () => {
  const audio = new TestAudioStore({ deleteErrors: [new Error("denied")] });
  const value = await harness({ audio });
  seedCompleted(value.repository);

  await expect(value.application.deleteMeeting({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  })).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "deleting", errorCode: "DELETE_INCOMPLETE", errorStage: "deleting_files",
  });
  await expect(value.application.deleteMeeting({
    meetingId: MEETING_ID,
    expectedVersion: 1,
  })).resolves.toMatchObject({ deleted: true });
  expect(value.repository.getMeeting(MEETING_ID)).toBeNull();
  expect(audio.deleted).toEqual([MEETING_ID, MEETING_ID]);
});

it("启动恢复区分孤儿 run，逐场续清 deleting 后整体清 work", async () => {
  const audio = new TestAudioStore({ deleteErrors: [new Error("first denied")] });
  const value = await harness({ audio });
  seedCompleted(value.repository, SECOND_MEETING_ID, RUN_ID, 1_000);
  seedCompleted(value.repository, THIRD_MEETING_ID, THIRD_RUN_ID, 2_000);
  value.repository.beginDeletion({
    meetingId: SECOND_MEETING_ID, expectedVersion: 1, nowMs: 3_000,
  });
  value.repository.beginDeletion({
    meetingId: THIRD_MEETING_ID, expectedVersion: 1, nowMs: 3_000,
  });
  value.repository.createImport({
    meetingId: MEETING_ID,
    title: "崩溃任务",
    sourceName: "crashed.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: THIRD_RUN_ID,
    nowMs: 4_000,
  });

  await expect(value.application.reconcileStartup()).resolves.toEqual({
    orphanedRuns: 1,
    completedDeletions: 1,
    failedDeletionIds: [SECOND_MEETING_ID],
    recoveredRecordingIds: [],
    failedRecordingRecoveryIds: [],
  });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "failed", errorCode: "ORPHANED_BY_RESTART", errorStage: "startup",
  });
  expect(value.repository.getMeeting(SECOND_MEETING_ID)).toMatchObject({
    status: "deleting", errorCode: "DELETE_INCOMPLETE",
  });
  expect(value.repository.getMeeting(THIRD_MEETING_ID)).toBeNull();
  expect(audio.cleanupAllCount).toBe(1);

  await expect(value.application.reconcileStartup()).resolves.toEqual({
    orphanedRuns: 0,
    completedDeletions: 1,
    failedDeletionIds: [],
    recoveredRecordingIds: [],
    failedRecordingRecoveryIds: [],
  });
  expect(value.repository.getMeeting(SECOND_MEETING_ID)).toBeNull();
});

it("启动把孤儿录音恢复为可重转写的规范音频事实", async () => {
  const value = await harness();
  value.repository.createRecording({
    meetingId: MEETING_ID,
    title: "崩溃录音",
    runId: RUN_ID,
    nowMs: 1_000,
  });

  await expect(value.application.reconcileStartup()).resolves.toEqual({
    orphanedRuns: 1,
    completedDeletions: 0,
    failedDeletionIds: [],
    recoveredRecordingIds: [MEETING_ID],
    failedRecordingRecoveryIds: [],
  });
  expect(value.audio.recovered).toEqual([MEETING_ID]);
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    origin: "recording",
    status: "failed",
    errorCode: "ORPHANED_BY_RESTART",
    sourceSizeBytes: 32_044,
    sourceSha256: "c".repeat(64),
  });
});

it("录音恢复失败保留原轨并持久化可行动错误", async () => {
  const audio = new TestAudioStore({ recoverError: new Error("bad chunk") });
  const value = await harness({ audio });
  value.repository.createRecording({
    meetingId: MEETING_ID,
    title: "损坏录音",
    runId: RUN_ID,
    nowMs: 1_000,
  });

  await expect(value.application.reconcileStartup()).resolves.toMatchObject({
    orphanedRuns: 1,
    recoveredRecordingIds: [],
    failedRecordingRecoveryIds: [MEETING_ID],
  });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "failed",
    errorCode: "AUDIO_RECOVERY_FAILED",
    errorStage: "recovering_audio",
    sourceSizeBytes: null,
    sourceSha256: null,
  });
  expect(audio.deleted).toEqual([]);
});

it("shutdown 停止接单、取消并等待活动 run 后才关闭 DB", async () => {
  const entered = deferred<void>();
  const value = await harness({ asr: heldRunner(entered) });
  await value.application.startImport({ path: "/active.wav" });
  await entered.promise;

  await value.application.shutdown();
  expect(value.audio.cleaned).toEqual([MEETING_ID]);
  await expect(value.application.startImport({ path: "/after-shutdown.wav" }))
    .rejects.toMatchObject({ code: "INVALID_MEETING_STATE" });
  expect(value.audio.opened).toEqual(["/active.wav"]);
  expect(() => value.repository.getMeeting(MEETING_ID)).toThrow();
});
