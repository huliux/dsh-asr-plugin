import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  buildRecordingTimeline,
  MAX_RECORDING_CHUNKS_PER_TRACK,
  type RecordingChunk,
  type RecordingTimeline,
  type RecordingTimelineChunk,
  type RecordingTrack,
} from "./recording-timeline.js";
import { openPcm16Wav, PCM_SAMPLE_RATE } from "./wav-reader.js";

const CLOSED_CHUNK_NAME = /^(\d+)-(\d+)\.wav$/;

interface ClosedChunk extends RecordingChunk {
  readonly size: number;
}

export class ClosedRecordingChunkError extends Error {
  readonly code = "AUDIO_READ_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClosedRecordingChunkError";
  }
}

export interface ClosedRecordingChunks {
  scan(): Promise<RecordingTimeline | null>;
  read(
    chunk: RecordingTimelineChunk,
    startFrame: number,
    endFrame: number,
  ): Promise<Float32Array>;
}

function failure(message: string, cause?: unknown): ClosedRecordingChunkError {
  return new ClosedRecordingChunkError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function timestamp(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw failure("Chunk timestamp is invalid");
  return result;
}

function timestampRange(name: string): { startUs: number; endUs: number } {
  const match = CLOSED_CHUNK_NAME.exec(name);
  if (match === null) throw failure("Closed chunk filename is invalid");
  const startUs = timestamp(match[1]!);
  const endUs = timestamp(match[2]!);
  if (endUs <= startUs) throw failure("Closed chunk timestamp range is invalid");
  return { startUs, endUs };
}

function expectedFrames(startUs: number, endUs: number): number {
  return Math.round(((endUs - startUs) * PCM_SAMPLE_RATE) / 1_000_000);
}

function assertInside(root: string, path: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw failure("Closed chunk path escapes the recording root");
  }
}

async function inspectChunk(
  root: string,
  track: RecordingTrack,
  path: string,
  name: string,
): Promise<ClosedChunk> {
  const canonical = await realpath(path);
  assertInside(root, canonical);
  const info = await stat(canonical);
  if (!info.isFile() || info.size < 44) throw failure("Closed chunk is not a regular WAV");
  const { startUs, endUs } = timestampRange(name);
  const reader = await openPcm16Wav(canonical);
  try {
    if (Math.abs(reader.metadata.frameCount - expectedFrames(startUs, endUs)) > 1) {
      throw failure("Closed chunk duration does not match its timestamp");
    }
    return {
      id: canonical,
      track,
      startUs,
      endUs,
      frameCount: reader.metadata.frameCount,
      size: info.size,
    };
  } finally {
    await reader.close();
  }
}

class FileClosedRecordingChunks implements ClosedRecordingChunks {
  private readonly known = new Map<string, ClosedChunk>();

  constructor(
    private readonly recordingRoot: string,
    private readonly trackRoots: Readonly<Record<RecordingTrack, string>>,
  ) {}

  async scan(): Promise<RecordingTimeline | null> {
    try {
      const seen = new Set<string>();
      for (const track of ["mic", "system"] as const) await this.scanTrack(track, seen);
      for (const id of this.known.keys()) {
        if (!seen.has(id)) throw failure("A closed recording chunk disappeared");
      }
      return this.known.size === 0 ? null : buildRecordingTimeline([...this.known.values()]);
    } catch (error) {
      if (error instanceof ClosedRecordingChunkError) throw error;
      throw failure("Closed recording chunks could not be scanned", error);
    }
  }

  async read(
    chunk: RecordingTimelineChunk,
    startFrame: number,
    endFrame: number,
  ): Promise<Float32Array> {
    const known = this.known.get(chunk.id);
    if (known === undefined || known.frameCount !== chunk.frameCount) {
      throw failure("Closed chunk is not part of the current timeline");
    }
    const reader = await openPcm16Wav(known.id);
    try {
      const info = await stat(known.id);
      if (info.size !== known.size || reader.metadata.frameCount !== known.frameCount) {
        throw failure("Closed chunk changed after it was scanned");
      }
      return await reader.readFrames(startFrame, endFrame);
    } catch (error) {
      if (error instanceof ClosedRecordingChunkError) throw error;
      throw failure("Closed recording chunk could not be read", error);
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  private async scanTrack(track: RecordingTrack, seen: Set<string>): Promise<void> {
    const root = this.trackRoots[track];
    const entries = await readdir(root, { withFileTypes: true });
    const wav = entries.filter((entry) => entry.name.endsWith(".wav"));
    if (wav.length > MAX_RECORDING_CHUNKS_PER_TRACK) {
      throw failure("Recording track has too many chunks");
    }
    for (const entry of wav) {
      if (!entry.isFile()) throw failure("Closed chunk must be a regular file");
      const path = await realpath(join(root, entry.name));
      assertInside(this.recordingRoot, path);
      seen.add(path);
      if (!this.known.has(path)) {
        this.known.set(path, await inspectChunk(this.recordingRoot, track, path, entry.name));
      }
    }
  }
}

export async function openClosedRecordingChunks(
  recordingDirectory: string,
): Promise<ClosedRecordingChunks> {
  try {
    const recordingRoot = await realpath(recordingDirectory);
    const mic = await realpath(join(recordingRoot, "mic", "chunks"));
    const system = await realpath(join(recordingRoot, "system", "chunks"));
    assertInside(recordingRoot, mic);
    assertInside(recordingRoot, system);
    return new FileClosedRecordingChunks(recordingRoot, { mic, system });
  } catch (error) {
    if (error instanceof ClosedRecordingChunkError) throw error;
    throw failure("Recording chunk roots are unavailable", error);
  }
}
