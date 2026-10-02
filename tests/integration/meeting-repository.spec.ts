import { createProcessingIdentity } from "../../src/assets/processing-identity.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";

const roots: string[] = [];
const repositories: MeetingRepository[] = [];

async function createRepository(): Promise<MeetingRepository> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-store-"));
  const repository = openMeetingRepository(join(root, "meetings.sqlite3"));
  roots.push(root);
  repositories.push(repository);
  return repository;
}

function closeRepository(repository: MeetingRepository): void {
  repository.close();
  const index = repositories.indexOf(repository);
  if (index >= 0) repositories.splice(index, 1);
}

function commitOldVersion(repository: MeetingRepository): void {
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });
  repository.commitTranscript({
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
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

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it("将 SQLite 主文件权限收紧为 owner-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-store-mode-"));
  const filename = join(root, "meetings.sqlite3");
  const repository = openMeetingRepository(filename);
  roots.push(root);
  repositories.push(repository);

  expect((await stat(filename)).mode & 0o777).toBe(0o600);
});

it("持久化并读回新导入的 processing 会议", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });

  expect(repository.getMeeting("11111111-1111-4111-8111-111111111111")).toEqual({
    meetingId: "11111111-1111-4111-8111-111111111111",
    origin: "import",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    sourceSha256: null,
    durationMs: null,
    status: "processing",
    committedStatus: null,
    transcriptVersion: 0,
    resultReason: null,
    engineFingerprint: null,
    runIdentity: null,
    transcriptIdentity: null,
    activeRunId: "22222222-2222-4222-8222-222222222222",
    runKind: "import",
    errorCode: null,
    errorStage: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
  });
});

it("繁忙时拒绝第二个导入且不留下会议", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "第一场",
    sourceName: "first.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });

  expect(() => repository.createImport({
    meetingId: "33333333-3333-4333-8333-333333333333",
    title: "第二场",
    sourceName: "second.m4a",
    sourceFormat: "m4a",
    sourceSizeBytes: 2048,
    runId: "44444444-4444-4444-8444-444444444444",
    nowMs: 2_000,
  })).toThrow(expect.objectContaining({ code: "ENGINE_BUSY" }));
  expect(repository.getMeeting("33333333-3333-4333-8333-333333333333")).toBeNull();
});

it("以活动 run id 记录同一 fd 受管副本的 SHA-256", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });

  expect(repository.recordManagedSource({
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    sourceSha256: "a".repeat(64),
    nowMs: 2_000,
  })).toMatchObject({ outcome: "updated", meeting: { sourceSha256: "a".repeat(64) } });
});

it("错误 run id 不能记录受管副本 SHA-256", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });

  expect(repository.recordManagedSource({
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "33333333-3333-4333-8333-333333333333",
    sourceSha256: "a".repeat(64),
    nowMs: 2_000,
  })).toMatchObject({ outcome: "run_not_active", meeting: { sourceSha256: null } });
});

it("原子提交完整候选并从 committed 版本读取", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });

  const result = repository.commitTranscript({
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 10_000,
    engineFingerprint: "a".repeat(64),
    segments: [
      { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "早上好" },
      { seq: 1, startMs: 1_100, endMs: 2_000, speakerLabel: "Speaker B", text: "开始吧" },
    ],
    nowMs: 2_000,
  });

  expect(result).toMatchObject({
    outcome: "committed",
    meeting: { status: "completed", committedStatus: "completed", transcriptVersion: 1 },
  });
  expect(repository.getMeetingPage({
    meetingId: "11111111-1111-4111-8111-111111111111",
    limit: 200,
  }).transcript.segments).toMatchObject([
    { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "早上好" },
    { seq: 1, startMs: 1_100, endMs: 2_000, speakerLabel: "Speaker B", text: "开始吧" },
  ]);
});

it("取消先赢时拒绝迟到候选且不留下转写", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    sourceName: "weekly.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1024,
    runId: "22222222-2222-4222-8222-222222222222",
    nowMs: 1_000,
  });

  expect(repository.finishRun({
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "transcribing",
    nowMs: 2_000,
  })).toMatchObject({ outcome: "updated", meeting: { status: "cancelled" } });

  expect(repository.commitTranscript({
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 10_000,
    engineFingerprint: "a".repeat(64),
    segments: [
      { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "迟到" },
    ],
    nowMs: 3_000,
  })).toMatchObject({ outcome: "run_not_active", meeting: { status: "cancelled" } });
  expect(repository.getMeetingPage({
    meetingId: "11111111-1111-4111-8111-111111111111",
    limit: 200,
  }).transcript.segments).toEqual([]);
});

