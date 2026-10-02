import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import { SCHEMA_V2_SQL, SCHEMA_V3_SQL } from "../../src/storage/schema.js";

const V1_SCHEMA_URL = new URL("../fixtures/storage/schema-v1.sql", import.meta.url);
const MEETING_ID = "00000000-0000-4000-8000-000000000001";
const FAILED_MEETING_ID = "00000000-0000-4000-8000-000000000002";
const DELETING_MEETING_ID = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];
const repositories: MeetingRepository[] = [];

async function createV1Database(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-schema-v1-"));
  const filename = join(root, "meetings.sqlite3");
  roots.push(root);
  const database = new DatabaseSync(filename);
  database.exec(await readFile(V1_SCHEMA_URL, "utf8"));
  database.prepare(`
    INSERT INTO meetings (
      meeting_id, title, source_name, source_format, source_size_bytes,
      source_sha256, duration_ms, status, committed_status, transcript_version,
      engine_fingerprint, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'm4a', ?, ?, ?, 'completed', 'completed', 1, ?, ?, ?)
  `).run(
    MEETING_ID,
    "迁移前会议",
    "legacy.m4a",
    4_096,
    "b".repeat(64),
    1_500,
    "a".repeat(64),
    1_000,
    2_000,
  );
  database.prepare(`
    INSERT INTO segments (
      segment_pk, meeting_id, transcript_version, seq,
      start_ms, end_ms, speaker_label, text
    ) VALUES (41, ?, 1, 0, 0, 1500, 'Speaker A', '保留迁移全文检索')
  `).run(MEETING_ID);
  database.prepare(`
    INSERT INTO meetings (
      meeting_id, title, source_name, source_format, source_size_bytes,
      status, error_code, error_stage, created_at_ms, updated_at_ms
    ) VALUES (?, '失败会议', 'failed.wav', 'wav', 2048,
      'failed', 'MODEL_INFERENCE_FAILED', 'asr', 3000, 4000)
  `).run(FAILED_MEETING_ID);
  database.prepare(`
    INSERT INTO meetings (
      meeting_id, title, source_name, source_format, source_size_bytes,
      status, created_at_ms, updated_at_ms
    ) VALUES (?, '删除中会议', 'deleting.mp3', 'mp3', 1024,
      'deleting', 5000, 6000)
  `).run(DELETING_MEETING_ID);
  database.close();
  return filename;
}

