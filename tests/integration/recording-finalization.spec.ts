import { rm } from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";

import { finalizeRecordingRun } from "../../src/application/recording-finalization.js";
import type { RecordingWorkerSession } from "../../src/recording/worker-client.js";
import type { RecordingFinalResultMessage } from "../../src/recording/worker-types.js";
import type { MeetingRepository } from "../../src/storage/meeting-repository.js";
import { TestAudioStore } from "../helpers/meeting-application-fixture.js";
import {
  createTemporaryMeetingRepository,
  importRunId,
  meetingId,
} from "../helpers/meeting-repository-fixture.js";

const roots: string[] = [];
const repositories: MeetingRepository[] = [];
const FINGERPRINT = "a".repeat(64);

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function repository(): Promise<MeetingRepository> {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  temporary.repository.createRecording({
    meetingId: meetingId(1),
    title: "录音会议",
    runId: importRunId(1),
    nowMs: 1_000,
  });
  temporary.repository.recordRecordingStarted({
    meetingId: meetingId(1),
    runId: importRunId(1),
    startedAtMs: 1_200,
  });
  return temporary.repository;
}

function finalResult(): RecordingFinalResultMessage {
  return {
    type: "final_result",
    request_id: "44444444-4444-4444-8444-444444444444",
    base_transcript_version: 0,
    engine_fingerprint: FINGERPRINT,
    payload: {
      duration_ms: 5_000,
      source_size_bytes: 160_044,
      source_sha256: "e".repeat(64),
      result_status: "completed",
      result_reason: null,
      segments: [{
        seq: 0,
        start_ms: 100,
        end_ms: 4_500,
        speaker_label: "Speaker A",
        text: "最终文本。",
      }],
      audio_files: ["audio.tmp.wav", "mic.tmp.wav"],
      metrics: { finalization_ms: 20, max_rss_bytes: 30, cache_hits: 1, cache_misses: 0 },
    },
  };
}

function session(finalize: RecordingWorkerSession["finalize"]): RecordingWorkerSession {
  return {
    completion: new Promise(() => undefined),
    snapshot: () => ({ revision: 0, audioThroughMs: 0, generatedAtMs: 0, segments: [] }),
    finalize,
    terminate: async () => undefined,
  };
}

function input(repository: MeetingRepository, worker: RecordingWorkerSession, audio = new TestAudioStore()) {
  let nowMs = 2_000;
  return {
    identity: {
      meetingId: meetingId(1),
      runId: importRunId(1),
      baseVersion: 0,
      requestId: "44444444-4444-4444-8444-444444444444",
      captureEndUs: 5_000_000,
      deadlineAtMs: 30_010,
      recordingEndedAtMs: 1_800,
    },
    dependencies: {
      audioStore: audio,
      engineFingerprint: FINGERPRINT,
      monotonicNow: () => 10,
      now: () => nowMs++,
      repository,
      worker,
    },
  };
}

it("promotes verified audio then commits one authoritative v1", async () => {
  const repo = await repository();
  const audio = new TestAudioStore();
  const worker = session(vi.fn(async () => finalResult()));

  const result = await finalizeRecordingRun(input(repo, worker, audio));

  expect(result).toMatchObject({ outcome: "committed", meeting: { transcriptVersion: 1 } });
  expect(audio.promoted).toEqual([meetingId(1)]);
  expect(repo.getMeeting(meetingId(1))).toMatchObject({
    status: "completed",
    committedStatus: "completed",
    recordingStartedAtMs: 1_200,
    recordingEndedAtMs: 1_800,
    sourceSizeBytes: 160_044,
    sourceSha256: "e".repeat(64),
  });
});

it("lets cancellation win the repository CAS without a half transcript", async () => {
  const repo = await repository();
  const worker = session(async () => {
    repo.finishRun({
      meetingId: meetingId(1),
      runId: importRunId(1),
      baseVersion: 0,
      outcome: "cancelled",
      errorCode: "CANCELLED_BY_USER",
      errorStage: "finalizing",
      nowMs: 3_000,
    });
    return finalResult();
  });

  const result = await finalizeRecordingRun(input(repo, worker));

  expect(result).toMatchObject({ outcome: "run_not_active", meeting: { status: "cancelled" } });
  expect(repo.getMeetingPage({ meetingId: meetingId(1) }).transcript.available).toBe(false);
});

