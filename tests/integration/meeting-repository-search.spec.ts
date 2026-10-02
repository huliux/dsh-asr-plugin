import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import {
  commitMeeting,
  createTemporaryMeetingRepository,
  meetingId,
  retranscribeRunId,
} from "../helpers/meeting-repository-fixture.js";

const roots: string[] = [];
const repositories: MeetingRepository[] = [];
let filename = "";

async function createRepository(): Promise<MeetingRepository> {
  const temporary = await createTemporaryMeetingRepository();
  filename = temporary.filename;
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  return temporary.repository;
}

function closeRepository(repository: MeetingRepository): void {
  repository.close();
  const index = repositories.indexOf(repository);
  if (index >= 0) repositories.splice(index, 1);
}

function mutateDatabase(sql: string): void {
  const database = new DatabaseSync(filename);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function tamper(cursor: string): string {
  const index = Math.floor(cursor.length / 2);
  const replacement = cursor[index] === "A" ? "B" : "A";
  return cursor.slice(0, index) + replacement + cursor.slice(index + 1);
}

function itemIds(page: { readonly items: readonly { readonly meetingId: string }[] }): string[] {
  return page.items.map((item) => item.meetingId);
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
  filename = "";
});

it("无 query 时按 created_at 和 meeting_id 倒序 keyset 分页并排除 deleting", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { createdAtMs: 1_000, texts: ["旧会议"] });
  commitMeeting(repository, 2, { createdAtMs: 2_000, texts: ["同日甲"] });
  commitMeeting(repository, 3, { createdAtMs: 2_000, texts: ["同日乙"] });
  commitMeeting(repository, 4, { createdAtMs: 3_000, texts: ["待删除"] });
  mutateDatabase(`UPDATE meetings SET status = 'deleting' WHERE meeting_id = '${meetingId(4)}'`);

  const first = repository.searchMeetings({ limit: 2 });
  expect(itemIds(first)).toEqual([meetingId(3), meetingId(2)]);
  expect(first.items.every((item) => item.hits.length === 0)).toBe(true);
  expect(first.nextCursor).not.toBeNull();

  const second = repository.searchMeetings({ cursor: first.nextCursor!, limit: 2 });
  expect(itemIds(second)).toEqual([meetingId(1)]);
  expect(second.nextCursor).toBeNull();
  expect(repository.searchMeetings({ query: "待删除" }).items).toEqual([]);
});

it("中文、英文和标点 query 只按字面量检索", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, {
    texts: ["今天讨论项目进度安排", "百分比 100% 是字面量", "Use C++ parser"],
    title: "中文项目会",
  });
  commitMeeting(repository, 2, {
    texts: ["Launch Plan approved", "He said \"ship it\" today", "path \\ and _ underscore"],
    title: "English launch",
  });
  commitMeeting(repository, 3, { texts: ["alpha beta but no literal operator phrase"] });

  expect(itemIds(repository.searchMeetings({ query: "项目进度" }))).toEqual([meetingId(1)]);
  expect(itemIds(repository.searchMeetings({ query: "launch plan" }))).toEqual([meetingId(2)]);
  expect(itemIds(repository.searchMeetings({ query: "C++" }))).toEqual([meetingId(1)]);
  expect(itemIds(repository.searchMeetings({ query: "\"ship it\"" }))).toEqual([meetingId(2)]);
  expect(itemIds(repository.searchMeetings({ query: "%" }))).toEqual([meetingId(1)]);
  expect(itemIds(repository.searchMeetings({ query: "_" }))).toEqual([meetingId(2)]);
  expect(itemIds(repository.searchMeetings({ query: "\\" }))).toEqual([meetingId(2)]);
  expect(repository.searchMeetings({ query: "alpha OR beta" }).items).toEqual([]);
  expect(repository.searchMeetings({ query: "不存在" }).items).toEqual([]);
});

it("每会最多返回 3 hits 且 snippet 保留命中并限制为 240 个 Unicode 字符", async () => {
  const repository = await createRepository();
  const longHit = `${"前".repeat(180)}needle${"后".repeat(180)}`;
  commitMeeting(repository, 1, {
    texts: [longHit, "needle 二", "needle 三", "needle 四", "needle 五"],
  });

  const page = repository.searchMeetings({ query: "needle" });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.hits).toHaveLength(3);
  expect(page.items[0]!.hits[0]!.snippet).toContain("needle");
  expect(Array.from(page.items[0]!.hits[0]!.snippet)).toHaveLength(240);
  expect(page.items[0]!.hits.map((hit) => hit.anchor)).toEqual([
    `${meetingId(1)}@v1:0`, `${meetingId(1)}@v1:1`, `${meetingId(1)}@v1:2`,
  ]);
});

