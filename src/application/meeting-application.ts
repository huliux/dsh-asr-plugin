import { freezeMeetingRuntime } from "./meeting-runtime.js";
import type { MeetingRuntimeSnapshot } from "./meeting-runtime.js";
import { randomUUID } from "node:crypto";
import { parse } from "node:path";

import type { JobHooks, JobRegistry, JobSpec } from "@deepseek-ai/dsh-jobs";

import { ManagedAudioError } from "../audio/managed-audio-error.js";
import {
  getDraftTranscriptPage,
  type DraftTranscriptPage,
} from "../recording/draft-transcript-page.js";
import type { DraftTranscriptSnapshot } from "../recording/worker-types.js";
import {
  RecordingSession,
  RecordingSessionError,
  type RecordingSessionHelperFactory,
  type RecordingSessionWorkerFactory,
  type RecordingSessionView,
} from "../recording/recording-session.js";
import type { ManagedAudioStore } from "../storage/managed-audio-store.js";
import {
  MeetingRepositoryError,
  type GetMeetingPageInput,
  type MeetingPage,
  type MeetingRecord,
  type MeetingRepository,
  type SearchMeetingsInput,
  type SearchMeetingsPage,
} from "../storage/meeting-repository.js";
import type { WorkerRunner } from "../worker/worker-pipeline.js";
import {
  createTranscriptProjection,
  type AgentTranscriptProjection,
  type ExportCommittedTranscriptInput,
  type GetAgentTranscriptProjectionInput,
  type TranscriptExportReceipt,
  type TranscriptProjection,
} from "../transcript-projection/transcript-projection.js";
import {
  isActiveReferencePhase,
  meetingReferenceCandidate,
  type GetMeetingReferenceCandidatesInput,
  type MeetingReferenceCandidate,
  type ResolveMeetingReferenceInput,
  validateMeetingReferenceLocale,
} from "./meeting-reference.js";
import {
  MeetingTranscriptionRun,
  type MeetingTranscriptionRunDependencies,
  type MeetingTranscriptionRunIdentity,
  type MeetingTranscriptionSource,
} from "./meeting-transcription-run.js";
import {
  RecordingApplication,
  type MeetingLivePage,
  type MeetingLivePageInput,
  type RecordingControlInput,
} from "./recording-application.js";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    meeting: "meeting";
  }
}

const JOB_OUTPUT_LIMIT_BYTES = 4_096;

export type MeetingApplicationErrorCode = "INVALID_INPUT" | "CANCELLED_BY_USER";

export class MeetingApplicationError extends Error {
  constructor(
    readonly code: MeetingApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingApplicationError";
  }
}

export interface MeetingApplicationOptions {
  readonly prepareRuntime?: (signal?: AbortSignal, purpose?: "batch" | "recording") => Promise<MeetingRuntimeSnapshot>;
  readonly asr: WorkerRunner;
  readonly audioStore: ManagedAudioStore;
  readonly dataRoot: string;
  readonly diarization: WorkerRunner;
  readonly engineFingerprint: string;
  readonly generateId?: () => string;
  readonly jobs: Pick<JobRegistry, "start">;
  readonly now?: () => number;
  readonly repository: MeetingRepository;
  readonly recording?: {
    readonly checkPermissions?: (signal?: AbortSignal) => Promise<void>;
    readonly helper: RecordingSessionHelperFactory;
    readonly monotonicNow?: () => number;
    readonly worker: RecordingSessionWorkerFactory;
  };
}

export interface RecordingDraftSource {
  readonly meetingId: string;
  readonly runId: string;
  snapshot(): DraftTranscriptSnapshot;
}