it("开始重转写后继续读取旧 committed 版本", async () => {
  const repository = await createRepository();
  commitOldVersion(repository);

  expect(repository.beginRetranscription({
    meetingId: "11111111-1111-4111-8111-111111111111",
    expectedVersion: 1,
    runId: "33333333-3333-4333-8333-333333333333",
    nowMs: 3_000,
  })).toMatchObject({
    baseVersion: 1,
    targetVersion: 2,
    meeting: {
      status: "processing",
      committedStatus: "completed",
      transcriptVersion: 1,
      activeRunId: "33333333-3333-4333-8333-333333333333",
      runKind: "retranscribe",
    },
  });
  expect(repository.getMeetingPage({
    meetingId: "11111111-1111-4111-8111-111111111111",
    limit: 200,
  }).transcript.segments).toMatchObject([
    { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "旧版本" },
  ]);
});

it("重启收敛孤儿运行并保留旧 committed 版本", async () => {
  const repository = await createRepository();
  const filename = join(roots[0]!, "meetings.sqlite3");
  commitOldVersion(repository);
  repository.beginRetranscription({
    meetingId: "11111111-1111-4111-8111-111111111111",
    expectedVersion: 1,
    runId: "33333333-3333-4333-8333-333333333333",
    nowMs: 3_000,
  });
  closeRepository(repository);

  const reopened = openMeetingRepository(filename);
  repositories.push(reopened);
  expect(reopened.reconcileOrphanedRuns(4_000)).toBe(1);
  expect(reopened.getMeeting("11111111-1111-4111-8111-111111111111")).toMatchObject({
    status: "failed",
    committedStatus: "completed",
    transcriptVersion: 1,
    activeRunId: null,
    runKind: null,
    errorCode: "ORPHANED_BY_RESTART",
    errorStage: "startup",
  });
  expect(reopened.getMeetingPage({
    meetingId: "11111111-1111-4111-8111-111111111111",
    limit: 200,
  }).transcript.segments).toMatchObject([
    { seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "旧版本" },
  ]);
});

it("拒绝高于当前实现的数据库 schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-store-"));
  roots.push(root);
  const filename = join(root, "meetings.sqlite3");
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA user_version = 5");
  database.close();

  expect(() => openMeetingRepository(filename)).toThrow(expect.objectContaining({
    code: "SCHEMA_VERSION_UNSUPPORTED",
  }));
});

it("打开时拒绝存在孤儿 segment 的数据库", async () => {
  const repository = await createRepository();
  const filename = join(roots[0]!, "meetings.sqlite3");
  closeRepository(repository);
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = OFF");
  database.prepare(`
    INSERT INTO segments (
      meeting_id, transcript_version, seq, start_ms, end_ms, speaker_label, text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("missing", 1, 0, 0, 1, "Speaker A", "孤儿");
  database.close();

  expect(() => openMeetingRepository(filename)).toThrow(expect.objectContaining({
    code: "DATABASE_INTEGRITY_FAILED",
  }));
});

it("把数据库打开失败映射为稳定存储错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-store-"));
  roots.push(root);

  expect(() => openMeetingRepository(root)).toThrow(expect.objectContaining({
    code: "STORAGE_FAILURE",
  }));
});


it("persists attempted and committed mode identities independently", async () => {
  const repository = await createRepository();
  const manifest = { schemaVersion: 2 as const, algorithmRevision: "test-v1", assets: [] };
  const base = createProcessingIdentity(manifest, "a".repeat(64), "base");
  const enhanced = createProcessingIdentity(manifest, "a".repeat(64), "enhanced");
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  repository.createImport({ meetingId, runId, title: "Mode test", sourceName: "mode.wav",
    sourceFormat: "wav", sourceSizeBytes: 1024, nowMs: 1_000, processingIdentity: base });
  expect(repository.getMeeting(meetingId)).toMatchObject({ runIdentity: base, transcriptIdentity: null });
  const candidate = { meetingId, runId, baseVersion: 0, resultStatus: "completed" as const,
    resultReason: null, durationMs: 10_000, engineFingerprint: base.engineFingerprint,
    segments: [{ seq: 0, startMs: 100, endMs: 1_000, speakerLabel: "Speaker A", text: "mode" }],
    nowMs: 2_000 };
  expect(() => repository.commitTranscript({ ...candidate, engineFingerprint: enhanced.engineFingerprint }))
    .toThrow(expect.objectContaining({ code: "RUN_STATE_CONFLICT" }));
  expect(repository.commitTranscript(candidate).meeting)
    .toMatchObject({ runIdentity: base, transcriptIdentity: base });
  const secondRunId = "33333333-3333-4333-8333-333333333333";
  repository.beginRetranscription({ meetingId, runId: secondRunId, expectedVersion: 1,
    nowMs: 3_000, processingIdentity: enhanced });
  repository.finishRun({ meetingId, runId: secondRunId, baseVersion: 1, outcome: "failed",
    errorCode: "MODEL_INFERENCE_FAILED", errorStage: "asr", nowMs: 4_000 });
  expect(repository.getMeeting(meetingId))
    .toMatchObject({ runIdentity: enhanced, transcriptIdentity: base, transcriptVersion: 1 });
  expect(repository.getMeetingPage({ meetingId }).transcript.segments[0]?.text).toBe("mode");
});
