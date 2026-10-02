import { rm } from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";

import {
  RecordingSession,
  type RecordingHelperTrackSnapshot,
  type RecordingHelperSession,
  type RecordingSessionWorkerFactory,
} from "../../src/recording/recording-session.js";
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
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

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

function worker(
  completion: Promise<RecordingFinalResultMessage> = new Promise(() => undefined),
  revision = 1,
): RecordingWorkerSession {
  return {
    completion,
    snapshot: () => ({
      revision,
      audioThroughMs: 5_000,
      generatedAtMs: 2_000,
      segments: [{ seq: 0, startMs: 100, endMs: 4_500, speakerLabel: null, text: "草稿。" }],
    }),
    finalize: vi.fn(async () => finalResult()),
    terminate: vi.fn(async () => undefined),
  };
}

function helper(completion: Promise<void> = new Promise(() => undefined)): RecordingHelperSession {
  let mic: RecordingHelperTrackSnapshot = { requested: true, state: "on", errorCode: null };
  let system: RecordingHelperTrackSnapshot = { requested: true, state: "on", errorCode: null };
  return {
    completion,
    snapshot: () => ({ mic, system, captureEndUs: 5_000_000 }),
    setTrack: vi.fn(async (track, requested) => {
      const value = { requested, state: requested ? "on" : "off", errorCode: null } as const;
      if (track === "mic") mic = value;
      else system = value;
      return { mic, system, captureEndUs: 5_000_000 };
    }),
    stop: vi.fn(async () => ({ mic, system, captureEndUs: 5_000_000 })),
    terminate: vi.fn(async () => undefined),
  };
}

async function fixture(options: {
  readonly helperSession?: RecordingHelperSession;
  readonly monotonicNow?: () => number;
  readonly now?: () => number;
  readonly workerFactory?: RecordingSessionWorkerFactory;
} = {}) {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  const helperSession = options.helperSession ?? helper();
  const workerSession = worker();
  const workerFactory = options.workerFactory ?? {
    start: vi.fn(async () => workerSession),
  };
  const audio = new TestAudioStore();
  let nowMs = 1_000;
  let monotonicMs = 10;
  const release = vi.fn();
  const session = new RecordingSession({
    baseVersion: 0,
    meetingId: meetingId(1),
    requestId: "44444444-4444-4444-8444-444444444444",
    runId: importRunId(1),
    requestMonotonicMs: 10,
    requestWallClockMs: 1_000,
    title: "录音会议",
  }, {
    audioStore: audio,
    engineFingerprint: FINGERPRINT,
    helper: { start: vi.fn(async () => helperSession) },
    monotonicNow: options.monotonicNow ?? (() => monotonicMs++),
    now: options.now ?? (() => nowMs++),
    repository: temporary.repository,
    worker: workerFactory,
  }, release);
  session.claim();
  session.publish("meeting-1");
  await session.started;
  return { audio, helperSession, release, repository: temporary.repository, session, workerSession };
}

it("records first track-on after permission wait from one wall and monotonic anchor", async () => {
  const value = await fixture({ monotonicNow: () => 260 });

  expect(value.repository.getMeeting(meetingId(1))).toMatchObject({
    createdAtMs: 1_000,
    recordingStartedAtMs: 1_250,
    recordingEndedAtMs: null,
  });
  expect(value.session.view()).toMatchObject({
    recordingStartedAtMs: 1_250,
    recordingEndedAtMs: null,
    recordingElapsedMs: 0,
    durationMs: null,
  });
});

it("marks an overdue first draft stale from the recording start time", async () => {
  let nowMs = 1_000;
  const emptyWorker: RecordingWorkerSession = {
    ...worker(new Promise(() => undefined), 0),
    snapshot: () => ({
      revision: 0,
      audioThroughMs: 0,
      generatedAtMs: 0,
      segments: [],
    }),
  };
  const value = await fixture({
    now: () => nowMs,
    workerFactory: { start: vi.fn(async () => emptyWorker) },
  });

  nowMs = 11_001;

  expect(value.session.view()).toMatchObject({
    draftStale: true,
    latestAudioAtMs: 5_000,
    latestDraftAtMs: null,
  });
});

