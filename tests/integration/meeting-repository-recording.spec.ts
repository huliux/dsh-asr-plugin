import { rm } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import {
  commitMeeting,
  createTemporaryMeetingRepository,
  importRunId,
  meetingId,
  retranscribeRunId,
} from "../helpers/meeting-repository-fixture.js";

const roots: string[] = [];
const repositories: MeetingRepository[] = [];

async function createRepository(): Promise<MeetingRepository> {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  return temporary.repository;
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

function recordingCommit(index: number, nowMs: number) {
  return {
    meetingId: meetingId(index),
    runId: importRunId(index),
    baseVersion: 0,
    resultStatus: "completed" as const,
    resultReason: null,
    durationMs: 1_500,
    sourceSizeBytes: 48_044,
    sourceSha256: "c".repeat(64),
    engineFingerprint: "a".repeat(64),
    segments: [
      { seq: 0, startMs: 0, endMs: 1_500, speakerLabel: "Speaker A", text: "录音正文" },
    ],
    nowMs,
  };
}

it("reports recording history only after capture starts and keeps it after reopening", async () => {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  const repository = temporary.repository;
  expect(repository.hasRecordingHistory()).toBe(false);
  commitMeeting(repository, 2, { texts: ["Imported text"] });
  expect(repository.hasRecordingHistory()).toBe(false);
  repository.createRecording({ meetingId: meetingId(1), runId: importRunId(1), title: "Recording", nowMs: 1_000 });
  expect(repository.hasRecordingHistory()).toBe(false);
  repository.recordRecordingStarted({ meetingId: meetingId(1), runId: importRunId(1), startedAtMs: 1_100 });
  expect(repository.hasRecordingHistory()).toBe(true);
  repository.close();
  const reopened = openMeetingRepository(temporary.filename);
  repositories.push(reopened);
  expect(reopened.hasRecordingHistory()).toBe(true);
});

it("创建 recording 会议并阻止导入抢占共享单活槽", async () => {
  const repository = await createRepository();

  const recording = repository.createRecording({
    meetingId: meetingId(1),
    title: "现场会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });

  expect(recording).toMatchObject({
    meetingId: meetingId(1),
    origin: "recording",
    sourceName: "recording.wav",
    sourceFormat: "wav",
    sourceSizeBytes: null,
    sourceSha256: null,
    status: "recording",
    activeRunId: importRunId(1),
    runKind: "recording",
    transcriptVersion: 0,
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
  });
  expect(() => repository.createImport({
    meetingId: meetingId(2),
    title: "导入会议",
    sourceName: "import.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: importRunId(2),
    nowMs: 2_000,
  })).toThrow(expect.objectContaining({ code: "ENGINE_BUSY" }));
  expect(repository.getMeeting(meetingId(2))).toBeNull();
});

it("只记录第一条可信轨道 on 的录音开始时间", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "权限等待后的会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });

  expect(repository.recordRecordingStarted({
    meetingId: meetingId(1),
    runId: importRunId(1),
    startedAtMs: 1_250,
  })).toMatchObject({
    recordingStartedAtMs: 1_250,
    recordingEndedAtMs: null,
    updatedAtMs: 1_250,
  });
  expect(repository.recordRecordingStarted({
    meetingId: meetingId(1),
    runId: importRunId(1),
    startedAtMs: 1_500,
  })).toMatchObject({
    recordingStartedAtMs: 1_250,
    updatedAtMs: 1_250,
  });
});

it("录音先进入 finalizing 再原子提交规范音频事实与转写", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "现场会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });
  repository.recordRecordingStarted({
    meetingId: meetingId(1),
    runId: importRunId(1),
    startedAtMs: 1_250,
  });

  expect(repository.beginRecordingFinalization({
    meetingId: meetingId(1),
    runId: importRunId(1),
    baseVersion: 0,
    nowMs: 2_000,
    recordingEndedAtMs: 1_900,
  })).toMatchObject({
    status: "processing",
    activeRunId: importRunId(1),
    runKind: "recording",
    recordingStartedAtMs: 1_250,
    recordingEndedAtMs: 1_900,
  });

  const committed = repository.commitTranscript(recordingCommit(1, 3_000));

  expect(committed).toMatchObject({
    outcome: "committed",
    meeting: {
      origin: "recording",
      status: "completed",
      sourceSizeBytes: 48_044,
      sourceSha256: "c".repeat(64),
      transcriptVersion: 1,
      activeRunId: null,
      runKind: null,
    },
  });
  expect(repository.getMeetingPage({ meetingId: meetingId(1) }).transcript.segments)
    .toMatchObject([{ seq: 0, text: "录音正文" }]);
});

it("没有可信开始时间时拒绝进入录音收尾", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "未开始捕获",
    runId: importRunId(1),
    nowMs: 1_000,
  });

  expect(() => repository.beginRecordingFinalization({
    meetingId: meetingId(1),
    runId: importRunId(1),
    baseVersion: 0,
    nowMs: 2_000,
    recordingEndedAtMs: 1_900,
  })).toThrow(expect.objectContaining({ code: "RUN_STATE_CONFLICT" }));
  expect(repository.getMeeting(meetingId(1))).toMatchObject({
    status: "recording",
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
  });
});

