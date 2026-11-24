import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import { openMeetingDatabase } from "../../src/storage/database.js";
import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import {
  createOkfIngestionRepository,
  type OkfIngestionRepository,
} from "../../src/storage/okf-ingestion-repository.js";

const MEETING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_MEETING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IMPORT_RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface Fixture {
  readonly directory: string;
  readonly otherDirectory: string;
  readonly database: DatabaseSync;
  readonly ingestion: OkfIngestionRepository;
  readonly meetings: MeetingRepository;
}

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const repositories: MeetingRepository[] = [];

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-okf-ingestion-"));
  roots.push(root);
  const filename = join(root, "meetings.sqlite3");
  const meetings = openMeetingRepository(filename);
  repositories.push(meetings);
  meetings.createImport({
    meetingId: MEETING_ID,
    title: "OKF 会议",
    sourceName: "okf.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: IMPORT_RUN_ID,
    nowMs: 1_000,
  });
  meetings.commitTranscript({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 5_000,
    engineFingerprint: "a".repeat(64),
    segments: [
      { seq: 0, startMs: 0, endMs: 1_000, speakerLabel: "Speaker A", text: "synthetic" },
    ],
    nowMs: 2_000,
  });
  const database = openMeetingDatabase(filename);
  databases.push(database);
  return {
    directory: join(root, "bundle"),
    otherDirectory: join(root, "other-bundle"),
    database,
    ingestion: createOkfIngestionRepository(database),
    meetings,
  };
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw");
}

it("creates the ingestion table at schema version 5", async () => {
  const fixture = await createFixture();
  const version = fixture.database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  const table = fixture.database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'okf_ingestion'
  `).get() as Record<string, unknown>;
  expect(version.user_version).toBe(5);
  expect(table.sql).toContain("PRIMARY KEY (meeting_id, transcript_version, directory)");
});

it("records a running attempt with attempt one and clears it when finished", async () => {
  const fixture = await createFixture();
  const { ingestion, directory } = fixture;

  const first = ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 10_000,
  });
  expect(first).toEqual({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "running",
    attempt: 1,
    startedAtMs: 10_000,
  });

  const failed = ingestion.finishAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "failed",
    finishedAtMs: 11_000,
    errorCode: "OKF_GIT_FAILED",
    errorMessage: "OKF commit failed",
  });
  expect(failed).toMatchObject({
    state: "failed",
    attempt: 1,
    finishedAtMs: 11_000,
    errorCode: "OKF_GIT_FAILED",
    errorMessage: "OKF commit failed",
  });

  const retry = ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 12_000,
  });
  expect(retry).toMatchObject({ state: "running", attempt: 2, startedAtMs: 12_000 });
  expect(retry.finishedAtMs).toBeUndefined();
  expect(retry.errorCode).toBeUndefined();
  expect(retry.errorMessage).toBeUndefined();

  const succeeded = ingestion.finishAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "succeeded",
    finishedAtMs: 13_000,
  });
  expect(succeeded).toMatchObject({ state: "succeeded", attempt: 2, finishedAtMs: 13_000 });
  expect(succeeded.errorCode).toBeUndefined();
  expect(ingestion.findAttempt(MEETING_ID, 1, directory)).toEqual(succeeded);
  expect(ingestion.listForMeeting(MEETING_ID, 10)).toEqual([succeeded]);
});

it("keeps one row per version and directory and orders by recency", async () => {
  const fixture = await createFixture();
  const { ingestion, directory, otherDirectory } = fixture;

  ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 20_000,
  });
  ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory: otherDirectory,
    startedAtMs: 21_000,
  });
  expect(ingestion.findLatestForMeeting(MEETING_ID)).toMatchObject({
    directory: otherDirectory,
    attempt: 1,
  });

  // The same start offset is tie-broken by attempt.
  const tied = ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 21_000,
  });
  expect(tied.attempt).toBe(2);
  expect(ingestion.findLatestForMeeting(MEETING_ID)).toMatchObject({
    directory,
    attempt: 2,
    startedAtMs: 21_000,
  });
  expect(ingestion.listForMeeting(MEETING_ID, 10).map((record) => record.directory))
    .toEqual([directory, otherDirectory]);
  expect(ingestion.listForMeeting(MEETING_ID, 1)).toHaveLength(1);

  // A new transcript version starts a fresh attempt counter.
  const nextVersion = ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 2,
    directory,
    startedAtMs: 22_000,
  });
  expect(nextVersion.attempt).toBe(1);
  expect(ingestion.listForMeeting(MEETING_ID, 10)).toHaveLength(3);
  expect(() => ingestion.listForMeeting(MEETING_ID, 0)).toThrow();
});

it("cascades ingestion rows when the meeting is deleted", async () => {
  const fixture = await createFixture();
  const { ingestion, directory, meetings, database } = fixture;

  ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 30_000,
  });
  ingestion.finishAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "failed",
    finishedAtMs: 31_000,
    errorCode: "OKF_AGENT_FAILED",
  });

  meetings.beginDeletion({ meetingId: MEETING_ID, expectedVersion: 1, nowMs: 32_000 });
  meetings.completeDeletion({ meetingId: MEETING_ID, expectedVersion: 1 });

  expect(ingestion.findLatestForMeeting(MEETING_ID)).toBeUndefined();
  expect(ingestion.listForMeeting(MEETING_ID, 10)).toEqual([]);
  expect(database.prepare("SELECT COUNT(*) AS total FROM okf_ingestion").get())
    .toEqual({ total: 0 });
});

it("rejects invalid keys, unknown meetings and unfinished attempts", async () => {
  const fixture = await createFixture();
  const { ingestion, directory } = fixture;

  expect(captureError(() => ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory: "relative/bundle",
    startedAtMs: 40_000,
  }))).toMatchObject({ code: "INVALID_INPUT" });

  expect(captureError(() => ingestion.beginAttempt({
    meetingId: OTHER_MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 40_000,
  }))).toMatchObject({ code: "MEETING_NOT_FOUND" });

  expect(captureError(() => ingestion.finishAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "succeeded",
    finishedAtMs: 41_000,
  }))).toMatchObject({ code: "RUN_STATE_CONFLICT" });

  ingestion.beginAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    startedAtMs: 42_000,
  });
  expect(captureError(() => ingestion.finishAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "failed",
    finishedAtMs: 43_000,
  }))).toMatchObject({ code: "INVALID_INPUT" });
  expect(captureError(() => ingestion.finishAttempt({
    meetingId: MEETING_ID,
    transcriptVersion: 1,
    directory,
    state: "succeeded",
    finishedAtMs: 43_000,
    errorMessage: "not allowed",
  }))).toMatchObject({ code: "INVALID_INPUT" });

  expect(ingestion.findAttempt(MEETING_ID, 9, directory)).toBeUndefined();
  expect(ingestion.findLatestForMeeting(OTHER_MEETING_ID)).toBeUndefined();
});