it("returns the cancellation winner when it precedes the finalization fence", async () => {
  const repo = await repository();
  repo.finishRun({
    meetingId: meetingId(1),
    runId: importRunId(1),
    baseVersion: 0,
    outcome: "cancelled",
    errorCode: "CANCELLED_BY_USER",
    errorStage: "recording",
    nowMs: 1_500,
  });
  const finalize = vi.fn(async () => finalResult());

  const result = await finalizeRecordingRun(input(repo, session(finalize)));

  expect(result).toMatchObject({ outcome: "run_not_active", meeting: { status: "cancelled" } });
  expect(finalize).not.toHaveBeenCalled();
  expect(repo.getMeetingPage({ meetingId: meetingId(1) }).transcript.available).toBe(false);
});

it("records a terminal Worker failure without deleting the recording facts", async () => {
  const repo = await repository();
  const worker = session(async () => {
    throw Object.assign(new Error("private detail"), { code: "MODEL_INFERENCE_FAILED" });
  });

  await expect(finalizeRecordingRun(input(repo, worker))).rejects.toMatchObject({
    code: "MODEL_INFERENCE_FAILED",
  });
  expect(repo.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    errorCode: "MODEL_INFERENCE_FAILED",
    recordingEndedAtMs: 1_800,
    transcriptVersion: 0,
  });
});

it("keeps version zero and the closed audio facts when promotion runs out of storage", async () => {
  const repo = await repository();
  const audio = new TestAudioStore({
    promoteError: Object.assign(new Error("disk full"), { code: "STORAGE_FAILURE" }),
  });

  await expect(finalizeRecordingRun(input(
    repo,
    session(async () => finalResult()),
    audio,
  ))).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(audio.promoted).toEqual([meetingId(1)]);
  expect(repo.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "failed", errorCode: "STORAGE_FAILURE", transcriptVersion: 0 },
    transcript: { available: false },
  });
});

it("rejects a promoted file claim mismatch before SQLite commit", async () => {
  const repo = await repository();
  const audio = new TestAudioStore();
  const promote = audio.promoteRecordingCandidate.bind(audio);
  vi.spyOn(audio, "promoteRecordingCandidate").mockImplementationOnce(async (...args) => ({
    ...await promote(...args),
    sourceSizeBytes: 160_046,
  }));

  await expect(finalizeRecordingRun(input(
    repo,
    session(async () => finalResult()),
    audio,
  ))).rejects.toMatchObject({ code: "AUDIO_READ_FAILED" });
  expect(repo.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    errorCode: "AUDIO_READ_FAILED",
    transcriptVersion: 0,
  });
});

it("turns a SQLite commit failure into a recoverable failed run without a half version", async () => {
  const repo = await repository();
  const audio = new TestAudioStore();
  vi.spyOn(repo, "commitTranscript").mockImplementationOnce(() => {
    throw new Error("sqlite write failed");
  });

  await expect(finalizeRecordingRun(input(
    repo,
    session(async () => finalResult()),
    audio,
  ))).rejects.toMatchObject({ code: "ENGINE_FAILURE" });
  expect(audio.promoted).toEqual([meetingId(1)]);
  expect(repo.getMeetingPage({ meetingId: meetingId(1) })).toMatchObject({
    meeting: { status: "failed", errorCode: "ENGINE_FAILURE", transcriptVersion: 0 },
    transcript: { available: false },
  });
});

it("fails explicitly before promotion when the shared thirty-second deadline is exhausted", async () => {
  const repo = await repository();
  const audio = new TestAudioStore();
  const worker = session(async () => finalResult());
  let call = 0;
  const request = input(repo, worker, audio);
  request.dependencies.monotonicNow = () => call++ === 0 ? 0 : 29_950;

  await expect(finalizeRecordingRun(request)).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
  expect(audio.promoted).toEqual([]);
  expect(repo.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    errorCode: "WORKER_TIMEOUT",
    transcriptVersion: 0,
  });
});