export interface GetRecordingDraftPageInput {
  readonly meetingId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ImportMeetingInput {
  readonly owner?: JobSpec["owner"];
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly title?: string;
}

export interface ImportMeetingStarted {
  readonly meetingId: string;
  readonly jobId: string;
  readonly status: "processing";
}

export interface RetranscribeMeetingInput {
  readonly expectedVersion: number;
  readonly meetingId: string;
  readonly owner?: JobSpec["owner"];
  readonly signal?: AbortSignal;
}

export interface RetranscribeMeetingStarted extends ImportMeetingStarted {
  readonly baseVersion: number;
  readonly targetVersion: number;
}

export interface DeleteMeetingInput {
  readonly expectedVersion: number;
  readonly meetingId: string;
}

export interface DeleteMeetingResult {
  readonly deleted: true;
  readonly freedBytes: number;
  readonly meetingId: string;
}

export interface StartupReconciliationResult {
  readonly completedDeletions: number;
  readonly failedDeletionIds: readonly string[];
  readonly failedRecordingRecoveryIds: readonly string[];
  readonly orphanedRuns: number;
  readonly recoveredRecordingIds: readonly string[];
}

function cancelledBeforePublication(): MeetingApplicationError {
  return new MeetingApplicationError(
    "CANCELLED_BY_USER",
    "Meeting transcription was cancelled before its background job was published",
  );
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledBeforePublication();
}

function explicitTitle(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new MeetingApplicationError("INVALID_INPUT", "Meeting title is invalid");
  }
  const title = value.trim();
  if (title.length < 1 || title.length > 200) {
    throw new MeetingApplicationError("INVALID_INPUT", "Meeting title is invalid");
  }
  return title;
}

function titleFromSource(sourceName: string): string {
  const title = parse(sourceName).name.trim();
  if (title.length < 1 || title.length > 200) {
    throw new MeetingApplicationError("INVALID_INPUT", "Audio filename cannot form a meeting title");
  }
  return title;
}

function requireEngineFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Meeting engine fingerprint must be lowercase SHA-256");
  }
}

function checkedClock(clock: () => number): () => number {
  return () => {
    const value = Math.trunc(clock());
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError("Meeting application clock must return a positive safe integer");
    }
    return value;
  };
}

export class MeetingApplication {
  private readonly dependencies: MeetingTranscriptionRunDependencies;
  private readonly prepareRuntime: MeetingApplicationOptions["prepareRuntime"];
  private readonly generateId: () => string;
  private readonly jobs: Pick<JobRegistry, "start">;
  private readonly transcriptProjection: TranscriptProjection;
  private accepting = true;
  private active: MeetingTranscriptionRun | RecordingSession | null = null;
  private readonly recording: RecordingApplication | null;
  private recordingDraft: RecordingDraftSource | null = null;
  private shutdownTask: Promise<void> | null = null;

  constructor(options: MeetingApplicationOptions) {
    requireEngineFingerprint(options.engineFingerprint);
    this.prepareRuntime = options.prepareRuntime === undefined ? undefined
      : async (signal, purpose) => freezeMeetingRuntime(await options.prepareRuntime!(signal, purpose).catch(error => {
        assertNotCancelled(signal);
        throw error;
      }));
    const now = checkedClock(options.now ?? Date.now);
    this.dependencies = {
      asr: options.asr,
      audioStore: options.audioStore,
      diarization: options.diarization,
      engineFingerprint: options.engineFingerprint,
      now,
      repository: options.repository,
    };
    this.generateId = options.generateId ?? randomUUID;
    this.jobs = options.jobs;
    this.transcriptProjection = createTranscriptProjection(
      options.repository,
      (meeting) => this.activeJobIdFor(meeting),
      { dataRoot: options.dataRoot, now },
    );
    this.recording = options.recording === undefined ? null : new RecordingApplication({
      ...(this.prepareRuntime === undefined ? {} : { prepareRuntime: this.prepareRuntime }),
      audioStore: options.audioStore,
      engineFingerprint: options.engineFingerprint,
      generateId: this.generateId,
      helper: options.recording.helper,
      ...(options.recording.checkPermissions === undefined ? {} : { checkPermissions: options.recording.checkPermissions }),
      jobs: options.jobs,
      now,
      repository: options.repository,
      worker: options.recording.worker,
      ...(options.recording.monotonicNow === undefined
        ? {}
        : { monotonicNow: options.recording.monotonicNow }),
    }, {
      activeRecording: (meetingId) => {
        const active = this.activeFor(meetingId);
        return active instanceof RecordingSession ? active : null;
      },
      claim: (session) => this.claim(session),
      currentRecording: () => this.active instanceof RecordingSession ? this.active : null,
      draftSource: (meetingId) => this.recordingDraft?.meetingId === meetingId
        ? this.recordingDraft
        : null,
      release: (session) => this.release(session),
      requireIdle: () => this.assertIdle(),
    });
  }