it("只有捕获已确认终止时才把结束时间写入失败或取消终态", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "确认终止的会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });
  repository.recordRecordingStarted({
    meetingId: meetingId(1),
    runId: importRunId(1),
    startedAtMs: 1_200,
  });

  expect(repository.finishRun({
    meetingId: meetingId(1),
    runId: importRunId(1),
    baseVersion: 0,
    outcome: "failed",
    errorCode: "WORKER_PROCESS_ERROR",
    errorStage: "finalizing",
    recordingEndedAtMs: 1_800,
    nowMs: 2_000,
  })).toMatchObject({
    outcome: "updated",
    meeting: { status: "failed", recordingEndedAtMs: 1_800 },
  });

  repository.createRecording({
    meetingId: meetingId(2),
    title: "未知终止时间",
    runId: importRunId(2),
    nowMs: 3_000,
  });
  expect(repository.finishRun({
    meetingId: meetingId(2),
    runId: importRunId(2),
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "starting",
    nowMs: 3_100,
  })).toMatchObject({ meeting: { recordingStartedAtMs: null, recordingEndedAtMs: null } });
});

it("取消与提交竞争时由同一 run 栅栏决定唯一终态", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "取消先赢",
    runId: importRunId(1),
    nowMs: 1_000,
  });

  expect(repository.finishRun({
    meetingId: meetingId(1),
    runId: importRunId(1),
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "recording",
    nowMs: 2_000,
  })).toMatchObject({ outcome: "updated", meeting: { status: "cancelled" } });
  expect(repository.commitTranscript(recordingCommit(1, 3_000)))
    .toMatchObject({ outcome: "run_not_active", meeting: { status: "cancelled" } });

  repository.createRecording({
    meetingId: meetingId(2),
    title: "提交先赢",
    runId: importRunId(2),
    nowMs: 4_000,
  });
  repository.recordRecordingStarted({
    meetingId: meetingId(2),
    runId: importRunId(2),
    startedAtMs: 4_100,
  });
  repository.beginRecordingFinalization({
    meetingId: meetingId(2),
    runId: importRunId(2),
    baseVersion: 0,
    recordingEndedAtMs: 4_900,
    nowMs: 5_000,
  });
  expect(repository.commitTranscript(recordingCommit(2, 6_000)))
    .toMatchObject({ outcome: "committed", meeting: { status: "completed" } });
  expect(repository.finishRun({
    meetingId: meetingId(2),
    runId: importRunId(2),
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "finalizing",
    nowMs: 7_000,
  })).toMatchObject({ outcome: "already_committed", meeting: { status: "completed" } });
});

