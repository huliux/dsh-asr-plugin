import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_RUN_ID = "22222222-2222-4222-8222-222222222222";
const RETRANSCRIBE_RUN_ID = "33333333-3333-4333-8333-333333333333";
const WRONG_RUN_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
const repositories: MeetingRepository[] = [];

async function createRepository(): Promise<{ filename: string; repository: MeetingRepository }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-store-"));
  const filename = join(root, "meetings.sqlite3");
  const repository = openMeetingRepository(filename);
  roots.push(root);
  repositories.push(repository);
  return { filename, repository };
}

function closeRepository(repository: MeetingRepository): void {
  repository.close();
  const index = repositories.indexOf(repository);
  if (index >= 0) repositories.splice(index, 1);
}

function startImport(repository: MeetingRepository): void {
  repository.createImport({
    meetingId: MEETING_ID,
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: IMPORT_RUN_ID,
    nowMs: 1_000,
  });
}

function commitVersionOne(repository: MeetingRepository): void {
  startImport(repository);
  repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 10_000,
    engineFingerprint: "a".repeat(64),
    segments: [
      { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "旧版本" },
    ],
    nowMs: 2_000,
  });
}

function beginVersionTwo(repository: MeetingRepository): void {
  repository.beginRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 1,
    runId: RETRANSCRIBE_RUN_ID,
    nowMs: 3_000,
  });
}

function commitVersionTwo(repository: MeetingRepository): void {
  repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: RETRANSCRIBE_RUN_ID,
    baseVersion: 1,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 10_000,
    engineFingerprint: "b".repeat(64),
    segments: [
      { seq: 0, startMs: 200, endMs: 1_200, speakerLabel: "Speaker B", text: "新版本" },
    ],
    nowMs: 4_000,
  });
}

function readText(repository: MeetingRepository): string[] {
  return repository.getMeetingPage({ meetingId: MEETING_ID, limit: 200 })
    .transcript.segments.map((segment) => segment.text);
}

function mutateDatabase(filename: string, sql: string): void {
  const database = new DatabaseSync(filename);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it("打开时拒绝与 segments 内容不一致的 FTS 索引", async () => {
  const { filename, repository } = await createRepository();
  commitVersionOne(repository);
  closeRepository(repository);
  mutateDatabase(filename, `
    INSERT INTO segments_fts(segments_fts) VALUES('delete-all')
  `);

  expect(() => openMeetingRepository(filename)).toThrow(expect.objectContaining({
    code: "DATABASE_INTEGRITY_FAILED",
  }));
});

it("segment 插入中断时回滚整批候选并保留旧版本", async () => {
  const { filename, repository } = await createRepository();
  commitVersionOne(repository);
  beginVersionTwo(repository);
  mutateDatabase(filename, `
    CREATE TRIGGER reject_v2_segment BEFORE INSERT ON segments
    WHEN new.transcript_version = 2
    BEGIN
      SELECT RAISE(ABORT, 'injected segment failure');
    END
  `);

  expect(() => commitVersionTwo(repository)).toThrow(expect.objectContaining({
    code: "STORAGE_FAILURE",
  }));
  expect(repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "processing",
    committedStatus: "completed",
    transcriptVersion: 1,
    activeRunId: RETRANSCRIBE_RUN_ID,
  });
  expect(readText(repository)).toEqual(["旧版本"]);
});