  controlRecording(input: RecordingControlInput): Promise<RecordingSessionView> {
    this.assertAccepting();
    return this.requiredRecording().control(input);
  }

  getMeetingLivePage(input: MeetingLivePageInput): MeetingLivePage {
    this.assertAccepting();
    return this.requiredRecording().livePage(input);
  }

  getRecordingState(): RecordingSessionView | null {
    this.assertAccepting();
    return this.requiredRecording().state();
  }

  getRecordingPreview(): readonly import("./recording-application.js").MeetingLiveSegment[] {
    this.assertAccepting();
    return this.requiredRecording().preview();
  }

  hasRecordingHistory(): boolean {
    this.assertAccepting();
    return this.dependencies.repository.hasRecordingHistory();
  }

  async prepareRecording(signal?: AbortSignal): Promise<void> {
    this.assertAccepting();
    this.assertIdle();
    assertNotCancelled(signal);
    await this.prepareRuntime?.(signal, "recording");
    assertNotCancelled(signal);
  }

  async startImport(input: ImportMeetingInput): Promise<ImportMeetingStarted> {
    this.assertAccepting();
    const title = explicitTitle(input.title);
    assertNotCancelled(input.signal);
    this.assertIdle();
    const runtime = this.prepareRuntime === undefined ? undefined : await this.prepareRuntime(input.signal);
    this.assertAccepting();
    assertNotCancelled(input.signal);
    this.assertIdle();
    const verified = await this.dependencies.audioStore.openInput(input.path);
    let run: MeetingTranscriptionRun | undefined;
    try {
      this.assertAccepting();
      assertNotCancelled(input.signal);
      this.assertIdle();
      run = this.createRun({
        baseVersion: 0,
        meetingId: this.generateId(),
        runId: this.generateId(),
        title: title ?? titleFromSource(verified.sourceName),
        startedAtMs: this.now(),
      }, { kind: "import", input: verified }, runtime);
      const jobId = this.publish(run, input.owner);
      return { meetingId: run.identity.meetingId, jobId, status: "processing" };
    } catch (error) {
      await (run?.closeUnclaimed() ?? verified.close()).catch(() => undefined);
      throw error;
    }
  }

  async startRetranscription(
    input: RetranscribeMeetingInput,
  ): Promise<RetranscribeMeetingStarted> {
    this.assertAccepting();
    assertNotCancelled(input.signal);
    this.assertIdle();
    let meeting = this.requiredMeeting(input.meetingId);
    const runtime = this.prepareRuntime === undefined ? undefined : await this.prepareRuntime(input.signal);
    this.assertRetranscriptionTarget(meeting, input.expectedVersion);
    meeting = await this.ensureRecordingSource(meeting);
    await this.assertManagedSource(meeting);
    this.assertAccepting();
    assertNotCancelled(input.signal);
    this.assertIdle();
    const run = this.createRun({
      baseVersion: input.expectedVersion,
      meetingId: meeting.meetingId,
      runId: this.generateId(),
      title: meeting.title,
      startedAtMs: this.now(),
    }, { kind: "retranscribe", meeting }, runtime);
    const jobId = this.publish(run, input.owner);
    return {
      meetingId: meeting.meetingId,
      jobId,
      status: "processing",
      baseVersion: input.expectedVersion,
      targetVersion: input.expectedVersion + 1,
    };
  }

