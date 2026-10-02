import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";

import {
  normalizeManagedAudio,
  type AudioConversionSubprocess,
  type NormalizedAudio,
} from "../audio/managed-audio-normalizer.js";
import {
  detectAudioSourceFormat,
  type AudioSourceFormat,
} from "../audio/source-format.js";
import { ManagedAudioError } from "../audio/managed-audio-error.js";
import { openPcm16Wav } from "../audio/wav-reader.js";
import {
  recoverRecordingAudio,
  type RecoveredRecordingAudio,
} from "../audio/recording-audio-recovery.js";
import {
  verifyAndPromoteRecordingAudio,
  type RecordingAudioCandidateClaim,
  type PromotedRecordingAudio,
} from "../audio/recording-audio-candidate.js";
import {
  managedPaths,
  managedSourcePath,
  recordingAudioLayout,
  type ManagedPaths,
  type RecordingAudioLayout,
} from "./managed-audio-paths.js";
import { managedTreeBytes } from "./managed-file-tree.js";
import type { MeetingOrigin } from "./types.js";

const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_CANONICAL_WAV_BYTES = 4n * 60n * 60n * 16_000n * 2n + 44n;
const DISK_SAFETY_BYTES = 512n * 1024n * 1024n;
const COPY_BUFFER_BYTES = 1024 * 1024;

export type ManagedAudioSubprocess = AudioConversionSubprocess;

export interface ManagedSource {
  readonly sourceFormat: AudioSourceFormat;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
}

export interface VerifiedAudioInput {
  readonly sourceFormat: AudioSourceFormat;
  readonly sourceName: string;
  readonly sourceSizeBytes: number;
  close(): Promise<void>;
  persist(meetingId: string): Promise<ManagedSource>;
}

export interface ManagedAudioStore {
  assertManagedSource(
    meetingId: string,
    sourceFormat: AudioSourceFormat,
    origin: MeetingOrigin,
  ): Promise<void>;
  cleanupAllWork(): Promise<void>;
  cleanupWork(meetingId: string): Promise<void>;
  deleteMeeting(meetingId: string): Promise<{ readonly freedBytes: number }>;
  normalize(
    meetingId: string,
    sourceFormat: AudioSourceFormat,
    signal?: AbortSignal,
  ): Promise<NormalizedAudio>;
  openInput(inputPath: string): Promise<VerifiedAudioInput>;
  prepareRecording(meetingId: string): Promise<RecordingAudioLayout>;
  promoteRecordingCandidate(
    meetingId: string,
    candidate: RecordingAudioCandidateClaim,
    signal?: AbortSignal,
  ): Promise<PromotedRecordingAudio>;
  recoverRecording(meetingId: string, maximumDurationMs?: number): Promise<RecoveredRecordingAudio>;
  prepareRetranscription(
    meetingId: string,
    sourceFormat: AudioSourceFormat,
    origin: MeetingOrigin,
    signal?: AbortSignal,
  ): Promise<NormalizedAudio>;
}

export interface ManagedAudioStoreOptions {
  readonly capacityBytes?: (dataRoot: string) => Promise<bigint>;
  readonly conversionDeadline?: () => AbortSignal;
  readonly dataRoot: string;
  readonly subprocess: ManagedAudioSubprocess;
}

function storageFailure(message: string, cause: unknown): ManagedAudioError {
  return new ManagedAudioError("STORAGE_FAILURE", message, { cause });
}

async function defaultCapacityBytes(dataRoot: string): Promise<bigint> {
  const stats = await statfs(dataRoot, { bigint: true });
  return stats.bavail * stats.bsize;
}

function assertCapacity(available: bigint, sourceSizeBytes: number): void {
  const required = BigInt(sourceSizeBytes) + MAX_CANONICAL_WAV_BYTES + DISK_SAFETY_BYTES;
  if (available < required) {
    throw new ManagedAudioError(
      "DISK_SPACE_INSUFFICIENT",
      "Managed audio storage does not have enough free space",
    );
  }
}

