import { createJobProgressSource } from "../jobs/progress-source.js";
import type { JobOutputSource } from "@deepseek-ai/dsh-jobs";
import type { ProcessingIdentity } from "../assets/processing-identity.js";
import type { JobHooks, JobOutcome } from "@deepseek-ai/dsh-jobs";

import { ManagedAudioError } from "../audio/managed-audio-error.js";
import { RuntimeAssetsError } from "../assets/runtime-assets-error.js";
import { AssetVerificationError } from "../assets/verify-assets.js";
import type { NormalizedAudio } from "../audio/managed-audio-normalizer.js";
import type {
  ManagedAudioStore,
  VerifiedAudioInput,
} from "../storage/managed-audio-store.js";
import {
  MeetingRepositoryError,
  type CommitTranscriptInput,
  type MeetingRecord,
  type MeetingRepository,
} from "../storage/meeting-repository.js";
import { WorkerClientError } from "../worker/worker-client.js";
import {
  runWorkerPipeline,
  type WorkerPipelineResult,
  type WorkerRunner,
} from "../worker/worker-pipeline.js";
import { ProgressOutput, workerPercent } from "./meeting-run-progress.js";

export type { MeetingRunStage } from "./meeting-run-progress.js";

export interface MeetingTranscriptionRunIdentity {
  readonly baseVersion: number;
  readonly meetingId: string;
  readonly runId: string;
  readonly title: string;
  readonly startedAtMs: number;
}

export interface MeetingTranscriptionRunDependencies {
  readonly processingIdentity?: ProcessingIdentity;
  readonly asr: WorkerRunner;
  readonly audioStore: ManagedAudioStore;
  readonly diarization: WorkerRunner;
  readonly engineFingerprint: string;
  readonly now: () => number;
  readonly repository: MeetingRepository;
}

export type MeetingTranscriptionSource =
  | { readonly kind: "import"; readonly input: VerifiedAudioInput }
  | { readonly kind: "retranscribe"; readonly meeting: MeetingRecord };

interface RunDecision {
  readonly outcome: JobOutcome;
  readonly terminalCode: string | null;
}

class TranscriptionRunCancelled extends Error {}

function failureCode(error: unknown, cancelled: boolean): string {
  if (cancelled || error instanceof TranscriptionRunCancelled) return "CANCELLED_BY_USER";
  if (error instanceof ManagedAudioError) return error.code;
  if (error instanceof RuntimeAssetsError || error instanceof AssetVerificationError) {
    return "MODEL_NOT_READY";
  }
  if (error instanceof MeetingRepositoryError) {
    return error.code === "STORAGE_FAILURE" ? error.code : "ENGINE_FAILURE";
  }
  if (error instanceof WorkerClientError) {
    if (error.code === "WORKER_PROTOCOL_ERROR") return error.code;
    if (["ASSET_MISMATCH", "MODEL_LOAD_FAILED", "NATIVE_LOAD_FAILED"].includes(error.code)) {
      return "MODEL_NOT_READY";
    }
  }
  return "ENGINE_FAILURE";
}

function completedDecision(meeting: MeetingRecord): RunDecision {
  return {
    terminalCode: null,
    outcome: {
      status: "completed",
      detail: `meeting_id=${meeting.meetingId} transcript_version=${meeting.transcriptVersion} result_status=${meeting.committedStatus}`,
    },
  };
}

function failedDecision(code: string): RunDecision {
  return {
    terminalCode: code,
    outcome: { status: "failed", detail: code },
  };
}

function killedDecision(): RunDecision {
  return {
    terminalCode: "CANCELLED_BY_USER",
    outcome: { status: "killed", detail: "CANCELLED_BY_USER" },
  };
}

function candidateFrom(
  result: WorkerPipelineResult,
  identity: MeetingTranscriptionRunIdentity,
  durationMs: number,
  engineFingerprint: string,
  nowMs: number,
): CommitTranscriptInput {
  if (result.type === "empty") {
    return {
      meetingId: identity.meetingId,
      runId: identity.runId,
      baseVersion: identity.baseVersion,
      resultStatus: "empty",
      resultReason: result.asr.payload.empty_reason,
      durationMs,
      engineFingerprint,
      segments: [],
      nowMs,
    };
  }
  return {
    meetingId: identity.meetingId,
    runId: identity.runId,
    baseVersion: identity.baseVersion,
    resultStatus: result.diarization.payload.result_status,
    resultReason: result.diarization.payload.result_reason,
    durationMs,
    engineFingerprint,
    segments: result.diarization.payload.segments.map((segment) => ({
      seq: segment.seq,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      speakerLabel: segment.speaker_label,
      text: segment.text,
    })),
    nowMs,
  };
}