it("starts both tracks, applies idempotent track control, then commits v1 on stop", async () => {
  const value = await fixture();

  expect(value.session.view()).toMatchObject({
    meetingId: meetingId(1),
    jobId: "meeting-1",
    phase: "recording",
    mic: { requested: true, state: "on" },
    system: { requested: true, state: "on" },
    draftRevision: 1,
    latestAudioAtMs: 5_000,
  });
  await value.session.setTrack("mic", false);
  await value.session.setTrack("mic", false);
  expect(value.helperSession.setTrack).toHaveBeenCalledTimes(1);

  const stopped = await value.session.stop();

  expect(stopped).toMatchObject({
    phase: "completed",
    transcriptVersion: 1,
    recordingStartedAtMs: expect.any(Number),
    recordingEndedAtMs: expect.any(Number),
    recordingElapsedMs: expect.any(Number),
    durationMs: 5_000,
  });
  expect(stopped.recordingElapsedMs).toBe(
    stopped.recordingEndedAtMs! - stopped.recordingStartedAtMs!,
  );
  await expect(value.session.hooks.done).resolves.toMatchObject({ status: "completed" });
  expect(value.repository.getMeeting(meetingId(1))).toMatchObject({
    status: "completed",
    transcriptVersion: 1,
  });
  expect(value.release).toHaveBeenCalledWith(value.session);
});

it("keeps the DSH job report free of transcript text and absolute event times", async () => {
  const value = await fixture();

  const output = value.session.output.read(0).text;

  expect(output).not.toContain("草稿");
  expect(output).not.toContain("录音会议");
  expect(output).not.toContain("latestAudioAtMs");
  expect(output).not.toContain("latestDraftAtMs");
  expect(JSON.parse(output)).toMatchObject({
    meetingId: meetingId(1),
    phase: "recording",
    draftRevision: 1,
  });
  value.session.hooks.cancel("test complete");
  await value.session.hooks.done;
});

it("lets job cancellation win without committing the draft", async () => {
  const value = await fixture();

  value.session.hooks.cancel("user requested job_kill");

  await expect(value.session.hooks.done).resolves.toMatchObject({ status: "killed" });
  expect(value.repository.getMeeting(meetingId(1))).toMatchObject({
    status: "cancelled",
    transcriptVersion: 0,
  });
  expect(value.helperSession.terminate).toHaveBeenCalledOnce();
  expect(value.workerSession.terminate).toHaveBeenCalledOnce();
});

it("linearizes an asynchronous Helper failure before settling stop", async () => {
  const value = await fixture();
  vi.spyOn(value.helperSession, "stop").mockRejectedValueOnce(
    Object.assign(new Error("chunk timeline failed"), { code: "AUDIO_CHUNK_INVALID" }),
  );

  await expect(value.session.stop()).rejects.toMatchObject({ code: "AUDIO_CHUNK_INVALID" });

  await expect(value.session.hooks.done).resolves.toMatchObject({
    status: "failed",
    detail: "AUDIO_CHUNK_INVALID",
  });
  expect(value.repository.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    activeRunId: null,
    errorCode: "AUDIO_CHUNK_INVALID",
    transcriptVersion: 0,
  });
  expect(value.helperSession.terminate).toHaveBeenCalledOnce();
  expect(value.workerSession.terminate).toHaveBeenCalledOnce();
});

it("uses one thirty-second deadline from stop request through final commit", async () => {
  const monotonicNow = vi.fn(() => 10);
  const value = await fixture({ monotonicNow });
  monotonicNow.mockReturnValueOnce(0).mockReturnValue(30_001);

  await expect(value.session.stop()).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });

  expect(value.helperSession.stop).toHaveBeenCalledOnce();
  expect(value.workerSession.finalize).not.toHaveBeenCalled();
  expect(value.repository.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    errorCode: "WORKER_TIMEOUT",
    transcriptVersion: 0,
  });
});