  async deleteMeeting(input: DeleteMeetingInput): Promise<DeleteMeetingResult> {
    this.assertAccepting();
    const meeting = this.requiredMeeting(input.meetingId);
    const active = this.activeFor(input.meetingId);
    if (active !== null) {
      throw new MeetingRepositoryError(
        "INVALID_MEETING_STATE",
        `Meeting has active job ${active.jobId ?? "publishing"}; use job_kill, then wait with job_output(wait:true)`,
      );
    }
    this.dependencies.repository.beginDeletion({
      meetingId: meeting.meetingId,
      expectedVersion: input.expectedVersion,
      nowMs: this.now(),
    });
    const freedBytes = await this.completeFencedDeletion(meeting.meetingId, input.expectedVersion);
    return { meetingId: meeting.meetingId, deleted: true, freedBytes };
  }

  async reconcileStartup(): Promise<StartupReconciliationResult> {
    this.assertAccepting();
    this.assertIdle();
    const orphanedRuns = this.dependencies.repository.reconcileOrphanedRuns(this.now());
    const recordingRecovery = await this.recoverRecordingSources();
    let completedDeletions = 0;
    const failedDeletionIds: string[] = [];
    for (const meeting of this.dependencies.repository.listDeletingMeetings()) {
      try {
        await this.completeFencedDeletion(meeting.meetingId, meeting.transcriptVersion);
        completedDeletions += 1;
      } catch {
        failedDeletionIds.push(meeting.meetingId);
      }
    }
    await this.dependencies.audioStore.cleanupAllWork();
    return {
      orphanedRuns,
      completedDeletions,
      failedDeletionIds,
      ...recordingRecovery,
    };
  }

  getMeetingPage(input: GetMeetingPageInput): MeetingPage {
    this.assertAccepting();
    return this.dependencies.repository.getMeetingPage(input);
  }

  getMeetingAgentProjection(
    input: GetAgentTranscriptProjectionInput,
  ): AgentTranscriptProjection {
    this.assertAccepting();
    return this.transcriptProjection.getCommittedAgentProjection(input);
  }

  exportTranscript(input: ExportCommittedTranscriptInput): Promise<TranscriptExportReceipt> {
    this.assertAccepting();
    return this.transcriptProjection.exportCommittedTranscript(input);
  }

  getMeetingReferenceCandidates(
    input: GetMeetingReferenceCandidatesInput,
  ): readonly MeetingReferenceCandidate[] {
    this.assertAccepting();
    const online = this.recording?.state() ?? null;
    const preferredMeetingId = online !== null && isActiveReferencePhase(online.phase)
      ? online.meetingId
      : undefined;
    return this.dependencies.repository.listMeetingReferenceRecords({
      locale: input.locale,
      limit: 20,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(preferredMeetingId === undefined ? {} : { preferredMeetingId }),
    }).map((meeting) => meetingReferenceCandidate(meeting, online));
  }

  resolveMeetingReference(input: ResolveMeetingReferenceInput): MeetingReferenceCandidate {
    this.assertAccepting();
    validateMeetingReferenceLocale(input.locale);
    const meeting = this.dependencies.repository.getMeeting(input.meetingId);
    if (meeting === null || meeting.status === "deleting") {
      throw new MeetingRepositoryError("MEETING_NOT_FOUND", "Meeting reference is unavailable");
    }
    const online = this.recording?.state() ?? null;
    return meetingReferenceCandidate(meeting, online);
  }

