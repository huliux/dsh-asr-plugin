import { describe, expect, it } from "vitest";

import type { OkfIngestionRequest, OkfIngestionService, OkfSettings } from "../../src/okf/ingestion-service.js";
import { startOkfIngestion, withTranscriptCommitHook } from "../../src/okf/trigger.js";
import type {
  CommitTranscriptInput,
  CommitTranscriptResult,
  MeetingRecord,
  MeetingRepository,
} from "../../src/storage/meeting-repository.js";

const MEETING_ID = "22222222-2222-4222-8222-222222222222";

function meetingRecord(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    runIdentity: null,
    transcriptIdentity: null,
    meetingId: MEETING_ID,
    origin: "import",
    title: "Weekly sync",
    sourceName: "weekly-sync.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    sourceSha256: null,
    durationMs: 5_000,
    status: "completed",
    committedStatus: "completed",
    transcriptVersion: 1,
    resultReason: null,
    engineFingerprint: "a".repeat(64),
    activeRunId: null,
    runKind: null,
    errorCode: null,
    errorStage: null,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    recordingStartedAtMs: null,
    recordingEndedAtMs: null,
    ...overrides,
  };
}

function commitInput(overrides: Partial<CommitTranscriptInput> = {}): CommitTranscriptInput {
  return {
    meetingId: MEETING_ID,
    runId: "run-1",
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 5_000,
    engineFingerprint: "a".repeat(64),
    segments: [],
    nowMs: 3_000,
    ...overrides,
  };
}

type In<K extends keyof MeetingRepository> = Parameters<MeetingRepository[K]>[0];

function unsupported(): never {
  throw new Error("FakeMeetingRepository method is not used by this test");
}

/**
 * Full repository double: the two methods under test behave, every other member
 * fails loudly. `getMeeting` reads a private field so an unbound receiver would
 * throw instead of silently resolving through the proxy.
 */
class FakeMeetingRepository implements MeetingRepository {
  readonly commits: CommitTranscriptInput[] = [];
  commitOutcome: (input: CommitTranscriptInput) => CommitTranscriptResult;
  readonly #meeting: MeetingRecord;