export class MeetingTranscriptionRun {
  readonly hooks: JobHooks;
  readonly output: JobOutputSource;
  private readonly controller = new AbortController();
  private readonly progress: ProgressOutput;
  private decision: RunDecision | null = null;
  private jobIdValue: string | null = null;
  private resolveDone!: (outcome: JobOutcome) => void;

  constructor(
    readonly identity: MeetingTranscriptionRunIdentity,
    private readonly source: MeetingTranscriptionSource,
    private readonly dependencies: MeetingTranscriptionRunDependencies,
    private readonly release: (run: MeetingTranscriptionRun) => void,
  ) {
    this.progress = new ProgressOutput(identity.startedAtMs, dependencies.now);
    const done = new Promise<JobOutcome>((resolve) => { this.resolveDone = resolve; });
    this.output = createJobProgressSource(() => this.progress.read());
    this.hooks = {
      cancel: (reason?: string) => this.cancel(reason),
      done,
    };
  }

  get jobId(): string | null {
    return this.jobIdValue;
  }

  claim(): void {
    if (this.source.kind === "retranscribe") {
      this.dependencies.repository.beginRetranscription({
        meetingId: this.identity.meetingId,
        expectedVersion: this.identity.baseVersion,
        runId: this.identity.runId,
        nowMs: this.identity.startedAtMs,
        ...(this.dependencies.processingIdentity === undefined ? {}
          : { processingIdentity: this.dependencies.processingIdentity }),
      });
      return;
    }
    const input = this.source.input;
    this.dependencies.repository.createImport({
      meetingId: this.identity.meetingId,
      title: this.identity.title,
      sourceName: input.sourceName,
      sourceFormat: input.sourceFormat,
      sourceSizeBytes: input.sourceSizeBytes,
      runId: this.identity.runId,
      nowMs: this.identity.startedAtMs,
      ...(this.dependencies.processingIdentity === undefined ? {}
        : { processingIdentity: this.dependencies.processingIdentity }),
    });
  }

  publish(jobId: string): void {
    this.jobIdValue = jobId;
    void this.execute();
  }

  async closeUnclaimed(): Promise<void> {
    if (this.source.kind === "import") await this.source.input.close();
  }

  private timestamp(): number {
    return Math.max(this.identity.startedAtMs, Math.trunc(this.dependencies.now()));
  }

