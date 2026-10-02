import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ClosedRecordingChunks } from "./closed-recording-chunks.js";
import { pcm16Integer } from "./pcm16.js";
import {
  renderRecordingTrackWindow,
  renderRecordingWindow,
  type RecordingTimeline,
  type RecordingTrack,
} from "./recording-timeline.js";
import {
  openPcm16Wav,
  PCM_SAMPLE_RATE,
} from "./wav-reader.js";

const WAV_HEADER_BYTES = 44;
const WRITE_WINDOW_FRAMES = PCM_SAMPLE_RATE * 60;
const CANDIDATE_FILES = ["audio.tmp.wav", "mic.tmp.wav", "system.tmp.wav"] as const;

export type RecordingAudioCandidateFile = (typeof CANDIDATE_FILES)[number];

export interface RecordingAudioPaths {
  readonly meetingDirectory: string;
  readonly recordingDirectory: string;
  readonly workRecordingDirectory: string;
}

export interface RecordingAudioCandidateClaim {
  readonly audioFiles: readonly RecordingAudioCandidateFile[];
  readonly durationMs: number;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
}

export interface RecordingAudioCandidate extends RecordingAudioCandidateClaim {
  readonly captureEndUs: number;
  readonly frameCount: number;
  readonly tracks: readonly RecordingTrack[];
}

export interface PromotedRecordingAudio {
  readonly durationMs: number;
  readonly frameCount: number;
  readonly sourceFormat: "wav";
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
  readonly tracks: readonly RecordingTrack[];
}

export class RecordingAudioCandidateError extends Error {
  readonly code = "AUDIO_READ_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecordingAudioCandidateError";
  }
}

function failure(message: string, cause?: unknown): RecordingAudioCandidateError {
  return new RecordingAudioCandidateError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function wavHeader(frameCount: number): Buffer {
  const dataBytes = frameCount * 2;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function encodePcm16(samples: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(pcm16Integer(samples[index]!), index * 2);
  }
  return bytes;
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten === 0) throw failure("Recording candidate write made no progress");
    offset += result.bytesWritten;
  }
}

