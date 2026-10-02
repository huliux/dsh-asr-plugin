import { rm } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import type { MeetingRepository } from "../../src/storage/meeting-repository.js";
import {
  commitMeeting,
  createTemporaryMeetingRepository,
  meetingId,
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
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("先建立 deleting 栅栏再级联删除 meeting、segments 与 FTS", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["待删除的项目进度"] });

  expect(repository.beginDeletion({
    meetingId: meetingId(1), expectedVersion: 1, nowMs: 3_000,
  })).toMatchObject({ outcome: "started", meeting: { status: "deleting" } });
  expect(repository.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "deleting" }, transcript: { available: true },
  });
  expect(repository.searchMeetings({ query: "项目进度" }).items).toEqual([]);

  repository.completeDeletion({ meetingId: meetingId(1), expectedVersion: 1 });
  expect(repository.getMeeting(meetingId(1))).toBeNull();
  expect(repository.searchMeetings({ query: "项目进度" }).items).toEqual([]);
});

it("同版本 deleting 可续清并持久记录 DELETE_INCOMPLETE", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["正文"] });
  repository.beginDeletion({ meetingId: meetingId(1), expectedVersion: 1, nowMs: 3_000 });

  expect(repository.recordDeletionFailure({
    meetingId: meetingId(1), expectedVersion: 1, nowMs: 4_000,
  })).toMatchObject({
    status: "deleting", errorCode: "DELETE_INCOMPLETE", errorStage: "deleting_files",
  });
  expect(repository.beginDeletion({
    meetingId: meetingId(1), expectedVersion: 1, nowMs: 5_000,
  })).toMatchObject({
    outcome: "resumed",
    meeting: { status: "deleting", errorCode: "DELETE_INCOMPLETE" },
  });
  expect(repository.listDeletingMeetings()).toMatchObject([{
    meetingId: meetingId(1), transcriptVersion: 1,
  }]);
});

it("删除栅栏拒绝 processing、错误版本与不存在会议", async () => {
  const repository = await createRepository();
  repository.createImport({
    meetingId: meetingId(1),
    title: "处理中",
    sourceName: "pending.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: "10000000-0000-4000-8000-000000000001",
    nowMs: 1_000,
  });
  expect(() => repository.beginDeletion({
    meetingId: meetingId(1), expectedVersion: 0, nowMs: 2_000,
  })).toThrow(expect.objectContaining({ code: "INVALID_MEETING_STATE" }));

  repository.finishRun({
    meetingId: meetingId(1),
    runId: "10000000-0000-4000-8000-000000000001",
    baseVersion: 0,
    outcome: "failed",
    errorCode: "ENGINE_FAILURE",
    errorStage: "transcribing",
    nowMs: 3_000,
  });
  expect(() => repository.beginDeletion({
    meetingId: meetingId(1), expectedVersion: 1, nowMs: 4_000,
  })).toThrow(expect.objectContaining({ code: "TRANSCRIPT_VERSION_CONFLICT" }));
  expect(() => repository.beginDeletion({
    meetingId: meetingId(9), expectedVersion: 0, nowMs: 4_000,
  })).toThrow(expect.objectContaining({ code: "MEETING_NOT_FOUND" }));
});

it("只有精确版本的 deleting 行可完成删除", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["正文"] });

  expect(() => repository.completeDeletion({
    meetingId: meetingId(1), expectedVersion: 1,
  })).toThrow(expect.objectContaining({ code: "INVALID_MEETING_STATE" }));
  repository.beginDeletion({ meetingId: meetingId(1), expectedVersion: 1, nowMs: 3_000 });
  expect(() => repository.completeDeletion({
    meetingId: meetingId(1), expectedVersion: 0,
  })).toThrow(expect.objectContaining({ code: "TRANSCRIPT_VERSION_CONFLICT" }));
  expect(repository.getMeeting(meetingId(1))).toMatchObject({ status: "deleting" });
});
