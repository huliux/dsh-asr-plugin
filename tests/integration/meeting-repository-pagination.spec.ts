import { rm } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import type { MeetingRepository } from "../../src/storage/meeting-repository.js";
import {
  commitMeeting,
  createTemporaryMeetingRepository,
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

function tamper(cursor: string): string {
  const index = Math.floor(cursor.length / 2);
  const replacement = cursor[index] === "A" ? "B" : "A";
  return cursor.slice(0, index) + replacement + cursor.slice(index + 1);
}

function commitVersionTwo(repository: MeetingRepository, index: number): void {
  repository.beginRetranscription({
    meetingId: meetingId(index),
    expectedVersion: 1,
    runId: retranscribeRunId(index),
    nowMs: 10_000,
  });
  repository.commitTranscript({
    meetingId: meetingId(index),
    runId: retranscribeRunId(index),
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
      text: "第二版",
    }],
    nowMs: 11_000,
  });
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it("分页读取 committed 转写且 anchor 在版本内稳定", async () => {
  const repository = await createRepository();
  const texts = Array.from({ length: 201 }, (_, index) => `片段 ${index}`);
  commitMeeting(repository, 1, { texts, title: "超长会议" });

  expect(repository.getMeetingPage({ meetingId: meetingId(1) }).transcript.segments)
    .toHaveLength(100);
  const first = repository.getMeetingPage({ meetingId: meetingId(1), limit: 200 });
  expect(first.meeting).toMatchObject({ title: "超长会议", transcriptVersion: 1 });
  expect(first.transcript).toMatchObject({ available: true, version: 1, resultStatus: "completed" });
  expect(first.transcript.segments).toHaveLength(200);
  expect(first.transcript.segments[0]).toMatchObject({
    anchor: `${meetingId(1)}@v1:0`, seq: 0, text: "片段 0",
  });
  expect(first.transcript.nextCursor).not.toBeNull();

  const second = repository.getMeetingPage({
    meetingId: meetingId(1), cursor: first.transcript.nextCursor!, limit: 200,
  });
  expect(second.transcript.segments).toEqual([expect.objectContaining({ seq: 200 })]);
  expect(second.transcript.nextCursor).toBeNull();
});

it("首次导入未提交时明确返回 transcript unavailable", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: meetingId(1),
    title: "处理中",
    sourceName: "pending.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: retranscribeRunId(1),
    nowMs: 1_000,
  });

  expect(repository.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "processing", transcriptVersion: 0 },
    transcript: {
      available: false, version: null, resultStatus: null, segments: [], nextCursor: null,
    },
  });
  expect(() => repository.getMeetingPage({ meetingId: meetingId(99) })).toThrow(
    expect.objectContaining({ code: "MEETING_NOT_FOUND" }),
  );
});

it("拒绝篡改、跨会议和跨版本的 transcript cursor", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["一", "二"] });
  commitMeeting(repository, 2, { texts: ["另一场"] });
  const cursor = repository.getMeetingPage({ meetingId: meetingId(1), limit: 1 })
    .transcript.nextCursor!;

  expect(() => repository.getMeetingPage({ meetingId: meetingId(1), cursor: tamper(cursor) }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => repository.getMeetingPage({ meetingId: meetingId(2), cursor }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

  commitVersionTwo(repository, 1);
  expect(() => repository.getMeetingPage({ meetingId: meetingId(1), cursor }))
    .toThrow(expect.objectContaining({ code: "TRANSCRIPT_VERSION_CONFLICT" }));
});

it("重跑 processing、failed、cancelled 始终读取旧 committed 版本", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["保留的旧版本"] });
  repository.beginRetranscription({
    meetingId: meetingId(1), expectedVersion: 1, runId: retranscribeRunId(1), nowMs: 3_000,
  });
  expect(repository.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "processing" }, transcript: { segments: [{ text: "保留的旧版本" }] },
  });

  repository.finishRun({
    meetingId: meetingId(1), runId: retranscribeRunId(1), baseVersion: 1,
    outcome: "failed", errorCode: "ENGINE_FAILURE", errorStage: "transcribing", nowMs: 4_000,
  });
  expect(repository.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "failed" }, transcript: { segments: [{ text: "保留的旧版本" }] },
  });

  repository.beginRetranscription({
    meetingId: meetingId(1), expectedVersion: 1, runId: retranscribeRunId(2), nowMs: 5_000,
  });
  repository.finishRun({
    meetingId: meetingId(1), runId: retranscribeRunId(2), baseVersion: 1,
    outcome: "cancelled", errorCode: "CANCELLED_BY_USER", errorStage: "transcribing", nowMs: 6_000,
  });
  expect(repository.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "cancelled" }, transcript: { segments: [{ text: "保留的旧版本" }] },
  });
});

it.each([
  { name: "limit 为 0", input: { limit: 0 } },
  { name: "limit 超过 200", input: { limit: 201 } },
  { name: "cursor 超长", input: { cursor: "a".repeat(1_025) } },
  { name: "cursor 不是 base64url", input: { cursor: "***" } },
])("拒绝无效分页输入：$name", async ({ input }) => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["正文"] });
  expect(() => repository.getMeetingPage({ meetingId: meetingId(1), ...input }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
});
