import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";

import {
  MeetingApplication,
  type MeetingApplicationOptions,
} from "../../src/application/meeting-application.js";
import { ManagedAudioError } from "../../src/audio/managed-audio-error.js";
import type {
  ManagedAudioStore,
  ManagedSource,
  VerifiedAudioInput,
} from "../../src/storage/managed-audio-store.js";
import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import type {
  AsrResultMessage,
  DiarizationResultMessage,
  WorkerResultMessage,
} from "../../src/worker/types.js";
import type { WorkerRunner } from "../../src/worker/worker-pipeline.js";

export const MEETING_ID = "11111111-1111-4111-8111-111111111111";
export const RUN_ID = "22222222-2222-4222-8222-222222222222";
export const SECOND_MEETING_ID = "33333333-3333-4333-8333-333333333333";
export const SECOND_RUN_ID = "44444444-4444-4444-8444-444444444444";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export interface TestAudioBehavior {
  readonly assertSourceError?: unknown;
  readonly cleanupAllError?: unknown;
  readonly cleanupError?: unknown;
  readonly cleanupGate?: Promise<void>;
  readonly deleteErrors?: unknown[];
  readonly freedBytes?: number;
  readonly normalizeError?: unknown;
  readonly persistError?: unknown;
  readonly promoteError?: unknown;
  readonly recoverError?: unknown;
  readonly sourceName?: string;
}

export class TestAudioStore implements ManagedAudioStore {
  readonly asserted: string[] = [];
  readonly cleaned: string[] = [];
  readonly deleted: string[] = [];
  readonly opened: string[] = [];
  readonly persisted: string[] = [];
  readonly prepared: string[] = [];
  readonly recovered: string[] = [];
  readonly promoted: string[] = [];
  cleanupAllCount = 0;
  closeCount = 0;

  constructor(private readonly behavior: TestAudioBehavior = {}) {}

  async assertManagedSource(
    meetingId: string,
    _format: "wav" | "m4a" | "mp3",
    _origin: "import" | "recording",
  ): Promise<void> {
    this.asserted.push(meetingId);
    if (this.behavior.assertSourceError !== undefined) throw this.behavior.assertSourceError;
  }

  async cleanupAllWork(): Promise<void> {
    this.cleanupAllCount += 1;
    if (this.behavior.cleanupAllError !== undefined) throw this.behavior.cleanupAllError;
  }

  async cleanupWork(meetingId: string): Promise<void> {
    this.cleaned.push(meetingId);
    await this.behavior.cleanupGate;
    if (this.behavior.cleanupError !== undefined) throw this.behavior.cleanupError;
  }

  async deleteMeeting(meetingId: string): Promise<{ readonly freedBytes: number }> {
    this.deleted.push(meetingId);
    const error = this.behavior.deleteErrors?.shift();
    if (error !== undefined) throw error;
    return { freedBytes: this.behavior.freedBytes ?? 1_024 };
  }

  async normalize(meetingId: string, _format: "wav" | "m4a" | "mp3", signal?: AbortSignal) {
    if (signal?.aborted === true) {
      throw new ManagedAudioError("CANCELLED_BY_USER", "normalization cancelled");
    }
    if (this.behavior.normalizeError !== undefined) throw this.behavior.normalizeError;
    return {
      audioPath: `/managed/meetings/${meetingId}/audio.wav`,
      durationMs: 1_000,
      frameCount: 16_000,
    };
  }

  async openInput(inputPath: string): Promise<VerifiedAudioInput> {
    this.opened.push(inputPath);
    let closed = false;
    return {
      sourceFormat: "wav",
      sourceName: this.behavior.sourceName ?? "weekly-review.wav",
      sourceSizeBytes: 1_024,
      close: async () => {
        if (closed) return;
        closed = true;
        this.closeCount += 1;
      },
      persist: async (meetingId: string) => this.persist(meetingId),
    };
  }

  async prepareRecording(meetingId: string) {
    return {
      meetingDirectory: `/managed/meetings/${meetingId}`,
      recordingDirectory: `/managed/meetings/${meetingId}/recording`,
      workRecordingDirectory: `/managed/work/${meetingId}/recording`,
    };
  }

  async promoteRecordingCandidate(meetingId: string, candidate: {
    readonly audioFiles: readonly ("audio.tmp.wav" | "mic.tmp.wav" | "system.tmp.wav")[];
    readonly durationMs: number;
    readonly sourceSha256: string;
    readonly sourceSizeBytes: number;
  }) {
    this.promoted.push(meetingId);
    if (this.behavior.promoteError !== undefined) throw this.behavior.promoteError;
    return {
      durationMs: candidate.durationMs,
      frameCount: candidate.durationMs * 16,
      sourceFormat: "wav" as const,
      sourcePath: `/managed/meetings/${meetingId}/audio.wav`,
      sourceSha256: candidate.sourceSha256,
      sourceSizeBytes: candidate.sourceSizeBytes,
      tracks: candidate.audioFiles.includes("mic.tmp.wav")
        ? ["mic" as const]
        : ["system" as const],
    };
  }

  async recoverRecording(meetingId: string) {
    this.recovered.push(meetingId);
    if (this.behavior.recoverError !== undefined) throw this.behavior.recoverError;
    return {
      durationMs: 1_000,
      frameCount: 16_000,
      sourceFormat: "wav" as const,
      sourcePath: `/managed/meetings/${meetingId}/audio.wav`,
      sourceSha256: "c".repeat(64),
      sourceSizeBytes: 32_044,
      tracks: ["mic"] as const,
    };
  }