async function writeCandidate(
  path: string,
  timeline: RecordingTimeline,
  render: (startFrame: number, endFrame: number) => Promise<Float32Array>,
): Promise<void> {
  await rm(path, { force: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await writeAll(handle, wavHeader(timeline.frameCount), 0);
    for (let start = 0; start < timeline.frameCount; start += WRITE_WINDOW_FRAMES) {
      const end = Math.min(timeline.frameCount, start + WRITE_WINDOW_FRAMES);
      await writeAll(handle, encodePcm16(await render(start, end)), WAV_HEADER_BYTES + start * 2);
    }
    await handle.sync();
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw failure("Recording audio candidate promotion was cancelled");
}

async function fileSha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cloneSingleTrack(source: string, destination: string): Promise<void> {
  await rm(destination, { force: true });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await chmod(destination, 0o600);
  const handle = await open(destination, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function candidateFiles(tracks: readonly RecordingTrack[]): RecordingAudioCandidateFile[] {
  return [
    "audio.tmp.wav",
    ...tracks.map((track) => `${track}.tmp.wav` as const),
  ];
}

async function cleanCandidates(directory: string): Promise<void> {
  await Promise.all(CANDIDATE_FILES.map((name) => rm(join(directory, name), { force: true })));
}

async function removeCoveredChunks(
  recordingDirectory: string,
  tracks: readonly RecordingTrack[],
): Promise<void> {
  await Promise.all(tracks.map(async (track) => rm(
    join(recordingDirectory, track),
    { force: true, recursive: true },
  )));
  await syncDirectory(recordingDirectory);
}

export async function buildRecordingAudioCandidate(
  paths: RecordingAudioPaths,
  chunks: ClosedRecordingChunks,
): Promise<RecordingAudioCandidate> {
  try {
    const timeline = await chunks.scan();
    if (timeline === null) throw failure("Recording has no closed chunks");
    await mkdir(paths.workRecordingDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.workRecordingDirectory, 0o700);
    await cleanCandidates(paths.workRecordingDirectory);
    const tracks = (["mic", "system"] as const).filter((track) =>
      timeline.chunks.some((chunk) => chunk.track === track));
    for (const track of tracks) {
      await writeCandidate(
        join(paths.workRecordingDirectory, `${track}.tmp.wav`),
        timeline,
        (start, end) => renderRecordingTrackWindow(
          timeline, track, start, end, (chunk, from, to) => chunks.read(chunk, from, to),
        ),
      );
    }
    const audioPath = join(paths.workRecordingDirectory, "audio.tmp.wav");
    if (tracks.length === 1) {
      await cloneSingleTrack(
        join(paths.workRecordingDirectory, `${tracks[0]}.tmp.wav`),
        audioPath,
      );
    } else {
      await writeCandidate(
        audioPath,
        timeline,
        (start, end) => renderRecordingWindow(
          timeline, start, end, (chunk, from, to) => chunks.read(chunk, from, to),
        ),
      );
    }
    const sourceSizeBytes = (await stat(audioPath)).size;
    return {
      audioFiles: candidateFiles(tracks),
      captureEndUs: Math.max(...timeline.chunks.map((chunk) => chunk.endUs)),
      durationMs: Math.ceil((timeline.frameCount * 1_000) / PCM_SAMPLE_RATE),
      frameCount: timeline.frameCount,
      sourceSha256: await fileSha256(audioPath),
      sourceSizeBytes,
      tracks,
    };
  } catch (error) {
    if (error instanceof RecordingAudioCandidateError) throw error;
    throw failure("Recording audio candidate could not be built", error);
  }
}

function assertClaim(claim: RecordingAudioCandidateClaim): void {
  const files = [...claim.audioFiles];
  if (
    !Number.isSafeInteger(claim.durationMs) || claim.durationMs < 0 ||
    !Number.isSafeInteger(claim.sourceSizeBytes) || claim.sourceSizeBytes < WAV_HEADER_BYTES ||
    !/^[0-9a-f]{64}$/.test(claim.sourceSha256) ||
    files.length < 1 || files.length > CANDIDATE_FILES.length ||
    files[0] !== "audio.tmp.wav" || new Set(files).size !== files.length ||
    files.some((file) => !CANDIDATE_FILES.includes(file))
  ) throw failure("Recording audio candidate claim is invalid");
}

async function inspectFile(
  directory: string,
  name: string,
): Promise<{ canonical: string; frameCount: number; size: number }> {
  const canonicalDirectory = await realpath(directory);
  const path = join(canonicalDirectory, name);
  const info = await lstat(path);
  if (!info.isFile() || await realpath(path) !== path) {
    throw failure("Recording audio candidate is not a regular owned file");
  }
  const reader = await openPcm16Wav(path);
  try {
    return { canonical: path, frameCount: reader.metadata.frameCount, size: info.size };
  } finally {
    await reader.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function recoverPromotedRecordingAudio(
  paths: RecordingAudioPaths,
  maximumDurationMs?: number,
): Promise<PromotedRecordingAudio | null> {
  const sourcePath = join(paths.meetingDirectory, "audio.wav");
  if (!await pathExists(sourcePath)) return null;
  const tracks: RecordingTrack[] = [];
  for (const track of ["mic", "system"] as const) {
    if (await pathExists(join(paths.recordingDirectory, `${track}.wav`))) tracks.push(track);
  }
  if (tracks.length === 0) return null;
  const inspected = await Promise.all([
    inspectFile(paths.meetingDirectory, "audio.wav"),
    ...tracks.map((track) => inspectFile(paths.recordingDirectory, `${track}.wav`)),
  ]);
  const audio = inspected[0]!;
  if (inspected.some((file) => file.frameCount !== audio.frameCount)) {
    throw failure("Promoted recording audio frame counts do not match");
  }
  if (maximumDurationMs !== undefined && audio.frameCount * 1_000 > maximumDurationMs * PCM_SAMPLE_RATE) {
    throw failure("Promoted recording audio exceeds the verified capture duration");
  }
  const recovered = {
    durationMs: Math.ceil((audio.frameCount * 1_000) / PCM_SAMPLE_RATE),
    frameCount: audio.frameCount,
    sourceFormat: "wav" as const,
    sourcePath,
    sourceSha256: await fileSha256(sourcePath),
    sourceSizeBytes: audio.size,
    tracks,
  };
  await removeCoveredChunks(paths.recordingDirectory, tracks);
  return recovered;
}

export async function verifyAndPromoteRecordingAudio(
  paths: RecordingAudioPaths,
  claim: RecordingAudioCandidateClaim,
  signal?: AbortSignal,
): Promise<PromotedRecordingAudio> {
  try {
    throwIfAborted(signal);
    assertClaim(claim);
    const inspected = await Promise.all(claim.audioFiles.map((name) =>
      inspectFile(paths.workRecordingDirectory, name)));
    const audio = inspected[0]!;
    if (
      audio.size !== claim.sourceSizeBytes ||
      Math.ceil((audio.frameCount * 1_000) / PCM_SAMPLE_RATE) !== claim.durationMs ||
      inspected.some((file) => file.frameCount !== audio.frameCount) ||
      await fileSha256(audio.canonical, signal) !== claim.sourceSha256
    ) throw failure("Recording audio candidate does not match its claim");
    const tracks = claim.audioFiles.slice(1).map((name) =>
      name === "mic.tmp.wav" ? "mic" : "system") as RecordingTrack[];
    throwIfAborted(signal);
    for (const [index, track] of tracks.entries()) {
      await rename(inspected[index + 1]!.canonical, join(paths.recordingDirectory, `${track}.wav`));
    }
    const sourcePath = join(paths.meetingDirectory, "audio.wav");
    await rename(audio.canonical, sourcePath);
    await syncDirectory(paths.recordingDirectory);
    await syncDirectory(paths.meetingDirectory);
    await removeCoveredChunks(paths.recordingDirectory, tracks);
    return {
      durationMs: claim.durationMs,
      frameCount: audio.frameCount,
      sourceFormat: "wav",
      sourcePath,
      sourceSha256: claim.sourceSha256,
      sourceSizeBytes: claim.sourceSizeBytes,
      tracks,
    };
  } catch (error) {
    if (error instanceof RecordingAudioCandidateError) throw error;
    throw failure("Recording audio candidate could not be verified and promoted", error);
  }
}