  attachRecordingDraft(source: RecordingDraftSource): () => void {
    this.assertAccepting();
    const meeting = this.requiredMeeting(source.meetingId);
    if (
      meeting.status !== "recording" ||
      meeting.runKind !== "recording" ||
      meeting.activeRunId !== source.runId
    ) {
      throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Recording draft identity is stale");
    }
    if (this.recordingDraft !== null) {
      throw new MeetingRepositoryError("ENGINE_BUSY", "Another recording draft is active");
    }
    this.recordingDraft = source;
    return () => {
      if (this.recordingDraft === source) this.recordingDraft = null;
    };
  }

  getRecordingDraftPage(input: GetRecordingDraftPageInput): DraftTranscriptPage {
    this.assertAccepting();
    const source = this.recordingDraft;
    if (source === null || source.meetingId !== input.meetingId) {
      throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Recording draft is unavailable");
    }
    return getDraftTranscriptPage({ ...input, snapshot: source.snapshot() });
  }

  searchMeetings(input: SearchMeetingsInput): SearchMeetingsPage {
    this.assertAccepting();
    return this.dependencies.repository.searchMeetings(input);
  }

  shutdown(): Promise<void> {
    this.shutdownTask ??= this.performShutdown();
    return this.shutdownTask;
  }

  activeJobIdFor(meeting: MeetingRecord): string | null {
    const active = this.active;
    if (!["recording", "processing"].includes(meeting.status)
      || meeting.activeRunId === null || active === null) {
      return null;
    }
    return active.identity.meetingId === meeting.meetingId
      && active.identity.runId === meeting.activeRunId
      ? active.jobId
      : null;
  }

  private claim(run: MeetingTranscriptionRun | RecordingSession): JobHooks {
    this.assertAccepting();
    this.assertIdle();
    run.claim();
    this.active = run;
    return run.hooks;
  }

  private now(): number {
    return this.dependencies.now();
  }

  private release(run: MeetingTranscriptionRun | RecordingSession): void {
    if (this.active === run) this.active = null;
  }

  private activeFor(meetingId: string): MeetingTranscriptionRun | RecordingSession | null {
    return this.active?.identity.meetingId === meetingId ? this.active : null;
  }

  private assertAccepting(): void {
    if (!this.accepting) {
      throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Meeting application is shutting down");
    }
  }

  private assertIdle(): void {
    if (this.active !== null || this.recordingDraft !== null) {
      throw new MeetingRepositoryError("ENGINE_BUSY", "Another transcription is active");
    }
  }

  private requiredRecording(): RecordingApplication {
    if (this.recording === null) throw new RecordingSessionError("MODEL_NOT_READY");
    return this.recording;
  }

  private assertRetranscriptionTarget(meeting: MeetingRecord, expectedVersion: number): void {
    if (meeting.transcriptVersion !== expectedVersion) {
      throw new MeetingRepositoryError("TRANSCRIPT_VERSION_CONFLICT", "Transcript version changed");
    }
    if (!["completed", "empty", "partial", "failed", "cancelled"].includes(meeting.status)) {
      throw new MeetingRepositoryError("INVALID_MEETING_STATE", "Meeting cannot be retranscribed");
    }
  }

  private async assertManagedSource(meeting: MeetingRecord): Promise<void> {
    try {
      await this.dependencies.audioStore.assertManagedSource(
        meeting.meetingId,
        meeting.sourceFormat,
        meeting.origin,
      );
    } catch (error) {
      if (!(error instanceof ManagedAudioError) || error.code !== "INVALID_PATH") throw error;
      throw new MeetingRepositoryError(
        "INVALID_MEETING_STATE",
        "Managed source is unavailable; import the original audio again",
        { cause: error },
      );
    }
  }