  async prepareRetranscription(
    meetingId: string,
    format: "wav" | "m4a" | "mp3",
    _origin: "import" | "recording",
    signal?: AbortSignal,
  ) {
    this.prepared.push(meetingId);
    return this.normalize(meetingId, format, signal);
  }

  private async persist(meetingId: string): Promise<ManagedSource> {
    if (this.behavior.persistError !== undefined) throw this.behavior.persistError;
    this.persisted.push(meetingId);
    return {
      sourceFormat: "wav",
      sourcePath: `/managed/meetings/${meetingId}/source.wav`,
      sourceSha256: "b".repeat(64),
      sourceSizeBytes: 1_024,
    };
  }
}

export function asrResult(empty = false): AsrResultMessage {
  return {
    type: "result",
    request_id: RUN_ID,
    kind: "asr",
    base_transcript_version: 0,
    payload: {
      blocks: empty ? [] : [{ seq: 0, start_ms: 0, end_ms: 500, text: "会议正文" }],
      speech_regions: empty ? [] : [{ start_ms: 0, end_ms: 600 }],
      empty_reason: empty ? "silent" : null,
      metrics: { vad_ms: 1, asr_ms: 2, max_rss_bytes: 3 },
    },
  };
}

export function diarizationResult(partial = false): DiarizationResultMessage {
  return {
    type: "result",
    request_id: `${RUN_ID}:diar`,
    kind: "diarization",
    base_transcript_version: 0,
    payload: {
      result_status: partial ? "partial" : "completed",
      result_reason: partial ? "unknown_speaker_segments" : null,
      segments: [{
        seq: 0,
        start_ms: 0,
        end_ms: 500,
        text: "会议正文",
        speaker_label: partial ? "UNKNOWN" : "Speaker A",
      }],
      warnings: partial ? [{ code: "LOW_CONFIDENCE", seq: 0 }] : [],
      metrics: {
        fbank_ms: 1,
        embed_ms: 2,
        cluster_ms: 3,
        assign_ms: 4,
        max_rss_bytes: 5,
      },
    },
  };
}

export function immediateRunner(result: WorkerResultMessage): WorkerRunner {
  return {
    async run(run, options) {
      options?.onReady?.({
        type: "ready",
        protocol_version: 2,
        kind: run.kind,
        engine_fingerprint: "a".repeat(64),
        load_ms: 1,
      });
      options?.onProgress?.({
        type: "progress",
        request_id: run.request_id,
        stage: run.kind === "asr" ? "asr" : "assign",
        ratio: 1,
      });
      return result;
    },
  };
}

export function failingRunner(error: unknown, afterReady = false): WorkerRunner {
  return {
    async run(run, options) {
      if (afterReady) {
        options?.onReady?.({
          type: "ready",
          protocol_version: 2,
          kind: run.kind,
          engine_fingerprint: "a".repeat(64),
          load_ms: 1,
        });
      }
      throw error;
    },
  };
}

export function heldRunner(entered: Deferred<void>): WorkerRunner {
  return {
    async run(run, options) {
      options?.onReady?.({
        type: "ready",
        protocol_version: 2,
        kind: run.kind,
        engine_fingerprint: "a".repeat(64),
        load_ms: 1,
      });
      entered.resolve();
      return new Promise<WorkerResultMessage>((_resolve, reject) => {
        const cancel = () => reject(new ManagedAudioError("CANCELLED_BY_USER", "worker cancelled"));
        if (options?.signal?.aborted === true) cancel();
        else options?.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  };
}

export interface MeetingApplicationHarness {
  readonly application: MeetingApplication;
  readonly audio: TestAudioStore;
  readonly context: Context;
  readonly repository: MeetingRepository;
  readonly root: string;
  dispose(): Promise<void>;
}

export interface CreateMeetingApplicationHarnessOptions {
  readonly prepareRuntime?: MeetingApplicationOptions["prepareRuntime"];
  readonly asr?: WorkerRunner;
  readonly attachController?: boolean;
  readonly audio?: TestAudioStore;
  readonly diarization?: WorkerRunner;
  readonly now?: () => number;
  readonly repositoryAdapter?: (repository: MeetingRepository) => MeetingRepository;
  readonly recording?: MeetingApplicationOptions["recording"];
}

export async function createMeetingApplicationHarness(
  options: CreateMeetingApplicationHarnessOptions = {},
): Promise<MeetingApplicationHarness> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-application-"));
  const repository = openMeetingRepository(join(root, "meetings.sqlite3"));
  const context = new Context();
  await context.plugin(AgentRegistry);
  await context.plugin(LocalJobRegistry);
  if (options.attachController !== false) context.jobs.attachController("meeting-test");
  const audio = options.audio ?? new TestAudioStore();
  const ids = [MEETING_ID, RUN_ID, SECOND_MEETING_ID, SECOND_RUN_ID];
  let idIndex = 0;
  let nowMs = 1_000;
  const application = new MeetingApplication({
    ...(options.prepareRuntime === undefined ? {} : { prepareRuntime: options.prepareRuntime }),
    asr: options.asr ?? immediateRunner(asrResult()),
    audioStore: audio,
    dataRoot: root,
    diarization: options.diarization ?? immediateRunner(diarizationResult()),
    engineFingerprint: "a".repeat(64),
    generateId: () => ids[idIndex++]!,
    jobs: context.jobs,
    now: options.now ?? (() => nowMs++),
    repository: options.repositoryAdapter?.(repository) ?? repository,
    ...(options.recording === undefined ? {} : { recording: options.recording }),
  });
  return {
    application,
    audio,
    context,
    repository,
    root,
    async dispose() {
      await application.shutdown();
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
