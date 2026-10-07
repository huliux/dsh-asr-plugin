import { JobId } from "@deepseek-ai/dsh-jobs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type {
  RecordingHelperSession,
  RecordingHelperTrackSnapshot,
  RecordingSessionHelperFactory,
  RecordingSessionWorkerFactory,
} from "../../src/recording/recording-session.js";
import type { RecordingWorkerSession } from "../../src/recording/worker-client.js";
import type {
  DraftTranscriptSnapshot,
  RecordingFinalResultMessage,
} from "../../src/recording/worker-types.js";
import { openMeetingRepository } from "../../src/storage/meeting-repository.js";
import {
  MEETING_ID,
  RUN_ID,
  SECOND_MEETING_ID,
  TestAudioStore,
  createMeetingApplicationHarness,
  deferred,
  type MeetingApplicationHarness,
} from "../helpers/meeting-application-fixture.js";
import { commitMeeting } from "../helpers/meeting-repository-fixture.js";

const harnesses: MeetingApplicationHarness[] = [];
const FINGERPRINT = "a".repeat(64);

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function helperFactory(): {
  readonly factory: RecordingSessionHelperFactory;
  readonly session: RecordingHelperSession;
  readonly setTrack: ReturnType<typeof vi.fn>;
} {
  let mic: RecordingHelperTrackSnapshot = { requested: true, state: "on", errorCode: null };
  let system: RecordingHelperTrackSnapshot = { requested: true, state: "on", errorCode: null };
  const setTrack = vi.fn(async (track: "mic" | "system", requested: boolean) => {
    const value: RecordingHelperTrackSnapshot = {
      requested,
      state: requested ? "on" : "off",
      errorCode: null,
    };
    if (track === "mic") mic = value;
    else system = value;
    return { mic, system, captureEndUs: 5_000_000 };
  });
  const session: RecordingHelperSession = {
    completion: new Promise(() => undefined),
    snapshot: () => ({ mic, system, captureEndUs: 5_000_000 }),
    setTrack,
    stop: vi.fn(async () => ({ mic, system, captureEndUs: 5_000_000 })),
    terminate: vi.fn(async () => undefined),
  };
  return { factory: { start: vi.fn(async () => session) }, session, setTrack };
}

function result(): RecordingFinalResultMessage {
  return {
    type: "final_result",
    request_id: SECOND_MEETING_ID,
    base_transcript_version: 0,
    engine_fingerprint: FINGERPRINT,
    payload: {
      duration_ms: 5_000,
      source_size_bytes: 160_044,
      source_sha256: "e".repeat(64),
      result_status: "completed",
      result_reason: null,
      segments: [
        { seq: 0, start_ms: 100, end_ms: 2_000, speaker_label: "Speaker A", text: "第一段。" },
        { seq: 1, start_ms: 2_100, end_ms: 4_500, speaker_label: "Speaker B", text: "第二段。" },
      ],
      audio_files: ["audio.tmp.wav", "mic.tmp.wav"],
      metrics: { finalization_ms: 20, max_rss_bytes: 30, cache_hits: 1, cache_misses: 0 },
    },
  };
}

function draftSnapshot(revision: number, texts: readonly string[]): DraftTranscriptSnapshot {
  return {
    revision,
    audioThroughMs: texts.length * 1_000,
    generatedAtMs: revision * 1_000,
    segments: texts.map((text, seq) => ({
      seq,
      startMs: seq * 1_000,
      endMs: (seq + 1) * 1_000,
      speakerLabel: null,
      text,
    })),
  };
}

function workerFactory(initial = draftSnapshot(1, ["草稿一。", "草稿二。"])): RecordingSessionWorkerFactory & {
  readonly session: RecordingWorkerSession;
  updateSnapshot(snapshot: DraftTranscriptSnapshot): void;
} {
  let snapshot = initial;
  const session: RecordingWorkerSession = {
    completion: new Promise(() => undefined),
    snapshot: () => snapshot,
    finalize: vi.fn(async () => result()),
    terminate: vi.fn(async () => undefined),
  };
  return {
    session,
    start: vi.fn(async () => session),
    updateSnapshot(value) { snapshot = value; },
  };
}