it("Host 重启把 recording 收敛为孤儿失败且禁止迟到提交", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "重启中的会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });
  repository.recordRecordingStarted({
    meetingId: meetingId(1),
    runId: importRunId(1),
    startedAtMs: 1_200,
  });

  expect(repository.reconcileOrphanedRuns(2_000)).toBe(1);
  expect(repository.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    activeRunId: null,
    runKind: null,
    errorCode: "ORPHANED_BY_RESTART",
    errorStage: "startup",
    recordingStartedAtMs: 1_200,
    recordingEndedAtMs: null,
  });
  expect(repository.commitTranscript(recordingCommit(1, 3_000)))
    .toMatchObject({ outcome: "run_not_active", meeting: { status: "failed" } });
});

it("活动录音不能建立删除栅栏", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "活动会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });

  expect(() => repository.beginDeletion({
    meetingId: meetingId(1),
    expectedVersion: 0,
    nowMs: 2_000,
  })).toThrow(expect.objectContaining({ code: "INVALID_MEETING_STATE" }));
  expect(repository.getMeeting(meetingId(1))).toMatchObject({ status: "recording" });
});

it("两个仓储连接上的导入与录音 start 仍只有一个赢家", async () => {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  const competing = openMeetingRepository(temporary.filename);
  repositories.push(competing);

  temporary.repository.createImport({
    meetingId: meetingId(1),
    title: "导入先赢",
    sourceName: "import.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: importRunId(1),
    nowMs: 1_000,
  });
  expect(() => competing.createRecording({
    meetingId: meetingId(2),
    title: "录音后到",
    runId: importRunId(2),
    nowMs: 2_000,
  })).toThrow(expect.objectContaining({ code: "ENGINE_BUSY" }));
  expect(competing.getMeeting(meetingId(2))).toBeNull();
});

it("录音与重转写双向共享同一个活动槽", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["旧版本"] });
  repository.createRecording({
    meetingId: meetingId(2),
    title: "录音先赢",
    runId: importRunId(2),
    nowMs: 3_000,
  });
  expect(() => repository.beginRetranscription({
    meetingId: meetingId(1),
    expectedVersion: 1,
    runId: retranscribeRunId(1),
    nowMs: 4_000,
  })).toThrow(expect.objectContaining({ code: "ENGINE_BUSY" }));

  repository.finishRun({
    meetingId: meetingId(2),
    runId: importRunId(2),
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "recording",
    nowMs: 5_000,
  });
  repository.beginRetranscription({
    meetingId: meetingId(1),
    expectedVersion: 1,
    runId: retranscribeRunId(1),
    nowMs: 6_000,
  });
  expect(() => repository.createRecording({
    meetingId: meetingId(3),
    title: "录音后到",
    runId: importRunId(3),
    nowMs: 7_000,
  })).toThrow(expect.objectContaining({ code: "ENGINE_BUSY" }));
});

it("失败录音可幂等记录恢复后的规范音频事实供重转写", async () => {
  const repository = await createRepository();
  repository.createRecording({
    meetingId: meetingId(1),
    title: "可恢复会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });
  repository.finishRun({
    meetingId: meetingId(1),
    runId: importRunId(1),
    baseVersion: 0,
    outcome: "failed",
    errorCode: "ORPHANED_BY_RESTART",
    errorStage: "startup",
    nowMs: 2_000,
  });
  expect(repository.listRecordingsNeedingRecovery().map((meeting) => meeting.meetingId))
    .toEqual([meetingId(1)]);
  const input = {
    meetingId: meetingId(1),
    expectedVersion: 0,
    sourceSizeBytes: 48_044,
    sourceSha256: "d".repeat(64),
    nowMs: 3_000,
  };

  expect(repository.recordRecoveredRecordingSource(input)).toMatchObject({
    origin: "recording",
    status: "failed",
    sourceSizeBytes: 48_044,
    sourceSha256: "d".repeat(64),
  });
  expect(repository.recordRecoveredRecordingSource({ ...input, nowMs: 4_000 }))
    .toMatchObject({ sourceSizeBytes: 48_044, sourceSha256: "d".repeat(64) });
  expect(repository.listRecordingsNeedingRecovery()).toEqual([]);
});