function mapOpenError(error: unknown): ManagedAudioError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new ManagedAudioError("FILE_NOT_FOUND", "Audio file does not exist");
  return new ManagedAudioError("INVALID_PATH", "Audio path cannot be opened", { cause: error });
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (bytesWritten === 0) throw new Error("Managed source write made no progress");
    offset += bytesWritten;
  }
}

async function copyOpenedSource(
  source: FileHandle,
  destination: FileHandle,
  sourceSizeBytes: number,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, sourceSizeBytes));
  let position = 0;
  while (position < sourceSizeBytes) {
    const requested = Math.min(buffer.byteLength, sourceSizeBytes - position);
    const { bytesRead } = await source.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new ManagedAudioError("INVALID_PATH", "Audio file changed during import");
    const bytes = buffer.subarray(0, bytesRead);
    hash.update(bytes);
    await writeAll(destination, bytes);
    position += bytesRead;
  }
  return hash.digest("hex");
}

function sameOpenedFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNormalizationSource(sourcePath: string): Promise<void> {
  try {
    const stats = await lstat(sourcePath);
    if (!stats.isFile()) throw new Error("managed source is not a regular file");
  } catch (error) {
    throw storageFailure("Managed audio source is unavailable", error);
  }
}

async function assertRetranscriptionSource(sourcePath: string): Promise<void> {
  try {
    const stats = await lstat(sourcePath);
    if (!stats.isFile()) {
      throw new ManagedAudioError("INVALID_PATH", "Managed audio source is unavailable");
    }
  } catch (error) {
    if (error instanceof ManagedAudioError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManagedAudioError("INVALID_PATH", "Managed audio source is unavailable");
    }
    throw storageFailure("Managed audio source could not be inspected", error);
  }
}

class OpenVerifiedAudioInput implements VerifiedAudioInput {
  private closed = false;
  private persisted: ManagedSource | undefined;

  constructor(
    private readonly root: string,
    private readonly handle: FileHandle,
    private readonly initialStats: BigIntStats,
    readonly sourceFormat: AudioSourceFormat,
    readonly sourceName: string,
    readonly sourceSizeBytes: number,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  async persist(meetingId: string): Promise<ManagedSource> {
    if (this.persisted !== undefined) return this.persisted;
    if (this.closed) throw new ManagedAudioError("INVALID_PATH", "Audio input is already closed");
    const paths = managedPaths(this.root, meetingId, this.sourceFormat);
    try {
      this.persisted = await this.persistInto(paths);
      return this.persisted;
    } finally {
      await this.close().catch(() => undefined);
    }
  }

  private async persistInto(paths: ManagedPaths): Promise<ManagedSource> {
    let destination: FileHandle | undefined;
    try {
      await mkdir(paths.meetingDirectory, { recursive: true, mode: 0o700 });
      await mkdir(paths.workDirectory, { recursive: true, mode: 0o700 });
      await chmod(paths.meetingDirectory, 0o700);
      await chmod(paths.workDirectory, 0o700);
      await rm(paths.sourceTemporaryPath, { force: true });
      destination = await open(paths.sourceTemporaryPath, "wx", 0o600);
      const sourceSha256 = await copyOpenedSource(
        this.handle,
        destination,
        this.sourceSizeBytes,
      );
      if (!sameOpenedFile(this.initialStats, await this.handle.stat({ bigint: true }))) {
        throw new ManagedAudioError("INVALID_PATH", "Audio file changed during import");
      }
      await destination.sync();
      await destination.close();
      destination = undefined;
      await rename(paths.sourceTemporaryPath, paths.sourcePath);
      await syncDirectory(paths.meetingDirectory);
      await syncDirectory(paths.workDirectory);
      return {
        sourceFormat: this.sourceFormat,
        sourcePath: paths.sourcePath,
        sourceSha256,
        sourceSizeBytes: this.sourceSizeBytes,
      };
    } catch (error) {
      await destination?.close().catch(() => undefined);
      await rm(paths.sourceTemporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ManagedAudioError) throw error;
      throw storageFailure("Managed audio source could not be persisted", error);
    }
  }
}

class FileManagedAudioStore implements ManagedAudioStore {
  constructor(
    private readonly dataRoot: string,
    private readonly subprocess: ManagedAudioSubprocess,
    private readonly capacityBytes: (dataRoot: string) => Promise<bigint>,
    private readonly conversionDeadline: (() => AbortSignal) | undefined,
  ) {}