it("shows every current draft segment through revision changes and after stop", async () => {
  const worker = workerFactory(draftSnapshot(1, ["一。", "二。", "三。", "四。", "五。"]));
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helperFactory().factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  expect(harness.application.getRecordingPreview().map(segment => segment.text))
    .toEqual(["一。", "二。", "三。", "四。", "五。"]);
  worker.updateSnapshot(draftSnapshot(2, ["一已修订。", "二。", "三。", "四。", "五。", "六。"]));
  expect(harness.application.getRecordingPreview().map(segment => segment.text))
    .toEqual(["一已修订。", "二。", "三。", "四。", "五。", "六。"]);
  await harness.application.controlRecording({ action: "stop", meetingId: started.meetingId });
  expect(harness.application.getRecordingPreview().map(segment => segment.text))
    .toEqual(["一已修订。", "二。", "三。", "四。", "五。", "六。"]);
});

it("uses one application seam for start, track control and provisional live drafts", async () => {
  const helper = helperFactory();
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helper.factory, worker: workerFactory(), monotonicNow: (() => {
      let value = 10;
      return () => value++;
    })() },
  });
  harnesses.push(harness);
  commitMeeting(harness.repository, 9, { texts: ["历史正文"], title: "较新的历史会议" });

  const started = await harness.application.controlRecording({ action: "start", title: "产品讨论" });
  expect(started).toMatchObject({
    meetingId: MEETING_ID,
    jobId: "meeting-1",
    phase: "recording",
    draftRevision: 1,
    recordingStartedAtMs: 1_001,
    recordingEndedAtMs: null,
    recordingElapsedMs: expect.any(Number),
    durationMs: null,
  });
  expect(harness.application.getRecordingState()).toMatchObject({
    meetingId: MEETING_ID,
    phase: "recording",
  });
  expect(harness.application.getMeetingReferenceCandidates({ locale: "zh-CN" })[0])
    .toMatchObject({
      meetingId: MEETING_ID,
      label: "产品讨论",
      phase: "recording",
      startedAtMs: 1_001,
      recordingElapsedMs: expect.any(Number),
      durationMs: null,
    });
  const draft = harness.application.getMeetingLivePage({ meetingId: MEETING_ID, limit: 1 });
  expect(draft).toMatchObject({
    provisional: true,
    revision: 1,
    transcriptVersion: null,
    segments: [{ text: "草稿一。", speakerLabel: null }],
    nextCursor: expect.any(String),
  });
  await harness.application.controlRecording({ action: "mic_off", meetingId: MEETING_ID });
  await harness.application.controlRecording({ action: "mic_off", meetingId: MEETING_ID });
  expect(helper.setTrack).toHaveBeenCalledTimes(1);
  await harness.application.controlRecording({ action: "system_off", meetingId: MEETING_ID });
  expect(helper.setTrack).toHaveBeenCalledTimes(2);
  expect(harness.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "recording",
    recordingStartedAtMs: 1_001,
    recordingEndedAtMs: null,
  });
  await expect(harness.application.startImport({ path: "/busy.wav" }))
    .rejects.toMatchObject({ code: "ENGINE_BUSY" });

  const stopped = await harness.application.controlRecording({ action: "stop", meetingId: MEETING_ID });
  expect(stopped).toMatchObject({
    phase: "completed",
    transcriptVersion: 1,
    recordingStartedAtMs: 1_001,
    recordingEndedAtMs: expect.any(Number),
    recordingElapsedMs: expect.any(Number),
    durationMs: 5_000,
  });
  await expect(harness.context.jobs.wait(JobId(started.jobId), 2_000))
    .resolves.toMatchObject({ status: "completed" });
  expect(() => harness.application.getMeetingLivePage({
    meetingId: MEETING_ID,
    cursor: draft.nextCursor!,
  })).toThrow(expect.objectContaining({ code: "DRAFT_REVISION_CONFLICT" }));
  expect(() => harness.application.getMeetingLivePage({ meetingId: MEETING_ID }))
    .toThrow(expect.objectContaining({ code: "INVALID_MEETING_STATE" }));
  expect(() => harness.application.getMeetingLivePage({
    meetingId: MEETING_ID,
    cursor: "not-a-draft-cursor",
  })).toThrow(expect.objectContaining({ code: "INVALID_MEETING_STATE" }));
  expect(harness.application.getMeetingPage({ meetingId: MEETING_ID })).toMatchObject({
    transcript: {
      version: 1,
      resultStatus: "completed",
      segments: expect.arrayContaining([
        expect.objectContaining({ text: "第一段。", speakerLabel: "Speaker A" }),
      ]),
    },
  });
  expect(harness.repository.getMeeting(MEETING_ID)).toMatchObject({
    activeRunId: null,
    status: "completed",
    transcriptVersion: 1,
    recordingStartedAtMs: 1_001,
    recordingEndedAtMs: expect.any(Number),
    durationMs: 5_000,
  });
  expect(harness.application.getRecordingState()).toMatchObject({
    meetingId: MEETING_ID,
    phase: "completed",
  });
  expect(RUN_ID).not.toBe(SECOND_MEETING_ID);
});