it("query 分页不重复遗漏并拒绝篡改、跨 query 和跨模式 cursor", async () => {
  const repository = await createRepository();
  for (let index = 1; index <= 4; index += 1) {
    commitMeeting(repository, index, { texts: [`共同关键词 ${index}`] });
  }
  const first = repository.searchMeetings({ query: "共同关键词", limit: 2 });
  const second = repository.searchMeetings({
    query: "共同关键词", cursor: first.nextCursor!, limit: 2,
  });
  expect([...itemIds(first), ...itemIds(second)]).toEqual([
    meetingId(4), meetingId(3), meetingId(2), meetingId(1),
  ]);
  expect(second.nextCursor).toBeNull();

  expect(() => repository.searchMeetings({ query: "共同关键词", cursor: tamper(first.nextCursor!) }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => repository.searchMeetings({ query: "另一个词", cursor: first.nextCursor! }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => repository.searchMeetings({ cursor: first.nextCursor! }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  const recentCursor = repository.searchMeetings({ limit: 1 }).nextCursor!;
  expect(() => repository.searchMeetings({ query: "共同关键词", cursor: recentCursor }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("processing、failed、cancelled 重跑会议仍可检索旧 committed 版本", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["legacytoken old version"] });
  repository.beginRetranscription({
    meetingId: meetingId(1), expectedVersion: 1, runId: retranscribeRunId(1), nowMs: 3_000,
  });
  expect(repository.searchMeetings({ query: "legacytoken" }).items[0]).toMatchObject({
    status: "processing", transcriptVersion: 1,
  });

  repository.finishRun({
    meetingId: meetingId(1), runId: retranscribeRunId(1), baseVersion: 1,
    outcome: "failed", errorCode: "ENGINE_FAILURE", errorStage: "transcribing", nowMs: 4_000,
  });
  expect(repository.searchMeetings({ query: "legacytoken" }).items[0]).toMatchObject({
    status: "failed", transcriptVersion: 1,
  });

  repository.beginRetranscription({
    meetingId: meetingId(1), expectedVersion: 1, runId: retranscribeRunId(2), nowMs: 5_000,
  });
  repository.finishRun({
    meetingId: meetingId(1), runId: retranscribeRunId(2), baseVersion: 1,
    outcome: "cancelled", errorCode: "CANCELLED_BY_USER", errorStage: "transcribing", nowMs: 6_000,
  });
  expect(repository.searchMeetings({ query: "legacytoken" }).items[0]).toMatchObject({
    status: "cancelled", transcriptVersion: 1,
  });
});

it("外层最多分页 50 个 meetings 且 trim 后空 query 等同最近列表", async () => {
  const repository = await createRepository();
  for (let index = 1; index <= 51; index += 1) {
    commitMeeting(repository, index, { texts: [`bulk keyword ${index}`] });
  }

  const first = repository.searchMeetings({ query: "bulk keyword", limit: 50 });
  const second = repository.searchMeetings({
    query: "bulk keyword", cursor: first.nextCursor!, limit: 50,
  });
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(1);
  expect(repository.searchMeetings({ query: "bulk keyword" }).items).toHaveLength(20);
  expect(repository.searchMeetings({ query: "   ", limit: 1 }))
    .toEqual(repository.searchMeetings({ limit: 1 }));
  expect(() => repository.searchMeetings({ limit: 51 }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => repository.searchMeetings({ query: "界".repeat(501) }))
    .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(repository.searchMeetings({ query: "界".repeat(500) }).items).toEqual([]);
});

it("FTS rebuild 前后查询结果等价", async () => {
  const repository = await createRepository();
  commitMeeting(repository, 1, { texts: ["项目进度保持稳定", "第二个项目进度命中"] });
  commitMeeting(repository, 2, { texts: ["unrelated text"] });
  const before = repository.searchMeetings({ query: "项目进度" });
  closeRepository(repository);

  mutateDatabase(`
    INSERT INTO segments_fts(segments_fts) VALUES('delete-all');
    INSERT INTO segments_fts(segments_fts) VALUES('rebuild');
  `);
  const reopened = openMeetingRepository(filename);
  repositories.push(reopened);
  expect(reopened.searchMeetings({ query: "项目进度" })).toEqual(before);
});