  private async ensureRecordingSource(meeting: MeetingRecord): Promise<MeetingRecord> {
    if (meeting.origin !== "recording" || (
      meeting.sourceSizeBytes !== null && meeting.sourceSha256 !== null
    )) return meeting;
    let source: Awaited<ReturnType<ManagedAudioStore["recoverRecording"]>>;
    try {
      // Capture facts share a monotonic anchor; allow one chunk of observation lag.
      const maximumDurationMs = meeting.recordingStartedAtMs !== null && meeting.recordingEndedAtMs !== null
        ? meeting.recordingEndedAtMs - meeting.recordingStartedAtMs + 5_000
        : undefined;
      source = await this.dependencies.audioStore.recoverRecording(meeting.meetingId, maximumDurationMs);
    } catch (error) {
      try {
        this.dependencies.repository.recordRecordingRecoveryFailure({
          meetingId: meeting.meetingId,
          expectedVersion: meeting.transcriptVersion,
          nowMs: this.now(),
        });
      } catch {
        // Preserve the source recovery failure for the caller.
      }
      throw new MeetingRepositoryError(
        "INVALID_MEETING_STATE",
        "Recording audio could not be recovered from its closed chunks",
        { cause: error },
      );
    }
    return this.dependencies.repository.recordRecoveredRecordingSource({
      meetingId: meeting.meetingId,
      expectedVersion: meeting.transcriptVersion,
      sourceSizeBytes: source.sourceSizeBytes,
      sourceSha256: source.sourceSha256,
      nowMs: this.now(),
    });
  }

  private createRun(
    identity: MeetingTranscriptionRunIdentity,
    source: MeetingTranscriptionSource,
    runtime?: MeetingRuntimeSnapshot,
  ): MeetingTranscriptionRun {
    return new MeetingTranscriptionRun(
      identity,
      source,
      { ...this.dependencies, ...runtime },
      (finished) => this.release(finished),
    );
  }

  private publish(run: MeetingTranscriptionRun, owner: JobSpec["owner"] | undefined): string {
    const jobId = this.jobs.start({
      kind: "meeting",
      label: `转写：${run.identity.title}`,
      outputLimitBytes: JOB_OUTPUT_LIMIT_BYTES,
      ...(owner === undefined ? {} : { owner }),
      output: [run.output],
      run: () => this.claim(run),
    });
    run.publish(String(jobId));
    return String(jobId);
  }

  private requiredMeeting(meetingId: string): MeetingRecord {
    const meeting = this.dependencies.repository.getMeeting(meetingId);
    if (meeting === null) {
      throw new MeetingRepositoryError("MEETING_NOT_FOUND", "Meeting does not exist");
    }
    return meeting;
  }

  private async completeFencedDeletion(meetingId: string, expectedVersion: number): Promise<number> {
    try {
      const result = await this.dependencies.audioStore.deleteMeeting(meetingId);
      this.dependencies.repository.completeDeletion({ meetingId, expectedVersion });
      return result.freedBytes;
    } catch (error) {
      this.dependencies.repository.recordDeletionFailure({
        meetingId,
        expectedVersion,
        nowMs: this.now(),
      });
      throw new MeetingRepositoryError(
        "DELETE_INCOMPLETE",
        "Meeting deletion is incomplete and can be retried",
        { cause: error },
      );
    }
  }

  private async recoverRecordingSources(): Promise<{
    failedRecordingRecoveryIds: readonly string[];
    recoveredRecordingIds: readonly string[];
  }> {
    const recoveredRecordingIds: string[] = [];
    const failedRecordingRecoveryIds: string[] = [];
    for (const meeting of this.dependencies.repository.listRecordingsNeedingRecovery()) {
      try {
        await this.ensureRecordingSource(meeting);
        recoveredRecordingIds.push(meeting.meetingId);
      } catch {
        failedRecordingRecoveryIds.push(meeting.meetingId);
      }
    }
    return { recoveredRecordingIds, failedRecordingRecoveryIds };
  }

  private async performShutdown(): Promise<void> {
    this.accepting = false;
    const active = this.active;
    if (active !== null) {
      active.hooks.cancel("plugin unloading");
      await active.hooks.done;
    }
    this.recordingDraft = null;
    this.recording?.clear();
    this.dependencies.repository.close();
  }
}