it("最后状态 CAS 失败时回滚 segments 与版本", async () => {
  const { filename, repository } = await createRepository();
  commitVersionOne(repository);
  beginVersionTwo(repository);
  mutateDatabase(filename, `
    CREATE TRIGGER ignore_v2_commit BEFORE UPDATE OF transcript_version ON meetings
    WHEN new.transcript_version = 2
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);

  expect(() => commitVersionTwo(repository)).toThrow(expect.objectContaining({
    code: "RUN_STATE_CONFLICT",
  }));
  expect(repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "processing",
    committedStatus: "completed",
    transcriptVersion: 1,
    activeRunId: RETRANSCRIBE_RUN_ID,
  });
  expect(readText(repository)).toEqual(["旧版本"]);
});

it("提交先赢时迟到取消不能覆盖 committed 结果", async () => {
  const { repository } = await createRepository();
  commitVersionOne(repository);

  expect(repository.finishRun({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "transcribing",
    nowMs: 3_000,
  })).toMatchObject({
    outcome: "already_committed",
    meeting: { status: "completed", transcriptVersion: 1 },
  });
  expect(readText(repository)).toEqual(["旧版本"]);
});

it("另一个 Repository 读者在重跑提交前只看到旧 committed 版本", async () => {
  const { filename, repository } = await createRepository();
  commitVersionOne(repository);
  beginVersionTwo(repository);
  const reader = openMeetingRepository(filename);
  repositories.push(reader);

  expect(readText(reader)).toEqual(["旧版本"]);
  commitVersionTwo(repository);
  expect(readText(reader)).toEqual(["新版本"]);
});

it("在线 Worker 失败后保留旧 committed 版本并记录 ENGINE_FAILURE", async () => {
  const { repository } = await createRepository();
  commitVersionOne(repository);
  beginVersionTwo(repository);

  expect(repository.finishRun({
    meetingId: MEETING_ID,
    runId: RETRANSCRIBE_RUN_ID,
    baseVersion: 1,
    outcome: "failed",
    errorCode: "ENGINE_FAILURE",
    errorStage: "diarizing",
    nowMs: 4_000,
  })).toMatchObject({
    outcome: "updated",
    meeting: {
      status: "failed",
      committedStatus: "completed",
      transcriptVersion: 1,
      errorCode: "ENGINE_FAILURE",
      errorStage: "diarizing",
    },
  });
  expect(readText(repository)).toEqual(["旧版本"]);
});

it("expected version 不匹配时拒绝开始重跑且不改变会议", async () => {
  const { repository } = await createRepository();
  commitVersionOne(repository);

  expect(() => repository.beginRetranscription({
    meetingId: MEETING_ID,
    expectedVersion: 0,
    runId: RETRANSCRIBE_RUN_ID,
    nowMs: 3_000,
  })).toThrow(expect.objectContaining({ code: "TRANSCRIPT_VERSION_CONFLICT" }));
  expect(repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "completed",
    transcriptVersion: 1,
    activeRunId: null,
  });
});

it("错误 run id 不能提交或结束当前运行", async () => {
  const { repository } = await createRepository();
  startImport(repository);

  expect(repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: WRONG_RUN_ID,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 10_000,
    engineFingerprint: "a".repeat(64),
    segments: [
      { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "错误运行" },
    ],
    nowMs: 2_000,
  })).toMatchObject({ outcome: "run_not_active" });
  expect(() => repository.finishRun({
    meetingId: MEETING_ID,
    runId: WRONG_RUN_ID,
    baseVersion: 0,
    outcome: "failed",
    errorCode: "ENGINE_FAILURE",
    errorStage: "transcribing",
    nowMs: 3_000,
  })).toThrow(expect.objectContaining({ code: "RUN_STATE_CONFLICT" }));
  expect(repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "processing",
    transcriptVersion: 0,
    activeRunId: IMPORT_RUN_ID,
  });
  expect(readText(repository)).toEqual([]);
});

it("取消已赢时不再接纳或校验迟到候选", async () => {
  const { repository } = await createRepository();
  startImport(repository);
  repository.finishRun({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "transcribing",
    nowMs: 2_000,
  });

  expect(repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 10_000,
    engineFingerprint: "a".repeat(64),
    segments: [],
    nowMs: 3_000,
  })).toMatchObject({ outcome: "run_not_active", meeting: { status: "cancelled" } });
});

it.each([
  {
    name: "empty",
    status: "empty" as const,
    reason: "silent",
    segments: [],
  },
  {
    name: "partial",
    status: "partial" as const,
    reason: "unknown_speaker_segments",
    segments: [
      { seq: 0, startMs: 100, endMs: 500, speakerLabel: "UNKNOWN", text: "嗯" },
    ],
  },
])("原子提交 $name 候选", async ({ status, reason, segments }) => {
  const { repository } = await createRepository();
  startImport(repository);

  expect(repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    resultStatus: status,
    resultReason: reason,
    durationMs: 1_000,
    engineFingerprint: "a".repeat(64),
    segments,
    nowMs: 2_000,
  })).toMatchObject({
    outcome: "committed",
    meeting: { status, committedStatus: status, resultReason: reason, transcriptVersion: 1 },
  });
  expect(repository.getMeetingPage({ meetingId: MEETING_ID }).transcript).toMatchObject({
    available: true,
    version: 1,
    resultStatus: status,
  });
  expect(readText(repository)).toEqual(segments.map((segment) => segment.text));
});