it("keeps one live draft revision readable while fresh reads follow newer revisions", async () => {
  const worker = workerFactory(draftSnapshot(1, ["旧一。", "旧二。", "旧三。"]));
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helperFactory().factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });

  const first = harness.application.getMeetingLivePage({ meetingId: started.meetingId, limit: 1 });
  worker.updateSnapshot(draftSnapshot(2, ["新一。", "新二。", "新三。", "新四。"]));
  const latest = harness.application.getMeetingLivePage({ meetingId: started.meetingId, limit: 1 });
  const second = harness.application.getMeetingLivePage({
    meetingId: started.meetingId,
    cursor: first.nextCursor!,
    limit: 1,
  });
  const third = harness.application.getMeetingLivePage({
    meetingId: started.meetingId,
    cursor: second.nextCursor!,
    limit: 1,
  });

  expect(latest).toMatchObject({ revision: 2, segments: [{ seq: 0, text: "新一。" }] });
  expect([first, second, third]).toMatchObject([
    { revision: 1, segments: [{ seq: 0, text: "旧一。" }] },
    { revision: 1, segments: [{ seq: 1, text: "旧二。" }] },
    { revision: 1, segments: [{ seq: 2, text: "旧三。" }], nextCursor: null },
  ]);
});

it("invalidates live draft cursors as soon as the transcript commits", async () => {
  const cleanup = deferred<void>();
  const audio = new TestAudioStore({ cleanupGate: cleanup.promise });
  const harness = await createMeetingApplicationHarness({
    audio,
    recording: { helper: helperFactory().factory, worker: workerFactory() },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const draft = harness.application.getMeetingLivePage({ meetingId: started.meetingId, limit: 1 });
  const stopping = harness.application.controlRecording({
    action: "stop",
    meetingId: started.meetingId,
  });
  try {
    await vi.waitFor(() => expect(harness.repository.getMeeting(started.meetingId)).toMatchObject({
      status: "completed",
      transcriptVersion: 1,
    }));
    expect(() => harness.application.getMeetingLivePage({
      meetingId: started.meetingId,
      cursor: draft.nextCursor!,
    })).toThrow(expect.objectContaining({ code: "DRAFT_REVISION_CONFLICT" }));
    expect(() => harness.application.getMeetingLivePage({ meetingId: started.meetingId }))
      .toThrow(expect.objectContaining({ code: "INVALID_MEETING_STATE" }));
    expect(harness.application.getMeetingPage({ meetingId: started.meetingId }))
      .toMatchObject({ transcript: { version: 1, resultStatus: "completed" } });
  } finally {
    cleanup.resolve();
  }
  await stopping;
});

it("expires a retained live draft revision even when the current revision is unchanged", async () => {
  let nowMs = 1_000;
  const worker = workerFactory(draftSnapshot(1, ["旧一。", "旧二。"]));
  const harness = await createMeetingApplicationHarness({
    now: () => nowMs,
    recording: { helper: helperFactory().factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const first = harness.application.getMeetingLivePage({ meetingId: started.meetingId, limit: 1 });
  nowMs += 5 * 60 * 1_000 + 1;

  expect(() => harness.application.getMeetingLivePage({
    meetingId: started.meetingId,
    cursor: first.nextCursor!,
    limit: 1,
  })).toThrow(expect.objectContaining({ code: "DRAFT_REVISION_CONFLICT" }));
});

it("retains at most four live draft revisions and evicts the oldest", async () => {
  const worker = workerFactory(draftSnapshot(1, ["一-1。", "一-2。"]));
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helperFactory().factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const cursors: string[] = [];
  for (let revision = 1; revision <= 5; revision += 1) {
    worker.updateSnapshot(draftSnapshot(revision, [`${revision}-1。`, `${revision}-2。`]));
    const page = harness.application.getMeetingLivePage({ meetingId: started.meetingId, limit: 1 });
    cursors.push(page.nextCursor!);
  }

  expect(() => harness.application.getMeetingLivePage({
    meetingId: started.meetingId,
    cursor: cursors[0]!,
    limit: 1,
  })).toThrow(expect.objectContaining({ code: "DRAFT_REVISION_CONFLICT" }));
  expect(harness.application.getMeetingLivePage({
    meetingId: started.meetingId,
    cursor: cursors[1]!,
    limit: 1,
  })).toMatchObject({ revision: 2, segments: [{ seq: 1, text: "2-2。" }] });
});

it("removes a completed control call's abort listener", async () => {
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helperFactory().factory, worker: workerFactory() },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const control = new AbortController();

  await harness.application.controlRecording({
    action: "mic_off",
    meetingId: started.meetingId,
    signal: control.signal,
  });
  control.abort();

  expect(harness.repository.getMeeting(started.meetingId)).toMatchObject({ status: "recording" });
  await expect(harness.application.controlRecording({
    action: "stop",
    meetingId: started.meetingId,
  })).resolves.toMatchObject({ phase: "completed" });
});

it("commits a stopped recording even when its control request disconnects", async () => {
  const worker = workerFactory();
  const finalizing = deferred<RecordingFinalResultMessage>();
  vi.mocked(worker.session.finalize).mockReturnValue(finalizing.promise);
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helperFactory().factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const request = new AbortController();
  const stopped = harness.application.controlRecording({
    action: "stop",
    meetingId: started.meetingId,
    signal: request.signal,
  });
  const committed = expect(stopped).resolves.toMatchObject({
    phase: "completed",
    transcriptVersion: 1,
    errorCode: null,
  });
  await vi.waitFor(() => expect(harness.application.getRecordingState())
    .toMatchObject({ phase: "finalizing" }));

  request.abort();
  finalizing.resolve(result());

  await committed;
  expect(harness.application.getMeetingPage({ meetingId: started.meetingId }))
    .toMatchObject({ transcript: { version: 1, resultStatus: "completed" } });
});

it("shutdown cancels recording, settles both process seams, then closes SQLite", async () => {
  const helper = helperFactory();
  const worker = workerFactory();
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helper.factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });

  await harness.application.shutdown();

  await expect(harness.context.jobs.wait(JobId(started.jobId), 2_000)).resolves.toMatchObject({
    status: "killed",
  });
  expect(helper.session.terminate).toHaveBeenCalledOnce();
  expect(worker.session.terminate).toHaveBeenCalledOnce();
  expect(() => harness.repository.getMeeting(started.meetingId)).toThrow();
  const reopened = openMeetingRepository(join(harness.root, "meetings.sqlite3"));
  try {
    expect(reopened.getMeeting(started.meetingId)).toMatchObject({
      status: "cancelled",
      errorCode: "CANCELLED_BY_USER",
      activeRunId: null,
    });
  } finally {
    reopened.close();
  }
});

it("does not report a commit time when explicit job cancellation wins during stop", async () => {
  const worker = workerFactory();
  const finalizing = deferred<RecordingFinalResultMessage>();
  vi.mocked(worker.session.finalize).mockReturnValue(finalizing.promise);
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helperFactory().factory, worker },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const stopped = harness.application.controlRecording({ action: "stop", meetingId: started.meetingId });
  await vi.waitFor(() => expect(worker.session.finalize).toHaveBeenCalled());

  await harness.context.jobs.kill(JobId(started.jobId));
  finalizing.resolve(result());

  await expect(stopped).resolves.toMatchObject({
    phase: "cancelled", transcriptVersion: null, finalizationMs: null,
  });
});

it("keeps recording when a pending track-control request disconnects", async () => {
  const helper = helperFactory();
  const changed = deferred<Awaited<ReturnType<RecordingHelperSession["setTrack"]>>>();
  helper.setTrack.mockReturnValueOnce(changed.promise);
  const harness = await createMeetingApplicationHarness({
    recording: { helper: helper.factory, worker: workerFactory() },
  });
  harnesses.push(harness);
  const started = await harness.application.controlRecording({ action: "start" });
  const request = new AbortController();
  const control = harness.application.controlRecording({
    action: "mic_off", meetingId: started.meetingId, signal: request.signal,
  });
  const stillRecording = expect(control).resolves.toMatchObject({ phase: "recording" });
  await vi.waitFor(() => expect(helper.setTrack).toHaveBeenCalled());
  request.abort();
  changed.resolve(helper.session.snapshot());
  await stillRecording;
});

it("rejects recording before creating a meeting or starting capture when permission checks fail", async () => {
  const helper = helperFactory();
  const harness = await createMeetingApplicationHarness({ recording: {
    helper: helper.factory, worker: workerFactory(),
    checkPermissions: async () => { throw Object.assign(new Error("permission required"), { code: "MICROPHONE_PERMISSION_REQUIRED" }); },
  } });
  harnesses.push(harness);
  await expect(harness.application.controlRecording({ action: "start" })).rejects.toMatchObject({code:"MICROPHONE_PERMISSION_REQUIRED"});
  expect(helper.factory.start).not.toHaveBeenCalled();
  expect(harness.application.getRecordingState()).toBeNull();
  expect(harness.repository.getMeeting(MEETING_ID)).toBeNull();
});

it("checks permissions while assets prepare, then cancels the other gate on failure", async () => {
  const preparation = deferred<never>();
  let permissionStarted = false;
  let permissionCancelled = false;
  const harness = await createMeetingApplicationHarness({
    prepareRuntime: async () => preparation.promise,
    recording: { helper: helperFactory().factory, worker: workerFactory(),
      checkPermissions: async signal => {
        permissionStarted = true;
        await new Promise<void>(resolve => signal!.addEventListener("abort", () => {
          permissionCancelled = true; resolve();
        }, { once: true }));
      } },
  });
  harnesses.push(harness);
  const starting = harness.application.controlRecording({ action: "start" });
  void starting.catch(() => undefined);
  await new Promise(resolve => setImmediate(resolve));
  try { expect(permissionStarted).toBe(true); }
  finally { preparation.reject(new Error("MODEL_NOT_READY")); }
  await expect(starting).rejects.toThrow("MODEL_NOT_READY");
  expect(permissionCancelled).toBe(true);
  expect(harness.application.getRecordingState()).toBeNull();
});