async function createV2Database(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-schema-v2-"));
  const filename = join(root, "meetings.sqlite3");
  roots.push(root);
  const database = new DatabaseSync(filename);
  database.exec(SCHEMA_V2_SQL);
  database.prepare(`
    INSERT INTO meetings (
      meeting_id, origin, title, source_name, source_format, source_size_bytes,
      source_sha256, duration_ms, status, committed_status, transcript_version,
      engine_fingerprint, created_at_ms, updated_at_ms
    ) VALUES (?, 'recording', ?, 'recording.wav', 'wav', ?, ?, ?,
      'completed', 'completed', 1, ?, ?, ?)
  `).run(
    MEETING_ID,
    "v2 录音会议",
    4_096,
    "b".repeat(64),
    1_500,
    "a".repeat(64),
    1_000,
    2_000,
  );
  database.prepare(`
    INSERT INTO segments (
      segment_pk, meeting_id, transcript_version, seq,
      start_ms, end_ms, speaker_label, text
    ) VALUES (51, ?, 1, 0, 0, 1500, 'Speaker A', '保留 v2 全文检索')
  `).run(MEETING_ID);
  database.close();
  return filename;
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it("打开 v1 数据库后保留会议、转写和全文检索并标记为导入来源", async () => {
  const filename = await createV1Database();
  const repository = openMeetingRepository(filename);
  repositories.push(repository);

  expect(repository.getMeeting(MEETING_ID)).toMatchObject({
    meetingId: MEETING_ID,
    origin: "import",
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
    sourceName: "legacy.m4a",
    transcriptVersion: 1,
  });
  expect(repository.getMeetingPage({ meetingId: MEETING_ID }).transcript.segments)
    .toMatchObject([{ seq: 0, text: "保留迁移全文检索" }]);
  expect(repository.searchMeetings({ query: "迁移全文" }).items)
    .toMatchObject([{ meetingId: MEETING_ID, hits: [{ snippet: "保留迁移全文检索" }] }]);
  expect(repository.getMeeting(FAILED_MEETING_ID))
    .toMatchObject({ origin: "import", status: "failed", errorCode: "MODEL_INFERENCE_FAILED" });
  expect(repository.getMeeting(DELETING_MEETING_ID))
    .toMatchObject({ origin: "import", status: "deleting" });

  repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
  const reopened = openMeetingRepository(filename);
  repositories.push(reopened);
  expect(reopened.getMeeting(MEETING_ID))
    .toMatchObject({ origin: "import", transcriptVersion: 1 });
  reopened.close();
  repositories.splice(repositories.indexOf(reopened), 1);
  const database = new DatabaseSync(filename, { readOnly: true });
  expect(database.prepare("SELECT segment_pk FROM segments").get())
    .toEqual({ segment_pk: 41 });
  database.close();
});

it("打开 v2 数据库后无损增加 nullable 录音始止字段", async () => {
  const filename = await createV2Database();
  const repository = openMeetingRepository(filename);
  repositories.push(repository);

  expect(repository.getMeeting(MEETING_ID)).toMatchObject({
    meetingId: MEETING_ID,
    origin: "recording",
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
    transcriptVersion: 1,
  });
  expect(repository.searchMeetings({ query: "v2 全文" }).items)
    .toMatchObject([{ meetingId: MEETING_ID }]);

  repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
  const database = new DatabaseSync(filename);
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  expect(version.user_version).toBe(4);
  expect(database.prepare("SELECT segment_pk FROM segments").get())
    .toEqual({ segment_pk: 51 });
  expect(() => database.prepare(`
    UPDATE meetings SET recording_started_at_ms = 999 WHERE meeting_id = ?
  `).run(MEETING_ID)).toThrow();
  database.prepare(`
    UPDATE meetings SET recording_started_at_ms = 1200 WHERE meeting_id = ?
  `).run(MEETING_ID);
  expect(() => database.prepare(`
    UPDATE meetings SET recording_ended_at_ms = 1199 WHERE meeting_id = ?
  `).run(MEETING_ID)).toThrow();
  database.prepare(`
    UPDATE meetings SET recording_ended_at_ms = 1300 WHERE meeting_id = ?
  `).run(MEETING_ID);
  database.close();
});

it("新数据库直接创建 schema v4 与录音时间约束", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-schema-v3-"));
  const filename = join(root, "meetings.sqlite3");
  roots.push(root);
  const repository = openMeetingRepository(filename);
  repository.close();

  const database = new DatabaseSync(filename);
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  const columns = database.prepare("PRAGMA table_info(meetings)").all() as Record<string, unknown>[];
  const activeIndex = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_one_active_run'
  `).get() as Record<string, unknown> | undefined;
  database.close();

  expect(version.user_version).toBe(4);
  expect(columns.map((column) => column.name)).toContain("origin");
  expect(columns.map((column) => column.name)).toContain("recording_started_at_ms");
  expect(columns.map((column) => column.name)).toContain("recording_ended_at_ms");
  expect(activeIndex?.sql).toContain("'recording', 'processing'");
});


it("migrates v3 without guessing the historical processing mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-schema-v3-identity-"));
  roots.push(root);
  const filename = join(root, "meetings.sqlite3");
  const database = new DatabaseSync(filename);
  database.exec(SCHEMA_V3_SQL);
  database.prepare(`INSERT INTO meetings (meeting_id, origin, title, source_name, source_format,
    source_size_bytes, duration_ms, status, committed_status, transcript_version,
    engine_fingerprint, created_at_ms, updated_at_ms)
    VALUES (?, 'import', 'Legacy mode', 'legacy.wav', 'wav', 1024, 1000,
      'completed', 'completed', 1, ?, 1000, 2000)`).run(MEETING_ID, "a".repeat(64));
  database.prepare(`INSERT INTO segments (segment_pk, meeting_id, transcript_version,
    seq, start_ms, end_ms, speaker_label, text)
    VALUES (61, ?, 1, 0, 0, 1000, 'Speaker A', 'legacy identity preserved')`).run(MEETING_ID);
  database.close();
  const repository = openMeetingRepository(filename);
  repositories.push(repository);
  expect(repository.getMeeting(MEETING_ID)).toMatchObject({ runIdentity: null,
    transcriptIdentity: null, engineFingerprint: "a".repeat(64), transcriptVersion: 1 });
  expect(repository.getMeetingPage({ meetingId: MEETING_ID }).transcript.segments[0]?.text)
    .toBe("legacy identity preserved");
  expect(repository.searchMeetings({ query: "identity preserved" }).items).toHaveLength(1);
});