  async assertManagedSource(
    meetingId: string,
    sourceFormat: AudioSourceFormat,
    origin: MeetingOrigin,
  ): Promise<void> {
    const paths = managedPaths(this.dataRoot, meetingId, sourceFormat);
    await assertRetranscriptionSource(managedSourcePath(paths, origin));
  }

  async cleanupAllWork(): Promise<void> {
    const workRoot = join(this.dataRoot, "work");
    try {
      await rm(workRoot, { force: true, recursive: true });
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      await chmod(workRoot, 0o700);
    } catch (error) {
      throw storageFailure("Managed audio work root could not be cleaned", error);
    }
  }

  async cleanupWork(meetingId: string): Promise<void> {
    const { workDirectory } = managedPaths(this.dataRoot, meetingId, "wav");
    try {
      await rm(workDirectory, { force: true, recursive: true });
    } catch (error) {
      throw storageFailure("Managed audio work could not be cleaned", error);
    }
  }

  async deleteMeeting(meetingId: string): Promise<{ readonly freedBytes: number }> {
    const paths = managedPaths(this.dataRoot, meetingId, "wav");
    try {
      const freedBytes = await managedTreeBytes(paths.meetingDirectory, paths.workDirectory);
      await rm(paths.meetingDirectory, { force: true, recursive: true });
      await rm(paths.workDirectory, { force: true, recursive: true });
      return { freedBytes };
    } catch (error) {
      throw storageFailure("Managed meeting audio could not be deleted", error);
    }
  }

  async openInput(inputPath: string): Promise<VerifiedAudioInput> {
    if (!isAbsolute(inputPath)) {
      throw new ManagedAudioError("INVALID_PATH", "Audio path must be absolute");
    }
    let handle: FileHandle;
    try {
      handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw mapOpenError(error);
    }
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) throw new ManagedAudioError("INVALID_PATH", "Audio input is not a regular file");
      if (stats.size > BigInt(MAX_SOURCE_BYTES)) {
        throw new ManagedAudioError("AUDIO_FILE_TOO_LARGE", "Audio file exceeds 500 MiB");
      }
      const sourceSizeBytes = Number(stats.size);
      const sourceFormat = await detectAudioSourceFormat(handle, sourceSizeBytes);
      if (sourceFormat === null) {
        throw new ManagedAudioError("UNSUPPORTED_AUDIO_FORMAT", "Audio format is not supported");
      }
      assertCapacity(await this.capacityBytes(this.dataRoot), sourceSizeBytes);
      return new OpenVerifiedAudioInput(
        this.dataRoot,
        handle,
        stats,
        sourceFormat,
        basename(inputPath),
        sourceSizeBytes,
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (error instanceof ManagedAudioError) throw error;
      throw storageFailure("Audio input could not be inspected", error);
    }
  }