  constructor(meeting: MeetingRecord) {
    this.#meeting = meeting;
    this.commitOutcome = (input) => ({
      outcome: "committed",
      meeting: { ...this.#meeting, transcriptVersion: input.baseVersion + 1 },
    });
  }

  commitTranscript(input: CommitTranscriptInput): CommitTranscriptResult {
    this.commits.push(input);
    return this.commitOutcome(input);
  }

  getMeeting(meetingId: string): MeetingRecord | null {
    return meetingId === this.#meeting.meetingId ? this.#meeting : null;
  }

  beginDeletion(_input: In<"beginDeletion">) { return unsupported(); }
  beginRecordingFinalization(_input: In<"beginRecordingFinalization">) { return unsupported(); }
  beginRetranscription(_input: In<"beginRetranscription">) { return unsupported(); }
  close() { unsupported(); }
  completeDeletion(_input: In<"completeDeletion">) { unsupported(); }
  createImport(_input: In<"createImport">) { unsupported(); }
  createRecording(_input: In<"createRecording">) { return unsupported(); }
  finishRun(_input: In<"finishRun">) { return unsupported(); }
  hasRecordingHistory() { return unsupported(); }
  getCommittedTranscriptSlice(_input: In<"getCommittedTranscriptSlice">) { return unsupported(); }
  getCommittedTranscriptSnapshot(_meetingId: string) { return unsupported(); }
  getMeetingPage(_input: In<"getMeetingPage">) { return unsupported(); }
  listMeetingReferenceRecords(_input: In<"listMeetingReferenceRecords">) { return unsupported(); }
  listDeletingMeetings() { return unsupported(); }
  listRecordingsNeedingRecovery() { return unsupported(); }
  recordDeletionFailure(_input: In<"recordDeletionFailure">) { return unsupported(); }
  recordManagedSource(_input: In<"recordManagedSource">) { return unsupported(); }
  recordRecoveredRecordingSource(_input: In<"recordRecoveredRecordingSource">) { return unsupported(); }
  recordRecordingRecoveryFailure(_input: In<"recordRecordingRecoveryFailure">) { return unsupported(); }
  recordRecordingStarted(_input: In<"recordRecordingStarted">) { return unsupported(); }
  reconcileOrphanedRuns(_nowMs: number) { return unsupported(); }
  searchMeetings(_input: In<"searchMeetings">) { return unsupported(); }
}

interface IngestionHarness {
  readonly service: OkfIngestionService;
  readonly started: OkfIngestionRequest[];
}

function ingestionHarness(): IngestionHarness {
  const started: OkfIngestionRequest[] = [];
  return {
    started,
    service: {
      start(request) {
        started.push(request);
        return { kind: "disabled", meetingId: request.meetingId, jobId: null, message: "skipped" };
      },
      run(request) {
        return Promise.resolve({
          kind: "disabled",
          meetingId: request.meetingId,
          jobId: null,
          message: "skipped",
        });
      },
      recoverStartup(): Promise<void> {
        return Promise.resolve();
      },
      state() {
        return undefined;
      },
      whenIdle(): Promise<void> {
        return Promise.resolve();
      },
      shutdown(): Promise<void> {
        return Promise.resolve();
      },
    },
  };
}

function okfSettings(overrides: Partial<OkfSettings> = {}): OkfSettings {
  return { directory: "/tmp/okf-bundle", ingest: true, ...overrides };
}

describe("withTranscriptCommitHook", () => {
  it("calls the hook once per committed transcript with the new version", () => {
    const repository = new FakeMeetingRepository(meetingRecord());
    const calls: Array<readonly [string, number]> = [];
    const wrapped = withTranscriptCommitHook(repository, {
      onCommitted(meetingId, transcriptVersion) {
        calls.push([meetingId, transcriptVersion]);
      },
    });

    const first = commitInput({ baseVersion: 0 });
    const second = commitInput({ baseVersion: 1 });
    expect(wrapped.commitTranscript(first).meeting.transcriptVersion).toBe(1);
    expect(wrapped.commitTranscript(second).meeting.transcriptVersion).toBe(2);
    expect(calls).toEqual([[MEETING_ID, 1], [MEETING_ID, 2]]);
    expect(repository.commits).toEqual([first, second]);
  });

  it("does not call the hook when the run is no longer active", () => {
    const repository = new FakeMeetingRepository(meetingRecord());
    const notActive: CommitTranscriptResult = {
      outcome: "run_not_active",
      meeting: meetingRecord({ status: "failed", activeRunId: null }),
    };
    repository.commitOutcome = () => notActive;
    const calls: string[] = [];
    const wrapped = withTranscriptCommitHook(repository, {
      onCommitted(meetingId) {
        calls.push(meetingId);
      },
    });

    expect(wrapped.commitTranscript(commitInput())).toBe(notActive);
    expect(calls).toEqual([]);
    expect(repository.commits).toHaveLength(1);
  });

  it("returns the commit result when the hook throws", () => {
    const repository = new FakeMeetingRepository(meetingRecord());
    const wrapped = withTranscriptCommitHook(repository, {
      onCommitted() {
        throw new Error("hook hand-off failed");
      },
    });

    const result = wrapped.commitTranscript(commitInput());
    expect(result.outcome).toBe("committed");
    expect(result.meeting.transcriptVersion).toBe(1);
    expect(repository.commits).toHaveLength(1);
  });

  it("delegates other methods to the target with their original receiver", () => {
    const repository = new FakeMeetingRepository(meetingRecord());
    const wrapped = withTranscriptCommitHook(repository, { onCommitted() {} });

    expect(wrapped.getMeeting(MEETING_ID)).toBe(repository.getMeeting(MEETING_ID));
    expect(wrapped.getMeeting("missing")).toBeNull();
  });
});

describe("startOkfIngestion", () => {
  it("starts ingestion for the meeting when the bundle is configured", () => {
    const harness = ingestionHarness();
    startOkfIngestion(harness.service, { settings: () => okfSettings() }, MEETING_ID);
    expect(harness.started).toEqual([{ meetingId: MEETING_ID, skipIfSucceeded: true }]);
  });

  it("does nothing when no bundle directory is configured", () => {
    const harness = ingestionHarness();
    startOkfIngestion(
      harness.service,
      { settings: () => okfSettings({ directory: "" }) },
      MEETING_ID,
    );
    expect(harness.started).toEqual([]);
  });

  it("does nothing when the directory is only whitespace", () => {
    const harness = ingestionHarness();
    startOkfIngestion(
      harness.service,
      { settings: () => okfSettings({ directory: "   " }) },
      MEETING_ID,
    );
    expect(harness.started).toEqual([]);
  });

  it("does nothing for a committed but empty transcript", () => {
    const harness = ingestionHarness();
    startOkfIngestion(
      harness.service,
      { settings: () => okfSettings(), committedStatus: "empty" },
      MEETING_ID,
    );
    expect(harness.started).toEqual([]);
  });

  it("does nothing when automatic ingestion is switched off", () => {
    const harness = ingestionHarness();
    startOkfIngestion(
      harness.service,
      { settings: () => okfSettings({ ingest: false }) },
      MEETING_ID,
    );
    expect(harness.started).toEqual([]);
  });
});