it("fails and settles immediately when the Helper crashes during recording", async () => {
  const completion = Promise.withResolvers<void>();
  const helperSession = helper(completion.promise);
  const value = await fixture({ helperSession });

  completion.reject(Object.assign(new Error("helper crashed"), { code: "HELPER_PROCESS_ERROR" }));

  await expect(value.session.hooks.done).resolves.toMatchObject({
    status: "failed",
    detail: "HELPER_PROCESS_ERROR",
  });
  expect(value.repository.getMeeting(meetingId(1))).toMatchObject({
    status: "failed",
    activeRunId: null,
    errorCode: "HELPER_PROCESS_ERROR",
    recordingStartedAtMs: expect.any(Number),
    recordingEndedAtMs: null,
  });
  expect(value.helperSession.terminate).toHaveBeenCalledOnce();
  expect(value.workerSession.terminate).toHaveBeenCalledOnce();
});

it("restarts one crashed Worker from recording facts and still commits on stop", async () => {
  const crashed = Promise.withResolvers<RecordingFinalResultMessage>();
  void crashed.promise.catch(() => undefined);
  const first = worker(crashed.promise, 1);
  const replacement = worker(new Promise(() => undefined), 0);
  const factory: RecordingSessionWorkerFactory = {
    start: vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement),
  };
  const value = await fixture({ workerFactory: factory });

  crashed.reject(Object.assign(new Error("worker crashed"), { code: "WORKER_PROCESS_ERROR" }));

  await vi.waitFor(() => expect(factory.start).toHaveBeenCalledTimes(2));
  expect(value.session.view()).toMatchObject({ phase: "recording", errorCode: null });
  expect(value.session.snapshot()).toMatchObject({ revision: 0 });
  await expect(value.session.stop()).resolves.toMatchObject({
    phase: "completed",
    transcriptVersion: 1,
  });
  expect(first.terminate).toHaveBeenCalledOnce();
  expect(replacement.finalize).toHaveBeenCalledOnce();
});

it("keeps capturing after the replacement Worker crashes and rebuilds once at stop", async () => {
  const firstCrash = Promise.withResolvers<RecordingFinalResultMessage>();
  const secondCrash = Promise.withResolvers<RecordingFinalResultMessage>();
  void firstCrash.promise.catch(() => undefined);
  void secondCrash.promise.catch(() => undefined);
  const first = worker(firstCrash.promise);
  const replacement = worker(secondCrash.promise);
  const final = worker();
  const factory: RecordingSessionWorkerFactory = {
    start: vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(final),
  };
  const value = await fixture({ workerFactory: factory });

  firstCrash.reject(Object.assign(new Error("first crash"), { code: "WORKER_PROCESS_ERROR" }));
  await vi.waitFor(() => expect(factory.start).toHaveBeenCalledTimes(2));
  secondCrash.reject(Object.assign(new Error("second crash"), { code: "WORKER_PROCESS_ERROR" }));
  await vi.waitFor(() => expect(value.session.view()).toMatchObject({
    phase: "recording",
    errorCode: "WORKER_PROCESS_ERROR",
  }));

  await expect(value.session.stop()).resolves.toMatchObject({
    phase: "completed",
    errorCode: null,
  });
  expect(factory.start).toHaveBeenCalledTimes(3);
  expect(first.terminate).toHaveBeenCalledOnce();
  expect(replacement.terminate).toHaveBeenCalledOnce();
  expect(final.finalize).toHaveBeenCalledOnce();
});

it("terminates a helper that started before the Worker failed", async () => {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  const helperSession = helper();
  const session = new RecordingSession({
    baseVersion: 0,
    meetingId: meetingId(1),
    requestId: "44444444-4444-4444-8444-444444444444",
    runId: importRunId(1),
    requestMonotonicMs: 10,
    requestWallClockMs: 1_000,
    title: "录音会议",
  }, {
    audioStore: new TestAudioStore(),
    engineFingerprint: FINGERPRINT,
    helper: { start: vi.fn(async () => helperSession) },
    now: () => 1_001,
    repository: temporary.repository,
    worker: { start: vi.fn(async () => { throw new Error("worker failed"); }) },
  }, vi.fn());

  session.claim();
  session.publish("meeting-1");

  await expect(session.started).rejects.toMatchObject({ code: "ENGINE_FAILURE" });
  await expect(session.hooks.done).resolves.toMatchObject({ status: "failed" });
  expect(helperSession.terminate).toHaveBeenCalledOnce();
});