  async prepareRecording(meetingId: string): Promise<RecordingAudioLayout> {
    const layout = recordingAudioLayout(this.dataRoot, meetingId);
    const directories = [
      layout.meetingDirectory,
      layout.recordingDirectory,
      join(layout.recordingDirectory, "mic", "chunks"),
      join(layout.recordingDirectory, "system", "chunks"),
      layout.workRecordingDirectory,
    ];
    try {
      for (const directory of directories) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      }
      return layout;
    } catch (error) {
      throw storageFailure("Recording audio directories could not be prepared", error);
    }
  }

  async promoteRecordingCandidate(
    meetingId: string,
    candidate: RecordingAudioCandidateClaim,
    signal?: AbortSignal,
  ): Promise<PromotedRecordingAudio> {
    try {
      return await verifyAndPromoteRecordingAudio(
        recordingAudioLayout(this.dataRoot, meetingId),
        candidate,
        signal,
      );
    } catch (error) {
      if (error instanceof ManagedAudioError) throw error;
      throw storageFailure("Recording audio candidate could not be promoted", error);
    }
  }

  async recoverRecording(meetingId: string, maximumDurationMs?: number): Promise<RecoveredRecordingAudio> {
    return recoverRecordingAudio(recordingAudioLayout(this.dataRoot, meetingId), maximumDurationMs);
  }

  async normalize(
    meetingId: string,
    sourceFormat: AudioSourceFormat,
    signal?: AbortSignal,
  ): Promise<NormalizedAudio> {
    const paths = managedPaths(this.dataRoot, meetingId, sourceFormat);
    try {
      await assertNormalizationSource(paths.sourcePath);
      await mkdir(paths.meetingDirectory, { recursive: true, mode: 0o700 });
      await mkdir(paths.workDirectory, { recursive: true, mode: 0o700 });
      await chmod(paths.meetingDirectory, 0o700);
      await chmod(paths.workDirectory, 0o700);
      return await normalizeManagedAudio({
        ...paths,
        sourceFormat,
        subprocess: this.subprocess,
        ...(signal === undefined ? {} : { signal }),
        ...(this.conversionDeadline === undefined
          ? {}
          : { conversionDeadline: this.conversionDeadline }),
      });
    } catch (error) {
      if (error instanceof ManagedAudioError) throw error;
      throw storageFailure("Managed audio could not be normalized", error);
    }
  }

  async prepareRetranscription(
    meetingId: string,
    sourceFormat: AudioSourceFormat,
    origin: MeetingOrigin,
    signal?: AbortSignal,
  ): Promise<NormalizedAudio> {
    const paths = managedPaths(this.dataRoot, meetingId, sourceFormat);
    const sourcePath = managedSourcePath(paths, origin);
    await assertRetranscriptionSource(sourcePath);
    if (origin === "recording") {
      if (signal?.aborted === true) {
        throw new ManagedAudioError("CANCELLED_BY_USER", "Audio normalization was cancelled");
      }
      try {
        const reader = await openPcm16Wav(sourcePath);
        try {
          return {
            audioPath: sourcePath,
            durationMs: reader.metadata.durationMs,
            frameCount: reader.metadata.frameCount,
          };
        } finally {
          await reader.close();
        }
      } catch (error) {
        if (error instanceof ManagedAudioError) throw error;
        throw new ManagedAudioError("AUDIO_DECODE_FAILED", "Managed recording audio is damaged", {
          cause: error,
        });
      }
    }
    return this.normalize(meetingId, sourceFormat, signal);
  }
}

export async function openManagedAudioStore(
  options: ManagedAudioStoreOptions,
): Promise<ManagedAudioStore> {
  if (!isAbsolute(options.dataRoot)) {
    throw new ManagedAudioError("INVALID_PATH", "Managed audio root must be absolute");
  }
  try {
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    const dataRoot = await realpath(options.dataRoot);
    await chmod(dataRoot, 0o700);
    for (const name of ["meetings", "work"]) {
      const directory = join(dataRoot, name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    return new FileManagedAudioStore(
      dataRoot,
      options.subprocess,
      options.capacityBytes ?? defaultCapacityBytes,
      options.conversionDeadline,
    );
  } catch (error) {
    if (error instanceof ManagedAudioError) throw error;
    throw storageFailure("Managed audio root could not be prepared", error);
  }
}

export { ManagedAudioError } from "../audio/managed-audio-error.js";
export type { ManagedAudioErrorCode } from "../audio/managed-audio-error.js";
export type { RecoveredRecordingAudio } from "../audio/recording-audio-recovery.js";
export type { RecordingAudioLayout } from "./managed-audio-paths.js";