  private cancel(reason?: string): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason ?? "meeting transcription cancelled");
    if (this.decision !== null) return;
    try {
      const result = this.dependencies.repository.finishRun({
        meetingId: this.identity.meetingId,
        runId: this.identity.runId,
        baseVersion: this.identity.baseVersion,
        outcome: "cancelled",
        errorCode: "CANCELLED_BY_USER",
        errorStage: this.progress.stage,
        nowMs: this.timestamp(),
      });
      this.decision = result.outcome === "already_committed"
        ? completedDecision(result.meeting)
        : killedDecision();
      if (this.decision.outcome.status === "killed") {
        this.progress.finish(this.progress.stage, "CANCELLED_BY_USER");
      }
    } catch {
      // The producer retries the same business fence while settling its failure.
    }
  }

  private async execute(): Promise<void> {
    try {
      await this.runPipeline();
    } catch (error) {
      this.linearizeFailure(error);
    }
    if (this.decision !== null && this.decision.outcome.status !== "completed") {
      this.progress.finish(this.progress.stage, this.decision.terminalCode ?? "ENGINE_FAILURE");
    }
    const cleanupFailed = await this.releaseResources();
    let decision = this.decision ?? failedDecision("ENGINE_FAILURE");
    if (this.decision === null) this.progress.finish(this.progress.stage, "ENGINE_FAILURE");
    if (cleanupFailed) {
      decision = this.withCleanupFailure(decision);
    } else if (decision.outcome.status === "completed") {
      this.progress.finish("cleaning");
    }
    try {
      this.release(this);
    } catch {
      decision = this.withCleanupFailure(decision);
    }
    this.resolveDone(decision.outcome);
  }

  private async runPipeline(): Promise<void> {
    const audio = await this.prepareAudio();
    if (audio === null) return;
    this.progress.update("loading_asr", 25);
    const result = await runWorkerPipeline({
      asr: this.dependencies.asr,
      diarization: this.dependencies.diarization,
      asrRun: {
        type: "run",
        request_id: this.identity.runId,
        kind: "asr",
        base_transcript_version: this.identity.baseVersion,
        payload: { audio_path: audio.audioPath, duration_ms: audio.durationMs },
      },
      diarizationRequestId: `${this.identity.runId}:diar`,
      signal: this.controller.signal,
      onHandoff: () => this.progress.update("loading_diarization", 65),
      onReady: (kind) => this.progress.update(
        kind === "asr" ? "transcribing" : "diarizing",
        kind === "asr" ? 30 : 70,
      ),
      onProgress: (kind, message) => this.progress.update(
        kind === "asr" ? "transcribing" : "diarizing",
        workerPercent(kind, message),
      ),
    });
    this.commit(result, audio.durationMs);
  }

  private async prepareAudio(): Promise<NormalizedAudio | null> {
    if (this.controller.signal.aborted) throw new TranscriptionRunCancelled();
    this.progress.update("validating", 5);
    if (this.source.kind === "retranscribe") {
      this.progress.update("normalizing", 10);
      return this.dependencies.audioStore.prepareRetranscription(
        this.identity.meetingId,
        this.source.meeting.sourceFormat,
        this.source.meeting.origin,
        this.controller.signal,
      );
    }
    return this.prepareImportedAudio(this.source.input);
  }

  private async prepareImportedAudio(input: VerifiedAudioInput): Promise<NormalizedAudio | null> {
    const source = await input.persist(this.identity.meetingId);
    const recorded = this.dependencies.repository.recordManagedSource({
      meetingId: this.identity.meetingId,
      runId: this.identity.runId,
      sourceSha256: source.sourceSha256,
      nowMs: this.timestamp(),
    });
    if (recorded.outcome !== "updated") {
      this.decision = this.decisionFrom(recorded.meeting);
      return null;
    }
    this.progress.update("normalizing", 10);
    return this.dependencies.audioStore.normalize(
      this.identity.meetingId,
      source.sourceFormat,
      this.controller.signal,
    );
  }

  private commit(result: WorkerPipelineResult, durationMs: number): void {
    this.progress.update("committing", 95);
    const committed = this.dependencies.repository.commitTranscript(candidateFrom(
      result,
      this.identity,
      durationMs,
      this.dependencies.engineFingerprint,
      this.timestamp(),
    ));
    this.decision = committed.outcome === "committed"
      ? completedDecision(committed.meeting)
      : this.decisionFrom(committed.meeting);
    if (this.decision.outcome.status === "completed") this.progress.update("cleaning", 99);
  }

  private decisionFrom(meeting: MeetingRecord): RunDecision {
    if (meeting.committedStatus !== null
      && meeting.transcriptVersion > this.identity.baseVersion) {
      return completedDecision(meeting);
    }
    if (meeting.status === "cancelled") return killedDecision();
    return failedDecision(meeting.errorCode ?? "ENGINE_FAILURE");
  }

  private linearizeFailure(error: unknown): void {
    if (this.decision !== null) return;
    const cancelled = this.controller.signal.aborted || error instanceof TranscriptionRunCancelled;
    const code = failureCode(error, cancelled);
    try {
      const result = this.dependencies.repository.finishRun({
        meetingId: this.identity.meetingId,
        runId: this.identity.runId,
        baseVersion: this.identity.baseVersion,
        outcome: cancelled ? "cancelled" : "failed",
        errorCode: code,
        errorStage: this.progress.stage,
        nowMs: this.timestamp(),
      });
      this.decision = result.outcome === "already_committed"
        ? completedDecision(result.meeting)
        : cancelled ? killedDecision() : failedDecision(code);
    } catch (finishError) {
      this.decision = failedDecision(failureCode(finishError, false));
    }
    if (this.decision.outcome.status !== "completed") {
      this.progress.finish(this.progress.stage, this.decision.terminalCode ?? "ENGINE_FAILURE");
    }
  }

  private async releaseResources(): Promise<boolean> {
    let failed = false;
    try {
      await this.dependencies.audioStore.cleanupWork(this.identity.meetingId);
    } catch {
      failed = true;
    }
    if (this.source.kind === "import") {
      try {
        await this.source.input.close();
      } catch {
        failed = true;
      }
    }
    return failed;
  }

  private withCleanupFailure(decision: RunDecision): RunDecision {
    if (decision.outcome.status === "completed") {
      this.progress.finish("cleaning", "STORAGE_FAILURE");
    }
    return {
      ...decision,
      outcome: {
        ...decision.outcome,
        detail: `${decision.outcome.detail ?? decision.outcome.status} cleanup_error=STORAGE_FAILURE`,
      },
    };
  }
}
